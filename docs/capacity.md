# Capacity, models and quotas

## Start workers by measured pressure

Origin: the Controller used to count workers (8 with test suites plus 6 read-only). Counting did not stop a 12-thread server from reaching load 25 with timeouts, and at other times left it idle.

`controller/capacity.mjs` prints a verdict before every start:

```json
{ "suite": "start|wait", "readonly": "start|wait", "gateUnitSlots": 3, "gateE2eSlots": 2, "reason": "..." }
```

Inputs:

- Linux pressure stall information: `/proc/pressure/cpu`, `/proc/pressure/memory`, `/proc/pressure/io` (avg10, avg60). It tells how much of the time processes waited, which is far more telling than the load average and also sees foreign load.
- available memory
- the `gate` queue length per pool
- the number of running suite and read-only workers
- foreign load: processes outside the project's workspaces
- the latest quota readings for the agent CLIs

Rules (thresholds in `factory.config.json` → `capacity`):

- a new **suite worker** starts only when CPU pressure avg10 is below `cpuAvg10MaxPercent`, memory pressure avg10 below `memoryAvg10MaxPercent`, available memory above `availableMemoryMinGb`, the gate queue shorter than `gateQueueMax`, and the count below `suiteWorkersMax`
- **read-only workers** (Architects, Auditors, spec reviews) are cheap and start unless memory is short, up to `readOnlyWorkersMax`
- the **gate slot counts** rise and fall with pressure within the configured ranges; `gate` reads them from `gate-slots.json`
- every worker terminal gets a memory and process limit (`capacity.worker`) where the runner supports it

When capacity is short, the Controller starts in this order:

1. the critical path (tasks that block others)
2. rework and Testers of nearly finished tasks
3. waves
4. new development
5. debt and improvements

`gate` (`controller/gate.mjs`, Node only, no `flock`) queues waiters as ticket files per pool and host and lets only the oldest live ticket take a free slot, so gates on one host run first come, first served; stale tickets and slots of dead processes are swept. It logs wait time and run time per gate to the journal (`type: gate`); `loadlog.sh` writes load, memory, pressure and agent counts once a minute. The nightly audit reads both and answers: does more parallelism raise throughput, or only waiting?

## The caps are starting values: calibration

The capacity of a host (local or remote) is open. It is probed and adjusted step by step to what the workers actually need.

With `capacity.calibration.mode: auto`, `capacity.mjs` keeps a state file per host (`capacity-state.<host>.json`):

- it starts at `startSuite` / `startReadonly` workers, low on purpose
- it raises the cap by `step` when the host has been at the cap and quiet (no pressure, short gate queue, no load timeouts in the journal) for `raiseAfterQuietMinutes`
- it lowers the cap by `step` on pressure or load timeouts, at most once per 15 minutes, never below the start value
- it never exceeds `maxSuite` / `maxReadonly`
- every step is recorded in the state's history and in the journal; the nightly audit checks whether a step raised throughput or only waiting

`manual` uses the configured caps as they are. `--reset` restarts the calibration.

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

## Quota fallback

When the default agent CLI's weekly quota drops below `agents.fallback.quotaThresholdPercent` (10 % by default), every **new** worker starts with the fallback agent and the mapped model tier. Running workers finish as they are. The ladder applies the same way on the fallback. The Controller records each quota reading and the switch in `status.md` and the journal, and switches back after the reset.

## Worker limits

Where the runner supports it, each worker terminal starts with a memory limit and a process ceiling (`capacity.worker`). A runaway test run then cannot take the host down. If the runner cannot enforce them, the Controller notes that as a limitation in `status.md`.
