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
- **Rhythm:** choose day-plan/night-build, continuous or custom quiet hours in `rhythm.mode`.
- **Calibration:** leave capacity and agent calibration on `auto` to adjust limits and model tiers from measurements.
- **GitHub issues:** choose `steering.mode: github-issues`, create the labels and run `setup-matt-pocock-skills` for the shared tracker.

## 6. When something is off

| Symptom | What to check |
|---|---|
| A prerequisite or hook fails | Read the message and its suggested fix; never bypass hooks. |
| Controller is idle | Check `~/controller/status.md`, `inbox.md`, and `node capacity.mjs --verbose`. |
| Worker is idle | Check `node stallwatch.mjs` and its Orca terminal. |
| Tests flake under load | Check `~/load.log` and the gate journal; lower `capacity.calibration.startSuite`. |
| Update keeps your edited file | Merge the new version from `.factory/new/`. |

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
mkdir -p ~/.local/bin && install -m 755 ~/controller/gate ~/.local/bin/gate
(cd ~/controller && nohup bash loadlog.sh >/dev/null 2>&1 &)
PROJECT=your-project-name
mkdir -p ~/front-agent && cp -R .factory/front-agent "$HOME/front-agent/$PROJECT"
```

In a terminal in `~/controller`, run `claude "Read ~/controller/CONTROLLER.md and act as the Controller for this project."`. In the project directory start the Front agent with `claude "Read ~/front-agent/<project>/FRONT_AGENT.md and act as the Front agent."`. Use your chosen CLI in place of `claude`. For a remote Controller, follow [server setup](server-setup.md).
