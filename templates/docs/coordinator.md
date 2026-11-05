# Coordinator handbook

These rules bind whichever agent coordinates work in this repo: the Front agent on {{HUMAN}}'s machine and the Controller on the server. Workers follow `AGENTS.md`. {{HUMAN}} owns every decision that is not delegated here.

`docs/dev-workflow.md` explains this workflow to people. {{WORKFLOW_SYNC}}

**Only {{HUMAN}} decides for {{HUMAN}}:** "Decided by {{HUMAN}}" needs {{HUMAN}}'s quoted statement with a date. Anything an agent chose is written as `Assumption:` until {{HUMAN}} confirms it, and no reviewer holds work to an assumption as if it were a decision. The sections marked "decided by" below were confirmed at adoption.

**Process decisions go into the docs immediately:** whenever {{HUMAN}} and a coordinator decide something about the way of working, the coordinator updates {{COORDINATOR_UPDATES}} in the same turn, marked "decided by {{HUMAN}}, <date>". An agent's private memory is never the only record.

## Roles

- **Front agent:** talks to {{HUMAN}}; tickets and specs; the outside-in stages; one question at a time with the recommended option first; status as one table; morning handover. Does not steer workers.
- **Controller:** runs unattended on the server; starts and steers workers; Testers, Architects, waves, stall watch, escalation ladder, cleanup, journal, auditor, retros; writes `status.md` after every cycle. Never talks to {{HUMAN}} directly; questions go into `status.md` under "Needs {{HUMAN}}".
- **Worker Developer:** implements exactly one task on its own branch and worktree. Never pushes to `{{MAIN}}`.
- **Worker Tester:** independent reviewer of one task round per `docs/review-protocol.md`. Never the Developer of that task; fresh context every round; read-only except its findings file.
- **Worker Architect:** spec review before every build, coarse conformance for level 2/3 after the build, architecture health after each merged wave (`docs/architect-protocol.md`).
- **Worker Auditor / Retro:** read-only; audits the factory, not the product.

## Outside-in development (decided by {{HUMAN}}, {{DATE}})

New features go from the outside in. Nothing is built until {{HUMAN}} has signed off the UI (design drafts plus a clickable front-end fake with invented data), the interfaces (data in and out) and the logic (words plus a Mermaid diagram, agreed through `grilling`; `wayfinder` for multi-session efforts). Then `to-spec`, `to-tickets`, and the build. Design exports go into `design/<feature>/` so workers never need the design tool. Defects in already agreed behaviour go straight to the build.

## Functionality first (decided by {{HUMAN}}, {{DATE}})

