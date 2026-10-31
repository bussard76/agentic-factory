# Test stages

Origin of the split: full suites for every Developer once pushed a 12-thread server to load 25 and produced timeouts instead of confidence.

| Stage | Who | Runs |
|---|---|---|
| While building | Developer | **targeted**: typecheck, lint, the suites of the packages it touched, the browser specs that cover its change |
| Per task | Tester | **full**: `commands.verify` and `commands.e2e` on current `main` plus the branch, in a clean worktree |
| Per wave | Controller | **full** on the merged integration branch, then push to `main` |
| Release only | release gate, when the human declares a release | additionally `commands.release` (Docker images, compose end-to-end), the **security and load tests**, and a browser acceptance through the human's real addresses |

Docker runs **only** at release. Not per task, not per wave. This was corrected explicitly after it had crept back in once.

**The release gate is mandatory, not optional.** Functional checks are prioritised during development so the product moves fast; load and security tests do **not** run in daily task and wave gates, because they were observed to slow development down. They are paid before release: security tests (dependency audit, the threat-model checks, a security review of the release candidate), load tests (the flows under realistic concurrency), and the test and edge-case debt from the register. No release approval while any of these is open or failing, unless the human accepts a specific item in writing.

**Always on, in every review:** code quality (`ponytail-review`, the coding standards) and architecture conformance (level, exports, dependencies, data flows, import boundaries). An architecture violation blocks; quality findings are fixed when trivial, otherwise they become debt with a follow-up.

## Gates run in fair slots

Every full gate goes through `gate <command>` (`controller/gate.mjs`, Node only). Gates are pooled: unit gates and browser gates have separate slot counts. Waiters queue as ticket files per pool; only the oldest live ticket may take a free slot, so newer gates cannot overtake older ones, and tickets of dead processes are swept. The slot counts are adapted to measured pressure by `capacity.mjs` (see [capacity.md](capacity.md)).

Developers' focused checks run **without** the gate; they are cheap.

## Flaky tests under load

Some tests fail only when the server is saturated and pass alone. Rules:

- A known load flake may be rerun once, alone. If it is green alone three times, that is the evidence.
- In a review, an **unchanged** test that fails only by timeout under load and passes alone does not fail the review. The review names the failure and judges on the isolated pass. The cause goes into debt with a follow-up task.
- Flakes are fixed at the root in their own tasks, never by weakening tests.
- Failures caused by **foreign load** on the same host (another project's Docker stack churning the network, for example) count as environment: rerun, count the reruns, state the count in the report. Never touch the other project.

## Realistic test data

Demo data reproduces the **shapes** of the real data (link syntax, time zones, missing frontmatter, odd whitespace) with invented content. Two defects were found only by the human because the test data was too tidy. Whenever a defect is found by the human, the missing shape goes into the demo data.

## Fixed rules

- No real model calls in tests, scripts or while developing. Use a fake OpenAI-compatible server and scripted implementations.
- Tests go through public entry points, not internals.
- Never delete, skip or loosen an existing test. The pre-commit hook rejects a dropping test count.
- Every bug fix starts with a failing test that reproduces it.
