# Roles

Five kinds of participants. The human talks to exactly one of them.

| Role | Where it runs | Does | Never does |
|---|---|---|---|
| **Human** (the project owner) | wherever they are | sets goals and priorities, accepts on the preview (their own machine, their own environment; automated tests never use real data), decides level-3 architecture and everything that touches real external systems or real data | – |
| **Front agent** | an agent session on the human's machine (Claude Code, Codex or Pi) | the only contact for the human. Takes wishes and test findings, turns them into tickets and specs, runs the outside-in stages, asks decisions one question at a time, reports the status as one table, writes the morning handover | steer workers itself; show the human the back-and-forth of the workers |
| **Controller** | an agent session on the server, unattended | starts and steers every worker, schedules tests, reviews and waves, detects stuck workers, cleans up, writes `status.md` after every cycle, runs the auditor and retros | talk to the human directly; take level-3, ADR or product decisions (those go to the human as questions) |
| **Workers** | one per task, each in its own worktree and terminal | see below | push to `main`; weaken tests |
| **Reviewers and observers** | workers too, read-only | Tester, Architect, Auditor, Retro | change code |

## Worker roles

| Worker | Does | Model (default) |
|---|---|---|
| **Developer** | implements exactly one task, test-first, on its own branch; keeps a checklist of every requirement in the report; pushes after each item; self-reviews against the spec before replying | default |
| **Tester** | independent reviewer of one task round; fresh context every round, never the Developer of that task; runs the full gates itself; writes a findings file with a verdict | default |
| **Architect** | checks every spec before the build (level, interfaces, seams), a coarse conformance check after level-2/3 builds, and architecture health after each merged wave | default; large for ADRs and level 3 |
| **Spec writer** | drafts large task specs and ADR proposals from the human's decisions; docs only | default |
| **Auditor** | reads the journal, load log, reviews and debt and writes the top 3 improvements and risks, each with a measured value | default |
| **Retro** | reads one hard worker session and proposes 1–3 traceable changes to the agents' environment | default |

Workers are named by task and role, for example `T22-S5 · Worker Developer`, never by an automatic session name ([naming rules](orca.md#naming)). A worker can be Codex, Claude Code or Pi; the specs, rules and reply format are the same.

## Who decides what

| Level | Example | Decides |
|---|---|---|
| 1 | a change inside one module that keeps its public API | the Developer, checked by the Tester |
| 2 | a new or changed public export, a new dependency, a new route | the Controller, after the Architect's spec review; the decision is written into the task or a decisions file |
| 3 | new module responsibilities, contracts, data flows, technology, anything that touches real external systems or real data | the human, through an ADR with options and a recommendation |

The Front agent asks the human **one question at a time**, multiple choice, with the recommended option first.

## Interfaces between Front agent and Controller

Files in the controller directory on the server (default `~/controller/`):

| File | Written by | Content |
|---|---|---|
| `status.md` | Controller, after every cycle, overwritten completely | worker table; what reached `main`; "Needs the human" with options and recommendation; acceptance items with a sentence to try; problems; next steps |
| `inbox.md` | Front agent | the human's answers and new orders, one dated line each; the Controller moves processed lines to `inbox-done.md` |
| `events.md` | Front agent (transition only) | worker events relayed from the human's machine |
| `journal.ndjson` | Controller | one JSON event per line, see [improvement.md](improvement.md) |
| `handover.md` | Front agent | what is in flight and queued when a Controller takes over |
| `CONTROLLER.md` | the factory (`init`) | the Controller's handbook |

Urgent answers can also be sent as text into the Controller's terminal; a file entry alone does not wake an idle agent.
