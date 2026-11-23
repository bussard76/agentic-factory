# Getting started: from zero to the first wave

Start one agent in your project. It guides you through setup and the first feature; a remote server is optional.

## 0. What you need

- [Orca](https://github.com/stablyai/orca), installed and running.
- Node 22+ and git configured with your name and email (`git config --global user.name` and `user.email`). Your project must be a git repository; `git init` is enough.
- One logged-in agent CLI: Claude Code, Codex or Pi.
- Optional: `gh` for GitHub issues, Figma or Pencil for design.
- **Windows:** the factory's scripts need a Unix shell. Install WSL 2 (`wsl --install -d Ubuntu` in an admin PowerShell), run Orca's terminal on that distribution, install Node 22, git and the agent CLI inside WSL, and keep the project in the WSL file system (`~/…`, not `/mnt/c/…`). Everything below is then the same. Native Windows shells are not supported.

**The short way: one prompt** instead of sections 1 and 2. Open your project in any agent (in Orca if you can) and drop in:

```text
Set up the agentic factory for this project. If ~/agentic-factory does not exist, clone https://github.com/bussard76/agentic-factory.git into it; otherwise update it with git -C ~/agentic-factory pull --ff-only. Then read ~/agentic-factory/START.md and follow it: check the prerequisites, move into Orca if needed, and guide me through the onboarding.
```

The agent checks the prerequisites above and names what is missing; started outside Orca, it moves itself into an Orca terminal. On GitLab, put the project's clone URL into the prompt.

## 1. Get the factory

```bash
# reading this on GitLab? use the project's clone URL from Code → Clone
git clone https://github.com/bussard76/agentic-factory ~/agentic-factory
```

## 2. Start the Front agent in your project, in Orca

```bash
cd ~/path/to/your-project
# a new project instead: mkdir my-app && cd my-app && git init -b main && git commit --allow-empty -m "Initial commit"

ORCA="${ORCA_CLI_COMMAND:-orca}"   # on Linux outside Orca's own terminals: ORCA=orca-ide
$ORCA repo add --path "$PWD"
$ORCA agent launch --agent claude --worktree "path:$PWD" --surface terminal --focus \
  --prompt "Read ~/agentic-factory/START.md and set up this project."
```

The agent's tab opens in Orca under your project; talk to it there. Adding a project that Orca already knows does no harm. In the Orca window the same works by hand: add the project, open a terminal in it, run `claude "Read ~/agentic-factory/START.md and set up this project."`. Use `codex` or `pi` instead of `claude` if that is your logged-in CLI. The Front agent checks prerequisites, asks a few [onboarding questions](onboarding.md) one at a time, writes and pushes the adoption commit, starts the machine and checks it. It tells you where the project stands and what comes next. From then on, talk to this agent; at each session start it checks the status and follows the current phase.

Start every later session with the same sentence; the agent then reads `~/front-agent/<project>/FRONT_AGENT.md`.

## 3. The first feature, outside-in

Tell the Front agent what you want. It leads you through the surface (a design or clickable fake), the data going in and out, and the logic in words and a diagram. Once you agree, it writes a ready ticket and tells the Controller. Keep the first feature small: one visible behaviour and one or two acceptance sentences.

The Controller arranges the architecture review, build, independent test and integration wave. The [branch and worktree mechanics](workflow.md#branches-and-worktrees-the-mechanics-of-one-ticket) explain the details.

## 4. Accept on the preview

Try the integrated behaviour on the preview with the Front agent. If enabled, the preview follows `main`; its updater can run via the provided launchd template or cron. Tell the Front agent what you find, and it turns findings into tickets.

## 5. Later: remote server, more hosts and rhythm

- **Remote server and hosts:** follow [server setup](server-setup.md), configure `hosts.workers` and `hosts.controller.host`, run `update` and `start`; install the user-level skills on each Controller or Front agent host.
- **An Orca bot as Front agent:** `init` asks who the Front agent is (`hosts.frontAgent.kind`: a terminal session, the default, or an Orca bot) and, for a bot, its name. Create the bot in Orca first, give its `SOUL.md` the line "For each agentic-factory project, follow ~/front-agent/<project>/FRONT_BOT.md", then run `init`, `start` and `doctor`. See [Orca](orca.md), "Front agent as an Orca bot".
- **Controller directory:** `init` asks for it (`hosts.controller.controllerDir`) and proposes `~/controller-<project>` where `~/controller` already holds another project's Controller. Use an absolute path when your shell's `HOME` is not the one Orca's terminals use.
- **Rhythm:** choose day-plan/night-build, continuous or custom quiet hours in `rhythm.mode`.
- **Calibration:** leave capacity and agent calibration on `auto` to adjust limits and model tiers from measurements.
- **GitHub issues:** choose `steering.mode: github-issues`, create the labels and run `setup-matt-pocock-skills` for the shared tracker.

## 6. When something is off

| Symptom | What to check |
|---|---|
| A prerequisite or hook fails | Read the message and its suggested fix; never bypass hooks. |
| Controller is idle | Check `~/controller/status.md`, `inbox.md`, and `node capacity.mjs --verbose`. |
| Worker is idle | Check `node stallwatch.mjs` and its Orca terminal. |
| Tests flake under load | Check `~/load.log` (the lines ending in `project=<your project>`) and the gate journal; lower `capacity.calibration.startSuite`. |
| Update keeps your edited file | Merge the new version from `.factory/new/`. |

## What `start` writes on your machine

Inside the project, `init` and `update` write what the table in the appendix lists. `start` (and `install-skills`, `update`, the bot setup) also write the files below, **outside** the project. Nothing else is written outside it, apart from the queue directories of the gate (`$TMPDIR/<project>-gate-<pool>`) and the wave scripts and logs under `/tmp` (both named by the project), and what Orca and your agent (for example Claude Code's own `~/.claude.json`) keep for themselves. `~` is the home of the user who runs Orca: see "A separate HOME does not isolate a second factory" below. On a remote Controller host the same list applies on that host.

| Where | What | Two projects on one host | Remove it |
|---|---|---|---|
| `~/.claude/skills/<name>`, `~/.agents/skills/<name>` | The user-level skills the Controller and the Front agent need (`orchestration`, `orca-cli`, `retro`, …; `install-skills --all` adds every vendored skill) | Shared on purpose. A skill that exists is kept, never overwritten (`--force` replaces it), so a second project changes nothing the first one installed. | Delete the skill folders you no longer want; other projects and agents on the machine may use them. |
| `~/front-agent/<project>/` | The Front agent bundle, the status watch's state and log | One folder per project name | Delete the folder (after removing the schedule below). |
| `~/front-agent/.bots/<bot>-<id>/` | With an Orca bot as Front agent: the bot watch (`botwatch.sh`, its state, `projects.json`, `wake.md`) | One folder per bot, shared by every project that names that bot (one automation wakes the bot for all of them); each project is an entry in `projects.json`, which `start` merges (a second project never drops the first). `botwatch.mjs`, `hosts.mjs` and `botwatch.sh` come from whichever project ran `start` last, written whole (a temporary file and a rename), so Orca never runs half a file. | Delete the automation `agentic-factory watch · <bot>` in Orca, then the folder. |
| `<hosts.controller.controllerDir>` (default `~/controller`) | The Controller bundle: scripts, `CONTROLLER.md`, its state, `heartbeat.log`. Every file is written whole (a temporary file in the same directory, then a rename), so a script that starts at that moment never reads an empty or half file; the same holds for `~/front-agent/<project>/`. | One directory per project. `start` refuses a directory that belongs to another project and tells you to set `controllerDir`. | Stop the Controller session and delete the directory. |
| `~/.local/bin/gate`, `~/.local/bin/gate.mjs` | **Nothing since this version.** The gate is `<controllerDir>/gate` (with its `gate.mjs`), copied with the Controller bundle, and `gate`, `gate.mjs` and `factory.config.json` also to the same directory on every other remote worker host (gates run there too: its workers, its waves, and `capacity.mjs` writes its slots there); `doctor` checks it per host. Everything that calls it uses that absolute path from the project's own configuration: the worker specs, `wave.mjs`, `integ-wave.sh` and `CONTROLLER.md`. It reads its project, queue, slots and journal from its own directory, never from a config in the worktree it judges, and refuses a call from another project's worktree. | Not shared, so nothing to collide. A project started with an older factory wrote the shared `~/.local/bin/gate` and `gate.mjs`; those files stay as they are for older projects that still use them. An older `start` may rewrite them at any time, which cannot change this project: it never reads them. `doctor` and `status` say when such a leftover is there and not used by this project. | Delete both files once no older project on the host uses them. |
| `~/load.log` | One line per minute from `loadlog.sh`: load, memory, pressure, agent and test process counts, this project's gate waiters, and `project=<name>` at the end | Shared. Every project's logger appends to the same file; each line carries its project, and `start` passes the name (a logger of this directory that was started before without it is stopped and replaced; lines it wrote have no `project=`). The machine values are the same in each line of a minute; `gatewaiters` is the project's own. Read the lines of your project: `grep ' project=<name>$' ~/load.log`. | Stop the logger (`pkill -f '<controllerDir>/loadlog.sh'`) and delete the file. |
| Crontab (or a launchd agent in `~/Library/LaunchAgents/de.agentic-factory.statuswatch.<project>.<id>.plist` on macOS) | The status watch (every 5 minutes, terminal Front agent) and the heartbeat of the Controller | One entry per project and directory, each marked with the project's name; `start` adds only its own and leaves the rest of the crontab alone | `crontab -e` and delete the lines marked `# agentic-factory … : <project>`; on macOS `launchctl bootout gui/$(id -u)/<label>` and delete the plist. |
| `~/.lean-ctx/config.toml` | Only when lean-ctx is installed: `allow_paths` gets the project, its checkout on the Controller host and its worker workspaces, so the Controller may read them | Shared file. Only missing paths are added (each written as a correctly escaped TOML string, so any path works, also one with `]` or `"`); what is there, comments inside the list included, stays byte for byte. Nothing is written when all are there. The write is atomic (a temporary file and a rename; the file keeps its mode, a symlink stays one) and is computed again when the file changed meanwhile. A file the reader does not fully understand (a list that is not plain strings, the key twice, a string it cannot decode) is left alone, with a message that names the paths to add by hand. | Delete the project's paths from `allow_paths`. |
| `<controllerDir>/.claude/settings.local.json` | Only with pi's `context-mode` package: `Read(<path>/**)` permissions for the same paths | Inside the project's own Controller directory | Delete the entries or the file. |
| Orca | A repo entry (made by `init`), the Controller terminal and worker terminals and worktrees (`~/orca/workspaces/<project>/`), and with a bot the automation above | Named by project | `cleanup.mjs` removes finished worktrees; remove the repo entry in Orca's UI (the CLI can only hide it). |

**Never written by `start`:** the project's `.env`, other projects' Controllers, worktrees, workers or bots, and the preview's launchd agent (you load `preview.plist.template` yourself).

### A separate HOME does not isolate a second factory

Terminals that Orca starts (the Controller, the workers, the gate, the agent CLIs) run with the **real home of the user who runs Orca**, whatever `HOME` you gave the `agentic-factory` command. This is how Orca behaves, not something the factory can change. So a second `HOME` only moves what `start` itself writes (skills, `~/front-agent`, the load log); everything the Controller and the workers run later still reads and writes the real home, and `~` in a path expands there.

Separate two factories on one machine with names and **absolute paths** instead: give each project its own `hosts.controller.controllerDir` (`~/controller-<project>` is fine when the CLI and Orca run with the same home; when the CLI runs under another `HOME` than Orca, write it absolute, for example `/home/you/controller-<project>`, because Orca's terminals expand `~` to the real home), and keep workspaces and project checkouts apart by project name. Everything the factory shares on a machine is in the table above and is safe to share: the skills, the tagged load log and the `allow_paths` list.

## Appendix: What the agent does for you (and how to do it by hand)

Run these in the project directory, substituting the factory path if needed:

```bash
alias agentic-factory='node ~/agentic-factory/bin/agentic-factory.mjs'
agentic-factory init                         # interactive onboarding
agentic-factory init --print-questions       # JSON, no writes
agentic-factory init --print-questions --answers /path/to/answers.json
agentic-factory init --answers /path/to/answers.json
agentic-factory install-skills               # user-level skills on this host
agentic-factory start                        # bundles, gate, load log, Controller session
agentic-factory status --json                # phase and next step
agentic-factory doctor                       # check setup
agentic-factory update                       # refresh; preserves local edits
```

Answers are an object keyed by question ID; keep the file outside the repository. `init` can also be run interactively on its own. If there is no remote, it creates a local bare `origin` under `~/.factory-remotes/<project>-<hash>.git`; replace it later with `git remote set-url origin <url>`. It commits and pushes the adoption files as `Adopt agentic-factory (ADR-0001)` (using the next free ADR number when needed).

| Files written by `init` | Purpose |
|---|---|
| `factory.config.json` | Project settings, no secrets |
| `AGENTS.md`, `CODING_STANDARDS.md` | Agent rules and review standards |
| `docs/coordinator.md`, `docs/dev-workflow.md`, `docs/review-protocol.md`, `docs/architect-protocol.md`, `docs/debt.md` | Project handbooks |
| `docs/adr/0001-adopt-agentic-factory.md`, `docs/tasks/T00-template.md` | Adoption ADR and ticket template |
| `.githooks/` (or existing hooks directory), `tools/factory-guardrails.mjs` | Activated guardrails; existing hooks run first as `<hook>.own` |
| `.agents/skills/` and `.claude/skills` link | Vendored skills |
| `.factory/controller/`, `.factory/front-agent/`, `.factory/server/` | Ignored bundles regenerated by `update`; `.factory/manifest.json` is committed |

To start the sessions manually after `init`, install skills, copy the bundles and start the gate and load log:

```bash
agentic-factory install-skills
mkdir -p ~/controller && cp -R .factory/controller/. ~/controller/
# the gate is ~/controller/gate (copied with the bundle); nothing goes to ~/.local/bin
(cd ~/controller && FACTORY_PROJECT=your-project-name nohup bash loadlog.sh >/dev/null 2>&1 &)
PROJECT=your-project-name
mkdir -p ~/front-agent && cp -R .factory/front-agent "$HOME/front-agent/$PROJECT"
```

In a terminal in `~/controller`, run `claude "Read ~/controller/CONTROLLER.md and act as the Controller for this project."`. In the project directory start the Front agent with `claude "Read ~/front-agent/<project>/FRONT_AGENT.md and act as the Front agent."`. Use your chosen CLI in place of `claude`. For a remote Controller, follow [server setup](server-setup.md).
