# Keep the standard out of a project's history (preview)

`init --untracked-standard` checks in only what is the project's own, so people who work on the code another way carry none of the stack. A clone that nobody arms shows neither handbooks nor hooks.

This is a preview. It has not run on a real project or on a remote host yet, and an existing project cannot switch yet. See `F43` to `F45` in [`debt.md`](../debt.md).

## What lives where

| What | Where |
|---|---|
| Handbooks, factory rules (`AGENTS.factory.md`), skills | `.git/factory` of each clone, never in the history. Each worktree gets links through a `post-checkout` hook, listed in `.git/info/exclude`. The project's `.gitignore` stays untouched |
| Hooks and guardrails | The clone's `.git/hooks`. A hook that was already there runs first as `<hook>.own` |
| `factory.config.json`, ADRs, `ARCHITECTURE.md`, the project's own `AGENTS.md` and hooks | In the repository |
| Tickets, reviews, debt | Still in the repository, until the private companion repository exists |

## Deviating from the standard

**A tracked file at the same path is the deviation, and it wins.** `agentic-factory deviate docs/review-protocol.md` turns a link into the project's own file. Later factory versions no longer update it, and `doctor` lists it. A process decision goes into `docs/process-decisions.md`.

A skill that deviates stays excluded as a path. Stage a new file in it with `git add -f`, because `git status` does not show it; `doctor` lists such files. For a changed file, a plain `git add <file>` stages it but exits with an error, so use `git add -f` there too.

## Clones and the review gate

A fresh clone needs `agentic-factory start` once, and a wave refuses to run from a clone that has not had it.

`init` refuses husky, a `core.hooksPath` set outside the clone (global config, include), `--keep-own-hooks`, and untracked files at paths the standard uses. If a hooks path appears later, `arm.mjs`, `status`, `doctor` and every wave report it instead of running without the gate.
