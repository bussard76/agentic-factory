# Review: agent entry (START.md, `init --print-questions/--answers`, `status`, `start`)

Reviewed commit: 74769144be0ee5f71f36a7f444296db7bfbc29b3 (branch `bussard76/factory-agent-entry`, commits 1ba3d20 and 7476914 on top of `main`).
Reviewer: Fable (independent, one round). Read: `git diff main...HEAD`, START.md, front-agent/FRONT_AGENT.md, bin/agentic-factory.mjs, docs/getting-started.md, docs/de/erste-schritte.md, README.md, docs/onboarding.md, test/smoke.test.mjs. All line numbers refer to `bin/agentic-factory.mjs` at the reviewed commit unless a file is named.

## (a) Tests

Every run used a temporary `HOME`, `FACTORY_SKIP_ORCA=1`, and a `PATH` prefixed with stub `orca`, `claude`, `codex` binaries (`exit 0`). The real Orca was never called; no network was used. One exception, reported honestly: in scenario (c) the configured remote alias `srv` made `status`, `start` and `doctor` run `ssh srv` (and `rsync -e ssh`), which failed on hostname resolution in 0–2 s. Nothing was reached.

| # | Command (in the temp project) | Outcome |
|---|---|---|
| 1 | `node bin/agentic-factory.mjs selfcheck` | `selfcheck ok`, exit 0 |
| 2 | `node --test test/smoke.test.mjs` | 28 pass, 0 fail (63 s); the new test "agent entry questions, answers, status and start in an isolated home" passes |
| 3 | stdin: `sleep 12 \| { node … status --json; }`, same for `init --print-questions` and `start` | each exits after 0 s with stdin still open; no command waits on stdin |
| (a) | fresh Node repo (`package.json` with test/lint/dev/typecheck scripts, one commit) | |
| a1 | `status --json` | all prerequisites ok, `initialised:false`, `phase:onboarding` |
| a2 | `init --print-questions` | exit 0, JSON with 27 questions, every one with a stable id (`project.name` … `skills.installNow`), `open` lists all 27; `git status --porcelain` empty, `git remote` empty, `$HOME` untouched (no `.factory-remotes`) |
| a3 | `init --print-questions --answers {hosts.where:both}` | follow-ups `hosts.remote.name/ssh/sshConfig` appear; `hosts.controller` now offers `local,build-server`, recommended `build-server`; `open` shrinks by one |
| a4 | `init --answers {agents.default:invalid}` | exit 1, `--answers: "agents.default" must be one of codex, claude, pi (got "invalid")`; tree clean, no remote created |
| a5 | `init --answers <14 answers: both, controller local, claude, preview port 8181, rounds 2, …>` | exit 0; `factory.config.json` carries every answer (humanName, language, claude + haiku/sonnet/opus, hosts local+build-server, port 8181, rounds 2, design none, commands from package.json); local bare origin created, `Adopt agentic-factory (ADR-0001)` committed and pushed, 26 user-level skills installed |
| a6 | `status` | `MISSING Front agent bundle`, `MISSING Controller on local`, `Phase: start` |
| a7 | `start` twice | both exit 0; second run: skills `keep`, `Load log: already running`; outputs exist: `~/front-agent/proj-a/{FRONT_AGENT.md,…}`, `~/controller/{CONTROLLER.md,gate,loadlog.sh,skills,…}`, `~/.local/bin/gate` (0755), `~/.claude/skills` and `~/.agents/skills` (13 each); rendered FRONT_AGENT.md has 0 `{{` and the absolute CLI path; Controller session printed as a command (Orca skipped) |
| a8 | `ps -ax -o command \| grep home-a` | exactly one background process: `bash …/home-a/controller/loadlog.sh` (killed afterwards with `pkill -f`) |
| a9 | `doctor` | exit 1 only for `MISSING ssh bs reachable` (the fake alias); everything else OK |
| a10 | `status --json` | `setup.controller.running:false` (no status.md, no terminal) → `phase:start` again, as designed without Orca |
| (b) | empty `git init` repo (no commit, no package.json) | |
| b1 | `status --json` outside any repo | `phase:prerequisites`, missing `git repository → git init`, `git identity` |
| b2 | `init --print-questions` outside any repo | `{"blocker":"not a git repository: run git init first","questions":[]}`, exit 0 |
| b3 | `status`, `init --print-questions` in the empty repo | `onboarding`; 27 questions, commands recommended empty except `pnpm install`; nothing written |
| b4 | `init --print-questions --answers` with an unknown id `host.where`, `preview.port:"abc"`, `reviews.maxRounds:"x"`, `rules.confirm:true`, `skills.installNow:false`, `commands.e2e:null`, `project.repo:<the recommended sentence>` | exit 0; booleans mapped to yes/no, `null` to `""`; the unknown id is silently ignored; `abc` and `x` are accepted (finding 1) |
| b5 | `init --answers` with that file | exit 0, adoption committed and pushed to the local bare origin; config: `preview.port:null`, `reviews.maxRounds:null`, `project.repo:"local bare remote (init creates it under ~/.factory-remotes)"`; `~/controller/CONTROLLER.md` line 60 reads "After NaN rounds" |
| b6 | `start` twice, `doctor`, `update` | exit 0 / 0 / 0 / 0; `doctor` prints `preview not running on null`; `update` still works (5 updated, 0 kept) |
| (c) | repo with husky v9 hooks (`.husky/_`, own `pre-commit`, `core.hooksPath=.husky/_`, `prepare: husky`) | |
| c1 | `init --print-questions` | nothing written, `core.hooksPath` and `.husky/` untouched |
| c2 | `--answers {hosts.where:both, remote srv, hosts.controller:srv, codex}` | follow-ups present; `hosts.controller` options `local,srv` |
| c3 | `init --answers {hosts.where:local, hosts.controller:srv}` | exit 1, `must be one of local (got "srv")`; nothing written |
| c4 | `init --answers` (remote Controller) | merge mode: `.husky/pre-commit.own` kept, factory hooks written into `.husky/`, `core.hooksPath` stays `.husky/_`; adoption pushed; a test commit runs `own-pre-commit-ran` first and passes |
| c5 | `status`, `start`, `doctor` | `start` exit 1 in 0 s: `Controller bundle: copy to srv failed: ssh: Could not resolve hostname srv`, session command printed "on srv"; `doctor` exit 1 only for ssh; no background process left |
| phase | on (a) with a local `~/controller/status.md` written by hand | no status.md → `start`; fresh status.md, `- none` under `## Needs Sascha` → `outside-in: surface`; two bullets → `decisions` with both lines; table header only → `decisions` with the phantom item `\| Question \| Since \|` (finding 5); a bullet containing the word "none" → dropped (finding 5); `design/feat-a` only → `outside-in: data and logic`; + `T01` draft → same; ready/building/passed → `building`; integrated → `accept and next`; integrated + `design/feat-b` → `outside-in: data and logic`; paused only → `outside-in: data and logic`; status.md 30 min old, no terminal → `start` |
| gh | `steering.mode=github-issues` with a stub `gh` returning labels ready-for-agent, needs-human, in-progress, none | `byStatus {ready-for-agent:1, in-progress:1, open:2}`: `needs-human` lands in `open` (finding 6); stub `gh` exiting 1 → `tickets.unavailable` |
| remote | `sh -c 'pgrep -f loadlog.sh …'` (the remote command of `start` run locally) | `pgrep` matches the shell that runs the command line itself (finding 3) |

