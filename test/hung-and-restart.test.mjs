// A Controller that hangs: when the heartbeat calls it hung, who is told, when it is restarted (once), and what a restart does and
// does not touch; and restart.mjs, which the Controller runs itself to start fresh. Fakes only: the fake Orca keeps its terminals in a
// file, HOME is a throwaway directory, and no ORCA_* variable reaches a child process.
import "./support/safe-env.mjs";
import { tempDir } from "./support/cleanup.mjs";
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
  const dir = tempDir("af-hung-");
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
if (a[0] === "terminal" && a[1] === "list") { const lag = s.lagLeft > 0; if (lag) { s.lagLeft -= 1; save(); } out({ terminals: lag ? s.terminals.filter((t) => t.handle !== s.lagHandle) : s.terminals }); }
else if (a[0] === "terminal" && a[1] === "wait") { out({ wait: { satisfied: s.idle } }); }
else if (a[0] === "terminal" && a[1] === "read") { s.tick += 1; save(); const h = arg("--terminal"); const L = "abcdefghijklmnopqrstuvwxyz"; out({ terminal: { tail: [String(h).startsWith("term_wave") ? (s.waveTail ?? "") : s.screen === "changing" ? "working " + L[s.tick % 26] + L[(s.tick * 7) % 26] : s.screen === "timer" ? "compacting (" + s.tick + "s)" : s.screen === "clock" ? "working  " + String(10 + s.tick % 50) + ":" + String((s.tick * 7) % 60).padStart(2, "0") + ":" + String(s.tick % 60).padStart(2, "0") + "  tokens " + s.tick * 113 : s.screen === "glyph" ? ["◐", "◓", "◑", "◒"][s.tick % 4] + " thinking " + ["|", "/", "-", "|"][s.tick % 4] + "⠋⠙⠹⠸".split("")[s.tick % 4] + " " + ["→", "↗", "↑", "↖"][s.tick % 4] : s.screen === "static" ? "prompt" : s.screen] } }); }
else if (a[0] === "--version") console.log(s.oldOrca ? "1.4.266" : "1.4.272");
else if (a[0] === "terminal" && a[1] === "create" && a.includes("--help")) {
  if (s.helpFails) { console.error("orca: not running"); process.exit(1); }
  console.log("orca terminal create\\n\\nUsage: orca terminal create [--worktree <selector>] [--title <name>] [--command <text>] [--focus]" + (s.oldOrca && !s.helpLies ? "" : " [--keep-open]") + " [--json]");
}
else if (a[0] === "terminal" && a[1] === "create") {
  // An older Orca refuses an option it does not know at parse time: nothing is created.
  if (a.includes("--keep-open") && (s.oldOrca || s.helpLies)) { console.error("Unknown flag --keep-open for command: terminal create"); process.exit(1); }
  if (s.createFails) { console.error("orca: cannot create"); process.exit(1); }
  s.created += 1; const handle = "term_new" + s.created;
  const t = { handle, title: arg("--title"), worktreePath: arg("--worktree").replace(/^path:/, ""), agentIdentity: "claude", orphaned: false };
  if (s.background) { s.hidden = [t]; save(); out({ terminal: { handle, surface: "background" }, warning: "Terminal " + handle + " is running, but Orca could not make it discoverable. Run \`orca terminal focus --terminal " + handle + "\` to reveal and focus it." }); }
  else if (s.noHandle) { s.terminals.push(t); save(); out({}); }   // made and listed, but the answer names nothing
  else { s.terminals.push(t); if (s.listLag) { s.lagHandle = handle; s.lagLeft = s.listLag; } save(); out({ terminal: { handle } }); }
}
else if (a[0] === "terminal" && a[1] === "focus") { if (s.focusFails) { console.error("orca: cannot focus"); process.exit(1); } if (s.focusNoShow) { out({}); process.exit(0); } s.terminals.push(...(s.hidden ?? [])); s.hidden = []; save(); out({}); }
else if (a[0] === "terminal" && a[1] === "close") { if (s.closeFails || (s.closeStrayFails && String(arg("--terminal")).startsWith("term_new"))) { console.error("orca: cannot close"); process.exit(1); } s.hidden = (s.hidden ?? []).filter((t) => t.handle !== arg("--terminal")); if (s.closeSilentlyFails) { out({}); process.exit(0); } s.terminals = s.terminals.filter((t) => t.handle !== arg("--terminal")); save(); out({}); }
else if (a[0] === "terminal" && a[1] === "send") { if (s.answerBySending) { const t = new Date(); fs.utimesSync(s.answerBySending, t, t); } out({}); }
else if (a[0] === "orchestration" && a[1] === "inbox") out({ messages: s.messages });
else out({});`, { mode: 0o755 });
  const env = { ...process.env, ORCA_CLI_COMMAND: fake, HOME: home, FACTORY_RESTART_LOCK_WAIT_MS: "300", FACTORY_RESTART_LIST_WAIT_MS: "2000" };
  const patch = (p) => fs.writeFileSync(state, JSON.stringify({ ...JSON.parse(fs.readFileSync(state, "utf8")), ...p }));
  const read = (name) => { try { return fs.readFileSync(path.join(ctl, name), "utf8"); } catch { return null; } };
  const write = (name, text) => fs.writeFileSync(path.join(ctl, name), text);
  const age = (name, ms) => { const t = ago(ms); fs.utimesSync(path.join(ctl, name), t, t); };
  const run = (script, args = [], extra = {}) => spawnSync("node", [path.join(ctl, script), ...args], { encoding: "utf8", env: { ...env, ...extra } });
  const beat = () => { const r = run("heartbeat.mjs"); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const calledAll = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const all = () => calledAll().filter((a) => !a.includes("--help") && a[0] !== "--version");   // --help and --version ask, they create nothing
  const of = (a0, a1) => all().filter((a) => a[0] === a0 && a[1] === a1);
  const journal = () => (read("journal.ndjson") ?? "").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  // The Controller has written status.md 40 minutes ago and nothing since; the baseline beat is done.
  write("status.md", "# Status\n"); age("status.md", 40 * MIN);
  write("controller-terminal.txt", `term_old\n${project}\n`);
  beat();
  return { dir, home, ctl, project, config, patch, read, write, age, run, beat, all, calledAll, of, journal, state: () => JSON.parse(fs.readFileSync(state, "utf8")), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}


// Two beats: the first reads the screen, the second sees it change and reports.
const report = (h) => { h.beat(); return h.beat(); };
// The report is `minutes` old, the terminal shows one frame (as a Controller that really hangs does).
const toRestartPoint = (h, minutes = 16) => {
  h.write("heartbeat.hung.json", JSON.stringify({ ...JSON.parse(h.read("heartbeat.hung.json")), since: Date.now() - minutes * MIN }));
  h.patch({ screen: "static" });
};
const ON = { hung: { restart: true } };
const sendsTo = (h) => h.of("terminal", "send").map((a) => a[a.indexOf("--text") + 1]);

test("hung: busy, its terminal changing, no sign of work for 25 minutes: the Front agent is told at once, one pointer is typed, and by default nothing is ever restarted", () => {
  const h = setup();
  assert.doesNotMatch(h.beat(), /HUNG/, "the first reading of the screen: nothing to compare with");
  const out = h.beat();
  assert.match(out, /HUNG since \d\d:\d\d: busy, its terminal keeps changing, but status\.md and the journal have not changed for 4\d minutes; automatic restart is off \(hosts\.controller\.hung\.restart is not true\): report only/);
  assert.match(h.read("heartbeat-health.md"), /^- HUNG since/);
  assert.match(h.read("front-events.log"), /FRONT-EVENT HUNG: HUNG since/);
  assert.equal(sendsTo(h).length, 1);
  assert.equal(h.read("status.md"), "# Status\n", "the heartbeat never writes status.md: its age is the sign of work");
  toRestartPoint(h, 60);
  for (let i = 0; i < 3; i++) h.beat();
  assert.equal(h.of("terminal", "create").length, 0);
  assert.equal(h.of("terminal", "close").length, 0);
  assert.match(h.read("heartbeat-health.md"), /report only/);
  h.done();
});

test("hosts.controller.hung.restart is on only for the value true: false, \"true\", 1 and a typo of the key all leave it off, and the log says so for a wrong value", () => {
  for (const hung of [{ restart: false }, { restart: "true" }, { restart: 1 }, { restrat: true }, {}]) {
    const h = setup({ controller: { hung } });
    const out = report(h);
    toRestartPoint(h);
    h.beat(); h.beat();
    assert.equal(h.of("terminal", "create").length, 0, JSON.stringify(hung));
    if (typeof hung.restart === "string" || typeof hung.restart === "number") assert.match(out, /hung\.restart is not true or false: it counts as false/);
    h.done();
  }
});

test("N2 safety: an idle prompt that Orca reads as busy (a background shell) is not hung: its terminal does not change", () => {
  const h = setup({ screen: "static" });
  for (let i = 0; i < 4; i++) assert.doesNotMatch(h.beat(), /HUNG/);
  assert.equal(h.read("heartbeat-health.md"), null);
  h.done();
});

test("not hung: an idle Controller, a recent sign of work, a wave in flight, or the first look after a long pause (a laptop that slept)", () => {
  const idle = setup({ idle: true });
  for (let i = 0; i < 3; i++) assert.doesNotMatch(idle.beat(), /HUNG/);
  idle.done();
  const working = setup();
  working.write("journal.ndjson", `{"type":"start"}\n`);
  for (let i = 0; i < 3; i++) assert.doesNotMatch(working.beat(), /HUNG/);
  working.done();
  const slept = setup();
  slept.write("heartbeat.screen.json", JSON.stringify({ hash: "old", readAt: Date.now() - 2 * 60 * MIN, changedAt: null }));
  assert.doesNotMatch(slept.beat(), /HUNG/, "a reading from two hours ago says nothing about now");
  slept.done();
});

test("a Controller that only looks busy (idle at its prompt, a screen that changes) answers the pointer with a cycle and is neither reported for long nor restarted", () => {
  const h = setup({ controller: ON });
  h.beat();
  h.patch({ answerBySending: path.join(h.ctl, "status.md") });   // a Controller at its prompt runs a cycle when the line arrives
  const out = h.beat();
  assert.match(out, /HUNG since/);
  assert.match(out, /typed the pointer for a Controller that may only look busy/);
  assert.equal(sendsTo(h)[0], 'Heartbeat: you have shown no sign of work for a while. Run step 1 of "The loop" in CONTROLLER.md after your current step, and write status.md.');
  assert.match(h.beat(), /Controller no longer hung/);
  assert.equal(h.read("heartbeat-health.md"), null);
  for (let i = 0; i < 3; i++) h.beat();
  assert.equal(h.of("terminal", "create").length, 0, "no restart");
  assert.equal(sendsTo(h).length, 1, "the pointer is typed once per hang");
  h.done();
});

test("the pointer is never typed where a confirmation question is visible, the hang is still reported; the busy pointer neither", () => {
  const h = setup({ screen: "Do you want to proceed?\n 1. Yes\n 2. No" });
  h.write("status.md", "# Status\n"); h.age("status.md", 40 * MIN);
  // A dialog is static: use a changing frame around it so that the hang rule sees a changing terminal.
  h.patch({ screen: "changing" });
  h.beat();
  h.patch({ screen: "Do you want to proceed? (y/n)" });
  const out = h.beat();
  assert.match(out, /pointer not typed: a confirmation question is visible/);
  assert.equal(h.of("terminal", "send").length, 0);
  assert.ok(h.read("heartbeat-health.md"), "the report is made all the same");
  h.done();
});

test("restart (switched on): after hung.restartAfterMinutes, a typed and unanswered pointer and a frozen frame, once, through the session start builds, with --keep-open and the old terminal closed last", async () => {
  const h = setup({ controller: ON });
  report(h);
  toRestartPoint(h);
  const out = h.beat();
  assert.match(out, /restart: restarted; new terminal term_new1 created with --keep-open, term_old closed/);
  const create = h.of("terminal", "create");
  assert.equal(create.length, 1);
  const { controllerSession } = await import(path.join(ROOT, "controller/controller-terminal.mjs"));
  assert.equal(create[0][create[0].indexOf("--command") + 1], controllerSession({ dir: h.ctl, project: "p", agent: "claude", args: "--test-flag" }), "the command start makes, with exactly the configured controllerArgs");
  assert.match(create[0][create[0].indexOf("--command") + 1], /^cd .*ctl && claude --test-flag "Read .*\/CONTROLLER\.md and act as the Controller for the project p\."$/);
  assert.ok(create[0].includes("--keep-open"), "the new terminal does not close with the session that made it");
  assert.equal(create[0][create[0].indexOf("--worktree") + 1], `path:${h.project}`, "the worktree start recorded");
  assert.equal(create[0][create[0].indexOf("--title") + 1], "p · Controller");
  assert.deepEqual(h.all().map((a) => a.slice(0, 2).join(" ")).filter((x) => /terminal (create|close)/.test(x)), ["terminal create", "terminal close"]);
  assert.equal(h.of("terminal", "close")[0][h.of("terminal", "close")[0].indexOf("--terminal") + 1], "term_old");
  assert.equal(h.read("controller-terminal.txt"), `term_new1\n${h.project}\n`, "the new handle is recorded with its worktree");
  assert.equal(h.journal().filter((e) => e.type === "restart").length, 1);
  assert.match(h.read("restart.md"), /You are a fresh Controller[\s\S]*worker_done/);
  assert.match(h.read("restart.md"), /--terminal term_old/, "the old mailbox is named");
  const saved = fs.readdirSync(path.join(h.ctl, "restart"));
  assert.equal(saved.length, 1);
  assert.ok(fs.existsSync(path.join(h.ctl, "restart", saved[0], "status.md")), "the state it started from is kept");
  assert.match(h.read("heartbeat-health.md"), /RESTARTED automatically/);
  assert.match(h.read("front-events.log"), /FRONT-EVENT RESTARTED/);
  h.done();
});

test("restart (switched on) needs the second confirmation: a terminal that still changes is not restarted, a timer or a spinner is no change of frame", () => {
  const moving = setup({ controller: ON });
  report(moving);
  moving.write("heartbeat.hung.json", JSON.stringify({ ...JSON.parse(moving.read("heartbeat.hung.json")), since: Date.now() - 16 * MIN }));
  for (let i = 0; i < 2; i++) assert.doesNotMatch(moving.beat(), /restarted;/);
  assert.equal(moving.of("terminal", "create").length, 0);
  assert.match(moving.read("heartbeat-health.md"), /automatic restart waits: its terminal still changes, so it is not proven frozen/);
  moving.done();
  const timer = setup({ controller: ON, screen: "timer" });
  report(timer);
  toRestartPoint(timer); timer.patch({ screen: "timer" });
  assert.match(timer.beat(), /restart: restarted/, "only digits change: the same frame");
  timer.done();
  // A running clock, a token counter and spinner glyphs are no change of frame either.
  for (const screen of ["clock", "glyph"]) {
    const c = setup({ controller: ON, screen });
    report(c);
    toRestartPoint(c); c.patch({ screen });
    assert.match(c.beat(), /restart: restarted/, screen);
    c.done();
  }
  // No pointer was typed (it was report only): nothing proves that the Controller ignored it.
  const young = setup({ controller: ON });
  young.write("heartbeat.restarted.json", JSON.stringify({ at: Date.now() - 3 * 60 * MIN }));
  young.write("status.md", "# Status\n"); young.age("status.md", 4 * 60 * MIN);
  young.beat();
  assert.match(young.beat(), /pointer not typed: it was restarted and has not written status\.md since/);
  toRestartPoint(young);
  young.beat();
  assert.equal(young.of("terminal", "create").length, 0);
  assert.match(young.read("heartbeat-health.md"), /pointer line was not typed|pointer line could not be typed/);
  young.done();
});

test("restart (switched on) is not done while a gate or wave was journaled or a wave runs, and keeps reporting", () => {
  const h = setup({ controller: ON });
  report(h);
  toRestartPoint(h);
  h.write("journal.ndjson", JSON.stringify({ ts: new Date().toISOString(), type: "gate", task: "T1" }) + "\n"); h.age("journal.ndjson", 40 * MIN);
  fs.writeFileSync(path.join(h.ctl, "journal.ndjson"), JSON.stringify({ ts: new Date(Date.now() - 5 * MIN).toISOString(), type: "gate", task: "T1" }) + "\n");
  h.age("journal.ndjson", 40 * MIN);   // old file time, a recent gate line: the line is what counts
  const out = h.beat();
  assert.match(out, /restart: refused: a gate was journaled at/);
  assert.equal(h.of("terminal", "create").length, 0);
  assert.match(h.read("heartbeat-health.md"), /automatic restart waits: a gate was journaled/);
  h.done();
});

test("a second hang after a restart is escalated, stays escalated while the Controller does nothing, and never restarts; the heartbeat's own journal line is no sign of work", () => {
  const h = setup({ controller: ON });
  report(h);
  h.write("heartbeat.hung.json", JSON.stringify({ ...JSON.parse(h.read("heartbeat.hung.json")), since: Date.now() - 16 * MIN, hangRestarts: 1, restartedAt: Date.now() - 3 * 60 * MIN }));
  const out = h.beat();
  assert.match(out, /HUNG AGAIN since \d\d:\d\d .* after the automatic restart at \d\d:\d\d: it is not restarted again and needs a person/);
  assert.equal(h.of("terminal", "create").length, 0);
  assert.equal(h.journal().filter((e) => e.type === "escalation").length, 1);
  assert.ok(fs.statSync(path.join(h.ctl, "journal.ndjson")).mtimeMs < Date.now() - 30 * MIN, "the journal file keeps its old time: the heartbeat's own line is no sign of work");
  for (let i = 0; i < 4; i++) { h.beat(); assert.match(h.read("heartbeat-health.md") ?? "", /HUNG AGAIN/, `still there after ${i + 1} more minutes`); }
  assert.equal(h.read("front-events.log").split("\n").filter((l) => /HUNG-AGAIN/.test(l)).length, 1, "said once, not every minute");
  // Only a sign of work from the Controller ends it.
  h.write("status.md", "# Status\nback\n");
  assert.match(h.beat(), /Controller no longer hung/);
  assert.equal(h.read("heartbeat-health.md"), null);
  h.done();
});

test("a hang that ends (the Controller writes status.md) clears the report and starts no restart", () => {
  const h = setup({ controller: ON });
  report(h);
  assert.ok(h.read("heartbeat-health.md"));
  h.write("status.md", "# Status\nback\n");
  assert.match(h.beat(), /Controller no longer hung/);
  assert.equal(h.read("heartbeat-health.md"), null);
  assert.equal(h.of("terminal", "create").length, 0);
  h.done();
});

test("a text pattern only reports: it is matched against the whole screen, so it never restarts, and it is the only way a quiet screen is called hung", () => {
  const none = setup({ screen: "static" });
  assert.equal(none.config.hosts.controller.hung, undefined, "the template names no pattern and no product");
  none.done();
  const h = setup({ screen: "worker said: rate limit reached for T3", controller: { hung: { restart: true, patterns: ["rate limit"] } } });
  h.write("status.md", "# Status\n");   // fresh: the pattern alone decides
  assert.doesNotMatch(h.beat(), /HUNG/, "just seen");
  h.write("heartbeat.hung.json", JSON.stringify({ patternSince: Date.now() - 11 * MIN, hangRestarts: 0 }));
  assert.match(h.beat(), /HUNG since \d\d:\d\d: a configured text pattern has been visible in its terminal for 11 minutes; a text pattern only reports/);
  h.write("heartbeat.hung.json", JSON.stringify({ ...JSON.parse(h.read("heartbeat.hung.json")), since: Date.now() - 20 * MIN }));
  assert.match(h.beat(), /still hung; a pattern only reports/);
  assert.equal(h.of("terminal", "create").length, 0);
  h.done();
});

test("a restarted Controller that never writes status.md is reported once, shown in the sidebar, and nothing is typed into it", () => {
  const h = setup();
  h.write("heartbeat.restarted.json", JSON.stringify({ at: Date.now() - 20 * MIN, kind: "hang", from: "term_x", to: "term_old" }));
  h.write("inbox.md", "2026-11-24 do this\n");
  h.patch({ idle: true });
  const out = h.beat();
  assert.match(out, /has not written status\.md since: nothing typed/);
  assert.match(h.read("heartbeat-health.md"), /RESTARTED at \d\d:\d\d, but the Controller has not written status\.md since: it has not started a cycle/);
  assert.match(h.read("front-events.log"), /FRONT-EVENT NOT-STARTED/);
  assert.equal(h.of("terminal", "send").length, 0);
  assert.ok(h.all().some((a) => a[0] === "worktree" && a.some((x) => /has not started a cycle yet/.test(x))), "the sidebar does not say Working");
  for (let i = 0; i < 3; i++) h.beat();
  assert.equal(h.read("front-events.log").split("\n").filter((l) => /NOT-STARTED/.test(l)).length, 1, "told once");
  h.write("status.md", "# Status\nstarted\n");
  h.beat();
  assert.equal(h.read("heartbeat-health.md"), null);
  h.done();
});

test("a restart cannot close the old terminal: it is reported as failed, two Controllers is an alert, and the line stays until the old terminal is gone", () => {
  const h = setup();
  h.patch({ closeSilentlyFails: true });   // Orca says nothing, the terminal stays
  const r = h.run("restart.mjs", ["--reason", "context 60%"], { ORCA_TERMINAL_HANDLE: "term_old" });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /restarted \(with --keep-open\), but the old terminal term_old is still open .*close it by hand, two Controllers must not run/);
  assert.doesNotMatch(r.stdout, /closed\b(?! by)/);
  assert.match(h.read("front-events.log"), /FRONT-EVENT TWO-CONTROLLERS: .*could NOT be closed/);
  assert.doesNotMatch(h.read("front-events.log"), /old term_old closed/);
  assert.ok(h.journal().some((e) => e.type === "restart" && e.closeFailed === "term_old"));
  h.write("status.md", "# Status\n");
  h.beat();
  assert.match(h.read("heartbeat-health.md"), /TWO CONTROLLERS: the old terminal term_old could not be closed/);
  h.patch({ terminals: h.state().terminals.filter((t) => t.handle !== "term_old") });
  h.beat();
  assert.equal(h.read("heartbeat-health.md"), null, "gone: the alert ends");
  h.done();
});

test("restart.mjs: saves the handover, opens the new Controller, records it and closes the old terminal last; a second call too soon is refused", () => {
  const h = setup();
  h.write("handover.md", "# Handover\nthe queue\n");
  const dry = h.run("restart.mjs", ["--reason", "context 60%", "--dry"], { ORCA_TERMINAL_HANDLE: "term_old" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run: would save the handover.*--keep-open/);
  assert.equal(h.of("terminal", "create").length, 0);
  const r = h.run("restart.mjs", ["--reason", "context 60%"], { ORCA_TERMINAL_HANDLE: "term_old" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /restarted; new terminal term_new1 created with --keep-open, term_old closed/);
  assert.deepEqual(h.all().map((a) => a.slice(0, 2).join(" ")).filter((x) => /terminal (create|close)/.test(x)), ["terminal create", "terminal close"]);
  assert.equal(h.read("controller-terminal.txt"), `term_new1\n${h.project}\n`);
  assert.equal(fs.existsSync(path.join(h.ctl, "heartbeat.lock.d")), false, "the lock is released before the old terminal is closed");
  assert.match(h.read("restart.md"), /context 60%/);
  assert.match(h.read("restart.md"), /handover\.md` \(written /, "it says how old the handover is");
  assert.equal(h.read("handover.md"), "# Handover\nthe queue\n", "the Controller's own handover is never overwritten");
  assert.equal(h.of("orchestration", "send").length, 0, "a routine fresh start does not bother the Front agent");
  h.patch({ terminals: [{ handle: "term_new1", title: "p · Controller", worktreePath: h.project, agentIdentity: "claude" }] });
  const again = h.run("restart.mjs", ["--reason", "context 70%"], { ORCA_TERMINAL_HANDLE: "term_new1" });
  assert.equal(again.status, 3, again.stdout);
  assert.match(again.stdout, /refused: the Controller was restarted \d+ minutes ago \(hosts\.controller\.restart\.contextGapMinutes is 120\)/);
  assert.equal(h.of("terminal", "create").length, 1);
  h.done();
});

