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

Every full gate goes through `gate <command>` (`controller/gate.mjs`, Node only; it is called by its absolute path, `<controllerDir>/gate`, so projects on one host do not share a gate file; the queue and the slots were always per project, so there is no host-wide limit on full gates). Gates are pooled: unit gates and browser gates have separate slot counts. Waiters queue as ticket files per pool; only the oldest live ticket may take a free slot, so newer gates cannot overtake older ones, and tickets of dead processes are swept. The slot counts are adapted to measured pressure by `capacity.mjs` (see [capacity.md](capacity.md)).

Developers' focused checks run **without** the gate; they are cheap.

**The wave runs the full gate itself.** This is a rule of the wave and of the Controller: workers and the Controller push code to the main branch only through the wave. For a change that is not documentation only (by the check below), the wave runs `commands.verify` (and `commands.e2e`, when set) through this project's gate, `<controllerDir>/gate`, on the merged candidate and pushes only when it passes. The wave's code enforces that for the wave: no earlier result stands in for the run (not a Developer's or a Tester's gate run, not a result cached by tree or commit, no evidence file, no option or environment variable), and a gate that is not this project's own is refused (see below). The Developer and the Tester may run the gate for their own feedback; that run is not proof for the wave, and the wave does not look at it. A gate run takes minutes at most, and a record of an earlier run would be a source of error of its own.

**What the hook does and does not check.** The pre-push hook checks that every code commit is covered by a passing review; it does not check that any gate ran, and it cannot stop a push made outside the wave. That a push to main goes through the wave is process, not something the repository enforces; only branch protection on the remote that admits the Controller's push alone would enforce it.

