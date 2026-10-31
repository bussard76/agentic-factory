# Onboarding: what `init` asks and why

`npx agentic-factory init` is a guided onboarding for a new project. It asks one question at a time, offers a recommended answer first, writes `factory.config.json`, copies the handbooks, templates, hooks and skills, commits them as `Adopt agentic-factory (ADR-0001)`, pushes, and prints the steps only the human can do. Running it again (or `update`) never overwrites a file you changed: the new version lands in `.factory/new/` for you to merge.

| # | Question | Why it matters | Default |
|---|---|---|---|
| 1 | **Project name and repository** | names branches, worktrees, lock files and the preview; the Controller clones by this. Without a remote, `init` creates a local bare one as `origin` | from `git remote` |
| 2 | **Who is the human, and in which language do they want to read?** | the handbooks address the human by name; `docs/dev-workflow.md` is written in the human's language, agent files stay English | user name; language from `LANG` (`de` or `en`) |
| 3 | **Rhythm:** day plan / night build, continuous, or custom quiet hours | when the Controller may start new work | day plan / night build |
| 4 | **Steering mode:** GitHub issues or task files | where tickets live and how the frontier is shown; see [steering-modes.md](steering-modes.md) | GitHub issues if a GitHub remote and `gh` exist, else task files |
| 5 | **Orca check** (no question) | Orca is the prerequisite: `init` stops if the CLI is missing, reports whether the service runs, and registers the repo with the local Orca (fills `orcaRepoId`). `--experimental-terminal-runner` bypasses this for experiments | – |
| 6 | **Default agent and models:** Codex, Claude Code or Pi; the three model tiers as the CLI names them | models by complexity, the escalation ladder; the names are starting values, calibrated later | the installed CLI; its three tiers |
| 7 | **Where workers run:** only this machine, this machine plus one remote host, or only a remote host (name, ssh alias, ssh config) | a remote server is an option, not a must; more hosts can be added in the config later | only this machine |
| 8 | **Where the Controller runs** | the Front agent reads `status.md` there; a remote Controller survives this machine sleeping | the last worker host |
| 9 | **Calibration:** capacity caps and model tiers automatic or manual | the limits are starting values; auto raises and lowers them from measurements | auto / auto |
| 10 | **Commands:** install, typecheck, lint, unit, verify, e2e | the test stages, the gate and the wave call exactly these; `-` clears one | read from `package.json` scripts |
| 11 | **Preview on this machine:** enabled, port, start command | the human accepts on a local build that follows `main` | enabled, 8180 |
| 12 | **Review rounds** before a working feature is integrated | back pressure without endless loops | 2 |
| 13 | **Design tool:** Figma MCP, Pencil, none | stage 1 of outside-in and the export convention `design/<feature>/` | Figma if its MCP endpoint answers locally |
| 14 | **Hard rules to confirm** (printed as one list): no real data or secrets in the repo, no outward effects from the factory, workers never push to `main`, `--no-verify` forbidden, tests on demo data only, no real model calls in tests | one confirmation for the list; they end up in `AGENTS.md` and `docs/coordinator.md` | confirmed |
| 15 | **Install the user-level skills on this machine now?** | the Front agent (and a local Controller) run outside the repo and need `orchestration`, `orca-cli`, `retro`, `writing-for-agents` and the coordination skills in `~/.claude/skills` / `~/.agents/skills` | yes |

After the answers, `init`:

1. writes `factory.config.json`
2. copies `templates/` into the repo, filling placeholders (`AGENTS.md`, `CODING_STANDARDS.md`, `docs/coordinator.md`, `docs/dev-workflow.md`, `docs/review-protocol.md`, `docs/architect-protocol.md`, `docs/debt.md`, `docs/adr/`, `docs/tasks/`, `design/`, `.githooks/`, `tools/factory-guardrails.mjs`)
3. copies `skills/` into `.agents/skills/` and links `.claude/skills` to it
4. sets `core.hooksPath=.githooks`
5. writes the bundles `.factory/controller/` (`CONTROLLER.md` filled in, scripts, templates, user-level skills), `.factory/front-agent/` and `.factory/server/`, ignored by git and ready to copy to their hosts
6. prints the human's checklist: server setup, logins (GitHub, agent CLIs, Tailscale), Orca pairing, loading the preview service, starting the Controller with its start order

`doctor` checks the same things later: hooks installed, config valid, server reachable, tools present, `status.md` fresh.
