# Capacity, models and quotas

## Start workers by measured pressure

Origin: the Controller used to count workers (8 with test suites plus 6 read-only). Counting did not stop a 12-thread server from reaching load 25 with timeouts, and at other times left it idle.

`controller/capacity.mjs` prints a verdict before every start:

```json
{ "heavy": "start|wait", "light": "start|wait", "readonly": "start|wait", "suite": "same as heavy",
  "reason": "why heavy waits", "lightReason": "why light waits", "foreignLoad": 0.4, "unknownLoad": 2.8,
  "gateUnitSlots": 3, "gateE2eSlots": 2 }
```

Inputs, all measured in one round trip to the host (one `sh` script, locally or in one ssh call; a second call writes the gate slots to a remote host). It takes the one second of the CPU sample plus the time of the commands:

- Linux pressure stall information (PSI): `/proc/pressure/cpu`, `/proc/pressure/memory`, `/proc/pressure/io` (avg10). It tells how much of the time processes waited, which is far more telling than the load average.
- the load average (`load1`) and the number of threads
- available memory
- the `gate` queue length per pool
- CPU use per process over about one second, with each busy process's working directory (see "Foreign load")
- the number of running workers (heavy and light together, and read-only)
- load timeouts recorded in the journal
- the latest quota readings for the agent CLIs

## Two capacity classes

| Class | Who | CPU limit with PSI | CPU limit without PSI (macOS) |
|---|---|---|---|
| **heavy** | Testers (with a browser too) and every other worker that is not read-only, except Developers; what runs the full tests and gates | CPU avg10 ≤ `pressure.cpuAvg10MaxPercent` (20) | load1 ≤ threads × `heavyLoadPerThread` (0.9) |
| **light** | Developers | CPU avg10 ≤ `pressure.lightCpuAvg10MaxPercent` (default: the heavy limit × light factor ÷ heavy factor, 33) | load1 ≤ threads × `lightLoadPerThread` (1.5) |
| **read-only** | `--readonly` workers (Architects, Auditors, spec reviews, Retros) | no CPU limit | no CPU limit |

`start.mjs` picks the class from the worker's name: `<Task> · Worker Developer` is light, `--readonly` is read-only, **everything else is heavy**. A light limit below the heavy one counts as the heavy one. On a host with PSI the load factors do not decide the CPU rule; the light PSI default is derived from them, a judgement that no measurement backs yet.

What holds which class:

| | heavy | light | read-only |
|---|---|---|---|
| its CPU limit | yes | yes | |
| memory: pressure avg10 above `memoryAvg10MaxPercent` (5), or available below `availableMemoryMinGb` | yes | yes | yes |
| foreign load (below) | yes | yes | |
| the cap | `suiteMax`, shared | `suiteMax`, shared | `readonlyMax` |
| gate queue of `gateQueueMax` (3) or more | yes | | |
| a load timeout in the journal in the last 30 minutes | yes | | |

There is one cap for heavy and light together: it bounds how many writing workers run on a host. The gate queue and load timeouts are about full runs. **Full gates still go through the gate slots** whoever starts them: a light start is no permission to run a full gate outside `gate`. A Developer who runs full suites outside the gate loads the host like a heavy worker.

`suite` is the heavy verdict under its old name, so a handbook that only knows `suite` stays with the stricter class.

Other rules:

- only **running** workers count: an Orca worker until Orca reports its dispatch `succeeded`, `failed` or `stopped`, even if its agent still sits at the prompt after `worker_done`; an `abandoned` worker (Orca: it may still run) and a worker whose state cannot be read count as running
- a `wait` verdict carries `measureAgainAt` (one minute later; asking earlier gives the same answer) and `capOnly`: `true` when a pool waits and only a cap holds it back (the suite cap with nothing else against a Developer, or the read-only cap on a quiet host)
- the **gate slot counts** rise and fall with pressure within the configured ranges; `gate` reads them from `gate-slots.json`
- every worker terminal gets a memory and process limit (`capacity.worker`) where the runner supports it

All thresholds are in `factory.config.json` → `capacity`; a worker host's own `capacity` block overrides single values (its `pressure` block replaces the whole `pressure` object).

## Foreign load

Foreign load is the CPU, in cores, that processes **clearly belonging to something else** used during the sample. It holds heavy and light starts when both are true:

- foreign cores > threads × `foreignLoadMaxPerThread` (0.25), and
- load1 ≥ threads × `foreignLoadMinLoadPerThread` (0.5).

**How CPU is measured.** The CPU time each process used between two samples one second apart, not a lifetime average.

