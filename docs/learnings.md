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

From one project's feature with six slices, built in parallel on a shared host, in one day. Only what holds across projects and brings a real gain in quality or speed was taken over.

| # | Learning | Evidence | Status |
|---|---|---|---|
| 17 | **Green reviews do not mean it looks right.** Two UI slices passed Tester and conformance, yet the human's first look at the demo failed: most rows showed `N/A`, and the layout differed from the signed-off screens. Reviews check the spec, not the overall impression. | Browser run | Applied: `FRONT_AGENT.md` |
| 18 | **Demo data must show the normal case.** The fixtures covered the special states, so most items showed one. | Browser run | Applied: `T00-template.md` |
| 19 | **Review rounds need proportion at spec level too.** One small state in a local one-user app took several spec rounds on rare edge cases. | Review files | Applied: `coordinator.md`, spec review |
| 20 | **Agent assumptions must not be recorded as human decisions.** A worker cap and a file exception appeared under "Decided by" although agents had chosen them, and a later Tester held the system to the invented cap. | Review file, project docs | Applied as a rule: `coordinator.md`, `review-protocol.md`. No check enforces it. |
| 21 | **Fix internal interfaces before parallel slices start.** A consumer slice was merged against an assumed interface the producer did not supply, and isolated tests could not show it. | Spec review | Applied: `coordinator.md`, spec review, `T00-template.md` |
| 22 | **State order in the task spec.** Slices started before their shared base existed, although a message said to wait. Whether this caused rework was not measured. | Journal, status | Applied: `T00-template.md`, `coordinator.md` |
| 23 | **Check the review gate before running the gates.** A wave passed verify and e2e and was only then rejected at push, because a merge commit had no review. | Wave output | Applied: `integ-wave.sh` |
| 24 | **The update flow does not mention the review gate.** Documentation needs no review, except the review and Architect protocols and the coding standards, so an update that changes those needs one. | Review files, hook | Applied: `README.md` |
| 25 | **The status file goes stale during long cycles.** An answered question stayed under "Needs" for minutes, because `status.md` was written at the end of a cycle. | Heartbeat log, status | Applied: `CONTROLLER.md` |
| 26 | **Worker setup dirties the lockfile.** Worktrees showed the same lockfile change after setup, and cleanup then kept them. | `git status`, journal | Not taken over: the trigger is unknown, so there is nothing general to fix yet. |
| 27 | **State the Controller directory in specs.** On a host with several Controllers, a Tester checked another project's directory and reported a false finding. | Review file | Applied: `mkspec` |
| 28 | **Review worktrees pile up.** Testers left checkouts in the temp directory that no cleanup covers. | `git worktree list` | Applied: `mkspec`, as a rule for workers. Existing leftovers stay. |
| 29 | **`start.mjs` failed in existing worktrees.** It passed creation options that Orca rejects there, so a rework could not start through it. | Orca's help, a test with a fake Orca | Fixed: `start.mjs`. Not yet run against a real Orca. |
| 30 | **The review preview belongs on the human's machine.** | Human statement | Not taken over: `preview` already exists, and when to offer it is a preference. |
| 31 | **A surface is shaped faster with the human watching.** A feature passed its full suite and two reviews, and the human rejected its look on first sight. The same problems and several new interactions then took about an hour with the Front agent changing the code directly, against a day through the normal flow. | One project, one session, human statement | Proposed: design lane in `outside-in.md`. One project so far. |
| 32 | **Green reviews passed a surface that did not match its signed-off screens.** No step compared the two. | Review files, the signed-off screens | Proposed: comparison in `review-protocol.md`. |
