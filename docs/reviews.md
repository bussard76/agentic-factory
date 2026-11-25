# Reviews, debt and the hardening phase

## Back pressure

Nobody accepts their own work. Every task branch is reviewed by an **independent Tester** with a fresh context that did not build the change. The Tester knows only the spec, the repository rules and the code.

1. The Developer reports `worker_done`.
2. The Controller starts a Tester on the branch with the review protocol and the spec.
3. The Tester records the full 40-character SHA it reviewed, runs the full gates itself on **current `main` plus the branch**, checks the changed flows in the browser where the change is flow-relevant, and writes `docs/reviews/<task>-review-<round>.md` with findings by severity and `Verdict: pass|fail`. It commits only that file.
4. On `fail`, while rounds are left, the Controller starts a rework in the same worktree with the findings unchanged. With more than two rounds allowed, the rework after the second failure runs one model higher.
5. A new round gets a fresh Tester that knows only the previous findings file. From round 2 it narrows what it reviews, not which checks it applies: those findings and the task's own changes since the last reviewed commit, with commits from `main` left out. A new blocker or major comes only from a functional defect, a safety problem, or a wrong level or unannounced architectural change. The full gates still run.
6. After the configured number of rounds (`reviews.maxRounds`, two by default) a working feature is integrated. After the last round fails there is no rework: `mkspec test` and `mkspec rework` refuse and point to the final functional re-evaluation (`mkspec reeval`) of the commit that round reviewed. On a pass exactly that commit is integrated; a failing re-evaluation goes to the human. The limit counts failed rounds: beyond it a rework or a review round is allowed only when the round before says `Verdict: pass` (exactly one such line in its findings file, fetched from origin), for example after a failed conformance review, a red wave or a merge conflict. A rework without a findings file takes `--reason "<what failed>"`. The limit is a guardrail for the Controller, not an enforcement against a hostile one. Open points become debt plus an acceptance item for the human on the preview.
7. Level-2 and level-3 tasks also get an Architect's conformance check: a coarse boundary check (no new port, contract, store or data flow without a recorded approval, no forbidden imports), not a hunt for edge cases.

## Functional-only reviews

The principle: first it has to work; security and load are checked later, before release.

A review fails **only** for a real functional defect:

