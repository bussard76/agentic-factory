// A worker is finished when Orca reports its dispatch settled, not when its terminal is gone. These tests run the shared
// rule (lib.mjs) and cleanup, capacity and the heartbeat against a fake Orca whose dispatch states the test sets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const FILES = ["cleanup.mjs", "capacity.mjs", "heartbeat.mjs", "controller-terminal.mjs", "lib.mjs", "journal.mjs", "names.mjs", "steering/tasks.mjs"];

// dispatches: id → worker-list row fields; worker-show answers for the same ids, and dispatch_not_found for the rest.
function setup({ dispatches = {}, terminals = [], workers = {}, listed = true, capacity = { gate: {} } } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "af-finished-")));
  const ctl = path.join(dir, "ctl"), project = path.join(dir, "p"), ws = path.join(dir, "ws");
  fs.mkdirSync(path.join(ctl, "steering"), { recursive: true });
  fs.mkdirSync(path.join(project, "docs/tasks"), { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(ctl, f));
  fs.writeFileSync(path.join(ctl, "factory.config.json"), JSON.stringify({ project: { name: "p", mainBranch: "main", humanName: "Alex" }, agents: { runner: "orca" }, commands: {}, capacity, hosts: { controller: { host: "local" }, workers: [{ name: "local", kind: "local", projectDir: project, workspacesDir: ws, orcaRepoId: "r" }] } }));
  fs.writeFileSync(path.join(ctl, "workers.json"), JSON.stringify(workers));
  const state = path.join(dir, "state.json"), log = path.join(dir, "calls.log"), fake = path.join(dir, "fake-orca.mjs");
  fs.writeFileSync(state, JSON.stringify({ dispatches, terminals, listed }));
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const a = process.argv.slice(2), s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
fs.appendFileSync(${JSON.stringify(log)}, a.join(" ") + "\\n");
const out = (result) => console.log(JSON.stringify({ ok: true, result }));
const arg = (n) => a[a.indexOf(n) + 1];
if (a[0] === "terminal" && a[1] === "list") out({ terminals: s.terminals });
else if (a[0] === "terminal" && a[1] === "wait") out({ wait: { satisfied: true } });
else if (a[1] === "worker-list") out({ workers: s.listed ? Object.entries(s.dispatches).map(([id, d]) => ({ dispatchId: id, workerState: d.state, resource: { retainedReason: d.retainedReason ?? null } })) : [] });
else if (a[1] === "worker-show") {
  const d = s.dispatches[arg("--dispatch")];
  if (d) out({ worker: { state: d.state }, terminalResource: { retainedReason: d.retainedReason ?? null } });
  else { console.log(JSON.stringify({ ok: false, error: { code: "dispatch_not_found" } })); process.exit(1); }
}
else if (a[0] === "orchestration" && a[1] === "inbox") out({ messages: [] });
else if (a[0] === "worktree" && a[1] === "list") out({ worktrees: [] });
else out({});`);
  fs.chmodSync(fake, 0o755);
  const env = { ...process.env, ORCA_CLI_COMMAND: fake, FACTORY_CONFIG: path.join(ctl, "factory.config.json") };
  const run = (script, ...args) => spawnSync("node", [path.join(ctl, script), ...args], { cwd: ctl, encoding: "utf8", env });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { dir, ctl, project, ws, env, run, calls, git, readWorkers: () => JSON.parse(fs.readFileSync(path.join(ctl, "workers.json"), "utf8")), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("workerStatus: a settled dispatch is finished, a ready one running, an unanswered one unknown", async () => {
  const h = setup();
  process.env.FACTORY_CONFIG = path.join(h.ctl, "factory.config.json");
  const { workerStatus } = await import(path.join(h.ctl, "lib.mjs"));
  const dispatches = { a: { state: "succeeded" }, b: { state: "failed" }, c: { state: "stopped" }, d: { state: "abandoned" }, e: { state: "ready" }, f: { state: "gone" }, g: { state: "some-new-state" } };
  for (const id of ["a", "b", "c", "d"]) assert.equal(workerStatus({ dispatch: id, terminal: "t" }, { dispatches, terminals: new Set(["t"]) }), "finished", id);
  assert.equal(workerStatus({ dispatch: "e" }, { dispatches }), "running");
  // A dispatch Orca no longer knows: a terminal still listed may still work; a missing one or none is finished.
  assert.equal(workerStatus({ dispatch: "f", terminal: "t" }, { dispatches, terminals: new Set(["t"]) }), "running");
  assert.equal(workerStatus({ dispatch: "f", terminal: "t" }, { dispatches, terminals: new Set() }), "finished");
  assert.equal(workerStatus({ dispatch: "f" }, { dispatches }), "finished");
  assert.equal(workerStatus({ dispatch: "g" }, { dispatches }), "running", "an unrecognised state is not finished");
  assert.equal(workerStatus({ dispatch: "x", terminal: "t" }, { dispatches, terminals: new Set() }), "unknown", "no answer is never finished");
  // Records without a dispatch keep the old rules.
  assert.equal(workerStatus({ terminal: "t" }, { terminals: new Set(["t"]) }), "running");
  assert.equal(workerStatus({ terminal: "t" }, { terminals: new Set() }), "finished");
  assert.equal(workerStatus({ terminal: "t" }, { terminals: null }), "unknown");
  assert.equal(workerStatus({ pid: 1 }, { pidAlive: () => false }), "finished");
  h.done();
});

test("dispatchStates reads worker-list, falls back to worker-show, and marks a forgotten dispatch gone", () => {
  const h = setup({ dispatches: { ctx_a: { state: "succeeded", retainedReason: "user_requested" }, ctx_b: { state: "ready" } }, listed: false });
  const code = `import { dispatchStates } from ${JSON.stringify(path.join(h.ctl, "lib.mjs"))}; console.log(JSON.stringify(dispatchStates(["ctx_a", "ctx_b", "ctx_gone", undefined], undefined)));`;
  const r = spawnSync("node", ["--input-type=module", "-e", code], { encoding: "utf8", env: h.env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ctx_a: { state: "succeeded", keptOpen: true }, ctx_b: { state: "ready", keptOpen: false }, ctx_gone: { state: "gone" } });
  h.done();
});

const rec = (name, dispatch, terminal, worktree, extra = {}) => ({ name, host: "local", dispatch, terminal, worktree, readonly: false, ...extra });

test("cleanup releases a finished worker whose agent still sits at its prompt, closes its terminal and removes its merged worktree", () => {
  const h0 = setup();
  const wt = (n) => path.join(h0.ws, "p", n);
  const workers = {
    done: rec("T1 · Worker Developer", "ctx_done", "term_done", wt("t1")),
    busy: rec("T2 · Worker Developer", "ctx_busy", "term_busy", wt("t2")),
    open: rec("T3 · Worker Developer", "ctx_open", "term_open", wt("t3")),
    old: rec("T4 · Worker Tester", "ctx_old", "term_old", wt("t4")),
    rework: rec("T4 · Worker Developer", "ctx_rework", "term_rework", wt("t4")),
  };
  h0.done();
  const h = setup({
    workers,
    dispatches: { ctx_done: { state: "succeeded" }, ctx_busy: { state: "ready" }, ctx_open: { state: "succeeded", retainedReason: "user_requested" }, ctx_old: { state: "succeeded" }, ctx_rework: { state: "ready" } },
    terminals: Object.values(workers).map((w) => ({ handle: w.terminal, title: w.name, worktreePath: w.worktree })),
  });
  h.git("init", "-q", "-b", "main"); h.git("commit", "-q", "--allow-empty", "-m", "first");
  const bare = path.join(h.dir, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  h.git("remote", "add", "origin", bare); h.git("push", "-q", "origin", "main"); h.git("fetch", "-q", "origin");
  for (const n of ["t1", "t2", "t3", "t4", "t5"]) h.git("worktree", "add", "-q", "-b", `agents/${n}`, wt(n), "origin/main");
  fs.writeFileSync(path.join(wt("t5"), "notes.txt"), "work in progress");
  const dry = h.run("cleanup.mjs", "--dry");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would release the finished worker "T1 · Worker Developer"/);
  assert.match(dry.stdout, /would remove t1 \(merged\)/);
  assert.match(dry.stdout, /kept t2: worker "T2 · Worker Developer" running/);
  assert.match(dry.stdout, /kept t3: worker "T3 · Worker Developer" kept open/);
  assert.match(dry.stdout, /kept t4: worker "T4 · Worker Developer" running/, "a rework on the same worktree holds it");
  assert.match(dry.stdout, /kept t5: uncommitted or untracked changes/);
  assert.ok(!h.calls().some((c) => / worker-release | terminal close /.test(` ${c} `)), "a dry run releases and closes nothing");
  const r = h.run("cleanup.mjs");
  assert.equal(r.status, 0, r.stderr);
  const calls = h.calls();
  assert.ok(calls.includes("orchestration worker-release --dispatch ctx_done --json"));
  assert.ok(calls.includes("terminal close --terminal term_done --json"), "the finished worker's terminal is closed");
  assert.ok(!calls.some((c) => /worker-(release|abandon) --dispatch ctx_(busy|open|rework)/.test(c)), "running and kept-open workers are left alone");
  assert.ok(!calls.some((c) => /terminal close --terminal term_(busy|open|rework)/.test(c)));
  const removals = calls.filter((c) => c.startsWith("worktree rm ")).map((c) => c.split(" ")[3].split("/").pop());
  assert.deepEqual(removals, ["t1"], "only the merged worktree of the finished worker is removed");
  assert.deepEqual(Object.keys(h.readWorkers()).sort(), ["busy", "open", "rework"]);
  assert.match(r.stdout, /cleanup: removed .*released 2 dispatches/);
  h.done();
});

test("cleanup forgets a finished worker even when Orca cannot release it, and reports it", () => {
  const h = setup({ workers: { a: rec("T1 · Worker Developer", "ctx_a", "term_a", "/nowhere/t1") }, dispatches: { ctx_a: { state: "failed" } }, terminals: [] });
  // A fake that refuses every release and abandon.
  const fake = h.env.ORCA_CLI_COMMAND, src = fs.readFileSync(fake, "utf8");
  fs.writeFileSync(fake, src.replace(`const out = `, `if (a[1] === "worker-release" || a[1] === "worker-abandon") { console.log(JSON.stringify({ ok: false, error: { code: "release_unknown" } })); process.exit(1); }\nconst out = `));
  const r = h.run("cleanup.mjs");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /release FAILED for ctx_a/);
  assert.deepEqual(h.readWorkers(), {});
  h.done();
});

test("capacity counts running workers only; finished ones at their prompt free the cap", () => {
  const h = setup({
    workers: { a: rec("A · Worker Developer", "ctx_a", "term_a", "/w/a"), b: rec("B · Worker Developer", "ctx_b", "term_b", "/w/b"), c: rec("C · Worker Developer", "ctx_c", "term_c", "/w/c") },
    dispatches: { ctx_a: { state: "succeeded" }, ctx_b: { state: "succeeded" }, ctx_c: { state: "ready" } },
    terminals: [{ handle: "term_a" }, { handle: "term_b" }, { handle: "term_c" }],
  });
  const v = JSON.parse(h.run("capacity.mjs", "--verbose").stdout);
  assert.equal(v.measured.suite, 1);
  // An unreadable state counts as running.
  fs.writeFileSync(path.join(h.ctl, "workers.json"), JSON.stringify({ x: rec("X · Worker Developer", "ctx_unknown_but_present", "term_x", "/w/x") }));
  const src = fs.readFileSync(h.env.ORCA_CLI_COMMAND, "utf8");
  fs.writeFileSync(h.env.ORCA_CLI_COMMAND, src.replace(`const out = `, `if (a[1] === "worker-list" || a[1] === "worker-show") process.exit(1);\nconst out = `));
  const u = JSON.parse(h.run("capacity.mjs", "--verbose").stdout);
  assert.equal(u.measured.suite, 1); assert.match(u.reason, /1 recorded workers counted as live/);
  h.done();
});

test("capacity: --set-suite needs a number and a quote, is journaled, and a wait says when to measure again and whether only the cap holds", () => {
  // No pressure can count on this machine, so only the cap can hold the start back.
  const capacity = { gate: {}, availableMemoryMinGb: 0, gateQueueMax: 99, pressure: { cpuAvg10MaxPercent: 100, memoryAvg10MaxPercent: 100 } };
  const h = setup({ capacity, workers: { a: rec("A · Worker Developer", "ctx_a", "term_a", "/w/a") }, dispatches: { ctx_a: { state: "ready" } } });
  assert.notEqual(h.run("capacity.mjs", "--set-suite", "3").status, 0, "--by is required");
  assert.notEqual(h.run("capacity.mjs", "--set-suite", "0", "--by", "x").status, 0, "n ≥ 1");
  const r = h.run("capacity.mjs", "--set-suite", "1", "--by", "Alex: one at a time today");
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(v.caps.suite, 1);
  assert.equal(v.suite, "wait");
  assert.equal(v.capOnly, true, `nothing but the cap holds it: ${v.reason}`);
  assert.ok(Date.parse(v.measureAgainAt) - Date.now() > 30e3, "measure again in about a minute");
  const journal = fs.readFileSync(path.join(h.ctl, "journal.ndjson"), "utf8");
  assert.match(journal, /"type":"decision".*capacity suiteMax set → 1 by hand.*"by":"Alex: one at a time today"/);
  // The cap stays set on the next run.
  assert.equal(JSON.parse(h.run("capacity.mjs").stdout).caps.suite, 1);
  h.done();
});

test("heartbeat: a finished worker's record neither counts as active nor as pending work", () => {
  const h = setup({
    workers: { a: rec("A · Worker Developer", "ctx_a", "term_a", "/w/a") },
    dispatches: { ctx_a: { state: "succeeded" } },
    terminals: [{ handle: "term_c", title: "p · Controller" }, { handle: "term_a", title: "A · Worker Developer" }],
  });
  const beat = () => { const r = h.run("heartbeat.mjs"); assert.equal(r.status, 0, r.stderr); return fs.readFileSync(path.join(h.ctl, "heartbeat.notice"), "utf8"); };
  assert.match(beat(), /Nothing left to do/);
  fs.writeFileSync(path.join(h.ctl, "heartbeat.notice"), "");
  const state = path.join(h.dir, "state.json"), s = JSON.parse(fs.readFileSync(state, "utf8"));
  s.dispatches.ctx_a.state = "ready";
  fs.writeFileSync(state, JSON.stringify(s));
  assert.match(beat(), /Working: 1 workers/);
  h.done();
});
