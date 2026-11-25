# Steering modes

The factory steers work in one of two modes. Roles, reviews, waves and rules are identical; only where tickets live and how workers are launched differ. `factory.config.json` → `steering.mode` and `agents.runner` select them.

## `orca-tasks` (task files plus Orca)

The mode in daily use on the originating project.

- **Tickets** are files `docs/tasks/T<n>-<slug>.md` with a `Status:` line, an `## Architecture impact` section (level, modules, boundaries), results and observable acceptance. Numbers are unique; the Front agent checks before creating one. A task counts as ready only when every task number in its `Depends on:` line is `integrated` and, with `steering.readyCheck: enforce`, it is ready to code (below). States: `draft` (not assessed yet), `needs-info` (assessed, waits for the human's answer), `ready` (assessed, ready to code), `building`, `review`, `passed`, `integrated`, `paused`.
- **Workers** run as Orca-supervised terminals in their own worktrees. The Controller starts them with `controller/start.mjs`, waits for `worker_done`, `escalation` and `question` messages with `wait.mjs`, and nudges stuck ones through `stallwatch.mjs`.
- **Reviews and reports** are files under `docs/reviews/` and `docs/reports/`.
- **Decisions** go into the task file or a dated decisions file under `docs/reviews/`.

Strengths: everything is in git, works offline, no tracker needed. Weakness: nothing shows the frontier visually.

## `github-issues`

- **Tickets** are GitHub issues. Labels: `ready-for-agent` (buildable), `in-progress`, `needs-human`, `debt:<category>`, and the `wayfinder:*` labels for decision maps. Blocking uses GitHub's native "blocked by" relationships, so the frontier is visible in the tracker. An issue with an open blocker does not count as ready. `needs-info` is the label of an assessed issue that waits for the human's answer; with `steering.readyCheck: enforce` an issue without a passing assessment is neither listed nor claimed. A server without this field, such as an older GitHub Enterprise, makes the ready list fail instead of handing out blocked tickets.
- **Workers** run either through Orca (`agents.runner: orca`) or as plain agent processes in git worktrees (`agents.runner: terminal`). The Controller's `steering/issues.mjs` lists ready issues, claims one by assigning the factory's account and labelling it, posts the Tester's verdict as a comment, and closes it when the wave reaches `main`.
- **Reviews** are still committed files under `docs/reviews/` (the push gate needs them in the tree); the issue gets a comment linking the file.
- **Decisions** are resolution comments on the issue, mirrored as one line into the project's decisions file.

`setup-matt-pocock-skills` configures the tracker for the vendored skills (`to-tickets`, `wayfinder`, `to-spec`) so both modes see the same tracker.

## Ready to code: the same check in both modes

`steering.readyCheck` (`enforce` in a new project, `warn` when the key is missing, so `update` never stops an existing project) decides what the Controller does with a ticket that is not ready to code: with `enforce` it is left out of the ready list, `issues.mjs claim` and `tasks.mjs set <T> building` refuse it, and `mkspec.mjs dev` and `specreview` refuse the first spec for a ticket file; with `warn` each of them prints the message and carries on. Ready to code is, by form only: `Assessed: <ready outcome>, <date>`, a goal (`Goal`, in an issue also `What to build`), acceptance criteria as a list (`Observable acceptance` or `Acceptance criteria`), the limits (`Out of scope`), the level (`Level: 1|2|3`), and no unanswered `(blocking)` item under `Open questions`. A ticket whose Status is `building` or later, an issue labelled `in-progress`, and a spec that was already made (a restarted worker) are never stopped. Where a ticket comes from an outside tracker the factory has no connection to, the Front agent first brings it into this form. The Front agent's step is described in [workflow.md](workflow.md#sharpen-the-ticket); the check sees form, not quality.

## Runner: `orca` or `terminal`

| | `orca` | `terminal` |
|---|---|---|
| worker start | `orca orchestration worker-start` in a new worktree, named by task and role | `git worktree add` plus `codex`/`claude`/`pi` started with the spec as its first prompt, under `setsid`, output to a log |
| events | Orca messages (`worker_done`, `escalation`, `question`) | the worker writes `DONE`/`ESCALATE` lines into `<controllerDir>/events/<key>.md`; `wait.mjs` tails that directory |
| stall detection | terminal screen reads | log mtime and process state |
| cleanup | `orca worktree rm` | `git worktree remove` |

Orca is the prerequisite and the only supported runner. `terminal` mode exists behind `init --experimental-terminal-runner` for experiments and has no production mileage.
