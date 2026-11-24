# Review protocol for worker results

Every task branch is reviewed by an **independent Tester** before it is integrated. The Tester has a fresh context and did not build the change. It knows only the task spec, the repository rules and the code. Its findings flow back to the builder as rework. Integration happens only after `Verdict: pass`.

## Flow

1. The builder reports `worker_done`.
2. The Controller starts a Tester with this protocol and the task spec.
3. The Tester records the full 40-character SHA of the reviewed branch tip, writes `docs/reviews/<task>-review-<round>.md` with that `Reviewed commit`, and commits only that file on a review branch created from the reviewed head. Never `--no-verify`.
4. On `fail`, every `blocker` and `major` goes unchanged to the builder as rework. Debt candidates do not.
5. A new round gets a fresh Tester that knows only the previous findings file, and re-checks only those findings and the rework (see "Later rounds").
6. After {{MAX_ROUNDS}} rounds a working feature is integrated; open points become debt plus an acceptance item for {{HUMAN}}.
7. On `pass`, level-2/3 tasks also get a fresh Architect's coarse conformance check (`docs/architect-protocol.md`).

## Documentation-only changes

When the `factory.config.json` on `{{MAIN}}` sets `docsOnly.enabled`, a change that touches documentation only gets no separate review. The Controller runs `node docsonly.mjs <task> <branch>`, which runs `{{MAIN}}`'s docs-only check (the `docs-only` command of the factory guardrails) on the pushed branch; only its exit 0 counts. The check's output, every changed path and the verdict, is recorded in place of a findings file (in the Controller's journal as the task's `review` event). Documentation means plain Markdown or raster images inside the allowlist (`docsOnly.paths`, default `docs/**` and top-level Markdown); the check fails closed: code, configuration, executable files, mode changes, renames across the boundary, links, agent instruction files, the files the factory installs or reads as process state (these protocols, the coordinator and workflow docs, review findings, tickets) and any unclear state mean a normal review. Product code keeps its independent review before every push.

## Review rule: functional only (decided by {{HUMAN}}, {{DATE}})