**What the wave refuses or stops on** (fail closed, with a message, never a silent pass): a `GATE` that is not an absolute path to an executable file named `gate`, that lies inside the worktree being judged, or whose directory has no `factory.config.json` naming this project (`wave.mjs` sets `GATE` and `WAVE_PROJECT` from the Controller's own configuration, `hosts.controller.controllerDir`); and a `commands.verify` that is empty or only whitespace. A command that is only whitespace is treated exactly like an empty one: an empty `commands.e2e` is skipped, and a blank `commands.formatCheck` or `commands.markdownCheck` counts as not configured (a docs-only wave with neither takes the full gate). `docsOnly.enabled` counts only as the JSON boolean `true`; the string `"true"` is off, as for the Controller and the push gate. The command strings come from the Controller's configuration (the docs-only checks from `origin/<main>`'s `factory.config.json`), never from the worktree being judged. The gate runs the commands those settings name; what those commands do is defined by the project's own files (scripts, test configuration), which the Tester reviews before the wave. The only way past the full gate is the documentation-only path below.

## Documentation-only changes

With `docsOnly.enabled: true` in the `factory.config.json` on the main branch, a change that touches documentation only skips the separate review, and a wave that holds nothing but documentation skips the full gates (the one case in which the wave does not run the full gate). Off by default: without the key every change takes the full path, as before. The Controller and the wave read the setting from `origin/<main>`, so it takes effect once it is on the main branch; no `agentic-factory update` is needed. How it gets there: [Turning it on](#turning-it-on).

**The check** is `node tools/factory-guardrails.mjs docs-only`, run at the repository root (with the untracked standard: `.git/factory/hooks/factory-guardrails.mjs`). It fails closed:

| Candidate | Command |
|---|---|
| a branch or commit range | `docs-only origin/main..origin/agents/t12` (what the head adds since the merge base, and every commit on the way) |
| a task branch of the Controller's flow | `docs-only origin/main..origin/agents/t12 --ticket T12` (`--issue <n>` in github-issues mode): the ticket's own spec review and report may be on it, see [the ticket's own process files](#the-tickets-own-process-files) |
| the staged changes | `docs-only --staged` |
| the working tree, untracked files included | `docs-only` |

`--base <ref>` replaces `origin/<main branch>` for the last two; `--json` prints the result as one JSON line. The check prints every changed path (JSON-quoted when it holds unusual characters), marks each one that is not documentation with the reason, and ends with one line `verdict=<…> paths=<n> reason="…"` for the journal or review record. Exit codes: **0** docs-only, **3** not docs-only, **4** unclear, **2** usage. Every caller treats anything but 0 as "not docs-only".

**Its settings come from the base of the candidate** (the merge base's `factory.config.json`), never from the candidate itself, so a change cannot widen its own allowlist. A path is documentation only when all of these hold:

- **A plain file, before and after:** mode `100644`. A symlink, a submodule, an executable file or a mode change is not.
- **A documentation file type:** Markdown (`.md`) or a raster image (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`). `.svg` and `.mdx` can carry code, so they count only when the project lists them in `docsOnly.extraTypes` (`["svg", "mdx"]`). A file without an extension never counts.
- **In the allowlist** `docsOnly.paths`: path patterns (`**` any depth, `*` and `?` within one directory, `{a,b}` alternatives). Default `["docs/**", "*.md"]`: under `docs/`, and Markdown at the top level. A project whose documentation lives elsewhere names its own directories; the list replaces the default. Each pattern must start with a directory name (`handbook/**`) or name top-level files (`*.md`); `**`, `**/*.md` or `{docs,src}/**` are refused as unclear.
- **Not a file the factory installs or reads as process state or agent instruction:** every file in the factory's record of what it installed (`.factory/manifest.json` in the base, or the untracked standard's `standard.json`), and in any case `AGENTS.md`, `AGENTS.factory.md`, `ARCHITECTURE.md`, `CODING_STANDARDS.md`, `design/`, `tools/`, `docs/adr/`, the protocols, `docs/coordinator.md`, `docs/dev-workflow.md`, `docs/debt.md`, `docs/process-decisions.md`, `docs/controller-rules.md`, the review findings (`docs/reviews/`), reports, handoffs, and the tickets (`docs/tasks/` or `steering.tasksDir`). Agents act on these, so a change to them keeps its Tester (except the ticket's own two files, below).
- **Not an agent instruction file in any spelling** (`CLAUDE.md`, `GEMINI.md`, `agents.md`, `SKILL.md`, `*.agent.md`, `*.prompt.md`, …) and not under a dot path (hooks, CI, tool configuration).

Matching ignores case: on a case-insensitive file system `docs/ADR/` is `docs/adr/`. Configured paths (`docsOnly.paths`, `steering.tasksDir`) are normalised first: backslashes become slashes, a leading `./` or `/` and a trailing `/` are dropped, so `./docs/tickets`, `/docs/tickets` and `docs/tickets/` all name the same directory. A value that names nothing inside the repository (`../tickets`, `C:/…`, empty) makes the check unclear; it is never dropped silently. A rename is a delete plus an add, so both sides must be documentation. **Unclear (exit 4):** an empty diff, an unmerged path, a missing base or head, an invalid setting, a commit on the way whose own changes cannot be told, any git error.

**The ticket's own process files.** Every task branch of the Controller's flow carries two files besides the ticket's change, and both sit in directories the factory reads as process state, so without a ticket the check refuses them. The files come from the flow itself (`controller/templates/mkspec.mjs`; a test keeps the names in step):

| File | Who writes it | Who reads it |
|---|---|---|
| `docs/reviews/<ticket>-architecture-spec.md` | the Worker Architect, on `<prefix><ticket>-specreview`; the Developer merges that branch into the task branch | the Developer, the Tester, the conformance review, and the push gate: it takes **every** file under `docs/reviews/` with `Verdict: pass` and a `Reviewed commit: <sha>` line as the independent review of that commit |
| `docs/reports/<ticket file name>.md` (`issue-<n>.md` for an issue) | the Developer, as a draft first and then over many commits (and a "Rework n" section) | the Tester; nothing parses it |

The findings files (`-review-<n>`, `-review-final`, `-architecture-conformance`) are written on their own branches and merged by the wave, never on the task branch; the ticket's `Status:` is changed by the wave's own `status-wave-<n>` branch. None of them belongs to a docs-only task.

With `--ticket <id>` (and `--issue <n>` in github-issues mode) the check accepts **exactly** those two names of **that** ticket, and only when all of this holds; every other path under `docs/reviews`, `docs/reports` or the tickets keeps the branch off the docs-only path as before:

- **The ticket comes from the Controller's records, not from the branch.** `docsonly.mjs` passes its `<task>` argument, and only when `<branch>` is that task's own branch (`project.branchPrefix` plus the id in lower case). In orca-tasks mode the ticket's file must exist exactly once in `steering.tasksDir` of the **base** tree, and the report is named after it; a ticket file the branch adds does not count. Anything it cannot establish (no such file, two of them, a ticket directory that overlaps `docs/reviews` or `docs/reports`, another branch) accepts no process file, and the check says why.
- **New files, plain and exact:** absent on the base (so not modified, deleted or renamed), mode `100644`, the exact name including case. A second file of a kind, another ticket's file (`T030` is not `T03`) and a case variant are other files.
- **Never a findings file.** A content that mentions `Reviewed commit` in any spelling or spacing is refused, in every commit of the range, not only at the tip: a forged findings file would let unreviewed code through the push gate (the first review of #52, finding 2). A real spec review carries a `Verdict` and the SHA it read, never a `Reviewed commit`.
- **At least one real documentation change** must be there: process files alone are not a docs-only task.

Not covered, by design: a ticket changing its `Status:` (a docs-only task never carries one; the wave's status branch does), a findings file, a proposed ADR (level 3 is never docs-only).

**Markdown that is compiled is not inert.** Some site generators compile `.md` as MDX (imports, components), and some products load Markdown files as prompts or content. A project where that is so either leaves `docsOnly` off or narrows `docsOnly.paths` to the Markdown that nothing compiles or loads.

**The gate path.** The wave decides, before it merges anything, from `origin/<main>`: whether the path is on, which checks it runs, and the classifier itself (main's `tools/factory-guardrails.mjs`, or the clone's installed standard), so a branch in the wave cannot choose its own gate path. A wave whose merged changes the check calls docs-only runs only `commands.formatCheck` and `commands.markdownCheck` (one that is not configured is skipped) instead of `commands.verify` and `commands.e2e`, and pushes. The wave's own call has no ticket, so it does **not** accept the process files: a wave that holds a docs-only task's spec review and report, or the `status-wave-<n>` branch that sets `Status: integrated` (every wave in orca-tasks mode), takes the full gates once, as for code. What a docs-only task saves in the real flow is its Tester round and its review branch, not the wave's gate run. If neither is configured, it runs the full gates: a docs-only wave never pushes after running nothing. Its output carries the check's evidence and a line `GATE-PATH docs-only` or `GATE-PATH full` with the reason, which `wavewait.mjs` journals as a `gate` event. A wave that mixes documentation and code takes the full gates.

**No separate review.** For a docs-only task the Controller runs `node docsonly.mjs <task> <branch> [--ref "#<n>"]` instead of starting a Tester (it passes the ticket to the check, [above](#the-tickets-own-process-files); `--ref` names the issue in github-issues mode): it runs main's check on the pushed branch, prints the evidence and records it in the journal as the task's `review` event (`verdict=docs-only`, the head SHA and the paths). A failed fetch is unclear: review as usual. The push gate already lets documentation-only commits through without a findings file. With a `docsOnly.paths` of its own, the push gate exempts those paths too (under all the rules above), but only once the setting is on `main`: it reads the setting from the tree being replaced, so a push cannot widen its own exemption. Product code keeps its independent review before every push, unchanged.

### Turning it on

`docsOnly.enabled` is read from `factory.config.json` **on the main branch**, and the push gate reviews every change of that file there (it is configuration, not documentation): a plain push is refused with "A findings file under docs/reviews/ with Verdict: pass and Reviewed commit … must be in the pushed tree". There is deliberately no shortcut: a setting that removes reviews must not be one that can be changed without one. The routes:

1. **At onboarding.** `agentic-factory init` asks "Allow documentation-only tasks to skip their separate review?" (answer id `docsOnly.enabled`, default no). The answer goes into the adoption commit, which is how `factory.config.json` reaches main for a new project.
2. **Later: a ticket through the normal path.** Write a ticket whose result is the config change (`"docsOnly": { "enabled": true }`, and the `commands.formatCheck` / `commands.markdownCheck` a docs wave should run); it gets its spec review, Developer, Tester and wave like any task, and the Tester's passing findings let the push gate accept it. Three things to know first: the guardrails that understand `--ticket` must already be on main (or in this clone's standard): `agentic-factory update` refreshes `tools/factory-guardrails.mjs`, and as a protected file its commit needs an accepted ADR reference like any change to it; an older check on main gives `docsonly.mjs` no verdict, so every task keeps its Tester (safe, just not useful); and the wave runs the full gates for a task with process files, so `commands.formatCheck` and `commands.markdownCheck` only matter for a wave of documentation alone.

There is no `agentic-factory` command that edits the file on main, and nothing the Controller may do by hand: pushing to main goes through the wave.

## Formatter on staged files

`commands.formatStaged` runs the project's formatter in write mode on the staged files in `pre-commit`, so a format error never costs a gate run or a review round. Off unless the project names a command. Either a string, to which the staged paths are appended as arguments:

```json
"formatStaged": "pnpm exec prettier --write --ignore-unknown"
```

or `{ "command": "…", "paths": ["**/*.py"] }` to pass only matching files. What it does:

- **Fully staged files only:** added and modified regular files whose working copy equals the staged version, a renamed file under its new path. Deleted files, symlinks and submodules are not passed.
- The formatted bytes are staged under the mode that was staged, so the commit holds the formatted version and nothing the user did not stage (no unstaged `chmod`, no lost executable bit).
- **Partially staged files are skipped and named:** a file with unstaged content, an unstaged mode change, or deleted in the working tree is committed exactly as staged, and its working copy is never touched. Stage it fully to have it formatted. No `git stash` (the stash is shared by all worktrees of a clone), no backups to lose.
- A failing formatter fails the commit with its output and puts the working copies back as staged. If a later pre-commit step fails (the secret scan, the test count, lint), the formatting is taken back too, so the staged files are as the user staged them. A commit stopped afterwards by the commit message hook keeps the formatted version, in the index and the working copy alike.
- `git commit <paths>` (`--only`) is not formatted: git commits it from a temporary index, and formatting only that one would leave the real index with the unformatted version. Stage the files and commit without paths.
- Merge, cherry-pick and revert commits are not reformatted: their content was formatted on its branch, and a reformatted merge would carry unreviewed changes.

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