Docs read as a newcomer: EN and DE agree section by section (same prerequisites, same two commands, same appendix). It is clear that only Orca, Node/git identity, one agent CLI and the one sentence are manual. The appendix commands match the CLI (`init`, `--print-questions`, `--answers`, `install-skills`, `start`, `status --json`, `doctor`, `update`), and the README anchor to the appendix resolves. Gap: neither page says how the human comes back tomorrow (the same sentence again; START.md handles it via "anything else → section 4"), see finding 8.

## (b) Findings (prioritised)

1. **`--answers` validates choices only; text answers, unknown ids and a missing `rules.confirm` pass silently.** `bin/agentic-factory.mjs:36-43` (`preset`), `:60-65` (`askText`), `:194-200`. Test b4/b5: `preview.port:"abc"` and `reviews.maxRounds:"x"` become `null` in `factory.config.json`, `CONTROLLER.md` renders "After NaN rounds", `doctor` reports "preview not running on null"; `hosts.remote.ssh:""` is accepted (test a-style run with an empty alias); a mistyped id (`host.where`) is ignored and the default used; an answers file without `rules.confirm` confirms the hard rules by default (`batch → def`), although START.md step 6 requires an explicit yes. Why: the agent is now the one typing, and a wrong field reaches the Controller's handbook without any message. Change: give `askText` a validator (`number` for `preview.port`, `reviews.maxRounds`; non-empty for `project.name`, `hosts.remote.name`, `hosts.remote.ssh`), fail with the same `--answers: "<id>" …` message; after the question loop, fail on keys in `presetAnswers` that are not in `asked`; with `--answers`, require `rules.confirm` to be present and `"yes"`. Tag: debt (a careful agent that copies `recommended` is not affected; the interactive path has the same gaps).

2. **`project.repo`'s recommended value is a sentence, and START.md tells the agent to use `recommended`.** `:109` sets `d.repo` to `"local bare remote (init creates it under ~/.factory-remotes)"` in `--print-questions` mode; the JSON shows it as `recommended` of `project.repo` (test a2); the agent, told to answer every open question with the recommended option (START.md 2.3), writes it back and `init --answers` stores the sentence as `project.repo` (test b5). Why: a wrong fact in the project's config that `doctor` never flags. Change: compute the bare path in both modes (`local:${bare}`, it is deterministic) or set `project.repo` after `createRemote()` and leave the question out when there is no remote. Tag: debt (nothing renders `project.repo`).

