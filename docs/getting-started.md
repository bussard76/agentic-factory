# Getting started: from zero to the first wave

This guide takes a new project from nothing to the first reviewed change on `main`, with everything on your own machine. A remote server comes later and is optional. Budget about an hour, most of it reading.

## 0. What you need

- **Node 22+**, **git**, and a repository for your project (a fresh `git init` is fine).
- **One agent CLI** logged in: Codex (`codex`), Claude Code (`claude`) or Pi (`pi`). Workers, the Controller and the Front agent are all sessions of these.
- Optional: **Orca** (gives every worker its own worktree and terminal, and remote servers), **gh** (for GitHub-issue steering), **Figma** or **Pencil** (for stage 1 of outside-in).

## 1. Get the factory

```bash
git clone https://github.com/<owner>/agentic-factory ~/agentic-factory
alias agentic-factory='node ~/agentic-factory/bin/agentic-factory.mjs'
```

(Once published to npm, `npx agentic-factory` replaces the alias.)

## 2. Run the onboarding in your project

```bash
cd ~/path/to/your-project
agentic-factory init
```

`init` asks one question at a time, recommended answer first. For a first try, accept the defaults with one exception: answer **"Only on this machine"** for the hosts question. The questions and why they matter are in [onboarding.md](onboarding.md).

It writes:

| | |
|---|---|
| `factory.config.json` | every project-specific value; no secrets |
| `AGENTS.md`, `CODING_STANDARDS.md` | the agents' rules and the reviewer's standards |
| `docs/coordinator.md`, `docs/dev-workflow.md`, `docs/review-protocol.md`, `docs/architect-protocol.md`, `docs/debt.md` | the handbooks, filled in for your project |
| `docs/adr/0001-adopt-agentic-factory.md`, `docs/tasks/T00-template.md` | the adoption ADR and the ticket template |
| `.githooks/`, `tools/factory-guardrails.mjs` | the git guardrails, already activated (`core.hooksPath`) |
| `.agents/skills/` (+ `.claude/skills` link) | the vendored skills |
| `.factory/controller/`, `.factory/front-agent/`, `.factory/server/` | the bundles for the Controller, the Front agent and a future server |

Read `docs/dev-workflow.md` once. It is the whole process in plain language.

## 3. Commit the adoption

```bash
git add -A
git commit -m "Adopt agentic-factory (ADR-0001)"
```

The ADR reference is required: `AGENTS.md`, the hooks and the ADR folder are protected files. Try committing without it once to see the hook speak. Then run `agentic-factory doctor`; everything should be `OK` except the Controller, which is not running yet.

## 4. Start the Controller

```bash
cp -R .factory/controller ~/controller
install -m 755 ~/controller/gate ~/.local/bin/gate
(cd ~/controller && nohup bash loadlog.sh >/dev/null 2>&1 &)
```

Open a terminal in `~/controller` and start an agent session there, for example:

```bash
claude "Read ~/controller/CONTROLLER.md and act as the Controller for this project."
# or: codex "Read ~/controller/CONTROLLER.md and act as the Controller for this project."
```

The Controller reads its handbook, pulls the project, finds no tickets, writes `~/controller/status.md` and waits. Look at the status file: that is what the Front agent will show you.

## 5. Start the Front agent

```bash
mkdir -p ~/front-agent && cp -R .factory/front-agent ~/front-agent/<project>
```

In your project directory, start a second agent session:

```bash
claude "Read ~/front-agent/<project>/FRONT_AGENT.md and act as the Front agent. I am <your name>."
```

From now on you talk only to this session. Ask it for the status; it reads `~/controller/status.md` and shows you the table.

## 6. The first feature, outside-in

Tell the Front agent what you want. It will:

1. sketch the **surface** with you (a Figma frame or a clickable fake via the `prototype` skill) and export it to `design/<feature>/`
2. list the **data in and out** on the fake
3. agree the **logic** with you as words and a Mermaid diagram (`grilling`)
4. write the **ticket**: `docs/tasks/T01-<slug>.md` from the template (or a GitHub issue labelled `ready-for-agent`), with `Status: ready`
5. drop a line into `~/controller/inbox.md`

Keep the first feature tiny: one visible behaviour, one or two acceptance sentences. The point is to see the machine turn once.

## 7. Watch the machine turn

The Controller picks the ticket up on its next cycle (every 10 minutes, or immediately when nudged). You will see, in `status.md` and in your worktrees under `~/orca/workspaces/<project>/` (or wherever `workspacesDir` points):

1. **Architect** spec review → `docs/reviews/T01-architecture-spec.md`, `Verdict: pass`
2. **Developer** builds test-first on `agents/t01`, pushes, reports
3. **Tester** reviews on current `main` plus the branch, runs the full gates through `gate`, writes `docs/reviews/T01-review-1.md`
4. on `fail`: rework in the same worktree; on `pass`: the **wave** merges to the integration branch, runs the gates once, pushes to `main`
5. **cleanup**: finished worktrees disappear, the status shows the counts

Try pushing something to `main` by hand without a review. The pre-push hook refuses it and tells you why.

## 8. Accept on the preview

If you enabled the preview, `front-agent/preview-update.sh` keeps a separate clone on the current `main` and restarts your app on the configured port every time `main` moves. Load it as a launchd agent (macOS) from `preview.plist.template`, or run it from cron. Test the new behaviour there; findings go to the Front agent and become tickets.

## 9. Later: a remote server, more hosts, the night shift

- **Remote server:** follow [server-setup.md](server-setup.md) with `.factory/server/`, add the host to `factory.config.json` → `hosts.workers`, set `hosts.controller.host` to it if the Controller should move there, run `agentic-factory update`, copy the new `.factory/controller/` bundle to the server. Several hosts work the same way; `start.mjs --on <host>` picks one.
- **Rhythm:** `rhythm.mode` switches between day-plan/night-build, continuous and custom quiet hours.
- **Calibration:** leave `capacity.calibration.mode` and `agents.calibration` on `auto`. The caps and model tiers start low and move with the measurements; the nightly audit tells you what changed and why.
- **GitHub issues** instead of task files: `steering.mode: github-issues`, create the labels, run `setup-matt-pocock-skills` once so `wayfinder`, `to-tickets` and `to-spec` use the same tracker.

## 10. When something is off

| Symptom | Look at |
|---|---|
| `init` refuses or a hook blocks a commit | the message names the rule and the file; `--no-verify` is never the answer |
| Controller does nothing | `~/controller/status.md` (is it fresh?), `inbox.md` (is the ticket `ready`?), `node capacity.mjs --verbose` (is it waiting for capacity?) |
| A worker sits idle | `node stallwatch.mjs` output; in Orca, send a line into its terminal |
| Tests flake under load | `~/load.log`, the journal (`type: gate`), lower `capacity.calibration.startSuite` |
| You changed a template and `update` keeps your version | that is intended; the new upstream version is in `.factory/new/` for you to merge |

Everything the factory decides is in the journal (`~/controller/journal.ndjson`), everything you decide goes into `docs/coordinator.md` and `docs/dev-workflow.md` the moment it is decided.
