// A worker is finished when Orca reports its dispatch settled, not when its terminal is gone. These tests run the shared
// rule (lib.mjs) and cleanup, capacity and the heartbeat against a fake Orca whose dispatch states the test sets, in
// throwaway repositories. The rule throughout: cleanup deletes, so anything not positively finished is busy.
import "./support/safe-env.mjs";
import { tempDir } from "./support/cleanup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const FILES = ["cli.mjs", "keep.mjs", "cleanup.mjs", "capacity.mjs", "heartbeat.mjs", "controller-terminal.mjs", "front-notice.mjs", "inbox.mjs", "restart.mjs", "lib.mjs", "journal.mjs", "names.mjs", "steering/tasks.mjs"];

// dispatches: id → { state, retainedReason, ownership, owner (dispatch owning the terminal), noResource, setup: [terminal
// handles], releaseFails, releaseAnswer (what the release leaves in terminalResource.releaseState: released, retained,
// release_pending, …; already_released leaves released), receipt (the release answer's body, which cleanup must ignore) }. worker-list pages them
// (newest first, `pageSize` per page, `filler` unrelated rows first); worker-show answers for known ids and
// dispatch_not_found for the rest; `broken` makes every orchestration call fail without an answer.
function setup({ dispatches = {}, terminals = [], workers = {}, capacity = { gate: {} }, pageSize = 100, filler = 0, broken = false } = {}) {
  const dir = fs.realpathSync(tempDir("af-finished-"));
  const ctl = path.join(dir, "ctl"), project = path.join(dir, "p"), ws = path.join(dir, "ws");
  fs.mkdirSync(path.join(ctl, "steering"), { recursive: true });
  fs.mkdirSync(path.join(project, "docs/tasks"), { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(ctl, f));
  fs.writeFileSync(path.join(ctl, "factory.config.json"), JSON.stringify({ project: { name: "p", mainBranch: "main", humanName: "Alex" }, agents: { runner: "orca" }, commands: {}, capacity, hosts: { controller: { host: "local" }, workers: [{ name: "local", kind: "local", projectDir: project, workspacesDir: ws, orcaRepoId: "r" }] } }));
  fs.writeFileSync(path.join(ctl, "workers.json"), JSON.stringify(workers));
  const state = path.join(dir, "state.json"), log = path.join(dir, "calls.log"), fake = path.join(dir, "fake-orca.mjs");
  // Orca's listing: the Controller is an agent running in the project's worktree (controller-terminal.mjs), and the heartbeat
  // types nothing before the Controller's first status.md.
  fs.writeFileSync(path.join(ctl, "status.md"), "# Status\n");
  const listed = terminals.map((t) => (/· Controller$/.test(t.title ?? "") ? { worktreePath: project, agentIdentity: "claude", ...t } : t));
  fs.writeFileSync(state, JSON.stringify({ dispatches, terminals: listed, pageSize, filler, broken }));
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const a = process.argv.slice(2), s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
fs.appendFileSync(${JSON.stringify(log)}, a.join(" ") + "\\n");
const out = (result) => console.log(JSON.stringify({ ok: true, result }));
const fail = (code) => { console.log(JSON.stringify({ ok: false, error: { code } })); process.exit(1); };
const arg = (n) => a[a.indexOf(n) + 1];
const resource = (d, id) => (d.noResource ? null : { retainedReason: d.retainedReason ?? null, ownershipState: d.ownership ?? "owned", ownerDispatchId: d.owner ?? id, releaseState: d.releaseState ?? "retained" });
if (s.broken && a[0] === "orchestration") process.exit(1);
if (a[0] === "terminal" && a[1] === "list") out({ terminals: s.terminals });
else if (a[0] === "terminal" && a[1] === "wait") out({ wait: { satisfied: true } });
else if (a[1] === "worker-list") {
  const rows = [...Array.from({ length: s.filler }, (_, i) => ({ dispatchId: "ctx_filler" + i, workerState: "succeeded", resource: {} })),
    ...Object.entries(s.dispatches).map(([id, d]) => ({ dispatchId: id, workerState: d.state, resource: resource(d, id) }))];
  const from = Number(a.includes("--cursor") ? arg("--cursor") : 0), to = from + s.pageSize;
  out({ workers: rows.slice(from, to), page: { nextCursor: to < rows.length ? String(to) : null } });
}
else if (a[1] === "worker-show") {
  const id = arg("--dispatch"), d = s.dispatches[id];
  if (!d) fail("dispatch_not_found");
  out({ worker: { state: d.state, effects: (d.setup ?? []).map((id) => ({ kind: "terminal", role: "setup", id })) }, terminalResource: resource(d, id) });
}
else if (a[1] === "worker-release") {
  const d = s.dispatches[arg("--dispatch")];
  if (d?.releaseFails) fail("release_unknown");
  const answer = d?.releaseAnswer ?? "released";
  if (d) { d.releaseState = answer === "already_released" ? "released" : answer; fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s)); }
  out(d?.receipt ?? { dispatchId: arg("--dispatch") });
}
else if (a[0] === "orchestration" && a[1] === "inbox") out({ messages: [] });
else if (a[0] === "worktree" && a[1] === "list") out({ worktrees: [] });
else out({});`);
  fs.chmodSync(fake, 0o755);
  const env = { ...process.env, ORCA_CLI_COMMAND: fake, FACTORY_CONFIG: path.join(ctl, "factory.config.json") };
  for (const k of Object.keys(env)) if (k.startsWith("ORCA_") && k !== "ORCA_CLI_COMMAND") delete env[k];   // never the developer's Orca
  const run = (script, ...args) => spawnSync("node", [path.join(ctl, script), ...args], { cwd: ctl, encoding: "utf8", env });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
  const patch = (fn) => { const s = JSON.parse(fs.readFileSync(state, "utf8")); fn(s); fs.writeFileSync(state, JSON.stringify(s)); };
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const wt = (n) => path.join(ws, "p", n);
  // A throwaway repository with an origin and one worktree per name, each on its own branch at origin/main (merged).
  const repo = (...names) => {
    git("init", "-q", "-b", "main"); git("commit", "-q", "--allow-empty", "-m", "first");
    const bare = path.join(dir, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    git("remote", "add", "origin", bare); git("push", "-q", "origin", "main"); git("fetch", "-q", "origin");
    for (const n of names) git("worktree", "add", "-q", "-b", `agents/${n}`, wt(n), "origin/main");
  };
  const setWorkers = (w) => fs.writeFileSync(path.join(ctl, "workers.json"), JSON.stringify(w));
  return { setWorkers, dir, ctl, project, ws, env, run, calls, patch, git, wt, repo, readWorkers: () => JSON.parse(fs.readFileSync(path.join(ctl, "workers.json"), "utf8")), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const libCall = (h, expr) => {
  const code = `import * as lib from ${JSON.stringify(path.join(h.ctl, "lib.mjs"))}; console.log(JSON.stringify(${expr}));`;
  const r = spawnSync("node", ["--input-type=module", "-e", code], { encoding: "utf8", env: h.env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const rec = (name, dispatch, terminal, worktree, extra = {}) => ({ name, host: "local", dispatch, terminal, worktree, readonly: false, ...extra });

test("workerStatus: only succeeded, failed and stopped are finished; abandoned and unanswered are not", async () => {
  const h = setup();
  process.env.FACTORY_CONFIG = path.join(h.ctl, "factory.config.json");
  const { workerStatus } = await import(path.join(h.ctl, "lib.mjs"));
  const dispatches = { a: { state: "succeeded" }, b: { state: "failed" }, c: { state: "stopped" }, d: { state: "abandoned" }, e: { state: "ready" }, f: { state: "gone" }, g: { state: "some-new-state" } };
  for (const id of ["a", "b", "c"]) assert.equal(workerStatus({ dispatch: id, terminal: "t" }, { dispatches, terminals: new Set(["t"]) }), "finished", id);
  assert.equal(workerStatus({ dispatch: "d", terminal: "t" }, { dispatches, terminals: new Set() }), "running", "Orca: an abandoned worker may still run");
  assert.equal(workerStatus({ dispatch: "e" }, { dispatches }), "running");
  assert.equal(workerStatus({ dispatch: "g" }, { dispatches }), "running", "an unrecognised state is not finished");
  // A dispatch Orca no longer knows: a terminal still listed may still work; a missing one or none is finished.
  assert.equal(workerStatus({ dispatch: "f", terminal: "t" }, { dispatches, terminals: new Set(["t"]) }), "running");
  assert.equal(workerStatus({ dispatch: "f", terminal: "t" }, { dispatches, terminals: new Set() }), "finished");
  assert.equal(workerStatus({ dispatch: "x", terminal: "t" }, { dispatches, terminals: new Set() }), "unknown", "no answer is never finished");
  // Records without a dispatch keep the old rules; a record with nothing to check is unknown.
  assert.equal(workerStatus({ terminal: "t" }, { terminals: new Set(["t"]) }), "running");
  assert.equal(workerStatus({ terminal: "t" }, { terminals: new Set() }), "finished");
  assert.equal(workerStatus({ terminal: "t" }, { terminals: null }), "unknown");
  assert.equal(workerStatus({ pid: 1 }, { pidAlive: () => false }), "finished");
  assert.equal(workerStatus({ name: "x" }, {}), "unknown");
  h.done();
});

test("dispatchStates pages worker-list at most 3 times, asks worker-show for at most 10 more, and leaves the rest unknown", () => {
  const dispatches = { ctx_near: { state: "succeeded", retainedReason: "user_requested", ownership: "external" }, ctx_far: { state: "ready" } };
  const h = setup({ dispatches, pageSize: 100, filler: 450 });   // ctx_near and ctx_far sit at rows 450 and 451: beyond 3 pages
  const ids = ["ctx_near", "ctx_far", "ctx_gone", ...Array.from({ length: 12 }, (_, i) => `ctx_missing${i}`)];
  const got = libCall(h, `lib.dispatchStates(${JSON.stringify(ids)}, undefined)`);
  const calls = h.calls();
  assert.equal(calls.filter((c) => c.includes("worker-list")).length, 3, "paging is bounded");
  assert.equal(calls.filter((c) => c.includes("worker-show")).length, 10, "fallback lookups are bounded");
  assert.deepEqual(got.ctx_near, { state: "succeeded", keptOpen: true, owned: false, owner: "ctx_near" });
  assert.deepEqual(got.ctx_far, { state: "ready", keptOpen: false, owned: true, owner: "ctx_far" });
  assert.deepEqual(got.ctx_gone, { state: "gone" });
  assert.equal(Object.keys(got).length, 10, "ids beyond the bounds stay unanswered, which reads as unknown");
  h.done();
  // Paging follows the cursor and stops as soon as every id is found.
  const p = setup({ dispatches: { ctx_a: { state: "failed" } }, pageSize: 100, filler: 150 });
  assert.deepEqual(libCall(p, `lib.dispatchStates(["ctx_a"], undefined)`), { ctx_a: { state: "failed", keptOpen: false, owned: true, owner: "ctx_a" } });
  assert.deepEqual(p.calls().filter((c) => c.includes("worker-list")).map((c) => c.includes("--cursor 100")), [false, true]);
  assert.ok(!p.calls().some((c) => c.includes("worker-show")));
  p.done();
  // A broken Orca: one list call, one show call, then it stops; nothing is answered.
  const b = setup({ broken: true });
  assert.deepEqual(libCall(b, `lib.dispatchStates(["ctx_a", "ctx_b", "ctx_c"], undefined)`), {});
  assert.equal(b.calls().length, 2);
  b.done();
});

test("cleanup releases only what Orca reports settled and is safe to let go, and closes no other terminal", () => {
  const h = setup(), wt = h.wt;
  const workers = {
    done: rec("T1 · Worker Developer", "ctx_done", "term_done", wt("t1")),
    busy: rec("T2 · Worker Developer", "ctx_busy", "term_busy", wt("t2")),
    open: rec("T3 · Worker Developer", "ctx_open", "term_open", wt("t3")),
    old: rec("T4 · Worker Tester", "ctx_old", "term_old", wt("t4")),
    rework: rec("T4 · Worker Developer", "ctx_rework", "term_rework", wt("t4")),
    gone: rec("T5 · Worker Developer", "ctx_abandoned", "structworker_5", wt("t5")),
    dirty: rec("T6 · Worker Developer", "ctx_dirty", "term_dirty", wt("t6")),
    first: rec("T7 · Worker Developer", "ctx_first", "term_shared", wt("t7")),
    follow: rec("T7b · Worker Developer", "ctx_follow", "term_shared", wt("t7b")),
    unpushed: rec("T8 · Worker Developer", "ctx_unpushed", "term_unpushed", wt("t8")),
    human: rec("T9 · Worker Developer", "ctx_human", "structworker_9", wt("t9")),
  };
  h.setWorkers(workers);
  h.patch((s) => Object.assign(s, {
    dispatches: {
      ctx_done: { state: "succeeded", setup: ["term_done_setup"] }, ctx_busy: { state: "ready" }, ctx_open: { state: "succeeded", retainedReason: "user_requested" },
      ctx_old: { state: "succeeded" }, ctx_rework: { state: "ready" }, ctx_abandoned: { state: "abandoned" }, ctx_dirty: { state: "succeeded" },
      ctx_first: { state: "succeeded" }, ctx_follow: { state: "ready" }, ctx_unpushed: { state: "failed" }, ctx_human: { state: "succeeded", setup: ["term_9_setup"] },
    },
    terminals: [
      ...Object.values(workers).filter((w) => w.terminal.startsWith("term_") && w.terminal !== "term_shared").map((w) => ({ handle: w.terminal, title: w.name, worktreePath: w.worktree })),
      { handle: "term_shared", title: "T7b · Worker Developer", worktreePath: wt("t7b") },
      { handle: "term_done_setup", title: "Setup", worktreePath: wt("t1") },
      { handle: "term_9_setup", title: "Setup", worktreePath: wt("t9") },
      { handle: "term_9_shell", title: "my shell", worktreePath: wt("t9") },
    ],
  }));
  h.repo("t1", "t2", "t3", "t4", "t5", "t6", "t7", "t7b", "t8", "t9");
  fs.writeFileSync(path.join(wt("t6"), "notes.txt"), "work in progress");
  fs.writeFileSync(path.join(wt("t8"), "a.txt"), "a");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", wt("t8"), "commit", "-qam", "x", "--allow-empty"]);
  execFileSync("git", ["-C", wt("t8"), "add", "a.txt"]); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", wt("t8"), "commit", "-qm", "unpushed"]);
  const dry = h.run("cleanup.mjs", "--dry");
  assert.equal(dry.status, 3, dry.stderr);
  const o = dry.stdout;
  assert.match(o, /would release the finished worker "T1 · Worker Developer"/);
  assert.match(o, /would remove t1 \(merged\)/, "its own setup terminal does not keep it");
  assert.match(o, /kept t2: worker "T2 · Worker Developer" running/);
  assert.match(o, /kept t3: worker "T3 · Worker Developer" finished, but Orca keeps it open \(user_requested\); release it with `orca orchestration worker-release --dispatch ctx_open`/);
  assert.match(o, /kept t4: worker "T4 · Worker Developer" running/, "a rework on the same worktree holds it");
  assert.match(o, /kept t5: worker "T5 · Worker Developer" abandoned, may still run/);
  assert.match(o, /kept t6: worker "T6 · Worker Developer" finished with uncommitted or untracked changes; not released/);
  assert.match(o, /kept t7: worker "T7 · Worker Developer" finished, but its terminal is used by a running worker/);
  assert.match(o, /kept t8: worker "T8 · Worker Developer" finished with commits that are not on origin; not released/);
  assert.match(o, /kept t9: terminal "my shell" open in it/, "a terminal that is not the worker's keeps the worktree");
  assert.ok(!h.calls().some((c) => /worker-release|terminal close|worktree rm/.test(c)), "a dry run changes nothing");
  const r = h.run("cleanup.mjs", "--apply");
  assert.equal(r.status, 0, r.stderr);
  const calls = h.calls();
  const releasedIds = calls.filter((c) => c.includes("worker-release")).map((c) => c.split(" ")[3]).sort();
  assert.deepEqual(releasedIds, ["ctx_done", "ctx_human", "ctx_old"]);
  assert.deepEqual(calls.filter((c) => c.startsWith("terminal close")).map((c) => c.split(" ")[3]), ["term_done_setup"], "only the released dispatch's own setup terminal, before its worktree goes");
  assert.ok(!calls.some((c) => c.includes("worker-abandon")), "no abandon fallback");
  assert.deepEqual(calls.filter((c) => c.startsWith("worktree rm ")).map((c) => c.split(" ")[3].split("/").pop()), ["t1"]);
  assert.deepEqual(Object.keys(h.readWorkers()).sort(), ["busy", "dirty", "first", "follow", "gone", "open", "rework", "unpushed"]);
  assert.match(r.stdout, /released 3 dispatches/);
  // The released worker's setup terminal in t9 is remembered; once the human's shell is gone, t9 goes with it.
  h.patch((s) => { s.terminals = s.terminals.filter((t) => t.handle !== "term_9_shell"); });
  fs.rmSync(path.join(h.dir, "calls.log"));
  const again = h.run("cleanup.mjs", "--apply");
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(h.calls().filter((c) => c.startsWith("worktree rm ")).map((c) => c.split(" ")[3].split("/").pop()), ["t9"]);
  assert.deepEqual(h.calls().filter((c) => c.startsWith("terminal close")).map((c) => c.split(" ")[3]), ["term_9_setup"]);
  h.done();
});

test("cleanup matches a record's worktree by directory name when the record holds another path to it", () => {
  const h = setup();
  h.repo("t1", "t2");   // git reports the real path; the records hold a path through a symlink, as a configured ~/… path would differ
  const link = path.join(h.dir, "link"); fs.symlinkSync(h.ws, link);
  h.setWorkers({ a: rec("T1 · Worker Developer", "ctx_a", "structworker_a", path.join(link, "p", "t1")), b: rec("T2 · Worker Developer", "ctx_b", "structworker_b", path.join(link, "p", "t2")) });
  h.patch((s) => { s.dispatches = { ctx_a: { state: "ready" }, ctx_b: { state: "succeeded" } }; });
  fs.writeFileSync(path.join(h.wt("t2"), "wip.txt"), "x");
  const r = h.run("cleanup.mjs", "--dry");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept t1: worker "T1 · Worker Developer" running/, "a running structured worker holds its worktree");
  assert.match(r.stdout, /kept t2: worker "T2 · Worker Developer" finished with uncommitted or untracked changes/);
  // A record whose worktree git does not list, but which still exists, is not released either.
  h.setWorkers({ c: rec("T3 · Worker Developer", "ctx_c", "structworker_c", path.join(h.dir, "elsewhere")) });
  fs.mkdirSync(path.join(h.dir, "elsewhere"));
  h.patch((s) => { s.dispatches = { ctx_c: { state: "succeeded" } }; });
  const o = h.run("cleanup.mjs", "--apply");
  assert.ok(!h.calls().some((c) => c.includes("worker-release")), o.stdout);
  assert.deepEqual(Object.keys(h.readWorkers()), ["c"]);
  h.done();
});

test("dispatchStates asks the least recently asked ids first, so ids that never leave cannot starve the others", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `ctx_${i}`);
  const h = setup({ dispatches: Object.fromEntries(ids.map((id) => [id, { state: "ready" }])), filler: 400 });
  const first = libCall(h, `lib.dispatchStates(${JSON.stringify(ids)}, undefined)`);
  assert.equal(Object.keys(first).length, 10);
  const second = libCall(h, `lib.dispatchStates(${JSON.stringify(ids)}, undefined)`);
  for (const id of ids.filter((id) => !first[id])) assert.ok(second[id], `${id} is answered on the next run`);
  h.done();
});

test("cleanup keeps a finished worker's record and worktree while Orca does not confirm its release", () => {
  const h = setup({ dispatches: { ctx_a: { state: "failed", releaseFails: true } } });
  h.setWorkers({ a: rec("T1 · Worker Developer", "ctx_a", "term_a", h.wt("t1")) });
  h.repo("t1");
  const r = h.run("cleanup.mjs", "--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept t1: worker "T1 · Worker Developer" finished, release answered release_unknown; retried next cycle/);
  assert.match(r.stdout, /release FAILED for ctx_a/);
  assert.deepEqual(Object.keys(h.readWorkers()), ["a"]);
  assert.ok(!h.calls().some((c) => c.startsWith("worktree rm")));
  // The next cycle retries, and a confirmed release forgets it.
  h.patch((s) => { s.dispatches.ctx_a.releaseFails = false; });
  assert.equal(h.run("cleanup.mjs", "--apply").status, 0);
  assert.deepEqual(h.readWorkers(), {});
  h.done();
});

test("capacity counts running, abandoned and unknown workers; finished ones at their prompt free the cap", () => {
  const h = setup({
    workers: { a: rec("A · Worker Developer", "ctx_a", "term_a", "/w/a"), b: rec("B · Worker Developer", "ctx_b", "term_b", "/w/b"), c: rec("C · Worker Developer", "ctx_c", "term_c", "/w/c"), d: rec("D · Worker Developer", "ctx_d", "structworker_d", "/w/d") },
    dispatches: { ctx_a: { state: "succeeded" }, ctx_b: { state: "succeeded" }, ctx_c: { state: "ready" }, ctx_d: { state: "abandoned" } },
    terminals: [{ handle: "term_a" }, { handle: "term_b" }, { handle: "term_c" }],
  });
  assert.equal(JSON.parse(h.run("capacity.mjs", "--verbose").stdout).measured.suite, 2);
  h.patch((s) => { s.broken = true; });
  const u = JSON.parse(h.run("capacity.mjs", "--verbose").stdout);
  // The two settled ones are remembered (settled states never change back); the other two cannot be read.
  assert.equal(u.measured.suite, 2); assert.match(u.reason, /2 recorded workers counted as live/);
  h.done();
});

test("capacity: --set-suite needs a bounded number and a quote, is journaled, and a wait says when to measure again and whether only the cap holds", () => {
  // No pressure can count on this machine, so only the cap can hold the start back.
  const capacity = { gate: {}, availableMemoryMinGb: 0, gateQueueMax: 99, pressure: { cpuAvg10MaxPercent: 100, memoryAvg10MaxPercent: 100 } };
  const h = setup({ capacity, workers: { a: rec("A · Worker Developer", "ctx_a", "term_a", "/w/a") }, dispatches: { ctx_a: { state: "ready" } } });
  assert.notEqual(h.run("capacity.mjs", "--set-suite", "3").status, 0, "--by is required");
  assert.notEqual(h.run("capacity.mjs", "--set-suite", "0", "--by", "x").status, 0, "n ≥ 1");
  const tooMany = h.run("capacity.mjs", "--set-suite", "500", "--by", "x");
  assert.notEqual(tooMany.status, 0, "n ≤ the largest configured cap"); assert.match(tooMany.stderr, /from 1 to 12/);
  const r = h.run("capacity.mjs", "--set-suite", "1", "--by", "Alex: one at a time today");
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(v.caps.suite, 1);
  assert.equal(v.suite, "wait");
  // Without PSI (macOS) the CPU rule reads the load average, which a parallel test run can push up: then capOnly must be false.
  const onlyCap = v.reason.split("; ").every((x) => /calibrated cap|available memory unknown/.test(x));
  assert.equal(v.capOnly, onlyCap, `capOnly says whether only the cap holds it: ${v.reason}`);
  assert.ok(Date.parse(v.measureAgainAt) - Date.now() > 30e3, "measure again in about a minute");
  const journal = fs.readFileSync(path.join(h.ctl, "journal.ndjson"), "utf8");
  assert.match(journal, /"type":"decision".*capacity suiteMax set → 1 by hand.*"by":"Alex: one at a time today"/);
  assert.equal(JSON.parse(h.run("capacity.mjs").stdout).caps.suite, 1, "the cap stays set on the next run");
  h.done();
});

test("heartbeat: a finished worker is not active, wakes the Controller once when it settles, and not again", () => {
  const h = setup({
    workers: { a: rec("A · Worker Developer", "ctx_a", "term_a", "/w/a") },
    dispatches: { ctx_a: { state: "ready" } },
    terminals: [{ handle: "term_c", title: "p · Controller" }, { handle: "term_a", title: "A · Worker Developer" }],
  });
  // Every run is the full check at a tenth minute.
  const env = { ...h.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=data:text/javascript,Date.prototype.getMinutes=()=>0`.trim() };
  const beat = () => { const r = spawnSync("node", [path.join(h.ctl, "heartbeat.mjs")], { cwd: h.ctl, encoding: "utf8", env }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const notice = () => fs.readFileSync(path.join(h.ctl, "heartbeat.notice"), "utf8");
  assert.match(beat(), /baseline/);
  assert.match(notice(), /Working: 1 workers/);
  assert.match(beat(), /woke term_c \(workers\)/);
  h.patch((s) => { s.dispatches.ctx_a.state = "failed"; });
  assert.match(beat(), /woke term_c \(1 workers settled\)/);
  assert.match(notice(), /Nothing left to do/);
  assert.doesNotMatch(beat(), /woke/, "a settled record waiting for cleanup wakes nobody again");
  h.done();
});