const creates = (h) => h.calledAll().filter((a) => a[0] === "terminal" && a[1] === "create").map((a) => a.includes("--help") ? "help" : a.includes("--keep-open") ? "keep-open" : "plain");

test("restart.mjs removes the old session's waiting marker and mail record once the new Controller is confirmed, and not before", () => {
  const h = setup();
  h.write("controller.waiting.json", JSON.stringify({ at: Date.now() }));
  h.write("mail.read.json", "{}");
  h.patch({ background: true, focusFails: true });   // not confirmed: the old Controller stays, and so do its files
  const bad = restart(h);
  assert.equal(bad.status, 1, bad.stdout);
  assert.ok(h.read("controller.waiting.json") && h.read("mail.read.json"), "an unconfirmed restart leaves the old session's files");
  h.patch({ background: false, focusFails: false });
  const r = restart(h);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(h.read("controller.waiting.json"), null);
  assert.equal(h.read("mail.read.json"), null);
  assert.match(r.stdout, /controller\.waiting\.json and mail\.read\.json were removed/);
  h.done();
});

test("restart.mjs on an Orca with --keep-open in its help passes it and says so", () => {
  const h = setup();
  const r = h.run("restart.mjs", ["--reason", "context 60%"], { ORCA_TERMINAL_HANDLE: "term_old" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /created with --keep-open, term_old closed/);
  assert.deepEqual(creates(h), ["help", "keep-open"], "asked first, then created with the option");
  assert.equal(h.journal().find((e) => e.type === "restart").keepOpen, true);
  h.done();
});

test("restart.mjs on an older Orca (1.4.266, no --keep-open: it refuses unknown options) makes the terminal without it, run by the Controller itself too, and says so", () => {
  const h = setup();
  h.patch({ oldOrca: true });
  const dry = h.run("restart.mjs", ["--reason", "context 60%", "--dry"], { ORCA_TERMINAL_HANDLE: "term_old" });
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /would save the handover.*without --keep-open \(the installed Orca 1\.4\.266 has no such option, from 1\.4\.272 on it has/);
  assert.doesNotMatch(dry.stdout, /terminal create[^(]*--keep-open/);
  assert.equal(h.of("terminal", "create").length, 0, "a dry run creates nothing");
  const r = h.run("restart.mjs", ["--reason", "context 60%"], { ORCA_TERMINAL_HANDLE: "term_old" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /restarted; new terminal term_new1 created without --keep-open \(the installed Orca 1\.4\.266/);
  assert.deepEqual(creates(h).filter((x) => x !== "help"), ["plain"], "the option was never passed, so the Orca never had to refuse");
  assert.equal(h.read("controller-terminal.txt"), `term_new1\n${h.project}\n`);
  assert.equal(h.journal().find((e) => e.type === "restart").keepOpen, false);
  assert.ok(!h.state().terminals.some((t) => t.handle === "term_old"), "the old terminal is closed, after the new one");
  h.done();
});

test("restart.mjs on an older Orca: the heartbeat's restart of a hung Controller works without --keep-open too", () => {
  const h = setup({ controller: ON });
  h.patch({ oldOrca: true });
  report(h);
  toRestartPoint(h);
  assert.match(h.beat(), /restart: restarted; new terminal term_new1 created without --keep-open/);
  assert.deepEqual(creates(h).filter((x) => x !== "help"), ["plain"]);
  h.done();
});

test("restart.mjs: an Orca whose help cannot be read, or that refuses an option its help names, leaves the running Controller alone", () => {
  for (const patch of [{ helpFails: true }, { helpLies: true }]) {
    const h = setup();
    h.patch(patch);
    const before = h.read("controller-terminal.txt");
    const r = h.run("restart.mjs", ["--reason", "context 60%"], { ORCA_TERMINAL_HANDLE: "term_old" });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, patch.helpFails ? /did not say what `orca terminal create` accepts.*nothing was changed/ : /refused --keep-open although its help names it; nothing was created and the old Controller is still there/);
    assert.equal(h.of("terminal", "close").length, 0, "the old terminal is never closed");
    assert.deepEqual(h.state().terminals.map((t) => t.handle), ["term_old"], "no half-made terminal");
    assert.equal(h.read("controller-terminal.txt"), before);
    assert.equal(h.read("restart.md"), null, "no restart.md for a Controller that was not replaced");
    h.done();
  }
});

test("restart.mjs: a terminal Orca could only create in the background is revealed with `terminal focus` before the old one is closed; one that never shows up is not confirmed and the old one stays", () => {
  const h = setup();
  h.patch({ background: true, oldOrca: true });
  const r = h.run("restart.mjs", ["--reason", "context 60%"], { ORCA_TERMINAL_HANDLE: "term_old" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(h.all().map((a) => a.slice(0, 2).join(" ")).filter((x) => /terminal (focus|close)/.test(x)), ["terminal focus", "terminal close"], "focus, then close");
  assert.equal(h.of("terminal", "focus")[0][h.of("terminal", "focus")[0].indexOf("--terminal") + 1], "term_new1");
  assert.equal(h.read("controller-terminal.txt"), `term_new1\n${h.project}\n`);
  h.done();
  const g = setup();
  g.patch({ background: true, focusFails: true });
  const bad = g.run("restart.mjs", ["--reason", "context 60%"], { ORCA_TERMINAL_HANDLE: "term_old" });
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(bad.stdout, /Orca created term_new1 but did not list it as live; the new terminal \(term_new1\) was closed again \(Orca answered ok and the list does not show it\) and the old Controller term_old stays the recorded, running one/);
  assert.deepEqual(g.of("terminal", "close").map((a) => a[a.indexOf("--terminal") + 1]), ["term_new1"], "only the new one is closed");
  assert.equal(g.read("controller-terminal.txt"), `term_old\n${g.project}\n`, "the old Controller stays the recorded one");
  assert.equal(g.read("restart.md"), null);
  assert.equal(g.read("restart.pending.json"), null);
  g.done();
});

const onlyOld = (h, out) => {
  assert.equal(out.status, 1, out.stdout);
  assert.deepEqual(h.state().terminals.map((t) => t.handle), ["term_old"], "exactly one Controller is left running");
  assert.deepEqual(h.of("terminal", "close").map((a) => a[a.indexOf("--terminal") + 1]).filter((x) => x === "term_old"), [], "the old one is never closed");
  assert.equal(h.read("controller-terminal.txt"), `term_old\n${h.project}\n`, "and it stays recorded");
  assert.equal(h.read("restart.md"), null);
};
const restart = (h, extra = {}) => h.run("restart.mjs", ["--reason", "context 60%"], { ORCA_TERMINAL_HANDLE: "term_old", ...extra });

test("restart.mjs F2: a focus that exits 0 but never makes the terminal listed is not a confirmation: the new one is closed again and the old Controller stays", () => {
  const h = setup();
  h.patch({ background: true, oldOrca: true, focusNoShow: true });
  const r = restart(h);
  onlyOld(h, r);
  assert.match(r.stdout, /Orca created term_new1 but did not list it as live; the new terminal \(term_new1\) was closed again/);
  h.done();
});

test("restart.mjs F3: a terminal that lists late is waited for; an answer without a handle closes NOTHING (never by title) and alerts on every channel; a pending leftover is closed only by its handle", () => {
  // A list that lags a moment is waited for.
  const b = setup();
  b.patch({ listLag: 2 });
  const rb = restart(b);
  assert.equal(rb.status, 0, rb.stdout + rb.stderr);
  assert.deepEqual(b.state().terminals.map((t) => t.handle), ["term_new1"]);
  b.done();
  // No handle in the answer, and another project's Controller and a person's terminal carry the same title: nothing is closed.
  const a = setup();
  const other = { handle: "term_other", title: "p · Controller", worktreePath: "/somewhere/else", agentIdentity: "claude", orphaned: false };
  const human = { handle: "term_human", title: "p · Controller", worktreePath: a.project, agentIdentity: undefined, orphaned: false };
  a.patch({ noHandle: true, terminals: [...a.state().terminals, other, human] });
  const ra = restart(a);
  assert.equal(ra.status, 1, ra.stdout);
  assert.deepEqual(a.of("terminal", "close"), [], "no close call at all");
  assert.deepEqual(a.state().terminals.map((t) => t.handle).sort(), ["term_human", "term_new1", "term_old", "term_other"], "everything that was there is still there");
  assert.match(ra.stdout, /POSSIBLE SECOND CONTROLLER.*Orca's answer carried no handle\); nothing was closed: no handle is known/);
  assert.match(a.read("front-events.log"), /FRONT-EVENT TWO-CONTROLLERS: POSSIBLE SECOND CONTROLLER/);
  assert.match(a.read("heartbeat-health.md"), /POSSIBLE SECOND CONTROLLER/, "the health file carries it for a Front agent that only reads that");
  assert.equal(a.read("controller-terminal.txt"), `term_old\n${a.project}\n`);
  // A heartbeat run keeps the line; a retry without a handle to act on is refused, not guessed.
  a.write("status.md", "# Status\n");
  a.beat();
  assert.match(a.read("heartbeat-health.md"), /POSSIBLE SECOND CONTROLLER/, "a hang check does not erase it");
  const retry = restart(a);
  assert.equal(retry.status, 1);
  assert.match(retry.stdout, /may have left a second Controller.*nothing is closed by guessing/);
  assert.deepEqual(a.of("terminal", "create").length, 1, "no third terminal");
  fs.rmSync(path.join(a.ctl, "restart.pending.json"));   // a person looked and decided
  a.beat();
  assert.equal(a.read("heartbeat-health.md"), null, "the line ends with the pending file");
  a.done();
  // A close that cannot be confirmed (a terminal that never showed up in the list, close fails) is said so, and the retry closes it by its handle once it is listed.
  const c = setup();
  c.patch({ listLag: 1000, closeStrayFails: true });
  const rc = restart(c);
  assert.equal(rc.status, 1, rc.stdout);
  assert.match(rc.stdout, /POSSIBLE SECOND CONTROLLER.*\(term_new1\).*closing term_new1 was tried and is UNCONFIRMED/);
  assert.match(c.read("heartbeat-health.md"), /UNCONFIRMED/);
  assert.equal(JSON.parse(c.read("restart.pending.json")).handle, "term_new1");
  c.patch({ closeStrayFails: false, lagLeft: 0, listLag: 0 });
  const again = restart(c);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(c.state().terminals.map((t) => t.handle), ["term_new2"], "the leftover is gone by its handle, the new Controller is the only one");
  assert.equal(c.read("restart.pending.json"), null);
  assert.equal(c.read("heartbeat-health.md"), null);
  c.done();
});

test("restart.mjs: a pending handle Orca does not list is not forgotten: its close is tried by handle, and the record and the alert stay until Orca answers ok", () => {
  const h = setup();
  fs.writeFileSync(path.join(h.ctl, "restart.pending.json"), JSON.stringify({ handle: "term_new7", before: [], title: "p · Controller", at: Date.now() - 600_000 }));   // a hidden background terminal: not in the list
  h.patch({ closeStrayFails: true });
  const r = restart(h);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /term_new7\) is not confirmed closed \(the close is unconfirmed/);
  assert.equal(h.of("terminal", "create").length, 0, "no third terminal while it is unsettled");
  assert.ok(h.read("restart.pending.json"), "the record stays");
  h.beat();
  assert.match(h.read("heartbeat-health.md"), /POSSIBLE SECOND CONTROLLER.*term_new7/, "and the alert is up");
  h.patch({ closeStrayFails: false });   // Orca now answers ok to the close of that handle
  const again = restart(h);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(h.of("terminal", "close").map((a) => a[a.indexOf("--terminal") + 1]).slice(-2), ["term_new7", "term_old"], "closed by its handle first, the old one last");
  assert.equal(h.read("restart.pending.json"), null);
  h.beat();
  assert.equal(h.read("heartbeat-health.md"), null, "now the alert goes");
  h.done();
});

test("the heartbeat raises RESTART-LEFTOVER from restart.pending.json itself on every run: after a crash, with a corrupt alerts file, once only; it ends with the file", () => {
  const h = setup();
  fs.writeFileSync(path.join(h.ctl, "restart.pending.json"), JSON.stringify({ handle: "term_new9", before: [], at: Date.now() - 600_000 }));   // a restart was killed after it wrote this: nobody raised an alert
  h.beat();
  assert.match(h.read("heartbeat-health.md"), /POSSIBLE SECOND CONTROLLER: restart\.pending\.json is present.*term_new9/);
  h.beat();
  assert.equal((h.read("front-events.log").match(/FRONT-EVENT TWO-CONTROLLERS/g) ?? []).length, 1, "told once, not every run");
  // The alerts file is damaged: it is rebuilt from what is true now and the line stays.
  fs.writeFileSync(path.join(h.ctl, "heartbeat.alerts.json"), "{not json");
  h.beat();
  assert.match(h.read("heartbeat-health.md"), /POSSIBLE SECOND CONTROLLER/);
  assert.doesNotThrow(() => JSON.parse(h.read("heartbeat.alerts.json")));
  // A restart in progress (a young file) is not an alert.
  fs.writeFileSync(path.join(h.ctl, "restart.pending.json"), JSON.stringify({ handle: "term_new9", before: [], at: Date.now() }));
  fs.rmSync(path.join(h.ctl, "heartbeat.alerts.json")); fs.rmSync(path.join(h.ctl, "heartbeat-health.md"));
  h.beat();
  assert.doesNotMatch(h.read("heartbeat-health.md") ?? "", /POSSIBLE SECOND CONTROLLER/);
  fs.writeFileSync(path.join(h.ctl, "restart.pending.json"), JSON.stringify({ handle: "term_new9", before: [], at: Date.now() - 600_000 }));
  h.beat();
  assert.match(h.read("heartbeat-health.md"), /POSSIBLE SECOND CONTROLLER/);
  fs.rmSync(path.join(h.ctl, "restart.pending.json"));
  h.beat();
  assert.doesNotMatch(h.read("heartbeat-health.md") ?? "", /POSSIBLE SECOND CONTROLLER/, "the line ends with the file");
  h.done();
});

test("restart.mjs: restart.pending.json never closes the Controller itself, the caller's own terminal or anything it was not made for", () => {
  for (const [why, pending] of [["names the recorded Controller", { handle: "term_old", before: [] }], ["is not an object", [1]], ["has an odd handle", { handle: 7, before: "x" }]]) {
    const h = setup();
    fs.writeFileSync(path.join(h.ctl, "restart.pending.json"), JSON.stringify(pending));
    const r = restart(h);
    const order = h.all().filter((a) => a[0] === "terminal" && /^(create|close)$/.test(a[1])).map((a) => `${a[1]} ${a.includes("--terminal") ? a[a.indexOf("--terminal") + 1] : ""}`.trim());
    if (why === "names the recorded Controller") {
      assert.equal(r.status, 0, r.stdout);
      assert.deepEqual(order, ["create", "close term_old"], `${why}: the new terminal is made first, the old one closed once, last`);
    } else {
      assert.equal(r.status, 1, `${why}: ${r.stdout}`);
      assert.deepEqual(order, [], `${why}: nothing was closed or made`);
    }
    h.done();
  }
});

test("restart.mjs F1: from the Controller's own session on an Orca without --keep-open it goes ahead and says on what that rests; withoutKeepOpen: false refuses it, the heartbeat's own restart is not affected", () => {
  const h = setup();
  h.patch({ oldOrca: true });
  const r = restart(h);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /created without --keep-open \(the installed Orca 1\.4\.266 has no such option.*survives the end of this session rests on this Orca version's behaviour/);
  h.done();
  const g = setup({ controller: { restart: { withoutKeepOpen: false } } });
  g.patch({ oldOrca: true });
  const refused = restart(g);
  assert.equal(refused.status, 3, refused.stdout);
  assert.match(refused.stdout, /refused: the installed Orca 1\.4\.266 has no `terminal create --keep-open` \(it has from 1\.4\.272\) and hosts\.controller\.restart\.withoutKeepOpen is false/);
  assert.equal(g.of("terminal", "create").length, 0);
  const outside = g.run("restart.mjs", ["--reason", "hung", "--force"]);   // no ORCA_TERMINAL_HANDLE: not run by a session
  assert.equal(outside.status, 0, outside.stdout + outside.stderr);
  g.done();
});

test("a restart that ends with no live Controller is reported to the Front agent by the next heartbeat run, once", () => {
  const h = setup();
  h.patch({ oldOrca: true });
  assert.equal(restart(h).status, 0);
  h.patch({ terminals: [] });   // the new terminal went with the old one
  assert.doesNotMatch(h.read("front-events.log") ?? "", /NO-CONTROLLER/);
  h.beat();
  assert.match(h.read("front-events.log"), /FRONT-EVENT NO-CONTROLLER: NO CONTROLLER: the Controller restarted at \d\d:\d\d \(context\) is no longer running: its terminal term_new1 is gone/);
  assert.match(h.read("heartbeat-health.md"), /NO CONTROLLER: .*If you stopped it on purpose, ignore this/, "also in the health file, which is what a Front agent that only reads files sees");
  h.beat();
  assert.equal((h.read("front-events.log").match(/FRONT-EVENT NO-CONTROLLER/g) ?? []).length, 1, "told once");
  assert.match(h.read("heartbeat-health.md"), /NO CONTROLLER/, "but the line stays while there is none");
  // A Controller runs again: the line goes.
  h.patch({ terminals: [{ handle: "term_new1", title: "p · Controller", worktreePath: h.project, agentIdentity: "claude", orphaned: false }] });
  h.write("status.md", "# Status\n");
  h.beat();
  assert.equal(h.read("heartbeat-health.md"), null);
  h.done();
});

test("restart.mjs run by the Controller needs its own terminal handle and must be that terminal; --force is for a person and never skips the wave guard", () => {
  const h = setup();
  const none = h.run("restart.mjs", ["--reason", "x"]);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /ORCA_TERMINAL_HANDLE is not set/);
  const other = h.run("restart.mjs", ["--reason", "x"], { ORCA_TERMINAL_HANDLE: "term_somebody" });
  assert.equal(other.status, 1);
  assert.match(other.stdout, /is not the recorded Controller terminal/);
  assert.equal(h.of("terminal", "create").length, 0);
  // A wave that has not printed WAVE-END.
  h.write("wave-handle.txt", "local term_wave\n");
  h.patch({ terminals: [...h.state().terminals, { handle: "term_wave", title: "p · Integration · wave", worktreePath: "/w/i" }] });
  for (const args of [["--reason", "x"], ["--reason", "x", "--force"]]) {
    const r = h.run("restart.mjs", args, { ORCA_TERMINAL_HANDLE: "term_old" });
    assert.equal(r.status, 3, r.stdout);
    assert.match(r.stdout, /refused: a wave is running/);
  }
  assert.equal(h.of("terminal", "create").length, 0);
  h.patch({ waveTail: "WAVE-END" });
  const ended = h.run("restart.mjs", ["--reason", "x"], { ORCA_TERMINAL_HANDLE: "term_old" });
  assert.equal(ended.status, 0, ended.stdout);
  assert.deepEqual(h.of("terminal", "close").map((a) => a[a.indexOf("--terminal") + 1]), ["term_old"], "only the Controller's terminal is closed; the wave's stays");
  h.done();
});

test("restart.mjs refuses within restart.afterGateMinutes of a gate, wave or push; --force is for a person; a failed create leaves everything as it was", () => {
  const h = setup();
  h.write("journal.ndjson", JSON.stringify({ ts: new Date(Date.now() - 2 * MIN).toISOString(), type: "gate", task: "T1" }) + "\n");
  const gated = h.run("restart.mjs", ["--reason", "x"], { ORCA_TERMINAL_HANDLE: "term_old" });
  assert.equal(gated.status, 3);
  assert.match(gated.stdout, /refused: a gate was journaled at .*afterGateMinutes/);
  h.write("journal.ndjson", "");
  h.write("workers.json", JSON.stringify({ a: null, t1: { name: "T1 · Worker", terminal: "term_w" } }));   // a null record must not break the handover
  h.patch({ createFails: true });
  const failed = h.run("restart.mjs", ["--reason", "x"], { ORCA_TERMINAL_HANDLE: "term_old" });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /the old Controller is still there/);
  assert.equal(h.read("restart.md"), null, "no stale restart.md for a later fresh start");
  assert.equal(h.of("terminal", "close").length, 0);
  assert.equal(h.read("controller-terminal.txt"), `term_old\n${h.project}\n`);
  assert.equal(h.read("heartbeat.restarted.json"), null);
  assert.equal(h.run("restart.mjs").status, 2);
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

test("restart.mjs keeps the last ten copies of the state only", () => {
  const h = setup();
  for (let i = 0; i < 12; i++) fs.mkdirSync(path.join(h.ctl, "restart", `2026-01-${String(i + 10)}T00-00-00-000Z`), { recursive: true });
  const r = h.run("restart.mjs", ["--reason", "x"], { ORCA_TERMINAL_HANDLE: "term_old" });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(fs.readdirSync(path.join(h.ctl, "restart")).length, 10);
  h.done();
});

test("every key this PR adds is in factory.config.example.json with its default, and the defaults are the ones the code uses", async () => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, "factory.config.example.json"), "utf8")).hosts.controller;
  assert.deepEqual({ wake: { idleMinutes: example.wake.idleMinutes, busyPointerMinutes: example.wake.busyPointerMinutes, dialogHoldMinutes: example.wake.dialogHoldMinutes, repeatMinutes: example.wake.repeatMinutes, quietSeconds: example.wake.quietSeconds }, hung: example.hung, restart: example.restart },
    { wake: { idleMinutes: 30, busyPointerMinutes: 2, dialogHoldMinutes: 15, repeatMinutes: 10, quietSeconds: 20 }, hung: { minutes: 25, restartAfterMinutes: 15, restart: false, patterns: [], patternMinutes: 10, resetAfterDays: 7 }, restart: { minGapMinutes: 30, contextGapMinutes: 120, afterGateMinutes: 15, contextPercent: 50, withoutKeepOpen: true } });
  assert.ok(Array.isArray(example.wake.dialogPatterns) && example.wake.dialogPatterns.length > 0);
  // The same defaults in the code, with no key set.
  const h = setup();
  const probe = path.join(h.ctl, "probe.mjs");
  fs.writeFileSync(probe, `import { WAKE, HUNG, RESTART } from "./lib.mjs"; console.log(JSON.stringify({ WAKE, HUNG, RESTART }));`);
  const got = JSON.parse(h.run("probe.mjs").stdout);
  assert.deepEqual([got.WAKE.idleMinutes, got.WAKE.busyPointerMinutes, got.WAKE.dialogHoldMinutes, got.HUNG.minutes, got.HUNG.restartAfterMinutes, got.HUNG.restart, got.HUNG.patternMinutes, got.HUNG.resetAfterDays, got.RESTART.minGapMinutes, got.RESTART.contextGapMinutes, got.RESTART.afterGateMinutes, got.RESTART.contextPercent, got.RESTART.withoutKeepOpen], [30, 2, 15, 25, 15, false, 10, 7, 30, 120, 15, 50, true]);
  assert.deepEqual([got.WAKE.repeatMinutes, got.WAKE.quietSeconds], [example.wake.repeatMinutes, example.wake.quietSeconds]);
  assert.deepEqual(got.WAKE.dialogPatterns, example.wake.dialogPatterns);
  h.done();
});

test("a bot Front agent is sent the hang at once, as a question; a terminal Front agent gets its status watch run, unless statusWatch is false", () => {
  const bot = setup({ frontAgent: { kind: "orca-bot", bot: "Front Bot" } });
  report(bot);
  const sent = bot.of("orchestration", "send");
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0][sent[0].indexOf("--to") + 1], sent[0][sent[0].indexOf("--type") + 1], sent[0][sent[0].indexOf("--subject") + 1]], ["bot:Front Bot", "question", "HUNG"]);
  bot.done();
  for (const [statusWatch, runs] of [[undefined, true], [false, false]]) {
    const terminal = setup({ frontAgent: { kind: "terminal", ...(statusWatch === undefined ? {} : { statusWatch }) } });
    const watch = path.join(terminal.home, "front-agent", "p");
    fs.mkdirSync(watch, { recursive: true });
    fs.writeFileSync(path.join(watch, "statuswatch.mjs"), `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(path.join(terminal.dir, "watch-ran"))}, fs.readFileSync(${JSON.stringify(path.join(terminal.ctl, "heartbeat-health.md"))}, "utf8"));`);
    report(terminal);
    assert.equal(fs.existsSync(path.join(terminal.dir, "watch-ran")), runs, `statusWatch ${statusWatch}`);
    if (runs) assert.match(fs.readFileSync(path.join(terminal.dir, "watch-ran"), "utf8"), /HUNG since/, "run after the health file was written");
    terminal.done();
  }
});
