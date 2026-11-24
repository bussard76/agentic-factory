// controller/heartbeat.mjs against a fake Orca: who gets woken, when, and that a signal is only spent on a successful wake.
import "./support/safe-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// No ORCA_* variable of the machine running the tests reaches a script under test (only what a test sets itself does).
const cleanEnv = (extra = {}) => { const env = { ...process.env, ...extra }; for (const k of Object.keys(env)) if (/^ORCA_/.test(k) && !(k in extra)) delete env[k]; return env; };
function setup({ state = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-heartbeat-"));
  const ctl = path.join(dir, "ctl"), project = path.join(dir, "p");
  fs.mkdirSync(path.join(ctl, "steering"), { recursive: true });
  fs.mkdirSync(path.join(project, "docs/tasks"), { recursive: true });
  for (const f of ["heartbeat.mjs", "cli.mjs", "controller-terminal.mjs", "front-notice.mjs", "inbox.mjs", "restart.mjs", "lib.mjs", "steering/tasks.mjs"]) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(ctl, f));
  fs.writeFileSync(path.join(ctl, "factory.config.json"), JSON.stringify({ project: { name: "p", mainBranch: "main", humanName: "Alex" }, agents: { runner: "orca" }, commands: {}, hosts: { controller: { host: "local" }, workers: [{ name: "local", kind: "local", projectDir: project, orcaRepoId: "r" }] } }));
  const fake = path.join(dir, "fake-orca.mjs");
  const stateFile = path.join(dir, "state.json");
  const calls = path.join(dir, "calls.log");
  // Orca's listing: an agent running in the project's worktree is what makes a terminal the Controller (controller-terminal.mjs).
  const listed = (state.terminals ?? [{ handle: "term_c", title: "p · Controller" }]).map((t) => ({ worktreePath: project, agentIdentity: "claude", ...t }));
  fs.writeFileSync(path.join(ctl, "status.md"), "# Status\n");
  fs.writeFileSync(stateFile, JSON.stringify({ messages: [], idle: true, ...state, terminals: listed }));
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const a = process.argv.slice(2), s = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + "\\n");
const out = (result) => console.log(JSON.stringify({ ok: true, result }));
if (a[0] === "terminal" && a[1] === "list") out({ terminals: s.terminals });
else if (a[0] === "terminal" && a[1] === "wait") out({ wait: { satisfied: s.idle } });
else if (a[0] === "terminal" && a[1] === "read") out({ tail: s.screenText ?? s.waveTail ?? "" });
else if (a[0] === "orchestration" && a[1] === "inbox") out({ messages: s.messages });
else out({});`);
  fs.chmodSync(fake, 0o755);
  const beat = () => {
    const r = spawnSync("node", [path.join(ctl, "heartbeat.mjs")], { encoding: "utf8", env: cleanEnv({ ORCA_CLI_COMMAND: fake, FACTORY_CONFIG: path.join(ctl, "factory.config.json") }) });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const sent = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((a) => a[0] === "terminal" && a[1] === "send") : []);
  const patch = (p) => fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stateFile, "utf8")), ...p }));
  const write = (name, text) => fs.writeFileSync(path.join(ctl, name), text);
  const age = (name, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(path.join(ctl, name), t, t); };
  return { dir, ctl, beat, sent, patch, write, age, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const worker = JSON.stringify({ t1: { name: "T1 · Worker Developer", host: "local", terminal: "term_w", worktree: "/w/t1" } });
const doneMsg = { id: "m1", type: "worker_done", from: "term_w", subject: "done" };

test("old messages wake nobody; a new worker message wakes the Controller once", () => {
  const h = setup({ state: { messages: [{ id: "m0", type: "worker_done", from: "term_w", subject: "old" }] } });
  h.write("workers.json", worker);
  assert.match(h.beat(), /baseline/);
  assert.equal(h.sent().length, 0);
  h.patch({ messages: [{ id: "m0", type: "worker_done", from: "term_w" }, doneMsg] });
  const out = h.beat();
  assert.match(out, /worker done: T1 · Worker Developer/);
  assert.match(out, /woke term_c \(1 worker message/);
  assert.equal(h.sent().length, 1);
  h.write("workers.json", "{}"); // A running worker would wake it at each tenth minute, which is not what this test is about.
  assert.doesNotMatch(h.beat(), /worker message/);
  assert.equal(h.sent().length, 1);
  h.done();
});

test("a signal stays pending while the Controller is busy, and is delivered on a later tick", () => {
  const h = setup();
  h.write("workers.json", worker);
  h.beat();
  h.patch({ messages: [doneMsg], idle: false });
  assert.match(h.beat(), /busy, not woken \(1 worker message/);
  assert.equal(h.sent().length, 0);
  h.patch({ idle: true });
  assert.match(h.beat(), /woke term_c/);
  assert.equal(h.sent().length, 1);
  h.done();
});

test("N7: a finished worker whose worktree cleanup just removed is not marked in the sidebar, and says nothing about it", () => {
  const h = setup();
  const ws = path.join(h.dir, "ws");
  fs.writeFileSync(path.join(h.ctl, "factory.config.json"), JSON.stringify({ project: { name: "p", mainBranch: "main", humanName: "Alex" }, agents: { runner: "orca" }, commands: {}, hosts: { controller: { host: "local" }, workers: [{ name: "local", kind: "local", projectDir: path.join(h.dir, "p"), workspacesDir: ws, orcaRepoId: "r" }] } }));
  const workerOn = JSON.stringify({ t1: { name: "T1 · Worker Developer", host: "local", terminal: "term_w", worktree: path.join(ws, "p", "t1") } });
  const marks = () => fs.readFileSync(path.join(h.dir, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((a) => a[0] === "worktree" && a[1] === "set" && a.some((x) => /^id:r::/.test(x)));
  h.write("workers.json", workerOn);
  h.beat();
  fs.writeFileSync(path.join(h.dir, "calls.log"), "");
  h.patch({ messages: [doneMsg] });
  const out = h.beat();
  assert.match(out, /worker done: T1 · Worker Developer/);
  assert.doesNotMatch(out, /marking failed/);
  assert.equal(marks().length, 0, "the worktree is gone: no mark");
  // Still there: it is marked.
  fs.mkdirSync(path.join(ws, "p", "t1"), { recursive: true });
  h.patch({ messages: [doneMsg, { id: "m2", type: "worker_done", from: "term_w", subject: "again" }] });
  h.beat();
  assert.equal(marks().length, 1);
  h.done();
});

test("a worker the Controller already dropped from workers.json still wakes it", () => {
  const h = setup();
  h.write("workers.json", worker);
  h.beat();
  h.write("workers.json", "{}");
  h.patch({ messages: [doneMsg] });
  assert.match(h.beat(), /woke term_c/);
  h.done();
});

// Pretends the Controller has been busy without a break since `minutes` ago (the heartbeat records it, one run at a time).
const busySince = (h, minutes) => h.write("heartbeat.busy.json", JSON.stringify({ since: Date.now() - minutes * 60_000, last: Date.now() - 30_000 }));

test("a busy Controller gets one pointer to what is waiting after two minutes of being busy, not after five", () => {
  const h = setup({ state: { idle: false } });
  h.beat();
  h.write("inbox.md", "2026-11-05 do this\n");
  assert.equal(h.sent().length, 0, "not at once");
  assert.match(h.beat(), /busy, not woken \(inbox; Orca: not idle\)/, "what Orca said is logged");
  assert.equal(h.sent().length, 0, "a fresh instruction waits: the Controller was busy for a moment only");
  busySince(h, 3);
  assert.match(h.beat(), /pointed the busy Controller to the inbox/);
  assert.match(h.sent()[0].join(" "), /inbox\.md/);
  h.beat();
  assert.equal(h.sent().length, 1, "only once per inbox state");
  h.write("inbox.md", "2026-11-05 do this\n2026-11-05 and this\n");
  busySince(h, 4);
  h.beat();
  assert.equal(h.sent().length, 2, "a new line is a new state");
  h.done();
});

test("a worker message or a finished wave reaches a busy Controller as a pointer too, once", () => {
  const h = setup({ state: { idle: false } });
  h.write("workers.json", worker);
  h.beat();
  h.patch({ messages: [doneMsg] });
  h.beat();
  assert.equal(h.sent().length, 0);
  busySince(h, 3);
  assert.match(h.beat(), /pointed the busy Controller to new mail or a finished wave/);
  assert.match(h.sent()[0].join(" "), /something new is waiting/);
  assert.doesNotMatch(h.sent()[0].join(" "), /done/, "nothing a worker wrote is typed");
  h.beat();
  assert.equal(h.sent().length, 1);
  h.done();
});

test("the busy pointer is not typed while a confirmation question is visible; it is typed once the question is gone", () => {
  const h = setup({ state: { idle: false } });
  h.patch({ waveTail: "" });
  h.beat();
  h.write("inbox.md", "do this\n");
  busySince(h, 3);
  // The fake serves the screen from the state file.
  const screen = (text) => h.patch({ screenText: text });
  screen("Allow this command to run? Do you want to proceed?\n 1. Yes\n 2. No");
  assert.match(h.beat(), /pointer not typed: a confirmation question is visible/);
  assert.equal(h.sent().length, 0);
  screen("> ");
  h.beat();
  assert.equal(h.sent().length, 1);
  h.done();
});

test("hosts.controller.wake.busyPointerMinutes sets how long a busy Controller is left alone", () => {
  const h = setup({ state: { idle: false } });
  fs.writeFileSync(path.join(h.ctl, "factory.config.json"), JSON.stringify({ project: { name: "p", mainBranch: "main", humanName: "Alex" }, agents: { runner: "orca" }, commands: {}, hosts: { controller: { host: "local", wake: { busyPointerMinutes: 10 } }, workers: [{ name: "local", kind: "local", projectDir: path.join(h.dir, "p"), orcaRepoId: "r" }] } }));
  h.beat();
  h.write("inbox.md", "do this\n");
  busySince(h, 5);
  h.beat();
  assert.equal(h.sent().length, 0);
  busySince(h, 11);
  h.beat();
  assert.equal(h.sent().length, 1);
  h.done();
});

test("inbox.mjs --done moves exactly what was printed; a line that arrives meanwhile stays and wakes the Controller, identical text included", () => {
  const h = setup();
  h.beat();
  const inbox = (args = []) => spawnSync("node", [path.join(h.ctl, "inbox.mjs"), ...args], { encoding: "utf8", env: cleanEnv({ FACTORY_CONFIG: path.join(h.ctl, "factory.config.json") }) });
  const text = () => fs.readFileSync(path.join(h.ctl, "inbox.md"), "utf8");
  h.write("inbox.md", "yes\n");
  assert.match(h.beat(), /woke term_c \(inbox\)/, "no record: every line is new, as before");
  assert.equal(inbox().stdout, "yes\n");
  fs.appendFileSync(path.join(h.ctl, "inbox.md"), "yes\n");   // the human's second answer, the same words, while the Controller works
  const done = inbox(["--done"]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /moved 1 line\(s\) to inbox-done\.md; 1 line\(s\) arrived since you read it and stay in inbox\.md/);
  assert.equal(text(), "yes\n", "the second line was never printed and stays");
  assert.equal(fs.readFileSync(path.join(h.ctl, "inbox-done.md"), "utf8"), "yes\n");
  h.write("heartbeat.last", ""); h.age("heartbeat.last", 5 * 60_000);
  assert.match(h.beat(), /woke term_c \(inbox\)/, "the unread line wakes it, with \"Needs\" open or not");
  // Read and done again: nothing is new, not even at a tenth minute.
  inbox(); assert.equal(inbox(["--done"]).status, 0);
  assert.equal(text(), "");
  h.age("heartbeat.last", 5 * 60_000);
  assert.doesNotMatch(h.beat(), /woke/);
  // Two copies sent again after the first were moved out are new again.
  h.write("inbox.md", "yes\n");
  h.age("heartbeat.last", 5 * 60_000);
  assert.match(h.beat(), /woke term_c \(inbox\)/);
  h.done();
});

test("inbox.mjs: a half-written last line is neither printed nor moved, and a file that was edited under it is left alone; a stale or foreign record counts as all new", () => {
  const h = setup();
  h.beat();
  const inbox = (args = []) => spawnSync("node", [path.join(h.ctl, "inbox.mjs"), ...args], { encoding: "utf8", env: cleanEnv({ FACTORY_CONFIG: path.join(h.ctl, "factory.config.json") }) });
  h.write("inbox.md", "one\ntw");
  assert.equal(inbox().stdout, "one\n");
  assert.equal(inbox(["--done"]).status, 0);
  assert.equal(fs.readFileSync(path.join(h.ctl, "inbox.md"), "utf8"), "tw");
  h.write("inbox.md", "alpha\nbeta\n");
  inbox();
  h.write("inbox.md", "ALPHA\nbeta\nmore\n");   // edited by hand between the two steps
  const refused = inbox(["--done"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /no longer starts with what you read; nothing was moved/);
  assert.equal(fs.readFileSync(path.join(h.ctl, "inbox.md"), "utf8"), "ALPHA\nbeta\nmore\n");
  assert.equal(inbox(["--done"]).status, 1, "done without a read of its own is refused too after the record is used up or missing");
  for (const bad of ["not json", "[]", "null", JSON.stringify({ bytes: 9999, hash: "x" }), JSON.stringify({ bytes: 3, hash: "wrong" })]) {
    h.write("inbox.handled.json", bad);
    h.write("heartbeat.last", ""); h.age("heartbeat.last", 5 * 60_000);
    assert.match(h.beat(), /woke term_c \(inbox\)/, bad);
  }
  h.done();
});

test("with a \"Needs\" item open, an inbox newer than status.md still wakes the Controller: an answer never waits for ever", () => {
  const h = setup();
  h.beat();
  h.write("status.md", "# Status\n## Needs Alex\n- Which option?\n## Next\n"); h.age("status.md", 30 * 60_000);
  assert.doesNotMatch(h.beat(), /woke/, "nothing new: a Controller that waits for the human is not woken");
  h.write("inbox.md", "2026-11-24 option B\n");
  assert.match(h.beat(), /woke term_c \(inbox/);
  // It answers, writes status.md (a newer one) and moves the line out.
  h.write("status.md", "# Status\n## Needs Alex\n- Next question?\n## Next\n");
  h.write("inbox.md", "");
  h.write("heartbeat.last", ""); h.age("heartbeat.last", 5 * 60_000);
  assert.doesNotMatch(h.beat(), /woke/);
  h.done();
});

test("an idle project is woken at most every wake.idleMinutes, and an unreadable source is no event", () => {
  const h = setup();
  h.beat();
  assert.match(h.beat(), /woke term_c \(idle check\)/, "the first idle check is due at once");
  h.write("heartbeat.last", "");
  h.age("heartbeat.last", 25 * 60_000);
  assert.doesNotMatch(h.beat(), /woke/, "25 minutes: too soon");
  h.age("heartbeat.last", 31 * 60_000);
  assert.match(h.beat(), /woke term_c \(idle check\)/, "31 minutes: due (default 30)");
  h.done();
});

test("a Controller that only waits for the human is not woken, not even hourly", () => {
  const h = setup();
  h.beat();
  h.write("heartbeat.last", "");
  h.age("heartbeat.last", 2 * 60 * 60_000);
  h.write("status.md", "# Status\n## Needs Alex\n- Which option?\n## Next\n");
  h.beat();
  assert.equal(h.sent().length, 0);
  h.write("status.md", "# Status\n## Needs Alex\n- none\n## Next\n");
  assert.match(h.beat(), /woke term_c \(/);
  assert.equal(h.sent().length, 1);
  h.done();
});

test("a finished wave wakes the Controller once", () => {
  const h = setup({ state: { terminals: [{ handle: "term_c", title: "p · Controller" }, { handle: "term_wave", title: "p · Integration · T1" }], waveTail: "x\nPUSHED main\nWAVE-END\n" } });
  h.beat();
  h.write("wave-handle.txt", "local term_wave\n");
  const out = h.beat();
  assert.match(out, /wave finished: pushed to main/);
  assert.match(out, /woke term_c \(wave finished/);
  assert.doesNotMatch(h.beat(), /wave finished/);
  h.done();
});

test("a Controller terminal that pi renamed to its cwd is still found and woken", () => {
  for (const piTitle of ["π - ctl", "⠋ π - ctl", "π - ~/ctl", "Pi - /home/x/ctl"]) {
    const h = setup({ state: { terminals: [{ handle: "term_other", title: "π - ~/ctl-other" }, { handle: "term_pi", title: piTitle }] } });
    h.beat();
    assert.match(h.beat(), /woke term_pi/, piTitle);
    h.done();
  }
  const h = setup({ state: { terminals: [{ handle: "term_x", title: "π - ~/other-ctl", worktreePath: "/elsewhere" }] } });
  assert.match(h.beat(), /nothing woken/, "another directory's pi terminal is not this Controller");
  h.done();
});

test("no Controller terminal: nothing is woken and it says so", () => {
  const h = setup({ state: { terminals: [] } });
  assert.match(h.beat(), /no terminal recorded or named as the Controller, nothing woken/);
  assert.equal(h.sent().length, 0);
  h.done();
});

test("the cron script adds one line, keeps the rest of the crontab, and keeps an existing heartbeat", async () => {
  const { heartbeatCronScript } = await import(path.join(ROOT, "bin/heartbeat-cron.mjs"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-heartbeat-cron-"));
  const tab = path.join(dir, "tab");
  fs.writeFileSync(tab, "0 3 * * * other job\n");
  const fake = path.join(dir, "crontab");
  fs.writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "-l" ]; then cat "${tab}"; else cat > "${tab}.new" && mv "${tab}.new" "${tab}"; fi\n`);
  fs.chmodSync(fake, 0o755);
  const run = (d) => spawnSync("sh", ["-c", heartbeatCronScript(d, "p")], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: "/home/x" } }).stdout.trim();
  assert.equal(run("~/controller"), "added");
  const text = fs.readFileSync(tab, "utf8");
  assert.match(text, /^0 3 \* \* \* other job$/m);
  assert.match(text, /^\* \* \* \* \* cd "\/home\/x\/controller" && PATH="\/home\/x\/\.local\/bin:.*" node heartbeat\.mjs >> heartbeat\.log 2>&1$/m);
  assert.equal(run("~/controller"), "exists");
  assert.equal(fs.readFileSync(tab, "utf8"), text);
  fs.writeFileSync(tab, "* * * * * flock -n /home/x/c2/heartbeat.lock node /home/x/c2/heartbeat.mjs\n");
  assert.equal(run("~/c2"), "exists", "a line written by hand stays");
  assert.equal(run("~/c3"), "added", "another project's directory gets its own line");
  fs.rmSync(dir, { recursive: true, force: true });
});
