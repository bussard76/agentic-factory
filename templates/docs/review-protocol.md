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

When the `factory.config.json` on `{{MAIN}}` sets `docsOnly.enabled`, a task whose ticket declares itself a documentation ticket (`Level: 1` and `Documentation only: yes`, both when the work started and when the check runs: for a task file at the branch's base and on `{{MAIN}}` now, for an issue in the Controller's record from `claim` and in the issue's text now; a declaration on the task branch does not count, and neither readings that say no or cannot be made) and whose change touches documentation only gets no separate review. The Controller runs `node docsonly.mjs <task> <branch>` (in github-issues mode with `--ref "#<n>"`), which runs `{{MAIN}}`'s docs-only check (the `docs-only` command of the factory guardrails) on the pushed branch; only its exit 0 counts. The check's output, every changed path and the verdict, is recorded in place of a findings file (in the Controller's journal as the task's `review` event). Documentation means plain Markdown or raster images inside the allowlist (`docsOnly.paths`, default `docs/**` and top-level Markdown); the check fails closed: code, configuration, executable files, mode changes, renames across the boundary, links, agent instruction files, the files the factory installs or reads as process state (these protocols, the coordinator and workflow docs, review findings, tickets) and any unclear state mean a normal review. The one exception is the ticket's own pair, which every task branch of the Controller's flow carries: its architecture spec review (`docs/reviews/<task>-architecture-spec.md`) and its report (`docs/reports/<ticket file name>.md`, `issue-<n>.md` for an issue). They count when the Controller names the ticket, the branch is that ticket's own, the files are new on the branch, and neither reads like a findings file (a `Reviewed commit` line: the push gate takes such a file under `docs/reviews/` as the review of that commit, so only a Tester writes one); anything else under those directories, a second file of a kind, another ticket's file, a findings file and a ticket changing its status keep the Tester. Product code keeps its independent review before every push.

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

## What the wave merges

A review covers one commit: the one in the findings file's `Reviewed commit:` line (or, for the docs-only path, the head in the docs-only evidence). The Controller records that commit in its own journal after every verdict (`node reviewed.mjs <task> <review-branch> <review-sha>`, with the review branch and SHA the reviewer reported), and the wave merges exactly that commit, never whatever the branch points at when the wave runs; a review branch only as the commit the Controller read, a review branch only with its one findings file, and a `status-wave-<n>` branch only if it sets `Status: integrated` on tickets of the wave, one line each. A failed Tester round of a commit is undone only by a passing re-evaluation (`-review-final`) of the same commit; a review whose reviewer reported no SHA cannot be recorded and goes back to review. If the branch on origin has moved past it (a push after the review, a rewritten branch), the wave stops before it merges anything and names both commits; a clean merge of `{{MAIN}}` into the branch does not count as a move, one that changes anything else does. The task then goes back to review as after any change: a fresh Tester on the current head, whose `Reviewed commit` is the one that counts from then on. A fix after a pass is no failed round. A worker therefore cannot add code after its review and have it integrated: pushing after `worker_done` costs a new review. The record is the Controller's own, but the commit in it is copied from the review branch as the Controller read it: it is as trustworthy as that branch was then, and a reviewer that lies about its `Reviewed commit` is outside this protection (the push gate reads findings files by content; debt F54, longer term).

## A waiver: a decided non-blocker, with a follow-up

A failed review stops the wave (`WAVE-NOT-STARTED`): the task goes back for rework, a new round, or after the round limit the re-evaluation. Sometimes the finding is real but not a blocker: the content is fine, the full gate is green, and what failed the review is, say, a missing proof of how the work was done. {{HUMAN}} or the Front agent can **decide** that, and the decision is recorded as a **waiver** (`node waiver.mjs`, by the Controller, in its own journal). **The Controller never decides a waiver**: it records the decision that the Front agent or the owner gave, quotes their words, and starts nothing on its own account.

A waiver names the task, the failed review (its branch, its commit and findings file), the reviewed commit (full SHA), **each finding it waives by id**, who decided (`front-agent` or `owner`), their words verbatim, the reason, and where the follow-up lives (a follow-up ticket, a debt entry or an issue that exists). It is checked by code, not by wording, with two limits that the code cannot close: **the class of a finding is the reviewer's own claim** (the code checks ids, format, levels and the binding to one commit, not that a class is right), and **who decided is the caller's claim** (nobody checks who spoke). Whoever decides a waiver must read the findings file. The class never changes the verdict: a review fails only for what the functional-only rule says; the class only decides whether a finding that already failed it can be waived.

- It covers **that one review of that one commit**. A new commit on the branch needs a new review. A second failed review of the same commit (a failed re-evaluation or conformance review) needs its own waiver. The review stays `Verdict: fail`; the push gate takes the waived commit as reviewed only for the wave's own push and only with the failed findings file in the pushed tree.
- Every `blocker` and `major` of the review must be named. A finding classed `security`, `data-corruption`, `input-loss` or `gate`, in **any** severity, makes the review unwaivable: those need a fix. So does a red gate (the review's `Gates:` line, and the wave's own full gate, which runs on the merged candidate and must pass). A file without the classes (written before they existed) or not in the format below is not waivable; a new review with the current template is needed.
- The **Front agent** may waive only findings classed `process` or `style`, on a ticket of level 1 or 2, in a round before the last. The **owner** decides everything else: a `functional` finding, any ticket of level 3, the last Tester round and any waiver after the round limit, and a failed re-evaluation (at every level). The level is the one on the ticket as it is on the main branch (and where the work started), never the one on the task branch; a level that cannot be read is the owner's. With GitHub issues it comes from the task's own record, never from a reference typed by the caller. A review can be waived once: a second waiver for the same review is refused.
- It is not a way around a review: it does not pass anything and it is not available for a review that was never recorded, an older commit, or a branch that moved. After the round limit a waiver replaces the re-evaluation (`mkspec reeval`) only because the owner decided it; a re-evaluation that fails after a waiver of the round is a new failed review that needs its own, and only the owner can waive it.

Waivers are listed by `status` (count, task, commit, who decided, follow-up).

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
Gates: verify pass|fail, e2e pass|fail|none
Ponytail: <result on the full task diff>

## Spec checklist
| # | Requirement | Code | Test | Status |

## Findings
### F<n> [blocker|major|minor] [<class>] <short title>
- Where: `path:line`
- Problem: …
- Violates: <spec point or rule>
- Fix: …
- Proving test: …

## Debt candidates
| Category | Severity | Where | Proposal |
```

**Severity:** `blocker` for a functional defect, broken invariant or data rule, failing gate, or a possible change to a real external system; `major` for a spec requirement missing or wrong; `minor` for quality. `pass` requires zero blockers and zero majors.

**Class, one per finding, in the heading, from this fixed list (lower case):** `security`, `data-corruption`, `input-loss`, `gate` (a failing gate on the reviewed commit) can never be waived (see "A waiver"); `functional` (a specified flow is wrong), `process` (a missing proof, step or record of how the work was done, not what it does) and `style` (wording, naming, formatting, structure) may. Take the most serious class that fits; when unsure, the never-waivable one. Ids are `F1`, `F2`, ... and unique in the file. The Controller reads the heading strictly: a finding without a class or an id, a second form, an unknown class, or a `###` heading under `## Findings` that is no finding, or any line there that says `[blocker]` or `[major]` without being a finding heading, makes the whole file unreadable for a waiver, and so does a missing or malformed `Gates:` line in a Tester round. Debt candidates stay in their table, with their own categories.

## Push enforcement

{{HOOK_ENFORCEMENT}} Every non-documentation commit must be an ancestor of a `Reviewed commit:` SHA from a findings file under `docs/reviews/` with `Verdict: pass` that is in the pushed tree; a merge is judged by its own changes against its two parents (octopus merges are rejected, so waves merge one branch at a time). **Exempt** as documentation-only: files under `docs/` outside `docs/adr/`, and root Markdown other than `AGENTS.md` and `ARCHITECTURE.md`. **Not exempt**, because they set the reviewers' standards: `docs/review-protocol.md`, `docs/architect-protocol.md`, `CODING_STANDARDS.md`; they change through a reviewed task like code. `docs/coordinator.md` and `docs/dev-workflow.md` stay exempt so {{HUMAN}}'s process decisions can be recorded at once. The hook checks recorded coverage; the Controller remains responsible for the reviewer's independence.
