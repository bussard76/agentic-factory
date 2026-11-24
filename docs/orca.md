# Orca: client, server and remote workers

[Orca](https://github.com/stablyai/orca) is the factory's runner and a **prerequisite**. It gives every worker its own git worktree and terminal, carries structured messages between the Controller and its workers (`worker_done`, `escalation`, `question`), and lets a client on the human's machine steer a headless server over a private network. `init` stops when the Orca CLI is missing. (A plain-terminal runner exists behind `init --experimental-terminal-runner`; it is unsupported.)

## The pieces

| Piece | Where | What it does |
|---|---|---|
| **Orca client** | the human's machine (desktop app or `orca` CLI) | shows terminals and worktrees, pairs with servers, starts and names workers remotely |
| **Orca server** | the build server, `orca.service` (`orca-ide serve --port 6768 --pairing-address <tailscale-ip> --supervise`) | hosts the worktrees, terminals and the orchestration database; the Controller runs in one of its terminals |
| **Environments** | client config | a paired server is an *environment*; every command takes `--environment <name>` to address it |
| **Repos** | registered per server with `orca repo add --path ~/projects/<name>` | the repo id goes into `factory.config.json` → `hosts.workers[].orcaRepoId` of that host (`init` fills it for the local host) |
| **Worktrees** | `~/orca/workspaces/<repo>/<name>` on the server | one per worker; `coordinator-integration` is the wave's worktree |
| **Orchestration** | `orca orchestration …` | `worker-start` dispatches a task into a new worktree; `check --wait` delivers messages; `ask`/`reply`; `worker-release`/`worker-abandon` |

## Remote setup

1. Install the server with `server/` (steps 1–3). The service binds pairing to the Tailscale address only; never expose it publicly.
2. Read the pairing code from the service log and pair the client: `orca environment add --name <env> --pairing-code '<code>'`. Pair without a mobile code; a mobile pairing may neither create repos nor start workers.
3. Register the repo on the server and note its id.
4. Put `orcaEnvironment` and `orcaRepoId` into that host's entry in `factory.config.json` → `hosts.workers[]`. Every Controller script reads them.

The Controller itself runs **on the server**, in an Orca terminal, so it survives the client being closed and talks to workers locally. The Front agent on the human's machine only reads `status.md` over SSH and writes `inbox.md`. The Front agent can also run on the server, see [Front agent on the server](#front-agent-on-the-server).

## Naming

Every sidebar entry (worktree display name) and every terminal, which Orca shows as a tab, is named after its role or task, on every level. Automatic names such as `main`, a branch name, `Setup` or `user@host: path` must not remain.

| Level | Sidebar entry | Terminal | Example |
|---|---|---|---|
| Front agent | `<project> · Front Agent` | same | `my-app · Front Agent` |
| Controller | `<project> · Controller` | same | `my-app · Controller` |
| Worker | `<Task> · Worker <Role>` | same | `T22-S5 · Worker Developer` |
| Integration worktree | `<project> · Integration` | `<project> · Integration · Shell` | `my-app · Integration` |
| Wave or script run | in the integration entry | `<project> · Integration · <Title>` | `my-app · Integration · T22 S4 Routes` |

**Other terminals in an entry:** `<entry name> · <Purpose>`, for example `T22-S5 · Worker Developer · Setup` or `my-app · Controller · Shell`. Such a helper terminal is not the worker itself: it never keeps a worktree from being cleaned up, `stallwatch.mjs` does not watch it, and `cleanup.mjs` does not close it as a finished wave. So do not give a wave or a script the title `Setup` or `Shell`.

**Parts of a name**
- `<project>` is the project name from `factory.config.json`.
- `<Task>` is the ticket and slice or round, for example `T22-S5`, `T22-R6` or `Audit 2026-11-04`.
- `<Role>` is `Developer`, `Tester`, `Architect` or `Auditor`.
- The separator is ` · ` (space, middle dot, space).

**Rules**
- Whoever creates an entry or terminal names it in the same step.
- Naming is enforced by tooling, not left to an agent's memory. An automatic name is corrected; a name set by the human is never overwritten.
- A worker's terminal keeps its name even if the agent retitles it.
- The name changes only the display. The branch and path stay the same, and tools select entries by path or handle, never by display name.
- On a shared host, only name entries of your own project.

**What the tooling does**
- `controller/names.mjs` runs after every worker start and every `cleanup.mjs` cycle. It names this project's entries whose name is automatic or just the folder name: the checkout on the Controller's host, the integration worktree and the worktrees in `workers.json`. In entries with a known name it also renames terminals that still carry Orca's own name: `Setup` becomes `<entry name> · Setup`, and `user@host: path` becomes `<entry name> · Shell`.
- `agentic-factory start` names the Front agent's terminal and entry, and the Controller's terminal.
- A Controller on the human's machine shares the Front agent's checkout, so that one entry is `<project> · Front Agent`, and the Controller keeps its own terminal name.
- `start.mjs`, `wave.mjs` and `runscript.mjs` name their terminals when they create them.

**Limits of the tooling**
- An entry with no known role, such as the checkout on a worker-only host, is reported by `names.mjs` and left as it is.
- Orca does not mark a terminal's name as automatic, so only those two patterns count as automatic. Any other name stays until someone renames it. A human who names a terminal exactly `Setup` gets it corrected.
- A human who names an entry exactly like its folder gets it corrected, because that looks like Orca's own name.

## Front agent on the server

An alternative to the Front agent on the human's machine. **Status: piloted in one project; not supported by `agentic-factory start`, `statuswatch.mjs` or `doctor`. Do not set it up unless the project chose it** (see "Not covered" below).

**Why.** With the Front agent on the human's machine and the Controller on the server, the two live in two Orcas and exchange work through files and a nudging script. In the pilot project this showed as the human noticing that the two were out of step:
- an order was swallowed by the inbox archival and overlooked;
- the heartbeat log had 686 "busy, not woken" against 854 "woke": an order waits until the Controller's turn ends and has no queue of its own;
- nothing woke the Front agent; it polled every two to three minutes, and a watcher that expired went unnoticed.

Orca's own messages are event driven: `orca orchestration send` queues a message and, in the pilot (a pi Controller), woke the recipient at the end of its turn (measured 18 s, Controller idle). That was not seen with a Claude Code Controller in a later run (it stayed idle until the heartbeat or a person woke it), so nothing here relies on it; see [Heartbeat](#heartbeat). It works only inside **one** Orca. Measured across two Orcas (Orca 1.4.246 on the server, 1.4.255 on the client): a message from the client to a server terminal arrives; the server cannot answer to a client terminal (`terminal_not_found`); the client cannot read a server mailbox (`consumer_fenced`); creating a Run needs a terminal on that server (`stable_pane_required`). So both agents have to be in the same Orca.

**Setup.**
- The Front agent runs in an Orca terminal on the server, in its own worktree, and starts from a handover file (`front-agent/FRONT_AGENT.md` rendered for the project, plus the state). The human reaches it through the Orca client, where the server is a saved environment. Start it with `orca worktree create --environment <env> --repo id:<repoId> --name <project>-front --no-parent --agent <agent> --surface terminal --prompt "…"`.
- **On the server, before the first start:** run `agentic-factory install-skills` there, because the Front agent needs its skills on the machine it runs on. Set `hosts.frontAgent.statusWatch: false` in `factory.config.json`, or the status watch keeps targeting a terminal on the human's machine.
- **Tree, collapsible in the client:** Front agent (root) → Controller → Integration and all workers. Re-parent with `orca worktree set --worktree <selector> --parent-worktree <selector>`. Only the Front agent's own worktree is created with `--no-parent`, because it is the root. Every other factory worktree gets a parent; a second `--no-parent` makes a second root. Naming rules above still apply.
- **Orders and answers:** `orca orchestration send --to <terminal handle> --subject … --body …` in both directions. The Controller keeps `wait.mjs` for worker events.
- **Waking the Front agent: Orca's wake did not reach it; a watch does.** Measured in the pilot (Orca 1.4.246, Front agent in Claude Code): over about three hours the Controller sent 56 messages to the Front agent's terminal, and none woke it; they sat unread in its mailbox. A question for the human waited until the human happened to ask for the status. So the Front agent runs a watch in its own session (in Claude Code the `Monitor` tool) that (a) follows `front-events.log` with `tail -F -n0 … | grep --line-buffered -E "FRONT-EVENT (NEEDS-HUMAN|BLOCKED|GATE-RED|GATE-GREEN|DONE)"` and (b) every 15 s takes its mailbox with `orca orchestration check --terminal <own handle> --json` and prints every message it takes, because a taken message is gone from the mailbox; a line that only repeats an event from (a) may then come twice. Before arming the watch, take the backlog once and read it yourself, so old messages neither flood the watch nor get lost. Each printed line wakes the agent. Measured: a test message woke it after about 15 s. Limits: a `Monitor` expires after at most 30 minutes and is re-armed; nothing wakes a Front agent whose session is closed. Verify the watch once with a message to itself, not with a test line in the append-only event log.
- **Events from the Controller:** `front-events.log` (see [roles.md](roles.md#interfaces-between-front-agent-and-controller)), written when the event happens, plus a `send` to the Front agent's terminal. `inbox.md` and `status.md` stay as fallback and record.

**Work that only runs on the human's machine** (the native app and its packaging, the preview there, native checks, design tools, files that only exist there) goes to a **client worker**: the Front agent appends `CLIENT-TASK <date> <what>` to `client-tasks.log` in its directory on the server (`~/front-agent/<project>/`); a session on the human's machine waits for new lines, does the work and answers with `orca orchestration send` to the Front agent (client to server works). The server is **not** paired to the client: that would give the server control over the human's machine, and in a company that needs the IT department's consent. Consequence, accepted: client tasks wait while the machine is off.

**Not covered yet.** `agentic-factory start`, `statuswatch.mjs` and `doctor` still assume the Front agent on the human's machine (`hosts.frontAgent`). A `hosts.frontAgent.location: server` setting, the worktree creation and the re-parenting in `start`, and a check of the tree in `doctor` are follow-up work. Not verified yet: which message type a `send` from the Front agent carries, and that the Controller's `wait.mjs` (`--types worker_done,escalation,question`) leaves it for Orca's wake. The client worker is described, not shipped: the factory has no watcher script for `client-tasks.log`. The Front agent has no direct access to files and design tools that exist only on the human's machine; those stages go through the client worker or the human. The Front agent starts from its handover file, not from the earlier session's context.

## Status watch

`agentic-factory start` schedules `statuswatch.mjs` on the Front agent's machine every 5 minutes, through launchd on macOS and cron elsewhere, outside any session, so it works with whichever agent is in front. It sends alerts into the Front agent's terminal through Orca when that is idle; until then they wait, and the sidebar shows them. That terminal is an agent in the project's own checkout, preferably one named `<project> · Front Agent`.

`status` and `doctor` say when it stopped or cannot reach the terminal, and open questions stay visible either way. Set `hosts.frontAgent.statusWatch` to `false` where nobody works in front. Under WSL, check that the cron service runs.

## Front agent as an Orca bot

An Orca bot can be the Front agent instead of a terminal session: `hosts.frontAgent.kind: "orca-bot"` and `hosts.frontAgent.bot: "<bot name>"` (the name `orca bot list` shows). The default stays `"terminal"`, and a config without `kind` works exactly as before. A bot brings an owner chat, items with explicit "needs you" questions, a memory that survives restarts, and wake-ups through Orca instead of text typed into a terminal.

**What `start` does with a bot:**

- It does not schedule `statuswatch.mjs`; a status watch scheduled earlier by launchd is removed.
- It copies `botwatch.mjs` with `hosts.mjs` and `cli.mjs` into the bot's watch directory `~/front-agent/.bots/<bot>/`, adds the project to `projects.json` there, and creates **one** automation for the bot: every 5 minutes, `--runs-in chat --results-to chat`, with `botwatch.sh` as its precheck. The precheck exits 0, and so wakes the bot, only when in a watched project's `status.md` "Needs <human>", "Needs front agent" or "Problems" changed, when `status.md` is older than `hosts.frontAgent.staleMinutes` (default 25) or missing, or when its host cannot be reached. A lasting problem wakes the bot once, when it starts. It reads local Controllers directly and remote ones over ssh, keeps one state line per project in `botwatch.state`, and writes what woke the bot into `wake.md`, which the automation's prompt tells the bot to read. A precheck that fails (a bundle older than the factory, a missing file) wakes the bot once with the error in `wake.md`; a Front agent bundle without `cli.mjs` makes `start` skip the bot watch and say to run `update` first.
- The bot's rules are `~/front-agent/<project>/FRONT_BOT.md`: the Front agent's rules for a bot. Give the bot's SOUL.md the line "For each agentic-factory project, follow ~/front-agent/<project>/FRONT_BOT.md". Open questions go on items (`orca bot item set <n> --status needs-you --ask … --option …`, a new one with `orca bot item add --title … --done-means …`) and always also as plain text in the chat, because quick-reply buttons are not shown in every Orca view. A bot does not write product code: design-lane work goes through a worker.
- `start` cannot create the bot: Orca creates a bot only when its owner accepts it. Create it in Orca first; until then `start` fails that step and `status` says so in `next`.

**Choosing it and setting it up.** `init` asks who the Front agent is (`hosts.frontAgent.kind`, answer id of the same name: `terminal`, the default, or `orca-bot`) and, for a bot, its name (`hosts.frontAgent.bot`). It also asks for the Controller's directory (`hosts.controller.controllerDir`). The order for a bot: (1) create the bot in Orca: in the Orca app, or let another bot propose it with `orca bot create --offer` (that command runs only in a bot's own chat; the owner accepts the card); (2) add the SOUL.md line above to `~/.orca/bots/<bot>/SOUL.md`; (3) `init`; (4) `start`; (5) `doctor`. [START.md](../START.md) walks the agent through it.

**Item commands are the bot's own.** `orca bot item set` and `orca bot item add` exist inside a bot's own run, in its chat and in the runs the watch wakes. In a plain shell, or in another agent's terminal, `orca bot item --help` answers "Unknown command" and `orca bot --help` lists no item command: that is how Orca shows them, not a missing feature. Everything an outside agent needs from a bot's chat is `orca bot reply`, which answers only in the thread that woke the run.

**The watch's first run is a baseline.** The first time the precheck sees a project it only records the state of "Needs <human>", "Needs front agent" and "Problems"; it wakes the bot for those sections only on a change after that. A question that is already open at that moment therefore reaches the bot through the Controller's message (`--type status` or `question`), not through the watch; a stale, missing or unreachable `status.md` wakes it even on the first run (a missing one only after 15 minutes). A Controller on another machine cannot send, so after its first start ask the bot to read its `status.md`.

**Skipped run or error.** In `orca automations runs` a run whose precheck exits 1 (nothing new) is listed as `error: Precheck exited with code 1`. That is Orca's wording for a skipped run: no bot was woken and nothing is wrong. A real failure carries another message (the precheck exits 2 and prints `botwatch: <reason>`, or the dispatch itself fails).

**Directories.** `controllerDir` may be written with `~`; it is expanded when a script reads it, by the process that runs it. Terminals Orca starts use the HOME of the Orca app, which is not the HOME of a shell started with another one (a test HOME, `sudo`, another user). Write an absolute path then. `init` proposes `~/controller-<project>` instead of `~/controller` where `~/controller` already holds another project's Controller.

**One bot, several projects.** Two projects may name the same bot. The second `start` adds its project to the same `projects.json` and finds the existing automation (`orca automations list`), so there is still one automation and one precheck for all of them.

**The Controller with a bot.** On every front event it appends the line to `front-events.log` as with the Front agent on the server and, when it runs on the same machine as the bot, sends it with `orca orchestration send --to "bot:<name>"`: `--type question` for a new "Needs <human>" item or a block, `--type status` for everything else. `inbox.md` stays the record of orders. **Limit:** `bot:` only reaches bots on the same machine, and a server cannot send to a client (`terminal_not_found`, see "Front agent on the server"). A Controller on a remote host therefore does not send; the bot watches its `status.md` over ssh and sends orders as text into its terminal (`--environment <env>`) and through `inbox.md`.

**Checks.** With a bot, `status --json` reports `setup.frontAgent` (`bot`, `botExists`, `watchAutomation`) and `doctor` checks the bot in `orca bot list` and its automation in `orca automations list` instead of the status watch; `setup.statusWatch` is `false` there, because no status watch is used. The heartbeat (below) is the Controller's waker with a bot as with a terminal Front agent.

## Read access for the Controller

Some agent tools limit which paths a session may read. When `start` sets up a local Controller, it grants read access to the project, the Controller's project directory and the project's worker workspaces, for each such tool it finds on the machine: lean-ctx (`allow_paths` in `~/.lean-ctx/config.toml`) and pi's context-mode package (`permissions.allow: ["Read(<path>/**)"]` in `<controllerDir>/.claude/settings.local.json`). A tool that is not installed is skipped, and a grant that cannot be written is reported and never fails `start`. Another tool is added as one more entry in `bin/read-grants.mjs`. A Controller on a remote host gets no grants from `start`; add them there by hand.

## Heartbeat

`controller/heartbeat.mjs` wakes the Controller from outside, so noticing finished work does not depend on the Controller itself. `agentic-factory start` schedules it every minute, once per Controller directory: with launchd on a local macOS Controller (a user-level job, `~/Library/LaunchAgents/de.agentic-factory.heartbeat.<project>.<hash>.plist`, because `crontab` can be refused there with "Operation not permitted"), with one cron line elsewhere, leaving the rest of the crontab alone. `FACTORY_SCHEDULER=cron|launchd` overrides the choice, as for the status watch. Both give the job the directory of the `node` that ran `start` first on its PATH (under nvm and the like node is on no fixed path), so each `start` after switching node brings it up to date; the launchd label includes a hash of the Controller directory. A cron line that is already there stays, so an installation that works keeps its schedule (`start` only refreshes its PATH, and leaves a line written by hand alone). **Exit codes.** A heartbeat counts as scheduled when a cron line or a launchd job exists, or when it ran in the last 3 minutes although neither does (the host's own scheduler, such as a systemd timer, runs it: reported as `external`). `start` and `doctor` fail only when none of this holds after the first start; an installation whose heartbeat runs stays green, whatever schedules it. A host with neither cron nor launchd gets a message that says so and what to do: run `node heartbeat.mjs` every minute in the Controller directory, and set `hosts.controller.heartbeat` to `"external"`, which makes `start` schedule nothing and `doctor` check only that it runs. `doctor` and `status --json` (`setup.heartbeat`: `scheduled`, `state`, `installed`, `lastRunMin`, `lastOkAt`, `problem`) tell three cases apart: **never ran** (scheduled and installed for a few minutes, no run), **last run failed** (`heartbeat.mjs` touches `heartbeat.alive` when a run starts and `heartbeat.ok` when it got through the terminal list and the mail; a job that starts but crashes, or cannot reach Orca, has the first and not the second; launchd's own last exit code counts too), and **ran fine at HH:MM**; a job silent for more than 3 minutes is reported as silent; a host that does not answer over ssh is reported as unknown. Before the first `start` an unscheduled heartbeat is only an `info`. Set `hosts.controller.heartbeat` to `false` to opt out: `start` then removes a launchd job it installed earlier and says so if a cron line is still there (remove it with `crontab -e`). There is no `stop` command; `update` leaves the schedule alone. To remove a launchd heartbeat by hand, for instance after deleting a project: `launchctl bootout gui/$(id -u)/<label>` and delete `~/Library/LaunchAgents/<label>.plist` (the label is `de.agentic-factory.heartbeat.…`; `ls ~/Library/LaunchAgents` shows it).

- **Every minute:** a new worker message, a finished wave or an inbox entry wakes the Controller. At each tenth minute it also checks running workers and ready tickets, and an unreadable source counts as work. A worker whose dispatch Orca reports settled wakes the Controller once, when the heartbeat first sees it settled (a failed or stopped worker may send no message), and is no work after that, even while its record waits in `workers.json` for cleanup. Orca is asked about workers at most once per run, and for the sidebar at most every 10 minutes (`heartbeat.workers.json`).
- **Busy Controller:** a timeout on "idle" counts as busy. The signal stays pending until a wake succeeded, and every attempt goes to `heartbeat.log`. After 5 minutes an inbox entry reaches the running session as a one-line pointer, once.
- **First beat:** the first beat that finds the Controller only records the worker messages already there as seen, so older mail wakes nobody. Normally the next regular check covers a worker that finished meanwhile (the first hourly check is due at once); with an open "Needs <human>" item in `status.md` and no other reason, the first wake can take until the next tenth-minute check.
- **Waiting for the human:** if `status.md` lists anything under "Needs <human>" and nothing else is pending, it does not wake the Controller. Otherwise an idle Controller is woken about hourly.
- **Without a model:** it writes what the Controller is doing into the comment and status of the project's sidebar entry, and marks a finished worker's entry at once.

It only sends text into the Controller's terminal. It never starts or restarts a Controller.

**Which terminal is the Controller.** Identity is how it was made, with where it runs only as a check. (1) The handle from the receipt of the `terminal create` that `start` itself performed is recorded at that moment in `<controllerDir>/controller-terminal.txt` (handle, then the worktree it was created in); it is never taken from a lookup later. (2) Without a usable record (an installation from before this) only a terminal that carries the factory's own name for it, `<project> · Controller`, as title or pane title (or pi's `π - <controllerDir>` form) counts: Claude Code rewrites the tab title but not the pane title. (3) An unnamed agent session in the project's checkout is **never** the Controller, however alone it is: it may be a person's own session or the Front agent's, and typing the wake line into it would make it act as a Controller. The session that runs `start` (its `ORCA_TERMINAL_HANDLE`) is never a candidate. Every candidate must also pass Orca's listing: live (not orphaned), an agent session (`agentIdentity`), running in the Controller directory or the project's worktree (Orca lists a Controller's `worktreePath` as the project, so the worktree cannot tell it from anything else started there), and not named for another role (`· Front Agent`, `· Worker`, `· Integration`). A list that reports no worktree or no agent confirms nothing. `start`, `status`, `doctor` and the heartbeat take the places to look from one function (`controllerPlaces`): the checkout `start` ran in (recorded with the handle), the configured project directory and the Controller directory, so a Controller made from another checkout is found by all of them.