- a specified flow does not work or gives wrong results
- data is lost
- a change could reach a real external system (production, real accounts, the human's real data)

Everything else is a **debt candidate**, listed with a category, a severity and a one-line proposal, and never fails the review:

| Category | Examples |
|---|---|
| `tests` | missing or weak tests, coverage gaps |
| `edge-case` | unhandled inputs, boundary conditions |
| `security` | hardening beyond the threat model's blockers |
| `load` | behaviour under load, timeouts, flakiness |
| `style` | naming, duplication, readability |

Nothing is dropped. Debt is collected in `docs/debt.md` and worked off in a **hardening phase** once the functional surface has enough breadth. The human starts that phase; the Front agent proposes it.

## What runs when

| Check | When | Effect |
|---|---|---|
| **Functional check** of the specified flows | every task, every wave | the review verdict |
| **Code quality** (`ponytail-review`, `CODING_STANDARDS.md`) and **architecture conformance** (level, new exports, dependencies, data flows, import boundaries) | **always**, in every review | an architecture violation blocks; quality findings are fixed when trivial, otherwise recorded as debt with a follow-up |
| **Load, security and the other deferred checks** (load tests, dependency audit, threat-model review, deep edge-case hunting) | **not in daily runs**: observed to slow development down. They run in the hardening phase and **before every release** | a **condition of release approval**: the release gate is not passed while a `security`, `load`, `tests` or `edge-case` debt item is open, unless the human accepts it in writing in `docs/debt.md` |

Functional tests come first so the product moves fast; nothing is dropped. The Front agent proposes the hardening phase in time; the Controller reports the open debt by category in every status.

## Threat model for security findings

Judge security findings against an attacker **without write access to the human's machine**: web pages, network requests, crafted URLs, untrusted content inside the human's data. Those can be blockers when a change could reach a real external system. Attackers who can already change files in the repository or the user account are out of scope as blockers; record those findings as debt with a cheap hardening idea. State the attacker position in every security finding.

## Git enforces the gate

The template hooks (`templates/.githooks`, `templates/tools/factory-guardrails.mjs`) give every project:

- **pre-commit:** the project's formatter on the staged files, when `commands.formatStaged` is set ([testing.md](testing.md#formatter-on-staged-files)); test count must not drop; no whitespace errors or conflict markers; a staged-secret scan; the project's static checks
- **commit-msg:** protected files (`AGENTS.md`, `ARCHITECTURE.md`, `docs/adr/**`, the hooks, the guardrail script) change only when the message references an accepted `ADR-NNNN` that carries a `Decided by:` line; new dependencies are a level-2 decision of the Architect's spec review, not hook-protected
- **pre-push to `main`:** every non-documentation commit must be covered by a findings file under `docs/reviews/` with `Verdict: pass` and a `Reviewed commit:` SHA that is an ancestor of the pushed tip; after the reviewed commit only `docs/reviews/` may change. The one other way in is the Controller's wave carrying a waived failed review (see [A waiver](#a-waiver-a-decided-non-blocker-with-a-follow-up)): nothing else changes

`--no-verify` is forbidden everywhere. The hook checks recorded coverage; the Controller remains responsible for the reviewer's independence.

**Documentation-only tasks** (a ticket that declares it: `Level: 1`, `Documentation only: yes`, both when the work started and when the check runs) get no separate review when the project sets `docsOnly.enabled`: the docs-only check's evidence (every changed path and the verdict) takes the review's place (process files, review findings, tickets and agent instructions never count as documentation; the one exception is the ticket's own spec review and report, which every task branch carries: new files, exactly those names, never a findings file) in the journal. The task's wave still runs the full gates once (its own process files and the status branch are in it), so the saving is the Tester round. Details and the fail-closed rules: [testing.md](testing.md#documentation-only-changes).

## Findings file

```markdown
# <task> review, round <n>

Verdict: pass | fail
Reviewed commit: <40-character SHA>
Gates: verify pass|fail, e2e pass|fail|none
Ponytail: <ponytail-review result on the full task diff>

## Spec checklist
| # | Requirement | Code | Test | Status |

## Findings
### F<n> [blocker|major|minor] [<class>] <short title>
- Where: `path:line`
- Problem / Violates / Fix / Proving test

## Debt candidates
| Category | Severity | Where | Proposal |
```

`blocker`: functional defect, broken invariant or data rule, failing gate, a possible change to a real external system. `major`: a spec requirement missing or wrong. `minor`: quality. A `pass` needs zero blockers and zero majors; under functional-only rules, test and quality gaps are debt candidates rather than majors.

**Class, one per finding, in the heading** (every review that lists findings: the Tester in every round, the re-evaluation, the Architect's spec and conformance reviews): `security`, `data-corruption`, `input-loss` and `gate` can never be waived; `functional`, `process` and `style` may be. The ids (`F1`, `F2`, ...) are unique in the file. The Controller's code reads the heading strictly; a finding without a class, with an unknown one or in any other form makes the file unreadable for a waiver, and so does any line inside `## Findings` that looks like a blocker or major finding (`[blocker]`, `[major]`, in bold, a list, a deeper heading) without being a well-formed finding heading. The `Gates:` line of a Tester round is read the same way. **What the code does not know:** the class is the reviewer's own claim. The code checks ids, format, levels and the binding to one commit, not whether a class is right (a security hole labelled `functional` passes the check) and not who really wrote the file. Whoever decides a waiver has to read the findings file itself.

**The class never changes the verdict.** What fails a review is unchanged (a real functional defect; security, coverage and style observations are debt and block nothing, see [workflow.md](workflow.md)). The class only decides whether a finding that already failed a review can be waived: a review that failed for a finding classed `security` (a change that could reach a real external system, say) can never be waived, while a security observation that is only debt fails nothing and needs no waiver.

## A waiver: a decided non-blocker with a follow-up

A failed review stops the wave and sends the task back. Sometimes what failed it is real but not a blocker: a documentation ticket whose content is fine and whose full gate is green, failed only for a missing proof of the process (an approval given after the build). Then the Front agent, or the owner, **decides** that it is a follow-up and the Controller **records** that decision with `node waiver.mjs`. The Controller never decides a waiver; it writes down the decision that was given, with the words quoted, in its own journal (a `waiver` event only `waiver.mjs` can write, outside every worktree, like the review records).

What a waiver is for: a finding that was decided to be a non-blocker, with a follow-up that exists (a ticket, a debt entry or an issue). What it is not: a way around a review. In code, not in wording (with the limit that is named in each point: the code checks ids, levels and binding, not whether a class is right or who spoke):

- **It names what it covers:** the task, the failed review (branch, commit of the review branch, findings file), the reviewed commit (full SHA) and each finding by id. Every `blocker` and `major` must be named; naming none, naming a finding the file does not have, or `all` is refused. Minor findings and debt candidates are not blockers.
- **It never covers** a finding classed `security`, `data-corruption`, `input-loss` or `gate` (in any severity), a red `Gates:` line, a review without classes (written before them) or in another format (a new review with the current template is needed), and not the wave's own full gate: the wave still runs `commands.verify` (and `commands.e2e`) on the merged candidate, never the docs-only path, and pushes only if it is green.
- **Who decides:** the Front agent may waive only findings classed `process` or `style` (one constant, `FRONT_AGENT_WAIVABLE` in `controller/findings.mjs`), on a ticket of level 1 or 2, in a round before the last. The owner (their words verbatim) decides everything else: a `functional` finding, any ticket of level 3, the last Tester round and every waiver after the round limit, and a failed final re-evaluation (at every level). The level is the one on the ticket on the main branch (and where the work started), never the task branch's; a level that cannot be read is the owner's. With GitHub issues it is read from the task's own record (the issue `mkspec` bound to the task id, and the Controller's `claim` of that issue), never from a reference the caller types. **Not checked by the code:** who really spoke. `--decider owner` and the quoted words are the caller's claim (debt F55).
- **One review of one commit.** A new commit needs a new review (a waiver of the old one does not cover it), a branch that moved stops the wave, a review that was never recorded or a passed one cannot be waived, and a second failed review of the same commit (a failed re-evaluation after the round limit, a failed conformance review) needs its own waiver. One decision per review: a second waiver for the same review is refused, so the first decider stays on record. After the round limit a waiver of the last failed round replaces the re-evaluation (`mkspec reeval`) only because the owner decided it; the Front agent cannot.
- **The review stays a fail.** Its findings file reaches the main branch as written; the pre-push hook takes the waived commit as reviewed only for the wave's own push (`FACTORY_WAIVED`, set by `integ-wave.sh` after it checked that the wave merges that commit and that very findings file) and only if the pushed tree holds the failed file with its one `Verdict: fail` and one `Reviewed commit:` line. For everything else the hook is unchanged. Like every check in the hook it is local: a process that can set the variable can also push with `--no-verify` (debt F01, F54). A project whose hook is older than this change rejects the push of a waived wave; `agentic-factory update` brings the new one.
- **Visible:** `status --json` (`work.waivers`: count and list with task, commit, who decided, follow-up) and the human `status`; the `waiver` event and the wave's `waived` note are in the journal. The merge commit on the main branch carries the record (who is claimed to have decided, the findings, the follow-up, their words and the reason) marked as a record, not a proof: `wave.mjs` copies it from the Controller's journal, `integ-wave.sh` does not read the journal, and nobody checks who decided.
- **The follow-up is real:** a ticket file (not the README or the template) or a debt entry (an id with a digit in the first column of a table row, not the header or the separator), or `#<n>` with GitHub issues. Nothing checks that it is open or that it mentions the waived finding.
