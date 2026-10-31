# Review protocol for worker results

Every task branch is reviewed by an **independent Tester** before it is integrated. The Tester has a fresh context and did not build the change. It knows only the task spec, the repository rules and the code. Its findings flow back to the builder as rework. Integration happens only after `Verdict: pass`.

## Flow

1. The builder reports `worker_done`.
2. The Controller starts a Tester with this protocol and the task spec.
3. The Tester records the full 40-character SHA of the reviewed branch tip, writes `docs/reviews/<task>-review-<round>.md` with that `Reviewed commit`, and commits only that file on a review branch created from the reviewed head. Never `--no-verify`.
4. On `fail`, every `blocker` and `major` goes unchanged to the builder as rework. Debt candidates do not.
5. A new round gets a fresh Tester that knows only the previous findings file.
6. After {{MAX_ROUNDS}} rounds a working feature is integrated; open points become debt plus an acceptance item for {{HUMAN}}.
7. On `pass`, level-2/3 tasks also get a fresh Architect's coarse conformance check (`docs/architect-protocol.md`).

## Review rule: functional only (decided by {{HUMAN}}, {{DATE}})

The verdict is `fail` **only** for a real functional defect: a specified flow does not work or gives wrong results, data is lost, or a change could reach a real external system (production, real accounts, {{HUMAN}}'s real data). Evidence: the full suites plus checking the changed flows in the browser.

Missing or weak tests, coverage gaps, edge cases, security, load and style are **debt candidates** with a category (`tests`, `edge-case`, `security`, `load`, `style`), a severity and a one-line proposal. They never fail the review. They are not dropped: every debt candidate goes into `docs/debt.md`, and the categories `security`, `load`, `tests` and `edge-case` are paid before release. The release gate is not passed while one of them is open, unless {{HUMAN}} accepts the item in writing.

**Always checked, in every round:** code quality (`ponytail-review` on the full diff, `CODING_STANDARDS.md`) and architecture conformance (the stated level; every new export, dependency, data flow and import against the spec and the architecture docs). A wrong level or an unannounced architectural change is a `blocker`. Quality findings are `minor` unless trivial to fix now. **Not in daily rounds:** load tests, dependency audits and deep security hunting; they belong to the hardening phase and the release gate.

## Reviewer rules

- **Read-only.** Do not edit, stash or reset implementation files. The only file you write is your findings file.
- **Trust nothing reported.** Rerun the gates yourself: `{{VERIFY}}` always, `{{E2E}}` when the change can affect user flows. Run them through `gate`. Docker gates run only at release.
- **On current `{{MAIN}}` plus the branch.** Use a clean worktree: merge current `{{MAIN}}` into a temporary branch from the reviewed head (abort and note conflicts if any). Failures present only on the stale branch tip are not findings; failures on the merged tree are.
- **Clean checkout.** No leftover ignored build output from earlier runs; a test that passes only because of leftovers is a finding.
- **Full diff** against `origin/{{MAIN}}`, not a sample. Run `ponytail-review` on it and merge its findings with the severities below.
- **Flakes.** An unchanged test that fails only by timeout under load and passes alone is load debt: keep the original failure in the report, list each such file, judge on the isolated pass. Failures caused by foreign host load (network changes from another project's containers) count as environment: rerun, count the reruns, state the count.
- **Every finding is concrete:** `file:line`, what is wrong and the spec point or rule it violates, the required fix, and **the test that must prove the fix**.
- No real data, no real model calls, no real external services. Do not print secrets.

## Threat model for security findings

Judge against an attacker **without write access to {{HUMAN}}'s machine**: web pages, network requests, crafted URLs, untrusted content in {{HUMAN}}'s data. Such findings are blockers only when a change could reach a real external system; otherwise debt. Attackers who can already change files in the repo or the user account are out of scope as blockers; record as debt with a cheap hardening idea. State the attacker position.

## What the reviewer checks

1. **Spec compliance:** turn every requirement into a checklist row with the implementing code and the proving test, or "missing". Scope creep is a finding.
2. **Architecture level:** confirm the stated level; account for every new public export, dependency and import. A wrong level or unannounced architectural change is a `blocker`.
3. **Functional flows** in the browser or through the public API, with the demo data.
4. **No outward effects:** the change and its tests reach no real external system (production, real accounts, {{HUMAN}}'s real data); demo and mock only.
5. **Data rule:** no real identifiers, no secrets, `.env` not touched.
6. **Tests:** do they assert behaviour? Would they fail without the feature? Did the count drop? (Under the functional-only rule, weak tests are debt, not majors.)

## Findings file format

```markdown
# <task> review, round <n>

Verdict: pass | fail
Reviewed commit: <40-character SHA>
Gates: verify <result>, e2e <result>
Ponytail: <result on the full task diff>

## Spec checklist
| # | Requirement | Code | Test | Status |

## Findings
### [blocker|major|minor] <short title>
- Where: `path:line`
- Problem: …
- Violates: <spec point or rule>
- Fix: …
- Proving test: …

## Debt candidates
| Category | Severity | Where | Proposal |
```

**Severity:** `blocker` for a functional defect, broken invariant or data rule, failing gate, or a possible change to a real external system; `major` for a spec requirement missing or wrong; `minor` for quality. `pass` requires zero blockers and zero majors.

## Push enforcement

{{HOOK_ENFORCEMENT}} With the factory hooks armed (`core.hooksPath=.githooks`), `pre-push` checks every update of `{{MAIN}}`. Every non-documentation commit must be an ancestor of a `Reviewed commit:` SHA from a findings file under `docs/reviews/` with `Verdict: pass` that is in the pushed tree; a merge is judged by its own changes against its two parents (octopus merges are rejected, so waves merge one branch at a time). **Exempt** as documentation-only: files under `docs/` outside `docs/adr/`, and root Markdown other than `AGENTS.md` and `ARCHITECTURE.md`. **Not exempt**, because they set the reviewers' standards: `docs/review-protocol.md`, `docs/architect-protocol.md`, `CODING_STANDARDS.md`; they change through a reviewed task like code. `docs/coordinator.md` and `docs/dev-workflow.md` stay exempt so {{HUMAN}}'s process decisions can be recorded at once. The hook checks recorded coverage; the Controller remains responsible for the reviewer's independence.