test("a worker start.mjs started in a new worktree is released despite Orca's default keep-open; the Controller's keep marker holds it", () => {
  const h = setup({ dispatches: { ctx_a: { state: "succeeded", retainedReason: "user_requested" }, ctx_b: { state: "succeeded", retainedReason: "user_requested" }, ctx_old: { state: "succeeded", retainedReason: "user_requested" } } });
  h.repo("t1", "t2", "t3");
  h.setWorkers({
    a: rec("T1 · Worker Developer", "ctx_a", "structworker_a", h.wt("t1"), { keptByDefault: true }),
    b: rec("T2 · Worker Developer", "ctx_b", "structworker_b", h.wt("t2"), { keptByDefault: true }),
    old: rec("T3 · Worker Developer", "ctx_old", "structworker_old", h.wt("t3")),   // a record from before keptByDefault
  });
  const keep = spawnSync("node", [path.join(h.ctl, "keep.mjs"), "b", "--by", "Alex wants to read it"], { cwd: h.ctl, encoding: "utf8", env: h.env });
  assert.equal(keep.status, 0, keep.stderr);
  assert.equal(h.readWorkers().b.keep, true);
  assert.match(fs.readFileSync(path.join(h.ctl, "journal.ndjson"), "utf8"), /"type":"decision".*keeping worker b.*"by":"Alex wants to read it"/);
  const r = h.run("cleanup.mjs", "--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept t2: worker "T2 · Worker Developer" finished, kept by the Controller; `node keep.mjs b --off` lets cleanup release it/);
  assert.match(r.stdout, /kept t3: worker "T3 · Worker Developer" finished, but Orca keeps it open \(user_requested\)/, "older records stay held");
  assert.deepEqual(h.calls().filter((c) => c.includes("worker-release")).map((c) => c.split(" ")[3]), ["ctx_a"]);
  assert.deepEqual(h.calls().filter((c) => c.startsWith("worktree rm ")).map((c) => c.split(" ")[3].split("/").pop()), ["t1"]);
  assert.deepEqual(Object.keys(h.readWorkers()).sort(), ["b", "old"]);
  assert.equal(spawnSync("node", [path.join(h.ctl, "keep.mjs"), "b", "--off"], { cwd: h.ctl, encoding: "utf8", env: h.env }).status, 0);
  assert.equal(h.run("cleanup.mjs", "--apply").status, 0);
  assert.deepEqual(Object.keys(h.readWorkers()), ["old"]);
  assert.notEqual(spawnSync("node", [path.join(h.ctl, "keep.mjs"), "nosuch"], { cwd: h.ctl, encoding: "utf8", env: h.env }).status, 0);
  h.done();
});

test("only released and already_released count: retained and release_pending keep the record and the worktree", () => {
  const h = setup({ dispatches: { ctx_r: { state: "succeeded", releaseAnswer: "retained" }, ctx_p: { state: "failed", releaseAnswer: "release_pending" }, ctx_a: { state: "stopped", releaseAnswer: "already_released" } } });
  h.repo("t1", "t2", "t3");
  h.setWorkers({ r: rec("T1 · Worker Developer", "ctx_r", "structworker_r", h.wt("t1")), p: rec("T2 · Worker Developer", "ctx_p", "structworker_p", h.wt("t2")), a: rec("T3 · Worker Developer", "ctx_a", "structworker_a", h.wt("t3")) });
  const r = h.run("cleanup.mjs", "--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept t1: worker "T1 · Worker Developer" finished, release not confirmed by Orca \(releaseState retained\); retried next cycle/);
  assert.match(r.stdout, /kept t2: worker "T2 · Worker Developer" finished, release not confirmed by Orca \(releaseState release_pending\); retried next cycle/);
  assert.deepEqual(h.calls().filter((c) => c.startsWith("worktree rm ")).map((c) => c.split(" ")[3].split("/").pop()), ["t3"]);
  assert.deepEqual(Object.keys(h.readWorkers()).sort(), ["p", "r"]);
  h.done();
});

test("a settled dispatch whose terminal a follow-up dispatch now owns counts as running", () => {
  const h = setup({ dispatches: { ctx_old: { state: "succeeded", owner: "ctx_follow" }, ctx_gone_res: { state: "succeeded", noResource: true } } });
  h.repo("t1", "t2");
  h.setWorkers({ old: rec("T1 · Worker Developer", "ctx_old", "structworker_x", h.wt("t1")), nores: rec("T2 · Worker Developer", "ctx_gone_res", "structworker_y", h.wt("t2")) });
  assert.equal(JSON.parse(h.run("capacity.mjs", "--verbose").stdout).measured.suite, 1, "capacity counts it");
  const r = h.run("cleanup.mjs", "--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept t1: worker "T1 · Worker Developer" running/);
  assert.match(r.stdout, /kept t2: worker "T2 · Worker Developer" finished, but Orca reports no terminal resource for it/);
  assert.ok(!h.calls().some((c) => c.includes("worker-release") || c.startsWith("worktree rm")));
  assert.equal(JSON.parse(h.run("capacity.mjs", "--verbose").stdout).measured.suite, 1, "still counted: not cached while another dispatch owns the terminal");
  h.done();
});

test("scenario J: settled records behind the list window are asked once and then never again, so they stop counting", () => {
  const ids = Array.from({ length: 25 }, (_, i) => `ctx_${i}`);
  const h = setup({ dispatches: Object.fromEntries(ids.map((id) => [id, { state: "succeeded", retainedReason: "user_requested" }])), filler: 320 });
  h.setWorkers(Object.fromEntries(ids.map((id, i) => [id, rec(`T${i} · Worker Developer`, id, `structworker_${i}`, `/w/${i}`)])));
  const suites = [1, 2, 3].map(() => JSON.parse(h.run("capacity.mjs", "--verbose").stdout).measured.suite);
  assert.deepEqual(suites, [15, 5, 0]);
  fs.rmSync(path.join(h.dir, "calls.log"));
  assert.equal(JSON.parse(h.run("capacity.mjs", "--verbose").stdout).measured.suite, 0);
  assert.ok(!h.calls().some((c) => c.includes("worker-list") || c.includes("worker-show")), "settled states come from dispatch-settled.json");
  h.done();
});

test("scenario K: a backlog of finished default-kept workers drains, 10 per cleanup cycle", () => {
  const n = 40, ids = Array.from({ length: n }, (_, i) => `ctx_${i}`);
  const h = setup({ dispatches: Object.fromEntries(ids.map((id) => [id, { state: "succeeded", retainedReason: "user_requested" }])), filler: 320 });
  h.repo(...ids.map((_, i) => `k${i}`));
  h.setWorkers(Object.fromEntries(ids.map((id, i) => [id, rec(`K${i} · Worker Developer`, id, `structworker_${i}`, h.wt(`k${i}`), { keptByDefault: true })])));
  const left = [1, 2, 3, 4].map(() => { const r = h.run("cleanup.mjs", "--apply"); assert.equal(r.status, 0, r.stderr); return Object.keys(h.readWorkers()).length; });
  assert.deepEqual(left, [30, 20, 10, 0]);
  h.done();
});

test("the release receipt is not interpreted: only worker-show's terminalResource.releaseState released confirms it", () => {
  // Receipts that name "released" in some field must not count while Orca's own record says otherwise.
  const lying = { terminalResource: { ownershipState: "released", terminalState: "released", releaseState: "released" } };
  const h = setup({ dispatches: {
    ctx_lie: { state: "succeeded", releaseAnswer: "retained", receipt: lying },
    ctx_quiet: { state: "succeeded", releaseAnswer: "released", receipt: {} },
    ctx_none: { state: "succeeded", releaseAnswer: null },
  } });
  h.repo("t1", "t2", "t3");
  h.setWorkers({ lie: rec("T1 · Worker Developer", "ctx_lie", "structworker_1", h.wt("t1")), quiet: rec("T2 · Worker Developer", "ctx_quiet", "structworker_2", h.wt("t2")), none: rec("T3 · Worker Developer", "ctx_none", "structworker_3", h.wt("t3")) });
  h.patch((s) => { s.dispatches.ctx_none.releaseAnswer = "missing"; });
  const r = h.run("cleanup.mjs", "--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept t1: worker "T1 · Worker Developer" finished, release not confirmed by Orca \(releaseState retained\)/);
  assert.match(r.stdout, /kept t3: worker "T3 · Worker Developer" finished, release not confirmed by Orca \(releaseState missing\)/);
  assert.deepEqual(h.calls().filter((c) => c.startsWith("worktree rm ")).map((c) => c.split(" ")[3].split("/").pop()), ["t2"], "an empty receipt is fine when Orca's record says released");
  assert.deepEqual(Object.keys(h.readWorkers()).sort(), ["lie", "none"]);
  h.done();
});

test("a corrupt or null cache file is an empty cache: capacity and cleanup carry on, say so once, and rewrite it", () => {
  for (const content of ["{bad", "null", "[1,2]", "7"]) {
    const h = setup({ dispatches: { ctx_a: { state: "succeeded" }, ctx_b: { state: "ready" } } });
    h.repo("t1");
    h.setWorkers({ a: rec("T1 · Worker Developer", "ctx_a", "structworker_a", h.wt("t1"), { keptByDefault: true }), b: rec("T2 · Worker Developer", "ctx_b", "structworker_b", "/w/b") });
    for (const f of ["dispatch-settled.json", "dispatch-asked.json", "released-terminals.json", "quota.json", "capacity-state.local.json"]) fs.writeFileSync(path.join(h.ctl, f), content);
    const cap = h.run("capacity.mjs", "--verbose");
    assert.equal(cap.status, 0, `${content}: ${cap.stderr}`);
    assert.equal(JSON.parse(cap.stdout).measured.suite, 1, content);
    assert.match(cap.stderr, /dispatch-settled\.json could not be read; starting from scratch/, content);
    assert.equal(typeof JSON.parse(fs.readFileSync(path.join(h.ctl, "dispatch-settled.json"), "utf8")), "object", "rewritten");
    assert.ok(Number.isFinite(JSON.parse(fs.readFileSync(path.join(h.ctl, "capacity-state.local.json"), "utf8")).suiteMax), "calibration state rewritten");
    fs.writeFileSync(path.join(h.ctl, "dispatch-settled.json"), content);
    const r = h.run("cleanup.mjs", "--apply");
    assert.equal(r.status, 0, `${content}: ${r.stderr}`);
    assert.match(r.stdout, /released 1 dispatches/, content);
    assert.equal(typeof JSON.parse(fs.readFileSync(path.join(h.ctl, "released-terminals.json"), "utf8")), "object");
    h.done();
  }
});

test("heartbeat: corrupt or null state files do not stop it", () => {
  const h = setup({ dispatches: { ctx_a: { state: "ready" } }, terminals: [{ handle: "term_c", title: "p · Controller" }] });
  h.setWorkers({ a: rec("A · Worker Developer", "ctx_a", "structworker_a", "/w/a") });
  for (const f of ["heartbeat.known.json", "heartbeat.settled.json", "heartbeat.workers.json", "heartbeat.announced.json", "heartbeat.seen.json", "dispatch-settled.json"]) fs.writeFileSync(path.join(h.ctl, f), "null");
  for (let i = 0; i < 2; i++) { const r = spawnSync("node", [path.join(h.ctl, "heartbeat.mjs")], { cwd: h.ctl, encoding: "utf8", env: h.env }); assert.equal(r.status, 0, r.stderr); }
  assert.match(fs.readFileSync(path.join(h.ctl, "heartbeat.notice"), "utf8"), /Working: 1 workers/);
  h.done();
});
