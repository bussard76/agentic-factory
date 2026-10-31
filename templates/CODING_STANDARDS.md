# Coding standards

Read during **review**, not during implementation. The reviewer enforces these; the implementer focuses on the task. Mechanical rules belong in linters and hooks, not here; this file holds the judgement calls.

## Judgement calls the reviewer checks

- **Matches the surrounding code:** naming, comment density, idiom and file layout follow the module being changed, not the agent's habits.
- **No duplicated logic** where a helper already exists in the module or its package.
- **Error handling on every I/O path**, with the user-facing message in the UI language and no raw errors or JSON shown to users.
- **No dead code**, no commented-out blocks, no speculative abstractions ("we might need this later").
- **Public entry points** are the test seams. A test that reaches into internals is a finding.
- **Would the test fail if the feature were removed?** Spot-check at least two key tests by reasoning about this.
- **Untrusted content is escaped** wherever it is rendered or interpolated.
- **Secrets** never appear in logs, responses, fixtures, screenshots or the repo.
- **Dependencies** are justified, pinned and listed in the task; a new one is a level-2 change.

## Debt candidates, not findings

Under the functional-only review rule these are recorded as debt with a category and never fail a review: missing or weak tests, coverage gaps, edge cases, security hardening beyond the threat model's blockers, load behaviour, style. Each gets a one-line proposal.

## Adding to this file

Only through a retro or audit with a traceable cause, and only for judgement calls. A rule that a linter, type check, test or hook could enforce goes there instead.
