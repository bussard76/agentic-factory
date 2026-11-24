// A Controller that hangs: when the heartbeat calls it hung, who is told, when it is restarted (once), and what a restart does and
// does not touch; and restart.mjs, which the Controller runs itself to start fresh. Fakes only: the fake Orca keeps its terminals in a
// file, HOME is a throwaway directory, and no ORCA_* variable reaches a child process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const FILES = ["heartbeat.mjs", "cli.mjs", "controller-terminal.mjs", "front-notice.mjs", "inbox.mjs", "restart.mjs", "lib.mjs", "steering/tasks.mjs"];
const ago = (ms) => new Date(Date.now() - ms);
const MIN = 60_000;

function setup({ controller = {}, agents = {}, frontAgent, terminals, screen = "changing", idle = false, workers = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-hung-"));
  const home = path.join(dir, "home"), ctl = path.join(dir, "ctl"), project = path.join(dir, "p");
  fs.mkdirSync(home); fs.mkdirSync(path.join(ctl, "steering"), { recursive: true }); fs.mkdirSync(path.join(project, "docs/tasks"), { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(ctl, f));
  const config = { project: { name: "p", mainBranch: "main", humanName: "Alex" }, agents: { runner: "orca", default: "claude", controllerArgs: "--test-flag", ...agents }, commands: {}, hosts: { controller: { host: "local", controllerDir: ctl, ...controller }, workers: [{ name: "local", kind: "local", projectDir: project, orcaRepoId: "r" }], ...(frontAgent ? { frontAgent } : {}) } };
  fs.writeFileSync(path.join(ctl, "factory.config.json"), JSON.stringify(config));
  const state = path.join(dir, "state.json"), calls = path.join(dir, "calls.log"), fake = path.join(dir, "fake.mjs");
  const list = terminals ?? [{ handle: "term_old", title: "p · Controller", worktreePath: project, agentIdentity: "claude", orphaned: false }];
  fs.writeFileSync(state, JSON.stringify({ terminals: list, idle, screen, tick: 0, messages: [], created: 0 }));
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const a = process.argv.slice(2), S = ${JSON.stringify(state)}, s = JSON.parse(fs.readFileSync(S, "utf8"));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + "\\n");
const save = () => fs.writeFileSync(S, JSON.stringify(s));
const out = (result) => console.log(JSON.stringify({ ok: true, result }));
const arg = (n) => a[a.indexOf(n) + 1];
if (a[0] === "terminal" && a[1] === "list") out({ terminals: s.terminals });
else if (a[0] === "terminal" && a[1] === "wait") { out({ wait: { satisfied: s.idle } }); }
else if (a[0] === "terminal" && a[1] === "read") { s.tick += 1; save(); out({ terminal: { tail: [s.screen === "changing" ? "working " + s.tick : s.screen === "static" ? "prompt" : s.screen] } }); }
else if (a[0] === "terminal" && a[1] === "create") {
  if (s.createFails) { console.error("orca: cannot create"); process.exit(1); }
  s.created += 1; const handle = "term_new" + s.created;
  s.terminals.push({ handle, title: arg("--title"), worktreePath: arg("--worktree").replace(/^path:/, ""), agentIdentity: "claude", orphaned: false }); save(); out({ terminal: { handle } });
}
else if (a[0] === "terminal" && a[1] === "close") { if (s.closeFails) { console.error("orca: cannot close"); process.exit(1); } s.terminals = s.terminals.filter((t) => t.handle !== arg("--terminal")); save(); out({}); }
else if (a[0] === "terminal" && a[1] === "send") { if (s.answerBySending) { const t = new Date(); fs.utimesSync(s.answerBySending, t, t); } out({}); }
else if (a[0] === "orchestration" && a[1] === "inbox") out({ messages: s.messages });
else out({});`, { mode: 0o755 });
  const env = { ...process.env, ORCA_CLI_COMMAND: fake, HOME: home, FACTORY_RESTART_LOCK_WAIT_MS: "300" };
  for (const k of Object.keys(env)) if (/^ORCA_/.test(k) && k !== "ORCA_CLI_COMMAND") delete env[k];
  const patch = (p) => fs.writeFileSync(state, JSON.stringify({ ...JSON.parse(fs.readFileSync(state, "utf8")), ...p }));
  const read = (name) => { try { return fs.readFileSync(path.join(ctl, name), "utf8"); } catch { return null; } };
  const write = (name, text) => fs.writeFileSync(path.join(ctl, name), text);
  const age = (name, ms) => { const t = ago(ms); fs.utimesSync(path.join(ctl, name), t, t); };
  const run = (script, args = [], extra = {}) => spawnSync("node", [path.join(ctl, script), ...args], { encoding: "utf8", env: { ...env, ...extra } });
  const beat = () => { const r = run("heartbeat.mjs"); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const all = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const of = (a0, a1) => all().filter((a) => a[0] === a0 && a[1] === a1);
  const journal = () => (read("journal.ndjson") ?? "").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  // The Controller has written status.md 40 minutes ago and nothing since; the baseline beat is done.
  write("status.md", "# Status\n"); age("status.md", 40 * MIN);
  write("controller-terminal.txt", `term_old\n${project}\n`);
  beat();
  return { dir, home, ctl, project, config, patch, read, write, age, run, beat, all, of, journal, state: () => JSON.parse(fs.readFileSync(state, "utf8")), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("hung: busy, its terminal changing, no sign of work for 25 minutes: the Front agent is told at once, and nothing is restarted yet", () => {
  const h = setup();
  const first = h.beat();   // the first reading of the screen: nothing to compare with
  assert.doesNotMatch(first, /HUNG/);
  const out = h.beat();
  assert.match(out, /HUNG since \d\d:\d\d: busy, its terminal keeps changing, but status\.md and the journal have not changed for 4\d minutes; it is restarted at \d\d:\d\d unless it recovers/);
  assert.match(h.read("heartbeat-health.md"), /^- HUNG since/);
  assert.match(h.read("front-events.log"), /FRONT-EVENT HUNG: HUNG since/);
  assert.equal(h.of("terminal", "create").length, 0);
  assert.equal(h.read("status.md"), "# Status\n", "the heartbeat never writes status.md: its age is the sign of work");
  h.done();
});

test("a Controller that only looks busy (idle at its prompt, long workers to wait for, a screen that changes) answers the pointer typed with the report and is not restarted", () => {
  const h = setup();
  h.beat();
  h.patch({ answerBySending: path.join(h.ctl, "status.md") });   // a Controller at its prompt runs a cycle when the line arrives
  const out = h.beat();
  assert.match(out, /HUNG since/);
  assert.match(out, /typed the pointer for a Controller that may only look busy/);
  const typed = h.of("terminal", "send");
  assert.equal(typed.length, 1);
  assert.equal(typed[0][typed[0].indexOf("--text") + 1], 'Heartbeat: you have shown no sign of work for a while. Run step 1 of "The loop" in CONTROLLER.md after your current step, and write status.md.');
  assert.match(h.beat(), /Controller no longer hung/);
  assert.equal(h.read("heartbeat-health.md"), null);
  h.write("heartbeat.hung.json", JSON.stringify({ hangRestarts: 0 }));
  for (let i = 0; i < 3; i++) h.beat();
  assert.equal(h.of("terminal", "create").length, 0, "no restart");
  assert.equal(h.of("terminal", "send").length, 1, "the pointer is typed once per hang, not every minute");
  h.done();
});

test("N2 safety: an idle prompt that Orca reads as busy (a background shell) is not hung: its terminal does not change", () => {
  const h = setup({ screen: "static" });
  for (let i = 0; i < 4; i++) assert.doesNotMatch(h.beat(), /HUNG/);
  assert.equal(h.read("heartbeat-health.md"), null);
  h.done();
});

test("not hung: an idle Controller, a recent sign of work, or a wave in flight", () => {
  const idle = setup({ idle: true });
  for (let i = 0; i < 3; i++) assert.doesNotMatch(idle.beat(), /HUNG/);
  idle.done();
  const working = setup();
  working.write("journal.ndjson", `{"type":"start"}\n`);
  for (let i = 0; i < 3; i++) assert.doesNotMatch(working.beat(), /HUNG/);
  working.done();
});

test("a bot Front agent is sent the hang at once, as a question; a terminal Front agent gets its status watch run", () => {
  const bot = setup({ frontAgent: { kind: "orca-bot", bot: "Front Bot" } });
  bot.beat(); bot.beat();
  const sent = bot.of("orchestration", "send");
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0][sent[0].indexOf("--to") + 1], sent[0][sent[0].indexOf("--type") + 1], sent[0][sent[0].indexOf("--subject") + 1]], ["bot:Front Bot", "question", "HUNG"]);
  bot.done();
  const terminal = setup({ frontAgent: { kind: "terminal" } });
  const watch = path.join(terminal.home, "front-agent", "p");
  fs.mkdirSync(watch, { recursive: true });
  fs.writeFileSync(path.join(watch, "statuswatch.mjs"), `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(path.join(terminal.dir, "watch-ran"))}, fs.readFileSync(${JSON.stringify(path.join(terminal.ctl, "heartbeat-health.md"))}, "utf8"));`);
  terminal.beat(); terminal.beat();
  assert.match(fs.readFileSync(path.join(terminal.dir, "watch-ran"), "utf8"), /HUNG since/, "run after the health file was written");
  terminal.done();
});

test("after hung.restartAfterMinutes without a change the Controller is restarted once, through the session start builds", async () => {
  const h = setup();
  h.beat(); h.beat();
  h.write("status.md", "# Status\n"); h.age("status.md", 60 * MIN);   // still no sign of work
  const hung = JSON.parse(h.read("heartbeat.hung.json"));
  h.write("heartbeat.hung.json", JSON.stringify({ ...hung, since: Date.now() - 16 * MIN }));
  const out = h.beat();
  assert.match(out, /restart: restarted; new terminal term_new1, term_old closed/);
  const create = h.of("terminal", "create");
  assert.equal(create.length, 1);
  const { controllerSession } = await import(path.join(ROOT, "controller/controller-terminal.mjs"));
  assert.equal(create[0][create[0].indexOf("--command") + 1], controllerSession({ dir: h.ctl, project: "p", agent: "claude", args: "--test-flag" }), "the command start makes, with exactly the configured controllerArgs");
  assert.match(create[0][create[0].indexOf("--command") + 1], /^cd .*ctl && claude --test-flag "Read .*\/CONTROLLER\.md and act as the Controller for the project p\."$/);
  assert.equal(create[0][create[0].indexOf("--worktree") + 1], `path:${h.project}`, "the worktree start recorded");
  assert.equal(create[0][create[0].indexOf("--title") + 1], "p · Controller");
  // Order: the new terminal exists and is recorded before the old one is closed.
  const order = h.all().map((a) => a.slice(0, 2).join(" ")).filter((x) => /terminal (create|close)/.test(x));
  assert.deepEqual(order, ["terminal create", "terminal close"]);
  assert.equal(h.of("terminal", "close")[0][h.of("terminal", "close")[0].indexOf("--terminal") + 1], "term_old");
  assert.equal(h.read("controller-terminal.txt"), `term_new1\n${h.project}\n`, "the new handle is recorded with its worktree");
  assert.equal(h.journal().filter((e) => e.type === "restart").length, 1);
  assert.match(h.read("restart.md"), /You are a fresh Controller[\s\S]*worker_done/);
  const saved = fs.readdirSync(path.join(h.ctl, "restart"));
  assert.equal(saved.length, 1);
  assert.ok(fs.existsSync(path.join(h.ctl, "restart", saved[0], "status.md")), "the state it started from is kept");
  assert.match(h.read("heartbeat-health.md"), /RESTARTED automatically/);
  assert.match(h.read("front-events.log"), /FRONT-EVENT RESTARTED/);
  h.done();
});

test("a restart touches no worker, wave or worktree, and the fresh Controller is not typed into before it has written status.md", () => {
  const h = setup();
  h.write("workers.json", JSON.stringify({ t1: { name: "T1 · Worker Developer", host: "local", terminal: "term_w", dispatch: "d1", worktree: "/w/t1" } }));
  h.write("wave-handle.txt", "local term_wave\n");
  h.patch({ terminals: [...h.state().terminals, { handle: "term_w", title: "T1 · Worker Developer", worktreePath: "/w/t1", agentIdentity: "claude" }, { handle: "term_wave", title: "p · Integration · wave", worktreePath: "/w/i" }] });
  // A wave in flight: the Controller waits for it, so a quiet status.md is no hang. Nothing is reported, nothing restarted.
  for (let i = 0; i < 3; i++) assert.doesNotMatch(h.beat(), /HUNG/);
  const r = h.run("restart.mjs", ["--reason", "context 60%"], { ORCA_TERMINAL_HANDLE: "term_old" });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(h.of("terminal", "close").map((a) => a[a.indexOf("--terminal") + 1]), ["term_old"], "only the Controller's terminal is closed");
  assert.equal(h.read("workers.json").includes("term_w"), true);
  assert.equal(h.read("wave-handle.txt"), "local term_wave\n");
  assert.match(h.read("restart.md"), /term_w/, "the workers it started are listed for the fresh Controller");
  // Typing waits for a status.md newer than the restart.
  h.write("inbox.md", "2026-11-24 a new instruction\n");
  h.patch({ idle: true });
  assert.match(h.beat(), /has not written status\.md since: nothing typed/);
  assert.equal(h.of("terminal", "send").length, 0);
  h.write("status.md", "# Status\n");
  assert.match(h.beat(), /woke term_new1 \(inbox/);
  h.done();
});

test("a second hang after a restart is escalated and never restarted automatically; running start is the one reset", () => {
  const h = setup();
  h.beat(); h.beat();
  h.write("heartbeat.hung.json", JSON.stringify({ ...JSON.parse(h.read("heartbeat.hung.json")), since: Date.now() - 16 * MIN, hangRestarts: 1, restartedAt: Date.now() - 3 * 60 * MIN }));
  const out = h.beat();
  assert.match(out, /HUNG AGAIN since \d\d:\d\d .* after the automatic restart at \d\d:\d\d: it is not restarted again and needs a person/);
  assert.equal(h.of("terminal", "create").length, 0);
  assert.equal(h.of("terminal", "close").length, 0);
  assert.equal(h.journal().filter((e) => e.type === "escalation").length, 1);
  assert.match(h.read("front-events.log"), /FRONT-EVENT HUNG-AGAIN/);
  assert.match(h.read("heartbeat-health.md"), /HUNG AGAIN/);
  for (let i = 0; i < 3; i++) h.beat();
  assert.equal(h.read("front-events.log").split("\n").filter((l) => /HUNG-AGAIN/.test(l)).length, 1, "said once, not every minute");
  h.done();
});

test("hosts.controller.hung.restart: false keeps detection and reporting and never restarts", () => {
  const h = setup({ controller: { hung: { restart: false } } });
  h.beat();
  assert.match(h.beat(), /HUNG since .*automatic restart is off \(hosts\.controller\.hung\.restart\)/);
  h.write("heartbeat.hung.json", JSON.stringify({ ...JSON.parse(h.read("heartbeat.hung.json")), since: Date.now() - 20 * MIN }));
  assert.match(h.beat(), /still hung; automatic restart is off/);
  assert.equal(h.of("terminal", "create").length, 0);
  assert.match(h.read("heartbeat-health.md"), /HUNG since/);
  h.done();
});

test("a hang that ends (the Controller writes status.md) clears the report and starts no restart", () => {
  const h = setup();
  h.beat(); h.beat();
  assert.ok(h.read("heartbeat-health.md"));
  h.write("status.md", "# Status\nback\n");
  assert.match(h.beat(), /Controller no longer hung/);
  assert.equal(h.read("heartbeat-health.md"), null);
  assert.equal(h.of("terminal", "create").length, 0);
  h.done();
});

test("a text pattern from hosts.controller.hung.patterns counts as hung after hung.patternMinutes; none are shipped", () => {
  const none = setup({ screen: "static" });
  assert.deepEqual(none.config.hosts.controller.hung, undefined, "the template names no pattern and no product");
  none.done();
  const h = setup({ screen: "Compacting conversation…", controller: { hung: { patterns: ["compacting conversation"] } } });
  h.write("status.md", "# Status\n");   // fresh: the pattern alone decides
  assert.doesNotMatch(h.beat(), /HUNG/, "just seen");
  h.write("heartbeat.hung.json", JSON.stringify({ patternSince: Date.now() - 11 * MIN, hangRestarts: 0 }));
  assert.match(h.beat(), /HUNG since \d\d:\d\d: a configured text pattern has been visible in its terminal for 11 minutes/);
  h.done();
});

test("restart.mjs: saves the handover, opens the new Controller, records it and closes the old terminal last; a second call too soon is refused", () => {
  const h = setup();
  h.write("handover.md", "# Handover\nthe queue\n");
  const dry = h.run("restart.mjs", ["--reason", "context 60%", "--dry"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run: would save the handover/);
  assert.equal(h.of("terminal", "create").length, 0);
  const r = h.run("restart.mjs", ["--reason", "context 60%"], { ORCA_TERMINAL_HANDLE: "term_old" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /restarted; new terminal term_new1, term_old closed/);
  assert.deepEqual(h.all().map((a) => a.slice(0, 2).join(" ")).filter((x) => /terminal (create|close)/.test(x)), ["terminal create", "terminal close"]);
  assert.equal(h.read("controller-terminal.txt"), `term_new1\n${h.project}\n`);
  assert.equal(fs.existsSync(path.join(h.ctl, "heartbeat.lock.d")), false, "the lock is released before the old terminal is closed");
  assert.match(h.read("restart.md"), /context 60%/);
  assert.equal(h.read("handover.md"), "# Handover\nthe queue\n", "the Controller's own handover is never overwritten");
  assert.equal(h.read("front-events.log").includes("RESTARTED"), true);
  assert.equal(h.of("orchestration", "send").length, 0, "a routine fresh start does not bother the Front agent");
  // A fresh Controller may already be above the threshold: no restart loop.
  h.patch({ terminals: [{ handle: "term_new1", title: "p · Controller", worktreePath: h.project, agentIdentity: "claude" }] });
  const again = h.run("restart.mjs", ["--reason", "context 70%"], { ORCA_TERMINAL_HANDLE: "term_new1" });
  assert.equal(again.status, 3, again.stdout);
  assert.match(again.stdout, /refused: the Controller was restarted \d+ minutes ago/);
  assert.equal(h.of("terminal", "create").length, 1);
  h.done();
});

test("restart.mjs refuses from a session that is not the Controller's terminal, and leaves everything alone when Orca cannot create the terminal", () => {
  const h = setup();
  const other = h.run("restart.mjs", ["--reason", "x"], { ORCA_TERMINAL_HANDLE: "term_somebody" });
  assert.equal(other.status, 1);
  assert.match(other.stdout, /is not the recorded Controller terminal/);
  h.patch({ createFails: true });
  const failed = h.run("restart.mjs", ["--reason", "x"], { ORCA_TERMINAL_HANDLE: "term_old" });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /the old Controller is still there/);
  assert.equal(h.of("terminal", "close").length, 0);
  assert.equal(h.read("controller-terminal.txt"), `term_old\n${h.project}\n`);
  assert.equal(h.read("heartbeat.restarted.json"), null);
  const noReason = h.run("restart.mjs");
  assert.equal(noReason.status, 2);
  h.done();
});

test("restart.mjs and the heartbeat do not overlap: a held heartbeat lock stops the restart, and a restart in progress stops the heartbeat", () => {
  const h = setup();
  fs.mkdirSync(path.join(h.ctl, "heartbeat.lock.d"));
  const blocked = h.run("restart.mjs", ["--reason", "x"], { ORCA_TERMINAL_HANDLE: "term_old" });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /the heartbeat is running/);
  assert.equal(h.of("terminal", "create").length, 0);
  const calls = h.all().length;
  const quiet = h.run("heartbeat.mjs");
  assert.equal(quiet.status, 0);
  assert.equal(h.all().length, calls, "a heartbeat that finds the lock held does nothing");
  h.done();
});

test("a failed automatic restart is reported, left as it was, and not retried every minute", () => {
  const h = setup();
  h.beat(); h.beat();
  h.patch({ createFails: true });
  h.write("heartbeat.hung.json", JSON.stringify({ ...JSON.parse(h.read("heartbeat.hung.json")), since: Date.now() - 16 * MIN }));
  assert.match(h.beat(), /restart: Orca could not create the new terminal/);
  assert.match(h.read("heartbeat-health.md"), /the automatic restart failed/);
  const n = h.of("terminal", "create").length;
  h.beat(); h.beat();
  assert.equal(h.of("terminal", "create").length, n);
  assert.equal(h.of("terminal", "close").length, 0, "the old Controller was not closed");
  h.done();
});
