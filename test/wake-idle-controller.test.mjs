// An idle Controller that Orca reads as busy (its wait.mjs runs as a background shell) is woken from its own word, the marker
// `cycle.mjs end` writes; a busy-looking one without a believable marker gets the pointer for every reason; mail the Controller has
// handled stops counting. Fakes only: a fake Orca that records its calls, a throwaway HOME (support/safe-env.mjs).
import "./support/safe-env.mjs";
import { tempDir } from "./support/cleanup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const FILES = ["heartbeat.mjs", "cycle.mjs", "cli.mjs", "controller-terminal.mjs", "front-notice.mjs", "inbox.mjs", "restart.mjs", "lib.mjs", "steering/tasks.mjs"];
const worker = JSON.stringify({ t1: { name: "T1 · Worker Developer", host: "local", terminal: "term_w", worktree: "/w/t1" } });
const doneMsg = { id: "m1", type: "worker_done", from: "term_w", subject: "done" };
// A run at a tenth minute is the full check (ready tickets, running workers).
const TENTH = "--import=data:text/javascript,Date.prototype.getMinutes=()=>0";

function setup({ state = {}, tenth = false } = {}) {
  const dir = tempDir("af-wakeidle-");
  const ctl = path.join(dir, "ctl"), project = path.join(dir, "p");
  fs.mkdirSync(path.join(ctl, "steering"), { recursive: true });
  fs.mkdirSync(path.join(project, "docs/tasks"), { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(ctl, f));
  fs.writeFileSync(path.join(ctl, "factory.config.json"), JSON.stringify({ project: { name: "p", mainBranch: "main", humanName: "Alex" }, agents: { runner: "orca" }, commands: {}, hosts: { controller: { host: "local" }, workers: [{ name: "local", kind: "local", projectDir: project, orcaRepoId: "r" }] } }));
  const fake = path.join(dir, "fake-orca.mjs"), stateFile = path.join(dir, "state.json"), calls = path.join(dir, "calls.log");
  const listed = (state.terminals ?? [{ handle: "term_c", title: "p · Controller" }]).map((t) => ({ worktreePath: project, agentIdentity: "claude", lastOutputAt: Date.now() - 3_600_000, ...t }));
  fs.writeFileSync(path.join(ctl, "status.md"), "# Status\n");
  fs.writeFileSync(stateFile, JSON.stringify({ messages: [], idle: false, ...state, terminals: listed }));
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const a = process.argv.slice(2), s = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + "\\n");
const out = (result) => console.log(JSON.stringify({ ok: true, result }));
if (a[0] === "terminal" && a[1] === "list") out({ terminals: s.terminals });
else if (a[0] === "terminal" && a[1] === "wait") out({ wait: { satisfied: s.idle } });
else if (a[0] === "terminal" && a[1] === "read") { if (s.readFails) { console.error("orca: read failed"); process.exit(1); } out({ tail: s.screenText ?? "" }); }
else if (a[0] === "orchestration" && a[1] === "inbox") { if (s.inboxFails) { console.error("orca: down"); process.exit(1); } out({ messages: s.messages }); }
else out({});`);
  fs.chmodSync(fake, 0o755);
  const env = { ...process.env, ORCA_CLI_COMMAND: fake, FACTORY_CONFIG: path.join(ctl, "factory.config.json"), ...(tenth ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} ${TENTH}`.trim() } : {}) };
  const beat = () => { const r = spawnSync("node", [path.join(ctl, "heartbeat.mjs")], { encoding: "utf8", env }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const cycle = (mode) => spawnSync("node", [path.join(ctl, "cycle.mjs"), mode], { encoding: "utf8", env, cwd: ctl });
  const all = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const sent = () => all().filter((a) => a[0] === "terminal" && a[1] === "send").map((a) => a[a.indexOf("--text") + 1]);
  const waits = () => all().filter((a) => a[0] === "terminal" && a[1] === "wait").length;
  const patch = (p) => fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stateFile, "utf8")), ...p }));
  const write = (name, text) => fs.writeFileSync(path.join(ctl, name), text);
  const has = (name) => fs.existsSync(path.join(ctl, name));
  const age = (name, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(path.join(ctl, name), t, t); };
  // The Controller ended its cycle `ms` ago: status.md was written before that, and the marker is its last act.
  const marker = (ms = 90_000) => { age("status.md", ms + 60_000); write("controller.waiting.json", JSON.stringify({ at: Date.now() - ms })); };
  const busyFor = (min) => write("heartbeat.busy.json", JSON.stringify({ since: Date.now() - min * 60_000, last: Date.now() - 30_000 }));
  const ticket = () => fs.writeFileSync(path.join(project, "docs/tasks/T1-x.md"), "Status: ready\nLevel: 1\n");
  const first = () => { assert.match(beat(), /baseline/); };
  // The last wake typed because of the marker was `min` minutes ago.
  const unanswered = (min) => { const w = JSON.parse(fs.readFileSync(path.join(ctl, "heartbeat.markerwake.json"), "utf8")); fs.writeFileSync(path.join(ctl, "heartbeat.markerwake.json"), JSON.stringify({ ...w, at: Date.now() - min * 60_000 })); };
  return { dir, ctl, project, unanswered, beat, cycle, all, sent, waits, patch, write, has, age, marker, busyFor, ticket, first, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("idle at its prompt with a background shell (Orca says busy): the marker wakes it for a new inbox line within a minute, without asking Orca", () => {
  const h = setup();
  h.first();
  h.marker();
  h.write("inbox.md", "2026-11-24 start both Developers\n");
  const out = h.beat();
  assert.match(out, /woke term_c \(inbox; it marked itself waiting at \d\d:\d\d\)/);
  assert.equal(h.sent().length, 1);
  assert.match(h.sent()[0], /^Heartbeat: run the next cycle of "The loop"/);
  assert.equal(h.waits(), 0, "the Controller's own word replaces the 15 s question to Orca");
  h.done();
});

test("an unanswered wake is not typed every minute; after wake.repeatMinutes it is typed again, and a new cycle's marker is a new state", () => {
  const h = setup();
  h.first();
  h.marker();
  h.write("inbox.md", "do this\n");
  h.beat();
  for (let i = 0; i < 3; i++) assert.match(h.beat(), /has not started a cycle: not typed again before 10 minutes/);
  assert.equal(h.sent().length, 1);
  h.unanswered(11);
  h.beat();
  assert.equal(h.sent().length, 2, "repeated after the configured time");
  // The Controller ran a cycle (cycle.mjs start, work, cycle.mjs end): a new marker, a new wake.
  assert.equal(h.cycle("start").status, 0);
  assert.equal(h.has("controller.waiting.json"), false);
  h.marker(70_000);
  h.beat();
  assert.equal(h.sent().length, 3);
  h.done();
});

test("idle with ready tickets only and a background shell: woken at the tenth minute's check; without a marker it gets the pointer", () => {
  const h = setup({ tenth: true });
  h.first();
  h.ticket();
  h.marker();
  assert.match(h.beat(), /woke term_c \(1 ready; it marked itself waiting/);
  assert.equal(h.sent().length, 1);
  h.done();
  // No marker (an older handbook): Orca says busy, the pointer follows after the busy time, once per state, again after the repeat time.
  const g = setup({ tenth: true });
  g.first();
  g.ticket();
  assert.match(g.beat(), /busy, not woken \(1 ready; Orca: not idle\)/);
  assert.equal(g.sent().length, 0, "not at once");
  g.busyFor(3);
  assert.match(g.beat(), /pointed the busy Controller to ready/);
  assert.match(g.sent()[0], /ready tickets or running workers are waiting/);
  g.beat();
  assert.equal(g.sent().length, 1, "once per state");
  g.age("heartbeat.pointer", 5 * 60_000);
  g.beat();
  assert.equal(g.sent().length, 1, "not before wake.repeatMinutes");
  g.age("heartbeat.pointer", 11 * 60_000);
  g.beat();
  assert.equal(g.sent().length, 2, "an unanswered pointer is typed again");
  g.done();
});

test("running workers at the tenth minute reach a busy-looking Controller as a pointer, and an unreadable source does not", () => {
  const h = setup({ tenth: true, state: { terminals: [{ handle: "term_c", title: "p · Controller" }, { handle: "term_w", title: "T1 · Worker Developer" }] } });
  h.write("workers.json", worker);
  h.first();
  h.busyFor(3);
  h.beat();
  assert.match(h.sent()[0] ?? "", /ready tickets or running workers/);
  h.done();
  const g = setup({ tenth: true });
  g.first();
  fs.rmSync(path.join(g.project, "docs/tasks"), { recursive: true });   // tickets cannot be listed
  g.busyFor(3);
  g.write("heartbeat.last", "");
  g.beat();
  assert.equal(g.sent().length, 0);
  g.done();
});

test("a worker message the Controller has read stops counting once its cycle ended (cycle.mjs start, end); one that arrived after it is new; a cycle that died handled nothing", () => {
  const h = setup();
  h.write("workers.json", worker);
  h.first();
  h.patch({ messages: [doneMsg] });
  assert.match(h.beat(), /busy, not woken \(1 worker message/);
  const r = h.cycle("start");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /# m1 worker_done term_w done/);
  assert.equal(h.has("mail.handled.json"), false, "read, not yet handled: the cycle may still die");
  assert.match(h.beat(), /busy, not woken \(1 worker message/);
  assert.equal(h.cycle("end").status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.ctl, "mail.handled.json"), "utf8")), ["m1"]);
  h.write("heartbeat.last", "");
  h.age("status.md", 5 * 60_000);
  assert.doesNotMatch(h.beat(), /worker message/);
  assert.equal(h.sent().length, 0);
  h.patch({ messages: [doneMsg, { id: "m2", type: "escalation", from: "term_w", subject: "q" }] });
  assert.match(h.beat(), /woke term_c \(1 worker message/, "the new one is a reason again");
  assert.doesNotMatch(h.sent()[0], /\bq\b/, "nothing a worker wrote is typed");
  h.done();
});

test("mail alone is woken again when the wake was not answered, after wake.repeatMinutes, at most three times", () => {
  const h = setup();
  h.write("workers.json", worker);
  h.first();
  h.marker();
  h.patch({ messages: [doneMsg] });
  assert.match(h.beat(), /woke term_c \(1 worker message/);
  assert.doesNotMatch(h.beat(), /woke/, "the signal is spent");
  assert.equal(h.sent().length, 1);
  for (let n = 2; n <= 4; n++) {
    h.unanswered(11);
    assert.match(h.beat(), /woke term_c \(unanswered wake/);
    assert.equal(h.sent().length, n);
  }
  h.unanswered(11);
  h.beat();
  assert.equal(h.sent().length, 4, "three repeats are enough");
  // A Controller that answered (a new marker) starts afresh.
  h.cycle("start"); h.marker(70_000);
  h.patch({ messages: [doneMsg, { id: "m9", type: "worker_done", from: "term_w", subject: "again" }] });
  h.beat();
  assert.equal(h.sent().length, 5);
  h.done();
});

test("ready tickets the Controller left unstarted when it ended its cycle wake it within a minute, once per set, not every minute and not every cycle", () => {
  const h = setup();
  h.first();
  h.marker();
  h.ticket();
  assert.match(h.beat(), /woke term_c \(1 ready; it marked itself waiting/, "a new marker with a ready ticket");
  assert.equal(h.sent().length, 1);
  assert.doesNotMatch(h.beat(), /woke/, "the same marker is looked at once");
  // The Controller starts a cycle, ends it with the same ticket still ready (capacity): not woken again at once.
  h.cycle("start"); h.marker(70_000);
  h.beat();
  assert.equal(h.sent().length, 1, "the same set, woken a moment ago");
  // Another ticket is ready: a different set.
  fs.writeFileSync(path.join(h.project, "docs/tasks/T2-y.md"), "Status: ready\nLevel: 1\n");
  h.cycle("start"); h.marker(70_000);
  h.beat();
  assert.equal(h.sent().length, 2);
  // The same set after the repeat time.
  h.cycle("start"); h.marker(70_000);
  const seen = JSON.parse(fs.readFileSync(path.join(h.ctl, "heartbeat.markerseen.json"), "utf8"));
  fs.writeFileSync(path.join(h.ctl, "heartbeat.markerseen.json"), JSON.stringify({ ...seen, markerAt: 1, wokeAt: Date.now() - 11 * 60_000 }));
  h.beat();
  assert.equal(h.sent().length, 3);
  h.done();
});

test("a wave's gate and wavewait.mjs write the journal while the Controller sits idle: that does not contradict its marker", () => {
  const h = setup();
  h.first();
  h.marker();
  h.write("journal.ndjson", '{"type":"gate"}\n');
  h.write("inbox.md", "x\n");
  assert.match(h.beat(), /woke term_c \(inbox; it marked itself waiting/);
  h.done();
});

test("cycle.mjs: end writes the marker, start removes it even when Orca fails; start prints only mail not handled before, the newest in full", () => {
  const h = setup();
  assert.equal(h.cycle("end").status, 0);
  assert.ok(JSON.parse(fs.readFileSync(path.join(h.ctl, "controller.waiting.json"), "utf8")).at > Date.now() - 10_000);
  h.patch({ inboxFails: true });
  const bad = h.cycle("start");
  assert.equal(bad.status, 0);
  assert.equal(h.has("controller.waiting.json"), false, "cleared before anything can fail");
  assert.match(bad.stdout, /worker mail not read/);
  assert.equal(h.has("mail.read.json"), false, "nothing printed, nothing read");
  const msgs = [{ id: "a", type: "status", subject: "x" }, { id: "b", type: "question", from: "w", subject: "s", body: "b".repeat(5000) }, ...Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, type: "worker_done", from: "w", subject: `s${i}` }))];
  h.patch({ inboxFails: false, messages: msgs });
  const ok = h.cycle("start");
  assert.match(ok.stdout, /\(11 older message\(s\) not shown/);
  assert.match(ok.stdout, /# n39 /);
  assert.doesNotMatch(ok.stdout, /# a /, "status messages are not worker mail");
  h.cycle("end");
  const handled = JSON.parse(fs.readFileSync(path.join(h.ctl, "mail.handled.json"), "utf8"));
  assert.equal(handled.length, 41);
  const again = h.cycle("start");
  assert.match(again.stdout, /no worker mail that was not handled before; 41 older message\(s\) already handled/);
  assert.equal(h.cycle("stop").status, 1);
  h.done();
});

test("really busy: output a moment ago, or status.md written after the marker: nothing is typed, however long, and the marker is not used", () => {
  const h = setup({ state: { terminals: [{ handle: "term_c", title: "p · Controller", lastOutputAt: Date.now() - 2_000 }] } });
  h.first();
  h.marker();
  h.write("inbox.md", "do this\n");
  assert.match(h.beat(), /busy, not woken \(inbox; marker not used: its terminal printed \d+ s ago; Orca: not idle\)/);
  assert.equal(h.sent().length, 0);
  h.done();
  // The Controller wrote status.md after it marked itself waiting (it forgot to clear the marker): it works.
  const g = setup();
  g.first();
  g.marker();
  g.write("status.md", "# Status\nnewer\n");
  g.write("inbox.md", "do this\n");
  assert.match(g.beat(), /busy, not woken \(inbox; marker not used: the Controller wrote status.md after it marked itself waiting; Orca: not idle\)/);
  assert.equal(g.sent().length, 0);
  assert.equal(g.waits(), 1, "Orca decides, as before");
  // A screen that cannot be read is no proof of a prompt: the marker is not used.
  const j = setup({ state: { readFails: true } });
  j.first(); j.marker(); j.write("inbox.md", "x\n");
  assert.match(j.beat(), /marker not used: its screen cannot be read/);
  assert.equal(j.sent().length, 0);
  // A restart after the marker invalidates it.
  const k = setup();
  k.first(); k.marker(); k.write("heartbeat.restarted.json", JSON.stringify({ at: Date.now() - 1000 })); k.write("status.md", "# s\n"); k.age("status.md", 500); k.write("inbox.md", "x\n");
  k.beat();
  assert.equal(k.sent().length, 0);
  for (const x of [g, j, k]) x.done();
});

test("a confirmation dialog: with a believable marker nothing is typed; the pointer is held as before", () => {
  const h = setup({ state: { screenText: "Allow this command to run?\n 1. Yes\n 2. No" } });
  h.first();
  h.marker();
  h.write("inbox.md", "do this\n");
  assert.match(h.beat(), /busy, not woken \(inbox; marker not used: a confirmation question is visible/);
  h.busyFor(5);
  assert.match(h.beat(), /pointer not typed: a confirmation question is visible/);
  assert.equal(h.sent().length, 0);
  assert.equal(h.waits(), 0, "the dialog decides without a question to Orca");
  h.done();
});

test("an older handbook (no marker ever): Orca decides as before; a marker left from before an update is not believed once the Controller works", () => {
  const h = setup({ state: { idle: true } });
  h.first();
  h.write("inbox.md", "do this\n");
  assert.match(h.beat(), /woke term_c \(inbox\)/, "idle by Orca: woken, no marker involved");
  const g = setup({ state: { idle: false } });
  g.first();
  g.write("inbox.md", "do this\n");
  assert.match(g.beat(), /busy, not woken \(inbox; Orca: not idle\)/);
  g.busyFor(3);
  g.beat();
  assert.match(g.sent()[0], /inbox\.md has a new instruction/, "today's pointer");
  // A marker file that is not what cycle.mjs writes is no marker.
  for (const bad of ["not json", "[]", "{}", '{"at":"soon"}', `{"at":${Date.now() + 3_600_000}}`]) {
    const x = setup();
    x.first(); x.write("controller.waiting.json", bad); x.write("inbox.md", "x\n");
    assert.match(x.beat(), /busy, not woken/, bad);
    assert.equal(x.sent().length, 0, bad);
    x.done();
  }
  h.done(); g.done();
});

test("a Controller that crashed after marking itself waiting: nothing is typed into a terminal that is not confirmed as its agent", () => {
  const h = setup({ state: { terminals: [{ handle: "term_c", title: "p · Controller", agentIdentity: null }] } });
  h.marker();
  h.write("inbox.md", "do this\n");
  h.beat(); h.beat();
  assert.equal(h.sent().length, 0);
  h.done();
});
