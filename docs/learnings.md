# Learnings from running the factory

Lessons from real projects, with where each one now lives. The handbooks carry the rules; this page keeps the reasons.

## Noticing that work has finished (2026-11-05)

**Applied** means a rule in a handbook, which an agent has to follow. **Heartbeat** means `controller/heartbeat.mjs` does it, see [Orca](orca.md#heartbeat).

### Signals

| # | Learning | Status |
|---|---|---|
| 1 | **Every long-running activity needs a completion signal that reaches the Controller.** This includes waves, gates and audits, not only workers. A wave ran in its own terminal, was not in `workers.json` and sent no message, so its end woke nobody. | Applied: `CONTROLLER.md` |
| 2 | **Waking must not depend on a list the woken agent can change.** The heartbeat only counted messages from workers in `workers.json`, and a Controller cycle could remove a worker before its message was counted. Keep a separate, append-only record of known workers. | Heartbeat |
| 3 | **A signal counts as delivered only after a successful wake.** If the Controller is busy, retry on the next tick. Log every attempt, so silence never hides a miss. | Heartbeat |
| 4 | **Work between phases needs a wake too.** With no workers, no inbox and no ready tickets, the Controller only woke hourly, even though the next step was already approved. "Idle" must mean nothing is approved and waiting, not only that no worker runs. A Controller also fills free capacity in the same cycle after a wave. | Applied: `CONTROLLER.md` |
| 15 | **A busy Controller must still receive instructions.** A heartbeat that only sends to an idle terminal starves the inbox during long cycles. A human's instruction waited 27 minutes. After a few minutes, deliver a pointer to the inbox into the running session. | Heartbeat |

### Visibility

| # | Learning | Status |
|---|---|---|
| 5 | **Separate "the Controller knows" from "the human sees it".** A finished worker is marked at once in the sidebar, without a model and even while the Controller is busy. | Heartbeat |
| 6 | **The status display must cover every activity.** It showed "no workers active" while a wave was running. A display that omits an activity is wrong, not merely incomplete. | Applied: status format in `CONTROLLER.md` |
| 7 | **Name who is being waited on.** "Stalled" reads the same whether the human, the Front agent or nobody has to act. | Applied: status format in `CONTROLLER.md` |
| 8 | **The Front agent needs its own signal.** It must not learn about finished work only when the human asks. It watches the heartbeat log for done, stall and question events while a session is open. Without an open session, the sidebar marking is the only signal. | Partly: the heartbeat marks the sidebar, and `FRONT_AGENT.md` watches `status.md`. Watching `heartbeat.log` for events is F41. |
| 9 | **Do not wake a Controller that only waits for the human.** Fourteen hourly wakes overnight achieved nothing and cost model time. | Heartbeat |

### Rules and capacity

| # | Learning | Status |
|---|---|---|
| 10 | **An explicit request must reach the capacity limits.** "Massively parallel" would have met a calibrated cap of 2 that rises by one every 30 minutes. Check the cap when parallel work is requested, and keep the pressure checks. | Applied: `CONTROLLER.md` |
| 11 | **Check rule conflicts before review, not at the wave.** `design/README.md` required screenshots in git while `CONTROLLER.md` forbade binaries. Five reviews missed it, and it blocked the wave for 15 hours. Add it to the spec readiness checklist. | Applied: `T00-template.md`, `docs/workflow.md` |

### Verifying your own changes

| # | Learning | Status |
|---|---|---|
| 12 | **After an interrupted or failed command, inspect what actually ran before reporting.** A chained command may have partly run. | Applied: `CONTROLLER.md` |
| 13 | **Prove a mechanism through a real event.** A successful deployment or syntax check proves nothing about the signal path. Report a path as unproven until a real event has passed through it. | Applied: `CONTROLLER.md` |
| 14 | **Validate a script under its real file extension.** `node --check` rejects a `.new` suffix, so the deployment silently did not happen. | Applied: `CONTROLLER.md` |
| 16 | **A monitor stays silent if any pipe stage buffers.** A `cut` after `grep --line-buffered` withheld every event for 30 minutes. Silence from a watcher is not evidence: compare it with the source once after arming it. | Applied: `CONTROLLER.md` |

## Building a feature in parallel (2026-11-05)

From a project's feature with six slices, built in parallel on a shared host. **Proposed** means no rule or tool carries it yet. **Evidence** says how far it was checked.

### Review and acceptance

| # | Learning | Evidence | Status |
|---|---|---|---|
| 17 | **Green reviews do not mean it looks right.** Two UI slices passed Tester and conformance, yet the human's first look at the demo failed: of ten holdings, one drew a calculated line, 25 of 30 rows showed `N/A`, and the layout differed from the signed-off screens. Reviews check the spec, not the overall impression. Before showing a demo, the Front agent opens it, compares it with the signed-off screens and states what it does not show yet. | Browser run of the demo | Proposed |
| 18 | **Demo data must show the normal case.** The fixtures covered the special states, so most holdings showed one. Keep special states on a few items; most must look like real use, with enough data points. | Browser run of the demo | Proposed |
| 19 | **Review rounds need proportion at spec level too.** Expansion state in a local one-user app took several spec rounds on rare edge cases. The 2-round rule covers builds. Apply it to specs too: an edge case that affects no blocking category becomes debt, not another round. | Review files | Proposed |
| 20 | **Agent assumptions must not be recorded as human decisions.** A cap of 7 and 6 workers and a binary-file exception appeared under "Decided by" although agents had chosen them. A later Tester then held the system to the invented cap. "Decided by" needs a quoted statement with a date; anything else is an assumption until confirmed. | Review file, project docs | Proposed |

### Parallel work

| # | Learning | Evidence | Status |
|---|---|---|---|
| 21 | **Fix internal interfaces before parallel slices start.** A consumer slice was built and merged against an assumed interface that the producer slice did not supply. Passing its input as specified gave `missing_evidence`, and isolated tests could not show it. A parallel plan names each shared seam with exact fields, plus one test through the real producer and consumer. | Spec review | Proposed |
| 22 | **State order in the task spec.** Slices started before their shared base existed, although a message said to wait for it. Dependencies belong in the spec, not only in a message. Whether this caused rework was not measured. | Journal, status | Proposed |

### Waves and hooks

| # | Learning | Evidence | Status |
|---|---|---|---|
| 23 | **Check the review gate before running the gates.** A wave passed verify and e2e and was only then rejected at push, because a manual merge commit had no review. That check takes seconds, so it can run first. | Wave terminal output | Proposed |
| 24 | **The update flow does not mention the review gate.** A documents-only bundle update still needs a passing review before a wave accepts it; here it took two rounds. Say so in the README, or define a lighter path for documents-only updates. | Review files | Proposed |

### Status

| # | Learning | Evidence | Status |
|---|---|---|---|
| 25 | **The status file goes stale during long cycles.** An answered question stayed under "Needs" and in the sidebar for minutes, because `status.md` is written at the end of a cycle. Update it as soon as an answer is read. | Heartbeat log, status | Proposed |

### Environment

| # | Learning | Evidence | Status |
|---|---|---|---|
| 26 | **Worker setup dirties the lockfile.** Worktrees showed the same `package-lock.json` change of 30 deleted lines after setup. Cleanup then treats the worktree as having uncommitted work and keeps it, so entries pile up. The trigger is not established; `npm ci` in setup, or ignoring this exact change in cleanup, are candidates. | `git status`, cleanup journal | Proposed |
| 27 | **State the Controller directory in specs.** On a host with several Controllers, a Tester checked another project's `~/controller` instead of `~/controller-scalable` and reported a false finding. `mkspec` could name the directory. | Review file | Proposed |
| 28 | **Review worktrees pile up in `/tmp`.** Testers leave worktrees such as `/tmp/t22-process-review` that no cleanup covers. | `git worktree list` | Proposed |
| 29 | **`start.mjs` in existing worktrees.** A Controller reported that a start in an existing worktree passed setup options Orca rejects, so it called Orca directly. `set-pane-title` also keeps failing, earlier with `terminal_handle_stale`. Neither blocks a start. Reported only; the cause was not checked. | Controller status | Proposed |

### Preview

| # | Learning | Evidence | Status |
|---|---|---|---|
| 30 | **The review preview belongs on the human's machine.** A Controller ran its demo on the server, reachable only through a tunnel, while the human prefers a current state running locally. The Front agent offers one from a separate worktree after each wave, and says which commits it contains and what is not reviewed yet. | Human statement | Proposed |
