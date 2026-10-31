# AGENTS.md — rules for every coding agent in this repo

Read first: `ARCHITECTURE.md` (if present), your task, and `docs/coordinator.md` if you coordinate.

## Way of working

- **One task, its scope only.** Do exactly the task you were given. Out-of-scope findings go into your final report; do not fix them.
- **TDD.** For every behaviour: write a failing test first, make it pass, then refactor. Test through public entry points, not internals.
- **Done means:** `{{VERIFY}}` is green, the task's acceptance checks pass, and your report lists files changed, tests added and any assumptions.
- **Never weaken tests.** Do not delete, skip or loosen existing tests. If a test is wrong, escalate.
- **Small commits** on your branch with clear messages. Push your branch; never push to `{{MAIN}}`.

## Review gate

- No code reaches `{{MAIN}}` without a passing independent review under `docs/review-protocol.md`. The reviewer is never the builder.
- Reviewers work read-only and write only their findings file, committed separately under `docs/reviews/`.
- Builders fix findings. If a finding appears incorrect, explain why to the coordinator.
- `--no-verify` is forbidden.

## Coordinator

Whoever coordinates work (starts workers, merges, or talks to {{HUMAN}}) follows `docs/coordinator.md`.

## Change levels

Every task records `## Architecture impact` (level, modules and boundaries; level 3 needs an ADR). A fresh Worker Architect checks every spec before the build and conformance after level 2/3 builds; see `docs/architect-protocol.md`.

| Level | Examples | What you do |
|---|---|---|
| 1 | anything inside one module that keeps its public API | just do it |
| 2 | new or changed public export, new dependency, new route | checked by the Architect; ask the coordinator with a one-paragraph rationale; continue only after the answer |
| 3 | new module, changed responsibilities or allowed imports, different data flow, new technology, contract or protocol change | escalate; the coordinator gets {{HUMAN}}'s decision; do not implement until the accepted ADR says `Decided by: {{HUMAN}}` |

**Protected files** (the commit hook blocks changes unless the message references `ADR-NNNN` of an accepted ADR): `ARCHITECTURE.md`, `AGENTS.md`, `docs/adr/**`, `.githooks/**`, `tools/factory-guardrails.mjs`, root `package.json` dependency lists.

## Data rule

No real data in code, fixtures, tests or logs. Demo data is invented. Never read {{HUMAN}}'s real data or real external services from a worker. `.env` is never committed. Never print secrets.

## No outward effects

Agents and their tests change nothing outside the repository and the demo or test environment: no production systems, no real accounts, no real data, no sending, deploying or deleting. Whether and how the product acts on external systems is a product decision recorded in this project's docs.

## Language

Code, identifiers, comments, commit messages: English. UI texts and demo data: {{UI_LANGUAGE}}.

## Paid APIs

Never call real model APIs from tests, scripts or while developing. Use a fake OpenAI-compatible server and scripted implementations.

## Skills

- Developers follow `ponytail` while implementing and use `tdd` for every behaviour change and `diagnosing-bugs` for every bug or review blocker.
- Testers run `ponytail-review` on the full task diff and merge its findings into the review file with the protocol's severities. A Ponytail **Must fix** maps to at least `major`.
- Skills never override this file, the architecture docs or the data and safety rules. On conflict, repository rules win.
- Retro findings change repo files only (`docs/coordinator.md`, `docs/review-protocol.md`, `CODING_STANDARDS.md`, or `AGENTS.md` through an accepted ADR). Never edit global or user-level agent configuration.