3. **Remote `start`: the load log is never started on the Controller's host, and `start` says ok.** `:692`: `pgrep -f loadlog.sh >/dev/null || (… nohup bash loadlog.sh …)`. The remote side runs the whole string through `$SHELL -c '…'`, whose command line contains `loadlog.sh`, so `pgrep -f` always matches that shell (reproduced locally, table row "remote"). The `echo ok` then reports "Gate, user-level skills and load log on <host>: ok". Why: `~/load.log` is an audit input (`controller/templates/mkspec.mjs:109`) and the documented effect of `start`. Change: `pgrep -f "[b]ash loadlog.sh"` (the bracket keeps the pattern from matching itself) or check a pid file written by `loadlog.sh`. Tag: debt (remote path only; could not be executed here).

4. **Remote `start`: the Orca worktree selector carries an unexpanded `~`.** `:700`: for a remote Controller `--worktree path:${ctl.projectDir ?? `${ctl.projectsDir}/${c.project.name}`}` → `path:~/projects/<name>` (init never sets `projectDir` for remote hosts, `projectsDir` defaults to `~/projects`). `orca terminal create --help` documents `path:` with absolute paths; nothing expands `~` before Orca receives it. Also `--environment` takes `ctl.orcaEnvironment || ctl.name`, which init sets to the host name, but the saved Orca server may be named differently; `status`/`doctor` cannot tell. Why: the one step the newcomer cannot see fails on the server and `start` falls back to "start it by hand". Change: resolve the remote home once over ssh (`echo $HOME`) or require `projectDir` for remote hosts in init, and let `doctor` check `orca environment list` for the name. Tag: debt (unverifiable here; remote is optional).

5. **"Needs <human>" parsing counts a table header and drops items containing "none".** `:576`: lines are kept when they start with `-`, `*`, `n.` or `|` and do not match `/\b(none|nothing|keine)\b/i`. A section written as a table yields the header row (`| Question | Since |`) as an open item and phase `decisions` with nothing to ask; a real question such as "offer a none-of-the-above option?" vanishes. Why: the phase steers the Front agent's first question of every session. Change: drop the first table row when the next line is a `|---` separator, and treat only a line whose text (after the bullet) *is* `none`/`nothing`/`keine` as empty. Tag: debt (CONTROLLER.md prescribes bullets).

6. **github-issues branch of `status` does not know the factory's own `needs-human` label.** `:611`: the regex accepts `ready-for-agent|needs-triage|needs-info|ready-for-human|in-progress|blocked`; `controller/steering/issues.mjs` and the init checklist (`:284`) use `needs-human`, which the test "gh" shows landing in `open`. `needs-triage`/`needs-info`/`ready-for-human` are counted as drafts although init creates none of them. Why: decisions parked on issues never raise the `decisions` phase. Change: align the list with `issues.mjs` (`ready-for-agent`, `in-progress`, `needs-human`, plus the matt-pocock triage labels if `setup-matt-pocock-skills` ran) and add `needs-human` issues to `work.needsHuman`. Tag: debt.

7. **Controller terminal detection is a substring match on the whole terminal list.** `:561` `orcaTerminals().includes(controllerTitle(c))`, used at `:599` and `:697`. Project `a` matches `proj-a · Controller`; any terminal whose title or command contains the string counts. Then `status` reports the Controller as running and `start` never creates the session. Change: parse the JSON and compare `title === controllerTitle(c)`. Tag: debt.

8. **Docs: the return path is implicit.** `docs/getting-started.md:22-26`, `docs/de/erste-schritte.md:22-26`, README "Set up a project". The pages say "at each session start it checks the status" but not that the human starts tomorrow's session with the same sentence (START.md section 1 routes an initialised project to section 4). Add one sentence in EN and DE: "Start every later session the same way; the agent then reads `~/front-agent/<project>/FRONT_AGENT.md`." Also `docs/getting-started.md:87` (`cp -R .factory/controller ~/controller`) nests a second copy when `~/controller` exists; use `cp -R .factory/controller/. ~/controller/`. Tag: debt.

Not found: side effects in `--print-questions` (tests a2, b3, c1: tree, remote, `$HOME` untouched), stdin waits (test 3), unresolved placeholders (a7, b6), regressions in `init`, `update`, `doctor`, hooks merge (c4, smoke suite). `rsync -e` quoting (`:688`) uses double-quoted JSON strings, which rsync's `-e` parser honours; `~/controller/` as the rsync destination is expanded by the remote shell.

## (c) Verdict

Verdict: pass

No finding breaks the documented start on a single machine or silently weakens a guardrail; findings 1–4 should be worked off before the remote path is advertised as supported.

## (d) Reviewed commit

Reviewed commit: 74769144be0ee5f71f36a7f444296db7bfbc29b3