- A review fails only for a real functional defect: a specified flow does not work or gives wrong results, data is lost, or a change could reach a real external system (production, real accounts, {{HUMAN}}'s real data).
- Tests, coverage, edge cases, security, load and style are debt candidates with a category (`tests`, `edge-case`, `security`, `load`, `style`), a severity and a one-line proposal. They never fail a review. They are collected in `docs/debt.md` and worked off in a **hardening phase** once the functional breadth is there; {{HUMAN}} starts it, the Front agent proposes it.
- Architecture conformance is a coarse boundary check.
- **Spec reviews keep proportion too:** at most {{MAX_ROUNDS}} rounds on a spec. An edge case that causes no real functional defect becomes debt.
- At most {{MAX_ROUNDS}} review rounds, then integrate if the feature works; open points become debt plus an acceptance item for {{HUMAN}} on the preview.
- **Always on:** code quality (`ponytail-review`, `CODING_STANDARDS.md`) and architecture conformance (level, exports, dependencies, data flows, import boundaries) are checked in every review. An architecture violation blocks; quality findings are fixed when trivial, otherwise debt with a follow-up.
- **Not in daily runs, mandatory before release:** load and security tests slow development down (observed), so they do not run in task or wave gates. The deferred categories (`security`, `load`, `tests`, `edge-case`) are paid in the hardening phase and before every release; the release gate runs the security and load tests in addition to `{{RELEASE}}`. No release while such a debt item is open or failing, unless {{HUMAN}} accepts the specific item in writing in `docs/debt.md`. The Controller reports open debt by category in every `status.md`; the Front agent proposes the hardening phase in time.

## Test stages (decided by {{HUMAN}}, {{DATE}})

- Developer: targeted checks only (typecheck, lint, affected suites, the browser specs covering the change). No full suites.
- Tester and wave: full `{{VERIFY}}` and `{{E2E}}` on current `{{MAIN}}` plus the branch.
- Release only: `{{RELEASE}}`. Never per task or per wave.
- Every full gate runs through `gate` (fair slots, pooled by unit and browser), as `gate bash -c '<command>'` because `gate` starts a program without a shell.

## Capacity by measurement (decided by {{HUMAN}}, {{DATE}})

The Controller runs `node capacity.mjs` before every start and follows its verdict (pressure stall information, available memory, gate queue, foreign load, quotas). Starting values: at most {{SUITE_MAX}} suite workers and {{READONLY_MAX}} read-only workers; gate slots {{UNIT_SLOTS}} unit and {{E2E_SLOTS}} browser, adapted to pressure. Under pressure: critical path, nearly finished tasks, waves, new development, debt. Every worker gets a memory and process limit where the runner supports it.

## Models (decided by {{HUMAN}}, {{DATE}})

- `{{MODEL_DEFAULT}}` is the default for Developers, every Tester and spec reviews.
- `{{MODEL_SMALL}}` for mechanical checklist work.
- `{{MODEL_LARGE}}` only for ADRs and level-3 work, and at the top of the escalation ladder.
- **Escalation ladder:** after two failures on the same task the next attempt runs one tier higher.
- **Quota fallback:** below {{QUOTA_THRESHOLD}} % of {{AGENT_DEFAULT}}'s weekly quota, new workers start with {{AGENT_FALLBACK}} ({{MODEL_SMALL}} → {{FB_SMALL}}, {{MODEL_DEFAULT}} → {{FB_DEFAULT}}, {{MODEL_LARGE}} → {{FB_LARGE}}). Running workers finish. Switch back after the reset. Record every reading in `status.md`.

## Review loop

1. Developer done → Tester (fresh context) on current `{{MAIN}}` plus the branch.
2. Tester failed → rework in the same worktree with the findings unchanged; after two failures one tier higher.
3. Tester passed → conformance review for level 2/3, else into the next wave.
4. A wave starts when {{WAVE_PASSED}} passed tasks wait, one has waited {{WAVE_MINUTES}} minutes, or a task is on the critical path. The wave merges, runs the full gates once, and pushes to `{{MAIN}}`.
5. A red wave: a known load flake gets one isolated rerun; three green isolated runs are the evidence. A real failure goes back to the task.
6. Merge conflicts are resolved by the task's Developer on its branch and checked by a Tester.

## Cleanup after every cycle (decided by {{HUMAN}}, {{DATE}})

Close finished workers' terminals, release or abandon their dispatches, remove worktrees whose branch is merged or safely pushed (push a WIP branch first if anything is uncommitted), delete merged branches, keep active and paused tasks. Run `node cleanup.mjs` at the end of every cycle and report the counts in `status.md`.

## Audit and improvement workflow (decided by {{HUMAN}}, {{DATE}})

- **Journal:** one JSON line per event in `journal.ndjson` (`node journal.mjs <type> <task> k=v…`).
- **Auditor:** every night after the last wave and on clusters (three same-reason failures or three stalls within an hour): a read-only Pipeline Auditor writes `audits/<date>-<n>.md` with the top 3 improvements and risks, each with measured value, cause, proposal, level and success metric.
- **Fast lane:** level-1 improvements (docs, templates, controller scripts, tests) the Controller implements itself, at most {{FAST_LANE_MAX}} at a time, as normal tasks with a Tester. Everything that changes {{HUMAN}}'s way of working, costs, capacity rules or a recorded decision goes to "Needs {{HUMAN}}".
- **Retro per agent run:** triggers are two failed review rounds, an early stop, two stalls or nudges, the same self-caused error twice, a model escalation, or a defect that escaped to {{HUMAN}}. A read-only Retro worker follows `.agents/skills/retro/SKILL.md`, reads the session log, and writes `retros/<task>-<n>.md` with 1–3 traceable candidates. Mechanical mistakes become automated checks; judgement calls become reviewer standards; nothing new goes into `AGENTS.md`.

## Starting workers

- **Parallel tasks:** before they start, the plan names each shared interface with exact fields and one test through the real producer and consumer. A task states what it depends on in its spec, not only in a message.
- Name every worker `<Task> · Worker <Role>`, and every sidebar entry and terminal after its role or task. Never keep an automatic name. `start.mjs` and `names.mjs` do this; other terminals in an entry are `<entry name> · <Purpose>`. On a shared host, name only your own project's entries.
- Generate every spec from the template (`templates/mkspec.mjs <role> …`) with parameters. Never derive a spec by editing another task's spec.
- Specs have numbered steps, "done when", abort criteria, a self-review against the spec, and the reply format (`worker_done` with branch, head SHA and check results, or one concrete escalation with progress pushed).
- Workers can be Codex, Claude Code or Pi; the specs and rules are the same.

## Talking to {{HUMAN}}

- One question at a time, multiple choice, recommended option first.
- Status as one table: task, role, model, since, state, next step. Below it: new on `{{MAIN}}`, "Needs {{HUMAN}}", acceptance items with a sentence to try, problems, next steps.
- Before saying "it works": verify it in the real preview through the handed-out address.

## Data and safety rules (never delegate, never relax)

- No outward effects: agents and their tests change nothing outside the repository and the demo or test environment (no production systems, real accounts, sending, deploying or deleting). Whether the product acts on external systems is a product decision recorded in this project's docs.
- Tests run on demo data or a private copy of {{HUMAN}}'s data. The original is never written or deleted.
- No real data in the repo: no company values, names, addresses or secrets in code, tests, fixtures, reports or status files. `.env` is never committed. Filter `pair|token|code=` from any printed output.
- Workers never push to `{{MAIN}}`. `--no-verify` is forbidden. No real model calls in tests.
- Work data never goes to the build server. Demo data and invented secrets only.

## Decision history

Append dated sections below as decisions are made. Superseded rules stay here with "superseded by …" and are removed from `docs/dev-workflow.md`.
