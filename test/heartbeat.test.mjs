// controller/heartbeat.mjs against a fake Orca: who gets woken, when, and that a signal is only spent on a successful wake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function setup({ state = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-heartbeat-"));
  const ctl = path.join(dir, "ctl"), project = path.join(dir, "p");
  fs.mkdirSync(path.join(ctl, "steering"), { recursive: true });
  fs.mkdirSync(path.join(project, "docs/tasks"), { recursive: true });
  for (const f of ["heartbeat.mjs", "lib.mjs", "steering/tasks.mjs"]) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(ctl, f));
  fs.writeFileSync(path.join(ctl, "factory.config.json"), JSON.stringify({ project: { name: "p", mainBranch: "main", humanName: "Alex" }, agents: { runner: "orca" }, commands: {}, hosts: { controller: { host: "local" }, workers: [{ name: "local", kind: "local", projectDir: project, orcaRepoId: "r" }] } }));
  const fake = path.join(dir, "fake-orca.mjs");
  const stateFile = path.join(dir, "state.json");
  const calls = path.join(dir, "calls.log");
  fs.writeFileSync(stateFile, JSON.stringify({ terminals: [{ handle: "term_c", title: "p · Controller" }], messages: [], idle: true, ...state }));
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const a = process.argv.slice(2), s = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + "\\n");
const out = (result) => console.log(JSON.stringify({ ok: true, result }));
if (a[0] === "terminal" && a[1] === "list") out({ terminals: s.terminals });
else if (a[0] === "terminal" && a[1] === "wait") out({ wait: { satisfied: s.idle } });
else if (a[0] === "terminal" && a[1] === "read") out({ tail: s.waveTail ?? "" });
else if (a[0] === "orchestration" && a[1] === "inbox") out({ messages: s.messages });
else out({});`);
  fs.chmodSync(fake, 0o755);
  const beat = () => {
    const r = spawnSync("node", [path.join(ctl, "heartbeat.mjs")], { encoding: "utf8", env: { ...process.env, ORCA_CLI_COMMAND: fake, FACTORY_CONFIG: path.join(ctl, "factory.config.json") } });
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

test("a worker the Controller already dropped from workers.json still wakes it", () => {
  const h = setup();
  h.write("workers.json", worker);
  h.beat();
  h.write("workers.json", "{}");
  h.patch({ messages: [doneMsg] });
  assert.match(h.beat(), /woke term_c/);
  h.done();
});

test("a busy Controller gets one pointer to an inbox instruction after five minutes", () => {
  const h = setup({ state: { idle: false } });
  h.beat();
  h.write("inbox.md", "2026-11-05 do this\n");
  assert.equal(h.sent().length, 0, "not at once");
  h.beat();
  assert.equal(h.sent().length, 0, "a fresh instruction waits for the next cycle");
  h.age("inbox.md", 6 * 60_000);
  assert.match(h.beat(), /pointed the busy Controller to the inbox/);
  assert.match(h.sent()[0].join(" "), /inbox\.md/);
  h.beat();
  assert.equal(h.sent().length, 1, "only once per inbox state");
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

test("no Controller terminal: nothing is woken and it says so", () => {
  const h = setup({ state: { terminals: [] } });
  assert.match(h.beat(), /no terminal titled "p · Controller", nothing woken/);
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