Results: a record that is gone, orphaned, in another worktree or named for another role is dropped. Nothing identified means no wake and the sidebar comment "Controller is not running: run `agentic-factory start`", with a note when other agent sessions run in the checkout and are not taken. An installation whose Controller's CLI rewrote the title and dropped the pane title, with no record, is in that state: run `start` once; it opens a Controller, records it, and says which other agent sessions it found in the checkout (close one if it is an earlier Controller). Several terminals that carry the name and none recorded are not told apart: no wake, a comment, and `status` reports it. A terminal that carries the name but that Orca does not show as an agent running here gets no wake either, with a comment. `start` never opens a Controller next to a named one, whether confirmed, ambiguous or unconfirmed: it says what it found and exits 1. Whenever Orca's list itself failed, nothing is known and nothing is changed.

**What is typed.** The wake line is fixed text plus at most a count the script made (`Heartbeat: 2 new worker messages. Run the next cycle …`); the pointer to `inbox.md` is fixed text. Nothing a worker, a message or a file wrote is ever typed into the Controller's terminal; the Controller reads the mail itself in step 1 of its loop. Nothing at all is typed until the Controller has written its first `status.md`, because it may still sit at its first-start dialog (the trust question), where a typed line plus Enter would take the highlighted default.

**What wakes the Controller** (the same on Codex, Claude Code and pi): the heartbeat (where the project runs one: with `runner: terminal` `wait.mjs` is the only waker, and with the heartbeat opted out the human wakes the Controller), within a minute of a worker's message while the Controller is idle. `wait.mjs` is a second path for a Controller that is mid-cycle; a finished background command does not reliably start a turn at an idle prompt (in a real Claude Code run it did not), so nothing depends on it. If the heartbeat is not scheduled, nothing wakes an idle Controller: `doctor` says so.


