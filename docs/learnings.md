# Learnings from running the factory

Lessons from real projects, with where each one now lives. The handbooks carry the rules; this page keeps the reasons.

## Noticing that work has finished (2026-11-05)

**Applied means** a rule in a handbook, which an agent has to follow. **Open** means it needs a mechanism the factory does not have yet: a heartbeat outside the Controller. See F39 and F40 in [`debt.md`](../debt.md).

### Signals

| # | Learning | Status |
|---|---|---|
| 1 | **Every long-running activity needs a completion signal that reaches the Controller.** This includes waves, gates and audits, not only workers. A wave ran in its own terminal, was not in `workers.json` and sent no message, so its end woke nobody. | Applied: `CONTROLLER.md` |
| 2 | **Waking must not depend on a list the woken agent can change.** The heartbeat only counted messages from workers in `workers.json`, and a Controller cycle could remove a worker before its message was counted. Keep a separate, append-only record of known workers. | Open: F39 |
| 3 | **A signal counts as delivered only after a successful wake.** If the Controller is busy, retry on the next tick. Log every attempt, so silence never hides a miss. | Open: F39 |
| 4 | **Work between phases needs a wake too.** With no workers, no inbox and no ready tickets, the Controller only woke hourly, even though the next step was already approved. "Idle" must mean nothing is approved and waiting, not only that no worker runs. A Controller also fills free capacity in the same cycle after a wave. | Applied: `CONTROLLER.md` |
| 15 | **A busy Controller must still receive instructions.** A heartbeat that only sends to an idle terminal starves the inbox during long cycles. A human's instruction waited 27 minutes. After a few minutes, deliver a pointer to the inbox into the running session. | Open: F39 |

### Visibility

| # | Learning | Status |
|---|---|---|
| 5 | **Separate "the Controller knows" from "the human sees it".** A finished worker is marked at once in the sidebar, without a model and even while the Controller is busy. | Open: F40 |
| 6 | **The status display must cover every activity.** It showed "no workers active" while a wave was running. A display that omits an activity is wrong, not merely incomplete. | Applied: status format in `CONTROLLER.md` |
| 7 | **Name who is being waited on.** "Stalled" reads the same whether the human, the Front agent or nobody has to act. | Applied: status format in `CONTROLLER.md` |
| 8 | **The Front agent needs its own signal.** It must not learn about finished work only when the human asks. It watches the heartbeat log for done, stall and question events while a session is open. Without an open session, the sidebar marking is the only signal. | Partly: `FRONT_AGENT.md` watches `status.md`. The event log and the sidebar marking are F39 and F40. |
| 9 | **Do not wake a Controller that only waits for the human.** Fourteen hourly wakes overnight achieved nothing and cost model time. | Applied as a rule: `CONTROLLER.md`. Enforcing it needs F39. |

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