- Linux: `utime + stime` from `/proc/<pid>/stat`, divided by the elapsed time from `/proc/uptime`.
- macOS: two `ps -A -o pid=,ppid=,time=,comm=` readings of accumulated CPU time (resolution 0.01 s), then one `lsof` call for the working directories of the busy processes and their parents. `top -l 2` was not chosen: it waits for its own sample interval as well, and its output is harder to read reliably.

Processes under 5 % of a core are left out. The probe leaves out itself: its shell, everything the shell starts, and the processes above it (the ssh session or the Controller's command).

**Who owns a process.** Judged by its working directory:

1. **own:** it lies in the project's checkout, its workspaces (`<workspacesDir>/<project>`), the Controller directory, `~/front-agent/<project>` or `~/Development/<project>-preview` (on the Controller's host also the directory the scripts run from); or it is in a linked git worktree of one of these repositories, wherever that lies; or one of its path parts is exactly the project's name.
2. **foreign:** it is not own, not under a temp directory (`/tmp`, `/var/tmp`, `/var/folders`, `$TMPDIR`), and lies inside a git checkout. A repository in the home directory itself (dotfiles kept in git) does not count.
3. **says nothing:** everything else: `/`, the home directory, plain directories, temp directories, a working directory that cannot be read.

A process whose directory says nothing takes the verdict of its nearest parent that has one (a browser started from your worker is yours; one started by another project's test run is foreign). Without such a parent it is **unknown**. Foreign must be clear: a process that would be foreign but has an own process further up (a tool of your agent working in another checkout) is unknown as well. So a terminal multiplexer started from a directory of this project makes other projects' processes under it unknown. Unknown is reported (`unknownLoad` in the verdict and the journal) and **never holds a start**.

**Why a second condition on load1.** If load1 is below half the threads, at least half the host has been free over the last minute, so there is room whatever the process figures say. That also covers a wrong figure: the case that led to this rule showed about 7 cores of "foreign load" on a 12-thread host with load1 1.2, which is 0.1 per thread. `0` switches the cross-check off. When the figure is over its limit but load1 is not, the verdict says so in `loadNote`. load1 lags by up to a minute, so foreign load that just started holds a start a little later. A high load with a low foreign figure is judged by the CPU limits, as before.

**Why 0.25 stays.** On a correct figure it means a quarter of the host is busy with other work; no measurement argues for another value. It was not configurable before.

**What this can miss** (nearly always in the direction of not holding a start; the CPU, memory and PSI rules still see the load itself):

- containers and virtual machines (Docker, including the VM process on macOS), which also carry your own browser gates
- other users' and root processes, services, and anything with its working directory in `/`, the home directory or a temp directory, without a parent that says more
- another project that does not work in a git checkout, such as its Controller
- CPU of processes that start and end within the sampled second (a build of many short compiles), and many processes below 5 % each
- a directory outside the project with a part named exactly like the project counts as own

The other way round, **any** git checkout that is not this project's counts as foreign, including a person's own work in another repository and a tool that is installed as a git checkout. If the processes cannot be sampled at all, `foreignLoad` is `null`, `loadNote` says so and the rule is skipped. Windows is not measured.

When capacity is short, the Controller starts in this order:

1. the critical path (tasks that block others)
2. rework and Testers of nearly finished tasks
3. waves
4. new development
5. debt and improvements

`gate` (`controller/gate.mjs`, Node only, no `flock`) queues waiters as ticket files per pool and host and lets only the oldest live ticket take a free slot, so a project's gates run first come, first served. The queue and the slots belong to one project (`$TMPDIR/<project>-gate-<pool>`), as they always did: **there is no host-wide cap on full gates.** Two projects on one host run their gates at the same time, and `capacity.mjs` sees the other project only as load (as foreign load where its processes work in its own git checkouts). A host-wide pool would be a separate change; stale tickets and slots of dead processes are swept. It logs wait time and run time per gate to the journal (`type: gate`); `loadlog.sh` writes load, memory, pressure and agent counts once a minute (into `~/load.log`, each line ending in `project=<name>`; the queue and the slots above belong to one project, not to the host). The nightly audit reads both and answers: does more parallelism raise throughput, or only waiting?

## The caps are starting values: calibration

The capacity of a host (local or remote) is open. It is probed and adjusted step by step to what the workers actually need.

With `capacity.calibration.mode: auto`, `capacity.mjs` keeps a state file per host (`capacity-state.<host>.json`):

- it starts at `startSuite` / `startReadonly` workers, low on purpose
- it raises the cap by `step` when the host has been at the cap and quiet (nothing that holds a heavy start) for `raiseAfterQuietMinutes`
- it lowers the suite cap by `step` on **overload**: CPU past the **light** limit, memory short, a full gate queue or load timeouts; at most once per 15 minutes, never below the start value
- **foreign load never lowers a cap**, and neither does CPU between the heavy and the light limit (Developers are allowed to load the host that far). Both hold starts and begin the quiet time again. Before the two classes, CPU past the heavy limit lowered the cap; a project that wants that back sets `lightLoadPerThread` equal to `heavyLoadPerThread` (with PSI: `pressure.lightCpuAvg10MaxPercent` equal to `cpuAvg10MaxPercent`)
- it never exceeds `maxSuite` / `maxReadonly`
- every step is recorded in the state's history (the last 40 entries) and in the journal; the nightly audit checks whether a step raised throughput or only waiting

`manual` uses the configured caps as they are. `--reset` restarts the calibration.

`--set-suite <n> --by "<quote>"` sets the suite cap by hand when the human asks for it, from 1 up to the larger of `maxSuite` and `suiteWorkersMax`. The run that sets it makes no automatic step. The quote and the new cap go into the journal as a `decision`. The calibration continues from there: the cap still rises while the host stays quiet and falls on overload, but the step-down never goes below the start value, so a cap set below it stays until it is set again or reset.

### Caps lowered by the old foreign-load figure

Earlier versions overstated foreign load on Linux and lowered the suite cap for it. The first run of this version on each host's old state gives those steps back, once:

- only steps whose **only** recorded reason was foreign load, and only those after the last `--set-suite`: a cap a person set stays
- never above the cap before the first of those steps, nor above the largest configured cap
- the state records it (`restore`), and the journal gets a `decision` that names the old and the new cap

What is **not** given back: a step that also had another reason (CPU, memory, gate queue, load timeouts), steps that have left the 40-entry history, and the raises that did not happen while the false figure kept ending the quiet time (they come back at one step per `raiseAfterQuietMinutes` at the cap). An old step-down for foreign load that was real cannot be told apart and is given back too; real overload lowers the cap again. If a cap is still lower than it was, ask the human and set it: `node capacity.mjs --set-suite <n> --by "<their words>"` (with `--on <host>`). Do not use `--reset` for this: it goes back to the start values. In `capacity-state.<host>.json` and the journal (`capacity suiteMax down → …`) you can see what the cap was.

## Hosts are optional and plural

A remote server is an option, not a must. `hosts.workers` lists zero or more hosts; each has its own paths, Orca environment and capacity block. With only a local host, everything runs on the human's machine. Scripts take `--on <host>`; the Controller spreads work across hosts by their verdicts.

## Models by complexity

Three tiers, named in `factory.config.json` → `agents.models`:

| Tier | Use |
|---|---|
| `small` | mechanical checklist work |
| `default` | Developers, every Tester, spec and conformance reviews |
| `large` | ADRs and level-3 architecture, and the top of the escalation ladder |

**Escalation ladder:** after two failures on the same task the next attempt runs one tier higher: small → default → large.

**The tiers are starting values too.** The model names in the config are whatever the agent CLI offers; `init` asks for them. `controller/calibrate-models.mjs` reads the journal (pass rate and review rounds per role and model over a window) and moves a role one tier down when its pass rate is high and rounds are low, one tier up when failures cluster. With `agents.calibration: auto` it writes `model-tiers.json`, which `start.mjs` uses when no `--tier` is given; with `manual` it only recommends. Every change is a `decision` event the audit can verify.

**Pinning Pi workers per role.** Pi reaches several providers, so a tier name alone does not say which one runs. `agents.piRoleModels` maps a role to a `provider/model`, for example `{ "Developer": "provider/model-id" }`. A Pi worker of a listed role starts with that model (Orca passes `--model provider/id` on to pi); other roles, and Codex or Claude workers, keep their tier's model. A pinned role ignores its tier, so neither `--tier` nor the escalation ladder changes its model; only an explicit `--model` on `start.mjs` does. The plain-terminal runner does not pass a model to pi, so the key applies to the Orca runner.

## Quota fallback

When the default agent CLI's weekly quota drops below `agents.fallback.quotaThresholdPercent` (10 % by default), every **new** worker starts with the fallback agent and the mapped model tier. Running workers finish as they are. The ladder applies the same way on the fallback. The Controller records each quota reading and the switch in `status.md` and the journal, and switches back after the reset.

## Worker limits

Where the runner supports it, each worker terminal starts with a memory limit and a process ceiling (`capacity.worker`). A runaway test run then cannot take the host down. If the runner cannot enforce them, the Controller notes that as a limitation in `status.md`.