The verdict is `fail` **only** for a real functional defect: a specified flow does not work or gives wrong results, data is lost, or a change could reach a real external system (production, real accounts, {{HUMAN}}'s real data). Evidence: the full suites plus checking the changed flows in the browser. When `design/<feature>/` holds signed-off screens, compare the rendered result with them. A missing signed-off control or flow is a functional defect. Other visible differences go into the review file under "Differs from design" for the Front agent's acceptance; they do not fail the review.

Missing or weak tests, coverage gaps, edge cases, security, load and style are **debt candidates** with a category (`tests`, `edge-case`, `security`, `load`, `style`), a severity and a one-line proposal. They never fail the review. They are not dropped: every debt candidate goes into `docs/debt.md`, and the categories `security`, `load`, `tests` and `edge-case` are paid before release. The release gate is not passed while one of them is open, unless {{HUMAN}} accepts the item in writing.

**An assumption is no decision:** hold work only to a decision with {{HUMAN}}'s quoted statement and a date. Report an `Assumption:` that matters as a question.

**Always checked, in every round** (from round 2 on the changes that round re-checks, see "Later rounds"): code quality (`ponytail-review` on the full diff in round 1, on the task's own changes since the last reviewed commit in later rounds; `CODING_STANDARDS.md`) and architecture conformance (the stated level; every new export, dependency, data flow and import against the spec and the architecture docs). A wrong level or an unannounced architectural change is a `blocker`. Quality findings are `minor` unless trivial to fix now. **Not in daily rounds:** load tests, dependency audits and deep security hunting; they belong to the hardening phase and the release gate.

## Later rounds

**Rounds are bounded at {{MAX_ROUNDS}}.** A round that fails while rounds are left gets a rework and a new round. After round {{MAX_ROUNDS}} fails there is no rework and no further round (`mkspec` refuses both). The Controller runs the final functional re-evaluation (`mkspec reeval`) on the commit that round reviewed, as `CONTROLLER.md` says under "Tester failed". On `pass` exactly that commit is integrated. The task branch must not move past it, because the push gate accepts nothing after a reviewed commit except `docs/reviews/`. A failing re-evaluation, or more rounds (a higher `reviews.maxRounds`, a whole number of at least 1), is {{HUMAN}}'s decision.

**A fix after a pass is no failed round:** the limit counts failed review rounds. Beyond it, `mkspec rework` and `mkspec test` are allowed only when the round before says `Verdict: pass`. `mkspec` fetches that review branch from origin first and refuses when the fetch fails, the findings file is missing, or the file has not exactly one line that reads `Verdict: pass` or `Verdict: fail`; that one line is the verdict. So when the last round passed and the task then needs a fix (a failed conformance review, a red wave, a merge conflict), rework and re-check as usual; without a findings file, give `mkspec rework` `--reason "<what failed>"` (the wave log, the conflicting files) in place of the review argument. The limit is a guardrail for a Controller that follows these rules, not an enforcement against one that does not: round numbers come from the caller, and the push gate and the independent Testers are what protect `{{MAIN}}`.

**From round 2 the Tester narrows what it reviews, not which checks it applies.** Let A be the previous findings file's `Reviewed commit` and the head be the SHA under review. It reviews:

- every `blocker` and `major` of the previous round's findings file: fixed or not, with the test that proves it;
- the task's own changes since A: the commits of `git log --no-merges -p A..<head> ^origin/{{MAIN}}` (`^origin/{{MAIN}}` leaves out every commit that came in from `{{MAIN}}`), and for each merge commit of `git log --merges A..<head> ^origin/{{MAIN}}` what the merge itself changed (`git show --remerge-diff <merge>`). If that errors (git before 2.36) or skips the merge (an octopus merge prints `Skipping remerge-diff for octopus merges`), use `git show --cc <merge>` and review every file it shows.

If A is not an ancestor of the head (the branch was rebased or rewritten), the second point becomes the whole diff, as in round 1; the first point stays.

Every check of round 1 and every item under "Always checked" applies to these changes. A new `blocker` or `major` is raised only for a functional defect, a safety problem (a change that could reach a real external system, data loss, a secret, real data), or a wrong level or unannounced architectural change in these changes; anything else is a `minor` or a debt candidate. Code outside these changes was reviewed in an earlier round and is not reviewed again. The full gates still run on current `{{MAIN}}` plus the branch, and the new head gets its own `Reviewed commit`, so product code keeps its independent review before every push.

## Reviewer rules

- **Read-only.** Do not edit, stash or reset implementation files. The only file you write is your findings file.
- **Trust nothing reported.** Rerun the gates yourself: `{{VERIFY}}` always, `{{E2E}}` when the change can affect user flows. Run them through this project's gate, as `{{CONTROLLER_DIR}}/gate bash -c '<command>'` because the gate starts a program without a shell (never a bare `gate` from the PATH: on a host with other factories it would be another project's). Docker gates run only at release. Your gate run is evidence for your own findings only: the wave runs the full gate itself on the merged candidate before it pushes, and nothing you or the Developer ran takes its place.
- **On current `{{MAIN}}` plus the branch.** Use a clean worktree: merge current `{{MAIN}}` into a temporary branch from the reviewed head (abort and note conflicts if any). Failures present only on the stale branch tip are not findings; failures on the merged tree are.
- **Clean checkout.** No leftover ignored build output from earlier runs; a test that passes only because of leftovers is a finding.
- **Full diff** against `origin/{{MAIN}}` in round 1, not a sample; in later rounds the scope under "Later rounds". Run `ponytail-review` on it and merge its findings with the severities below.
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

{{HOOK_ENFORCEMENT}} Every non-documentation commit must be an ancestor of a `Reviewed commit:` SHA from a findings file under `docs/reviews/` with `Verdict: pass` that is in the pushed tree; a merge is judged by its own changes against its two parents (octopus merges are rejected, so waves merge one branch at a time). **Exempt** as documentation-only: files under `docs/` outside `docs/adr/`, and root Markdown other than `AGENTS.md` and `ARCHITECTURE.md`. **Not exempt**, because they set the reviewers' standards: `docs/review-protocol.md`, `docs/architect-protocol.md`, `CODING_STANDARDS.md`; they change through a reviewed task like code. `docs/coordinator.md` and `docs/dev-workflow.md` stay exempt so {{HUMAN}}'s process decisions can be recorded at once. The hook checks recorded coverage; the Controller remains responsible for the reviewer's independence.
