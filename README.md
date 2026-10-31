# agentic-factory

**A DevOps harness for building software with coordinated AI agents.**

One human. One agent that talks to them. One unattended controller that runs many workers on a server, with independent reviewers, measured capacity and a pipeline that audits and improves itself. Every rule in here was earned on a real project; every rule carries the decision and the reason behind it.

- **Intro:** open [`site/index.html`](site/index.html) for the ten-minute overview.
- **Getting started, step by step:** [`docs/getting-started.md`](docs/getting-started.md) (English), [`docs/de/erste-schritte.md`](docs/de/erste-schritte.md) (Deutsch). From zero to the first reviewed change on `main`, all on your own machine.
- **Process for people:** [`docs/workflow.md`](docs/workflow.md) (English), [`docs/de/workflow.md`](docs/de/workflow.md) (Deutsch).
- **Set up a project:** `npx agentic-factory init` in your repo (see [Quick start](#quick-start)).

## What you get

| Part | What it is |
|---|---|
| **Roles** | Front agent (talks to the human), Controller (runs unattended), workers: Developer, Tester, Architect, Auditor, Retro. [`docs/roles.md`](docs/roles.md) |
| **Outside-in** | New features start with UI drafts and a clickable fake, then data in and out, then the logic as words and diagrams. Code comes last. [`docs/outside-in.md`](docs/outside-in.md) |
| **Reviews that bite** | Nobody accepts their own work. Reviews fail only on real functional defects; everything else becomes categorised debt for a hardening phase. Git refuses pushes to `main` without a passing review. [`docs/reviews.md`](docs/reviews.md) |
| **Test stages** | Developers check what they touched, Testers and waves run everything, Docker only at release. [`docs/testing.md`](docs/testing.md) |
| **Measured capacity** | The Controller starts workers by measured pressure, not by a fixed count. Gates run in fair slots. Models by complexity with an escalation ladder and a quota fallback. [`docs/capacity.md`](docs/capacity.md) |
| **Self-improvement** | An event journal, a nightly pipeline auditor, retros per hard agent run, a fast lane for small fixes. [`docs/improvement.md`](docs/improvement.md) |
| **Two steering modes** | GitHub issues, or task files with Orca. Same roles, same rules. [`docs/steering-modes.md`](docs/steering-modes.md) |
| **Tools** | Controller scripts (`controller/`), Front-agent scripts (`front-agent/`), git guardrails and project templates (`templates/`), server setup (`server/`), vendored skills (`skills/`). |

## Quick start

**Requirements**

| | |
|---|---|
| **Orca** (required) | [orca.earendil.works](https://orca.earendil.works). The runner: every worker gets its own worktree and terminal, the Controller and workers exchange structured messages, remote servers are paired over a private network. `init` stops if the Orca CLI is missing. The Orca skills (`orchestration`, `orca-cli`) must be installed at user level on every host that runs a Controller or Front agent (`agentic-factory install-skills`). |
| **One agent CLI** | Codex, Claude Code or Pi, logged in. Workers, Controller and Front agent are sessions of these. |
| **Node 22+, git** | the scripts and hooks |
| optional | a Linux server for the Controller and workers ([`docs/server-setup.md`](docs/server-setup.md), about an hour); `gh` for GitHub-issue steering; Figma or Pencil for stage 1 of outside-in |

A plain-terminal runner without Orca exists behind `init --experimental-terminal-runner`. It is unsupported and not what the docs describe.

```bash
cd your-project
npx github:<your-fork>/agentic-factory init     # or: npx agentic-factory init, once published
```

`init` is the onboarding. It asks the questions a new project has to answer, writes `factory.config.json`, copies the handbooks, templates, hooks and skills into your repo, and prints the next steps for the human (logins, pairing, loading the preview). It never touches an existing file without showing the diff. [`docs/onboarding.md`](docs/onboarding.md) explains every question.

Then, on **every machine that runs a Controller or a Front agent**:

```bash
npx agentic-factory install-skills   # the Orca skills (orchestration, orca-cli) and the coordination skills at user level
```

Those two sessions run outside the project repo and cannot see its `.agents/skills`. Without the Orca skills an agent cannot start, watch or release workers; this is the one step people forget.

Later:

```bash
npx agentic-factory update    # re-render from a newer factory; files you changed are kept, new versions land in .factory/new/
npx agentic-factory doctor    # check hosts, tools, hooks, user-level skills and config
```

## Known limits (read before you trust the gates)

- The git guardrails are **local hooks**. They stop honest mistakes; they are not a security boundary. Protect `main` on the server side too (branch protection, a CI check). See [`debt.md`](debt.md).
- The staged-secret scan knows a handful of common patterns. Add a maintained scanner for anything sensitive.
- The test-count guard is a heuristic: it counts test calls in test files. A dummy test keeps the count.
- GitHub-issue steering has had less mileage than task files; the plain-terminal runner is experimental and unsupported.
- An independent review of this repo and its findings are in `docs/reviews/`; what is not fixed yet is in [`debt.md`](debt.md).

## How it works, in one picture

```mermaid
flowchart LR
  H[Human] <--> F[Front agent<br/>on the human's machine]
  F -- orders, answers<br/>inbox.md --> C[Controller<br/>on the server, unattended]
  C -- status.md --> F
  C --> D[Developer]
  C --> T[Tester]
  C --> A[Architect]
  C --> U[Auditor / Retro]
  C --> M[(main)]
  M --> P[Preview on the<br/>human's machine]
  P --> H
```

The human talks only to the Front agent and sees one status table. The Controller reads the human's answers from `inbox.md`, runs workers, reviews, waves and cleanup, and writes `status.md`. Work flows to `main` only through a wave with passing reviews. The human tests on a local preview that follows `main` on its own.

## Principles

1. **Functionality first.** A review fails only when a specified flow does not work, data is lost, or something real would leave the system. Tests, edge cases, security, load and style become debt with a category and a follow-up, worked off in a hardening phase.
2. **Outside-in.** Agree the surface, then the data, then the logic, each signed off by the human, before any code.
3. **Back pressure, not trust.** The reviewer is never the builder. The reviewer runs the gates itself. Git enforces review coverage on `main`.
4. **Measure, then decide.** Capacity, flakiness and process changes come from the journal and the load log, not from feelings.
5. **Decisions are written down the moment they are made**, with who decided and why, in the project's handbooks.
6. **The factory has no outward effects.** Agents and their tests change nothing outside the repository and the demo or test environment: no production systems, no real accounts, no real data, no sending, deploying or deleting. Whether and how the *product* acts on external systems is a product decision of the project, recorded in its own docs.
7. **No real data, no secrets, no `--no-verify`.** Ever.

## Repository layout

```
bin/            the CLI: init (onboarding), update, doctor
docs/           the process, for people (EN) and docs/de (DE)
templates/      files that init copies into a project (handbooks, hooks, guardrails, task and ADR templates)
controller/     the Controller handbook and its scripts (start, wait, stall watch, wave, cleanup, capacity, gate, journal, spec templates)
front-agent/    the Front agent handbook and its scripts (status watch, relay, preview updater)
server/         scripts that set up a Linux build server with Docker, Node, the agent CLIs and Orca
skills/         vendored skills with pinned sources and licenses (ponytail, engineering skills, retro, wayfinder, prototype)
site/           the single-page intro
```

## A start, not an end state

Version 0.1.0, extracted on 2026-10-31 from a project that has run this way since 2026-10-27. It is meant as a **starting point**:

- every project gets its own copy through `init` and changes it freely; `update` brings newer factory versions in without overwriting local changes (new versions land in `.factory/new/` for you to merge)
- what proves itself in a project flows back into the factory as a pull request
- the numbers in the config (capacity, models, rounds) are starting values that the factory calibrates from measurements
- a remote server is an option, not a must; so is the day/night rhythm; so is Orca

The tools target Linux servers and macOS, with Orca as the runner everywhere.

## License

MIT. Vendored skills keep their own MIT licenses, see [`skills/SKILLS.md`](skills/SKILLS.md).
