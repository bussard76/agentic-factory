# Recording decisions

Every rule in this factory traces back to a decision with a date and a reason. That is what makes the process explainable to a third party and lets an agent follow it without the human in the room.

## The rule

**Process decisions go into the project's docs immediately**, in the same turn they are made, in two places:

- `docs/coordinator.md`: the agents' handbook, in English, with the full history. New sections carry the heading `## <topic> (decided by <human>, <date>)`.
- `docs/dev-workflow.md`: the guide for people, in the human's language, kept complete and understandable for third parties. Superseded rules are removed here and stay only in the history.

An agent's private memory is never the only record. The Front agent and the Controller both follow this; the Controller's loop ends every process change with a docs commit.

## Architecture decisions

Level-3 changes need an **ADR** in `docs/adr/NNNN-<slug>.md` with options, a recommendation and, once decided, `Decided by: <human> (<date>), option <x>`. Protected files (`AGENTS.md`, `ARCHITECTURE.md`, `docs/adr/**`, the hooks and the guardrail script) change only when the commit message references an ADR that is accepted **and** carries that `Decided by:` line; the commit hook checks both. Never delete an accepted ADR; supersede it with a new one.

## Shared level-2 decisions

When the Controller decides the same thing for several tasks (a shared allowlist, a naming rule, an interface detail), it writes one dated decisions file under `docs/reviews/` and points the task specs at it, so workers get it as a binding instruction.

## What a decision line looks like

> - **Docker only at release (decided by <human>, <date>):** Developers, Testers and waves run no Docker gates. `e2e:compose` and `test:images` run once, in the release gate. Reason: the suites doubled every task's turnaround without finding anything the unit and browser suites had missed.

Measured cause, decision, scope, reason. Short enough to read, exact enough to follow.
