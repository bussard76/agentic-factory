# Steering modes

The factory steers work in one of two modes. Roles, reviews, waves and rules are identical; only where tickets live and how workers are launched differ. `factory.config.json` → `steering.mode` and `agents.runner` select them.

## `orca-tasks` (task files plus Orca)

The mode in daily use on the originating project.

- **Tickets** are files `docs/tasks/T<n>-<slug>.md` with a `Status:` line, an `## Architecture impact` section (level, modules, boundaries), results and observable acceptance. Numbers are unique; the Front agent checks before creating one.
- **Workers** run as Orca-supervised terminals in their own worktrees. The Controller starts them with `controller/start.mjs`, waits for `worker_done`, `escalation` and `question` messages with `wait.mjs`, and nudges stuck ones through `stallwatch.mjs`.
- **Reviews and reports** are files under `docs/reviews/` and `docs/reports/`.
- **Decisions** go into the task file or a dated decisions file under `docs/reviews/`.

Strengths: everything is in git, works offline, no tracker needed. Weakness: nothing shows the frontier visually.

## `github-issues`

- **Tickets** are GitHub issues. Labels: `ready-for-agent` (buildable), `in-progress`, `needs-human`, `debt:<category>`, and the `wayfinder:*` labels for decision maps. Blocking uses GitHub's native "blocked by" relationships, so the frontier is visible in the tracker.
- **Workers** run either through Orca (`agents.runner: orca`) or as plain agent processes in git worktrees (`agents.runner: terminal`). The Controller's `steering/issues.mjs` lists ready issues, claims one by assigning the factory's account and labelling it, posts the Tester's verdict as a comment, and closes it when the wave reaches `main`.
- **Reviews** are still committed files under `docs/reviews/` (the push gate needs them in the tree); the issue gets a comment linking the file.
- **Decisions** are resolution comments on the issue, mirrored as one line into the project's decisions file.

`setup-matt-pocock-skills` configures the tracker for the vendored skills (`to-tickets`, `wayfinder`, `to-spec`) so both modes see the same tracker.

## Runner: `orca` or `terminal`

| | `orca` | `terminal` |
|---|---|---|
| worker start | `orca orchestration worker-start` in a new worktree, named by task and role | `git worktree add` plus `codex`/`claude`/`pi` started with the spec as its first prompt, under `setsid`, output to a log |
| events | Orca messages (`worker_done`, `escalation`, `question`) | the worker writes `DONE`/`ESCALATE` lines into `<controllerDir>/events/<key>.md`; `wait.mjs` tails that directory |
| stall detection | terminal screen reads | log mtime and process state |
| cleanup | `orca worktree rm` | `git worktree remove` |

`terminal` mode exists so the factory can be shared and tried without Orca. `orca` mode is the one with the most mileage.
