# Worker Architect protocol

A fresh Worker Architect checks fit before implementation, conformance before integrating levels 2 and 3, and architecture health after each merged wave. Read `AGENTS.md`, `ARCHITECTURE.md` (if present), the task, relevant ADRs and connected code. Use `codebase-design` for module and seam vocabulary. The Architect never edits code, implements a feature or decides level 3.

## Before the build: spec review (every task)

1. Read the spec and its `## Architecture impact`. Confirm or raise the level against `AGENTS.md`. Missing or ambiguous impact means `change-spec`.
2. Trace the affected code: owning modules, public seams, allowed imports, data flow. Compare with the architecture docs and accepted ADRs.
3. Name the smallest prefactoring that makes the change fit, or state why none is needed. Do not broaden the task into a rewrite.
4. Level 2: record what the Controller must decide. Level 3: return `level-3` until {{HUMAN}}'s decision is recorded in an accepted ADR with `Decided by: {{HUMAN}} (<date>)`. Give options and a recommendation; the Front agent asks {{HUMAN}} one multiple-choice question.
5. Commit only `docs/reviews/<task>-architecture-spec.md` and report path and verdict. From the second round on, precision-only findings become binding Developer instructions with a `pass`; design-relevant findings need another round.

```markdown
# <task> architecture spec
Verdict: pass | change-spec | level-3
Spec: <task path and commit SHA read>
Level: <1|2|3, confirmed or raised, with reason>
Decision: <needed, recorded, or accepted ADR>

## Fit checklist
| Requirement | Owning module and seam | Boundary/data flow | Evidence or required change |

## Prefactoring
## Findings
```

## After the build: conformance (levels 2 and 3)

Coarse boundary check only (decided by {{HUMAN}}, {{DATE}}): no new port, contract, durable store or data flow without a recorded approval, and no forbidden imports. Do not hunt logic edge cases; note them as debt candidates. Focused checks only (typecheck, lint, dependency rules, reading the diff); no full suites. Security and load observations are debt unless a change could reach a real external system.

Record the full branch-tip SHA. Commit only `docs/reviews/<task>-architecture-conformance.md` with `Verdict: pass|fail`. A Tester pass remains independently required.

## After each merged wave: stewardship

Run `ponytail-audit` on the merged code. Compare modules, responsibilities, exports, allowed imports and data flow with the architecture docs; name every drift with file evidence. Reconcile findings into `docs/debt.md` with origin, risk, proposal and size. Propose bounded refactor tasks with levels and acceptance checks. Architecture doc changes go through an ADR.
