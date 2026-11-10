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

An alternative to the Front agent on the human's machine. **Status: piloted in the first project, not yet supported by `agentic-factory start`** (see "Not covered" below). Decided by the project owner of that project, 2026-11-10.

**Why.** With the Front agent on the human's machine and the Controller on the server, the two live in two Orcas and exchange work through files and a nudging script. In the first project this showed as the human noticing that the two were out of step:
- an order was swallowed by the inbox archival and overlooked;
- the heartbeat log had 686 "busy, not woken" against 854 "woke": an order waits until the Controller's turn ends and has no queue of its own;
- nothing woke the Front agent; it polled every two to three minutes, and a watcher that expired went unnoticed.

Orca's own messages are event driven: `orca orchestration send` queues a message and wakes the recipient at the end of its turn (measured 18 s, Controller idle). That works only inside **one** Orca. Measured across two Orcas (Orca 1.4.246 on the server, 1.4.255 on the client): a message from the client to a server terminal arrives; the server cannot answer to a client terminal (`terminal_not_found`); the client cannot read a server mailbox (`consumer_fenced`); creating a Run needs a terminal on that server (`stable_pane_required`). So both agents have to be in the same Orca.

**Setup.**
- The Front agent runs in an Orca terminal on the server, in its own worktree, and starts from a handover file (`front-agent/FRONT_AGENT.md` rendered for the project, plus the state). The human reaches it through the Orca client, where the server is a saved environment. Start it with `orca worktree create --environment <env> --repo id:<repoId> --name <project>-front --no-parent --agent <agent> --surface terminal --prompt "…"`.
- **Tree, collapsible in the client:** Front agent (root) → Controller → Integration and all workers. Re-parent with `orca worktree set --worktree <selector> --parent-worktree <selector>`. Workers the Front agent starts hang under it. Never start factory work with `--no-parent`, it becomes a second root. Naming rules above still apply.
- **Orders and answers:** `orca orchestration send --to <terminal handle> --subject … --body …` in both directions. Nobody polls and nobody runs watch scripts on Orca mail: a plain `check` takes the mail away from Orca's wake.
- **Events from the Controller:** `front-events.log` (see [roles.md](roles.md#interfaces-between-front-agent-and-controller)), written when the event happens, plus a `send` to the Front agent's terminal. `inbox.md` and `status.md` stay as fallback and record.

**Work that only runs on the human's machine** (the native app and its packaging, the preview there, native checks, design tools, files that only exist there) goes to a **client worker**: the Front agent appends `CLIENT-TASK <date> <what>` to a `client-tasks.log` next to its handover file; a session on the human's machine waits for new lines, does the work and answers with `orca orchestration send` to the Front agent (client to server works). The server is **not** paired to the client: that would give the server control over the human's machine, and in a company that needs the IT department's consent. Consequence, accepted: client tasks wait while the machine is off.

**Not covered yet.** `agentic-factory start`, `statuswatch.mjs` and `doctor` still assume the Front agent on the human's machine (`hosts.frontAgent`). A `hosts.frontAgent.location: server` setting, the worktree creation and the re-parenting in `start`, and a check of the tree in `doctor` are follow-up work. The Front agent has no direct access to files and design tools that exist only on the human's machine; those stages go through the client worker or the human. The Front agent starts from its handover file, not from the earlier session's context.

## Status watch

`agentic-factory start` schedules `statuswatch.mjs` on the Front agent's machine every 5 minutes, through launchd on macOS and cron elsewhere, outside any session, so it works with whichever agent is in front. It sends alerts into the Front agent's terminal through Orca when that is idle; until then they wait, and the sidebar shows them. That terminal is an agent in the project's own checkout, preferably one named `<project> · Front Agent`.

`status` and `doctor` say when it stopped or cannot reach the terminal, and open questions stay visible either way. Set `hosts.frontAgent.statusWatch` to `false` where nobody works in front. Under WSL, check that the cron service runs.

## Heartbeat

`controller/heartbeat.mjs` wakes the Controller from outside, so noticing finished work does not depend on the Controller itself. `agentic-factory start` adds one cron line per Controller directory on the Controller's host and leaves the rest of the crontab alone. Set `hosts.controller.heartbeat` to `false` to opt out.

- **Every minute:** a new worker message, a finished wave or an inbox entry wakes the Controller. At each tenth minute it also checks workers and ready tickets, and an unreadable source counts as work.
- **Busy Controller:** a timeout on "idle" counts as busy. The signal stays pending until a wake succeeded, and every attempt goes to `heartbeat.log`. After 5 minutes an inbox entry reaches the running session as a one-line pointer, once.
- **Waiting for the human:** if `status.md` lists anything under "Needs <human>" and nothing else is pending, it does not wake the Controller. Otherwise an idle Controller is woken about hourly.
- **Without a model:** it writes what the Controller is doing into the comment and status of the project's sidebar entry, and marks a finished worker's entry at once.

It only sends text into the terminal titled `<project> · Controller`. It never starts or restarts a Controller. Without that terminal it says so in the sidebar and in the log.


- **Start a worker:** `controller/start.mjs` wraps `orca orchestration worker-start --task-title "<Task> · Worker <Role>" --spec <text> --worktree new-child --name <dir> --base-branch origin/<main> --agent codex|claude|pi --model … --repo id:<repo-id> --setup run`, then names the terminal, pane and sidebar entry by task and role (see [Naming](#naming)). A worker is a child of the Controller's workspace, so Orca's own data holds the tree (`parentWorktreeId`, `childWorktreeIds`). A worker on another host than the Controller starts with `new-top-level`, because Orca refuses `new-child` across hosts.
- **Wait for events:** `wait.mjs` runs `orca orchestration check --wait --types worker_done,escalation,question` and acknowledges each delivery with `--ack`.
- **Nudge a stalled worker:** `orca terminal send --terminal <handle> --text "…" --enter`. A reply to an escalation alone does not wake an idle worker; always send the text into its terminal too.
- **Read a terminal:** `orca terminal read --terminal <handle> --screen --json`; `stallwatch.mjs` classifies the screen as working, idle, at capacity or gone.
- **Run a script on the server:** `runscript.mjs` creates a terminal in the integration worktree with the script inlined (no shell quoting of long content).
- **Clean up:** `cleanup.mjs` closes idle terminals of finished worktrees and removes them with `orca worktree rm --force`; dispatches are released with `worker-release` or `worker-abandon`.

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