- **Start a worker:** `controller/start.mjs` wraps `orca orchestration worker-start --task-title "<Task> · Worker <Role>" --spec <text> --worktree new-child --name <dir> --base-branch origin/<main> --agent codex|claude|pi --model … --repo id:<repo-id> --setup run`, then names the terminal, pane and sidebar entry by task and role (see [Naming](#naming)). A worker is a child of the Controller's workspace, so Orca's own data holds the tree (`parentWorktreeId`, `childWorktreeIds`). A worker on another host than the Controller starts with `new-top-level`, because Orca refuses `new-child` across hosts.
- **Wait for events:** `wait.mjs` runs `orca orchestration check --wait --types worker_done,escalation,question` and prints the first real event. The check itself marks the delivery handled; `--ack` is only sent when an older Orca returns a `deliveryId`. The payload is read whether Orca returns it as an object (concise view) or as a JSON string (`--full`), and a malformed message is printed without it, so one bad message never ends the wait. The Controller does not poll workers itself: the heartbeat wakes it when idle, this script reaches it when it is mid-cycle.
- **Nudge a stalled worker:** `orca terminal send --terminal <handle> --text "…" --enter`. A reply to an escalation alone does not wake an idle worker; always send the text into its terminal too.
- **Read a terminal:** `orca terminal read --terminal <handle> --screen --json`; `stallwatch.mjs` classifies the screen as working, idle, at capacity or gone. It reads only this project's workers: a terminal whose worktree lies under this project's workspace directory on that host, or whose handle is in `workers.json`; another project's terminals on a shared host are left alone.
- **Run a script on the server:** `runscript.mjs` creates a terminal in the integration worktree with the script inlined (no shell quoting of long content).
- **Clean up:** `cleanup.mjs` deletes only with `--apply`. Without it (or with `--dry`, which means the same) it changes nothing except `cleanup-pending.json`: it prints what it would release and remove (worktrees, merged remote branches, wave terminals, setup terminals, and the entries git ignores in those worktrees, such as `node_modules` or `.env`, which are lost with the worktree) and ends with one line that says nothing was removed and how to do it. With `--apply` it prints the same inventory first, then does it. **Exit code 3** means it found something to remove or release but was not told to. The Controller's handbook calls `node cleanup.mjs --all --prune-remote --apply`; a project that updated its scripts but kept an edited, older `CONTROLLER.md` (update leaves it and writes the new one to `.factory/new/.factory/controller/CONTROLLER.md`) calls it without, gets exit code 3 each cycle, and cleans up nothing until the handbook is merged. `doctor` and `status` say so: they fail when the installed handbook calls cleanup without `--apply`, and when removable work has waited longer than `cleanup.pendingWarnMinutes` (default 30) without a cleanup that applied it. With `--prune-remote` it also deletes the merged `status-wave-<n>` branches of finished waves (the branch has no prefix; it stays while a wave runs or its state is unknown). Cleanup releases workers whose dispatch Orca reports `succeeded`, `failed` or `stopped` with `worker-release` (Orca closes their terminal where it owns it) and removes merged worktrees with `orca worktree rm`. It closes no worker's agent terminal itself; before removing a worktree it closes only the setup terminals Orca created for the released dispatch, and it keeps a worktree in which any other terminal is open. At most 10 releases per host and run; a dispatch Orca no longer knows keeps its worktree until its record is removed by hand. A release counts only when Orca answers `released` or `already_released`; `retained` and `release_pending` keep the record and the worktree for the next cycle. A dispatch whose terminal now belongs to another dispatch (a follow-up started with `worker-start --terminal`) counts as running. Orca keeps every worker started in a new worktree open by default (`retainedReason: user_requested`). `start.mjs` records that as `keptByDefault`, and cleanup releases such workers when they are finished, clean and pushed or merged; only the factory's own marker (`node keep.mjs <key>`) holds them. What this gives up: a keep-open that a human sets in Orca by hand on a factory worker after its start is not seen, because Orca reports it with the same reason as its default. Older records without `keptByDefault` stay held while Orca keeps them open. Settled dispatch states never change back, so they are remembered in `dispatch-settled.json` and not asked again. Orca calls are bounded: three `worker-list` pages and ten `worker-show` calls per run, 20 seconds each; anything unanswered counts as busy.

## Skills: required on every Controller and Front-agent host

The Controller and the Front agent run **outside** the project repo (`~/controller`, `~/front-agent/<project>`), so the project's `.agents/skills` are invisible to them. The Orca skills must therefore be installed **at user level** (`~/.claude/skills`, `~/.agents/skills`) on every host that runs one of them:

```bash
agentic-factory install-skills            # on your machine
# on a remote controller host (the bundle carries the skills):
mkdir -p ~/.claude/skills ~/.agents/skills && cp -R ~/controller/skills/* ~/.claude/skills/ && cp -R ~/controller/skills/* ~/.agents/skills/
```

Without `orchestration` and `orca-cli` the agents do not know how to start, watch, nudge or release workers. `agentic-factory doctor` and `server/4-verify.sh` check for them.

Two Orca skills are vendored as **discovery stubs** (`skills/orca-cli`, `skills/orchestration`). They do not contain the guide; they tell the agent to load the version-matched one from the binary it will actually run:

```
orca skills get orchestration
orca skills get orca-cli
```

That keeps the instructions in step with the installed Orca version on each host. On Linux outside an Orca-managed terminal the binary is `orca-ide`; bare `orca` there is the GNOME screen reader.

## Without Orca (experimental, unsupported)

`init --experimental-terminal-runner` sets `agents.runner: terminal`: git worktrees, plain agent processes started with the spec as their first prompt, an `events/` directory the workers write `DONE`/`ESCALATE` lines into, and log-based stall detection. It exists for experiments and has had no production mileage. The documented workflow assumes Orca.
