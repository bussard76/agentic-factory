# Reviews, debt and the hardening phase

## Back pressure

Nobody accepts their own work. Every task branch is reviewed by an **independent Tester** with a fresh context that did not build the change. The Tester knows only the spec, the repository rules and the code.

1. The Developer reports `worker_done`.
2. The Controller starts a Tester on the branch with the review protocol and the spec.
3. The Tester records the full 40-character SHA it reviewed, runs the full gates itself on **current `main` plus the branch**, checks the changed flows in the browser where the change is flow-relevant, and writes `docs/reviews/<task>-review-<round>.md` with findings by severity and `Verdict: pass|fail`. It commits only that file.
4. On `fail` the Controller starts a rework in the same worktree with the findings unchanged. After the second failure the next attempt runs one model higher.
5. A new round gets a fresh Tester that knows only the previous findings file.
6. After **two rounds** a working feature is integrated. Open points become debt plus an acceptance item for the human on the preview.
7. Level-2 and level-3 tasks also get an Architect's conformance check: a coarse boundary check (no new port, contract, store or data flow without a recorded approval, no forbidden imports), not a hunt for edge cases.

## Functional-only reviews

Decided by the owner on 2026-10-30 ("first it has to work; we check security and load later").

A review fails **only** for a real functional defect:

- a specified flow does not work or gives wrong results
- data is lost
- a real outward effect could happen (sending, writing to an external system, touching the human's real data)

Everything else is a **debt candidate**, listed with a category, a severity and a one-line proposal, and never fails the review:

| Category | Examples |
|---|---|
| `tests` | missing or weak tests, coverage gaps |
| `edge-case` | unhandled inputs, boundary conditions |
| `security` | hardening beyond the threat model's blockers |
| `load` | behaviour under load, timeouts, flakiness |
| `style` | naming, duplication, readability |

Nothing is dropped. Debt is collected in `docs/debt.md` and worked off in a **hardening phase** once the functional surface has enough breadth. The human starts that phase; the Front agent proposes it.

## Threat model for security findings

Judge security findings against an attacker **without write access to the human's machine**: web pages, network requests, crafted URLs, untrusted content inside the human's data. Those can be blockers when they would cause a real outward effect. Attackers who can already change files in the repository or the user account are out of scope as blockers; record those findings as debt with a cheap hardening idea. State the attacker position in every security finding.

## Git enforces the gate

The template hooks (`templates/.githooks`, `templates/tools/factory-guardrails.mjs`) give every project:

- **pre-commit:** test count must not drop; no whitespace errors or conflict markers; a staged-secret scan; the project's static checks
- **commit-msg:** protected files (architecture docs, ADRs, hooks, dependency lists, contracts) change only when the message references an accepted `ADR-NNNN`
- **pre-push to `main`:** every non-documentation commit must be covered by a findings file under `docs/reviews/` with `Verdict: pass` and a `Reviewed commit:` SHA that is an ancestor of the pushed tip; after the reviewed commit only `docs/reviews/` may change

`--no-verify` is forbidden everywhere. The hook checks recorded coverage; the Controller remains responsible for the reviewer's independence.

## Findings file

```markdown
# <task> review, round <n>

Verdict: pass | fail
Reviewed commit: <40-character SHA>
Gates: verify <result>, e2e <result>
Ponytail: <ponytail-review result on the full task diff>

## Spec checklist
| # | Requirement | Code | Test | Status |

## Findings
### [blocker|major|minor] <short title>
- Where: `path:line`
- Problem / Violates / Fix / Proving test

## Debt candidates
| Category | Severity | Where | Proposal |
```

`blocker`: functional defect, broken invariant or data rule, failing gate, possible outward effect. `major`: a spec requirement missing or wrong. `minor`: quality. A `pass` needs zero blockers and zero majors; under functional-only rules, test and quality gaps are debt candidates rather than majors.
