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

The Controller itself runs **on the server**, in an Orca terminal, so it survives the client being closed and talks to workers locally. The Front agent on the human's machine only reads `status.md` over SSH and writes `inbox.md`.

## Naming

Every sidebar entry (worktree display name) and every terminal is named after its role or task, on every level. Automatic names such as `main`, a branch name, `Setup` or `user@host: path` must not remain.

| Level | Sidebar entry | Terminal | Example |
|---|---|---|---|
| Front agent | `<project> · Front Agent` | same | `my-app · Front Agent` |
| Controller | `<project> · Controller` | same | `my-app · Controller` |
| Worker | `<Task> · Worker <Role>` | same | `T22-S5 · Worker Developer` |
| Integration worktree | `<project> · Integration` | `<project> · Integration · Shell` | `my-app · Integration` |

**Other terminals in an entry:** `<entry name> · <Purpose>`, for example `T22-S5 · Worker Developer · Setup` or `my-app · Controller · Shell`.

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
- `controller/names.mjs` runs after every worker start and every `cleanup.mjs` cycle. It names this project's entries whose name is automatic or just the folder name: the checkout on the Controller's host, the integration worktree and the worktrees in `workers.json`.
- `agentic-factory start` names the Front agent's terminal and entry, and the Controller's terminal.
- A Controller on the human's machine shares the Front agent's checkout, so that one entry is `<project> · Front Agent`, and the Controller keeps its own terminal name.
- `start.mjs`, `wave.mjs` and `runscript.mjs` name their terminals when they create them.

**Limits of the tooling**
- An entry with no known role, such as the checkout on a worker-only host, is reported by `names.mjs` and left as it is.
- Terminals are named when they are created. Orca does not mark a terminal's name as automatic, so a terminal created by hand keeps its name until someone renames it.
- A human who names an entry exactly like its folder gets it corrected, because that looks like Orca's own name.

## How the Controller uses Orca

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
