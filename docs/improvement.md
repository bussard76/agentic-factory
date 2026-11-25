# The factory improves itself

Four pieces: a journal, a nightly auditor, a fast lane and a retro per hard agent run.

## Journal

The Controller appends one JSON line per event to `journal.ndjson` (`controller/journal.mjs`):

- always: `ts`, `type`, `task`
- where they apply: `role`, `model`, `agent`, `round`, `verdict`, `reason`, `minutes`, `wait_min`, `slot_pool`, `reruns`, `note`
- `type`: `start`, `done`, `review`, `rerun`, `stall`, `nudge`, `wave`, `escalation`, `decision`, `retro`, `gate`, `capacity`, `cleanup`
- a `review` event with a `head` (the commit a review covered), written by `reviewed.mjs` (also `path`, `branch`, `reviewSha`, `file`, `tip`, `by`) or by `docsonly.mjs` (`path: docs-only`, `paths`): the wave merges that commit. Reviews recorded without these fields (for calibration) carry a `role` and are not read by the wave
- a `waiver` event, written only by `waiver.mjs` (`by`; `journal.mjs` refuses the type and the keys `type=`, `task=`, `ts=`, `by=`; a hand-appended line is not stopped, debt F55): the recorded decision of the Front agent or the owner (`decider`: `front-agent` or `owner`, `words` verbatim, `reason`, `followUp`) that one failed review holds no blocker: `head` (reviewed commit), `branch`, `reviewSha`, `file` and `path` name that review, `findings` the finding ids it covers, `level` the ticket's level as read from the main branch (with GitHub issues from the task's own record: the `taskref` event `mkspec` writes when it first makes a spec for the task and its issue, and the `claim` of that issue). `decider` and `words` are the caller's claim: nothing checks who spoke, and the class of a finding is the reviewer's claim. The wave event of a wave that carried one has a `waived` note. `status --json` lists them (`work.waivers`).
- a `taskref` event, written by `mkspec` (`by: mkspec.mjs`; `journal.mjs` cannot write it, a hand-appended line is not stopped, debt F55), with GitHub issues: the first time a spec is made for a task id and its issue (`ref`: `#<n>`). A waiver reads the ticket level through it; a second, different issue for the same task id makes the binding ambiguous (the level is then unknown: the owner decides; `mkspec` warns). The binding is the reference the first `mkspec` call for the task was given, so it is only as true as that call; a task with no `mkspec` spec has none and is the owner's.
- `reason`: `functional`, `coverage`, `load-timeout`, `environment`, `spec-gap`, `security`, `early-stop`, `other`

## Pipeline Auditor

A read-only worker that audits the factory, not the product.

- **When:** every night after the last wave, and immediately on a cluster (three same-reason failures or three stalls within an hour).
- **Reads:** the journal, the load log, reviews and reports since the last audit, the debt register, the rules in force.
- **Asks:** Where is time lost (gate waits, reruns, review rounds, stalls, early stops)? Which failure reasons cluster, by role, model and agent? Which rules or templates cause rework? Which risks grow (debt, flaky tests, load, quotas)? Did the last improvements meet their success metrics?
- **Delivers:** one page under `audits/<date>-<n>.md` with the top 3 improvements and top 3 risks, each with a measured value, a cause, a proposal, a level and a checkable success metric. The key points go into the morning handover.

Example from the first audit: the server was saturated in 88 of 188 minutes, peak load 46.7 on 12 threads. That finding produced the measured-capacity rule in [capacity.md](capacity.md).

## Fast lane

- The Controller may implement **level-1 improvements** on its own: docs, templates, controller scripts and tests. Never product behaviour, never the human's rules.
- At most **one** improvement task at a time, so features keep priority.
- Each runs as a normal task with a Tester.
- The next audit checks the metric. If an improvement did not work, it is reverted.
- Anything that changes the human's way of working, costs, capacity rules or a recorded decision goes to "Needs the human".

## Retro per agent run

Run the `retro` skill on **individual worker sessions**, so the environment the agents work in keeps getting better.

**Triggers (any one):** two failed review rounds on a task; an early stop; two stalls or nudges; the same self-caused error twice (same failing command, wrong branch or file, a forbidden action attempted); a model escalation; a defect that escaped to the human.

**How:** a read-only Retro worker reads the session log (Codex in `~/.codex/sessions/`, Claude in `~/.claude/projects/`), the reports, reviews and journal entries, and writes `retros/<task>-<n>.md` with 1–3 candidates ordered by severity. Each candidate names its category (navigation, automated checks, coding standards, AGENTS.md, tool economy, no-ops, information access), the measured cost it removes, and the concrete change, preferring an automated check over a new rule.

**Guardrails (from the skill's own guidance):**

- A retro improves the agents' **environment**: pointers, checks, reviewer standards, tool access. It does not change product code or the process rules.
- Every candidate traces to a concrete moment in the session log. Untraceable advice is discarded.
- Mechanical mistakes become automated checks. Judgement calls become reviewer standards (`CODING_STANDARDS.md`, the review protocol), never implementer prose.
- New rules never go into `AGENTS.md`/`CLAUDE.md`, which load into every session.
- A new check is tested on current `main` and the branches in flight before it blocks anything.
- Smooth runs get no retro.

## Debt register

`docs/debt.md` lists every known debt with origin, risk, proposal and size. Roughly a fifth of capacity goes into paying it down; the hardening phase takes the security, load and test categories in one go.
