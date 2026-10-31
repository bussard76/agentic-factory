# Onboarding: what `init` asks and why

`npx agentic-factory init` is a guided onboarding for a new project. It asks one question at a time, offers a recommended answer first, writes `factory.config.json`, copies the handbooks, templates, hooks and skills, and prints the steps only the human can do. Running it again on an existing project shows diffs and asks before overwriting anything.

| # | Question | Why it matters | Default |
|---|---|---|---|
| 1 | **Project name and repository** | names branches, worktrees, lock files and the preview; the Controller clones by this | from `git remote` |
| 2 | **Who is the human, and in which language do they want to read?** | the handbooks address the human by name; `docs/dev-workflow.md` is written in the human's language, agent files stay English | `de` or `en` |
| 3 | **Steering mode:** GitHub issues or task files with Orca | where tickets live and how the frontier is shown; see [steering-modes.md](steering-modes.md) | GitHub issues if a GitHub remote exists, else task files |
| 4 | **Runner:** Orca or plain terminals | how workers are launched and observed | Orca if the `orca` CLI is installed, else terminal |
| 5 | **Default agent and models:** Codex, Claude Code or Pi; the three model tiers; the fallback agent and quota threshold | models by complexity, the escalation ladder, the quota fallback | Codex with the three tiers; fallback Claude at 10 % |
| 6 | **Controller host:** SSH alias, controller directory, projects and workspaces directories, Orca repo id and environment | the Front agent reads `status.md` there; the Controller's scripts need the paths | `workhorse`, `~/controller`, `~/projects`, `~/orca/workspaces` |
| 7 | **Capacity:** max suite workers, max read-only workers, gate slots, pressure thresholds, available memory minimum | the measured-capacity rule needs starting values; they are tuned by the audits | 8 / 6 / 3+2 / 20 % CPU, 5 % memory / 8 GB |
| 8 | **Commands:** install, typecheck, lint, unit, verify, e2e, release | the test stages, the gate and the wave call exactly these | read from `package.json` scripts where present |
| 9 | **Preview on the human's machine:** enabled, port, start command, env file | the human accepts on a local build that follows `main` | enabled, 8180 |
| 10 | **Review rules:** functional-only, max rounds, wave triggers | back pressure without blocking on non-functional findings | functional-only, 2 rounds, wave at 2 passed tasks or 60 minutes |
| 11 | **Hard rules to confirm:** no real data in the repo, no secrets, no outward effects without the human's click, `--no-verify` forbidden, workers never push to `main` | they are printed and the human confirms each; they end up in `AGENTS.md` and `docs/coordinator.md` | all confirmed |
| 12 | **Design tool:** Figma MCP, Pencil, none | stage 1 of outside-in and the export convention `design/<feature>/` | Figma if its MCP endpoint answers locally |

After the answers, `init`:

1. writes `factory.config.json`
2. copies `templates/` into the repo, filling placeholders (`AGENTS.md`, `CODING_STANDARDS.md`, `docs/coordinator.md`, `docs/dev-workflow.md`, `docs/review-protocol.md`, `docs/architect-protocol.md`, `docs/debt.md`, `docs/adr/`, `docs/tasks/`, `design/`, `.githooks/`, `tools/factory-guardrails.mjs`)
3. copies `skills/` into `.agents/skills/` and links `.claude/skills` to it
4. sets `core.hooksPath=.githooks`
5. writes a `controller/` bundle (`CONTROLLER.md` filled in, scripts, templates) ready to copy to the server, and `front-agent/` for the human's machine
6. prints the human's checklist: server setup, logins (GitHub, agent CLIs, Tailscale), Orca pairing, loading the preview service, starting the Controller with its start order

`doctor` checks the same things later: hooks installed, config valid, server reachable, tools present, `status.md` fresh.
