// controller/wait.mjs against a fake Orca (payload shapes, bad messages), and the bounded review rounds in mkspec.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function controllerDir(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-wait-rounds-"));
  fs.mkdirSync(path.join(dir, "templates"));
  for (const f of ["wait.mjs", "lib.mjs", "templates/mkspec.mjs"]) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "factory.config.json"), JSON.stringify({ project: { name: "p", mainBranch: "main", humanName: "Alex" }, agents: { runner: "orca" }, commands: { verify: "npm run verify" }, hosts: { controller: { host: "local" }, workers: [{ name: "local", kind: "local" }] }, ...config }));
  return dir;
}

// The fake Orca answers each `orchestration check` with the next batch from batches.json and logs its arguments.
function waitWith(batches, hours = "0.002") {
  const dir = controllerDir();
  const fake = path.join(dir, "fake-orca.mjs"), calls = path.join(dir, "calls.log"), state = path.join(dir, "batches.json");
  fs.writeFileSync(state, JSON.stringify(batches));
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + "\\n");
const b = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const next = b.shift() ?? { ok: true, result: { messages: [] } };
fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(b));
if (next && next.fail) { process.stderr.write(next.fail); process.exit(1); }
console.log(typeof next === "string" ? next : JSON.stringify(next));
`);
  fs.chmodSync(fake, 0o755);
  const r = spawnSync("node", ["wait.mjs", "--hours", hours], { cwd: dir, encoding: "utf8", timeout: 20_000, env: { ...process.env, ORCA_CLI_COMMAND: fake, FACTORY_CONFIG: "" } });
  const log = fs.readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...r, calls: log };
}

// The shape of a worker_done in the concise --json view, recorded from the current Orca (ids replaced): payload is an object, no deliveryId.
const RECORDED = { ok: true, result: { messages: [{ id: "msg_1", type: "worker_done", from: "structworker_x", to: "run:run_x", subject: "T1 done", handled: false, body: "pushed", payload: { taskId: "task_1", dispatchId: "ctx_1" } }] } };

test("wait.mjs reads the dispatch id from an object payload (current Orca) and needs no deliveryId", () => {
  const r = waitWith([RECORDED]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^# msg_1 worker_done T1 done ctx_1 \| pushed$/m);
  assert.doesNotMatch(r.stdout, /delivery undefined/);
  assert.equal(r.stderr, "");
});

test("wait.mjs reads a string payload, survives a malformed or missing one, and prints every message", () => {
  const r = waitWith([{ ok: true, result: { deliveryId: "d_1", messages: [
    { id: "msg_1", type: "worker_done", subject: "a", payload: JSON.stringify({ dispatchId: "ctx_1" }) },
    { id: "msg_2", type: "escalation", subject: "b", payload: "{not json" },
    { id: "msg_3", type: "question", subject: "c" },
    null,
  ] } }]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^delivery d_1 /m);
  assert.match(r.stdout, /^# msg_1 worker_done a ctx_1 \|/m);
  assert.match(r.stdout, /^# msg_2 escalation b {2}\|/m);
  assert.match(r.stdout, /^# msg_3 question c {2}\|/m);
  assert.equal(r.stderr, "");
});

test("wait.mjs keeps waiting past a heartbeat-only batch, acks only a delivery it was given", () => {
  const r = waitWith([
    { ok: true, result: { messages: [{ id: "h", type: "heartbeat" }] } },
    { ok: true, result: { deliveryId: "d_old", messages: [{ id: "h2", type: "heartbeat" }] } },
    { ok: true, result: { messages: [{ id: "msg_9", type: "worker_done", subject: "late", payload: { dispatchId: "ctx_9" } }] } },
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^# msg_9 worker_done late ctx_9 \|/m);
  const acks = r.calls.map((a) => (a.includes("--ack") ? a[a.indexOf("--ack") + 1] : null));
  assert.deepEqual(acks, [null, null, "d_old"], "only the batch that came with a deliveryId is acked, on the next check");
  assert.ok(r.calls.every((a) => a.includes("--full")), "the whole body, not the 200-character preview");
});

test("wait.mjs pauses on ok:false or a result without a message list instead of spinning, and logs it raw", () => {
  for (const bad of [{ ok: false, error: { message: "boom" } }, { ok: true, result: [] }, { ok: true, result: { messages: "not a list" } }]) {
    const t0 = Date.now();
    const r = waitWith([bad, bad, bad, bad, bad], "0.0005");   // 1.8 s window
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /orca check returned no message list, retrying in 30 s: \{/);
    assert.match(r.stdout, /no event after 0\.0005h/);
    assert.equal(r.calls.length, 1, "one call, then a pause that ends with the window");
    assert.ok(Date.now() - t0 < 10_000, "the pause never outlasts the window");
  }
});

test("wait.mjs logs a message without an id or type raw instead of printing undefined", () => {
  const r = waitWith([{ ok: true, result: { messages: [{}, { id: "msg_1", type: "question", subject: "q", body: "x".repeat(300) }] } }]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^# raw \{\}$/m);
  assert.doesNotMatch(r.stdout, /undefined/);
  assert.match(r.stdout, new RegExp(`^# msg_1 question q {2}\\| x{300}$`, "m"), "a long body is printed whole");
});

const spec = (dir, ...args) => spawnSync("node", ["templates/mkspec.mjs", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, FACTORY_CONFIG: "" } });
const TASK = ["T1", "docs/tasks/T1.md", "agents/t1"];

test("mkspec refuses a review round beyond reviews.maxRounds and names reeval on that round's reviewed commit", () => {
  const dir = controllerDir({ reviews: { maxRounds: 2 } });
  const r = spec(dir, "test", ...TASK, "abc", "--round", "3");
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "", "no spec path printed");
  assert.match(r.stderr, /review round 3 is beyond reviews\.maxRounds \(2\)/);
  assert.match(r.stderr, /The verdict of round 2 could not be read .*If round 2 failed, there is no rework and no further round/);
  assert.doesNotMatch(r.stderr, /fatal:/, "git's own error stays out of the message");
  assert.match(r.stderr, /mkspec\.mjs reeval T1 docs\/tasks\/T1\.md agents\/t1 "<the 'Reviewed commit' in docs\/reviews\/T1-review-2\.md>" agents\/t1-review-2:docs\/reviews\/T1-review-2\.md/);
  assert.match(r.stderr, /must not move past it/);
  assert.match(r.stderr, /"Needs Alex"/);
  assert.doesNotMatch(r.stderr, /at .*mkspec\.mjs:\d+/, "a message, not a stack trace");
  assert.ok(!fs.existsSync(path.join(dir, "specs/t1-test.txt")), "no spec written");
  for (const bad of ["x", "0", "-1", "1.5"]) assert.notEqual(spec(dir, "test", ...TASK, "abc", "--round", bad).status, 0, bad);
  const padded = spec(dir, "test", ...TASK, "abc", "--round", "02");
  assert.equal(padded.status, 0, "accepted as before");
  assert.match(fs.readFileSync(padded.stdout.trim(), "utf8"), /docs\/reviews\/T1-review-2\.md/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("mkspec refuses a rework after the last round, so a failed task never gets an unreviewable head", () => {
  const dir = controllerDir({ reviews: { maxRounds: 2 } });
  const ok = spec(dir, "rework", "T1", "1", "docs/tasks/T1.md", "agents/t1", "agents/t1-review-1:docs/reviews/T1-review-1.md");
  assert.equal(ok.status, 0, ok.stderr);
  const r = spec(dir, "rework", "T1", "2", "docs/tasks/T1.md", "agents/t1", "agents/t1-review-2:docs/reviews/T1-review-2.md");
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /rework 2 would need review round 3/);
  assert.match(r.stderr, /mkspec\.mjs reeval T1 docs\/tasks\/T1\.md agents\/t1 "<the 'Reviewed commit' in docs\/reviews\/T1-review-2\.md>"/);
  assert.notEqual(spec(dir, "rework", "T1", "x", "docs/tasks/T1.md", "agents/t1", "b:f").status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reviews.maxRounds must be a whole number of at least 1; a numeric string still works", () => {
  for (const bad of [0, -1, 2.5, "abc", ""]) {
    const dir = controllerDir({ reviews: { maxRounds: bad } });
    const r = spec(dir, "test", ...TASK, "abc");
    assert.notEqual(r.status, 0, JSON.stringify(bad));
    assert.match(r.stderr, /reviews\.maxRounds in factory\.config\.json must be a whole number of at least 1/);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const dir = controllerDir({ reviews: { maxRounds: "3" } });
  assert.equal(spec(dir, "test", ...TASK, "abc", "--round", "3").status, 0);
  assert.notEqual(spec(dir, "test", ...TASK, "abc", "--round", "4").status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "af-init-rounds-"));
  fs.writeFileSync(path.join(proj, "a.json"), JSON.stringify({ "reviews.maxRounds": "0" }));
  const init = spawnSync("node", [path.join(ROOT, "bin/agentic-factory.mjs"), "init", "--answers", "a.json"], { cwd: proj, encoding: "utf8", env: { ...process.env, HOME: proj, FACTORY_SKIP_ORCA: "1" } });
  assert.notEqual(init.status, 0);
  assert.match(init.stderr, /"reviews\.maxRounds" must be at least 1/);
  fs.rmSync(proj, { recursive: true, force: true });
});

test("from round 2 the Tester narrows what it reviews, not which checks; round 1 is unchanged", () => {
  const dir = controllerDir({ reviews: { maxRounds: 3 } });
  const one = fs.readFileSync(spec(dir, "test", ...TASK, "abc").stdout.trim(), "utf8");
  assert.match(one, /2\. Review the whole diff against its merge-base with origin\/main against every Result and Observable acceptance item\. Run 'ponytail-review' on the full diff\. Check the level is kept, tests go through public entry points and fail without the implementation, untrusted content is escaped, invented data only, no secrets, no changes to real external systems\.\n/);
  const r = spec(dir, "test", ...TASK, "def", "--round", "2");
  assert.equal(r.status, 0, r.stderr);
  const two = fs.readFileSync(r.stdout.trim(), "utf8");
  assert.match(two, /<A> is the 'Reviewed commit' in the round-1 findings docs\/reviews\/T1-review-1\.md \(git show origin\/agents\/t1-review-1:docs\/reviews\/T1-review-1\.md\); <head> is the full SHA you review/);
  assert.match(two, /If git merge-base --is-ancestor <A> <head> fails .*\(b\) is instead the whole diff/);
  assert.match(two, /git log --no-merges -p <A>\.\.<head> \^origin\/main/);
  assert.match(two, /git log --merges --format=%H <A>\.\.<head> \^origin\/main .*git show --remerge-diff <merge>/);
  assert.match(two, /check the level is kept, tests go through public entry points and fail without the implementation, untrusted content is escaped/, "round-1 checks stay");
  assert.match(two, /wrong level or unannounced architectural change in these changes/);
  assert.match(two, /gate bash -c 'npm run verify' once/, "the full gate still runs");
  assert.match(two, /docs\/reviews\/T1-review-2\.md/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the round-2 commands keep main's commits out and spot a rewritten branch", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "af-scope-"));
  const g = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, encoding: "utf8" });
  const commit = (file, msg) => { fs.writeFileSync(path.join(repo, file), msg); g("add", file); g("commit", "-qm", msg); };
  g("init", "-q", "-b", "main"); commit("base", "base");
  g("checkout", "-qb", "task"); commit("t1", "task round 1");
  const A = g("rev-parse", "HEAD").stdout.trim();
  g("checkout", "-q", "main"); commit("m1", "main commit 1"); commit("m2", "main commit 2");
  g("checkout", "-q", "task"); g("merge", "-q", "--no-edit", "main"); commit("t2", "task rework");
  const own = g("log", "--no-merges", "--format=%s", `${A}..HEAD`, "^main").stdout.trim().split("\n");
  assert.deepEqual(own, ["task rework"], "commits that came in from main are left out");
  assert.equal(g("log", "--merges", "--format=%H", `${A}..HEAD`, "^main").stdout.trim().split("\n").length, 1, "the task's own merge is still checked");
  assert.equal(g("merge-base", "--is-ancestor", A, "HEAD").status, 0);
  g("checkout", "-qb", "rewritten", "main"); commit("t1", "task round 1, rebased");
  assert.notEqual(g("merge-base", "--is-ancestor", A, "HEAD").status, 0, "a rebased branch falls back to the full round-1 scope");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("CONTROLLER.md and the review protocol state the same round rule and the event-driven loop", () => {
  const ctl = fs.readFileSync(path.join(ROOT, "controller/CONTROLLER.md"), "utf8");
  const protocol = fs.readFileSync(path.join(ROOT, "templates/docs/review-protocol.md"), "utf8");
  assert.doesNotMatch(ctl, /every 10 minutes/);
  assert.match(ctl, /do not poll workers yourself/);
  assert.doesNotMatch(ctl, /Second failure: one tier higher/, "no tier-up rework that a refused round could never test");
  for (const doc of [ctl, protocol]) {
    assert.match(doc, /no rework and no further round/);
    assert.match(doc, /mkspec reeval/);
    assert.match(doc, /must not move past/);
    assert.match(doc, /narrows what it reviews, not which checks it applies/);
    assert.match(doc, /functional defect, a safety problem/);
    assert.match(doc, /wrong level or unannounced architectural change/);
    assert.match(doc, /independent review/);
  }
  assert.match(protocol, /\*\*Always checked, in every round\*\* \(from round 2 on the changes that round re-checks/);
});

test("wait.mjs writes a large event completely to a pipe before it exits", () => {
  const big = "x".repeat(300_000);
  const r = waitWith([{ ok: true, result: { messages: [{ id: "msg_1", type: "escalation", subject: "big", body: big }, { id: "msg_2", type: "question", subject: "after" }] } }]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(big), `the whole body (got ${r.stdout.length} bytes)`);
  assert.match(r.stdout, /^# msg_2 question after {2}\|/m, "the message after it too");
});

test("wait.mjs prints the CLI's stderr when a check fails", () => {
  const r = waitWith([{ fail: "Error: connection lost; replay with --retry-request req_42\n" }], "0.0005");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /orca check failed \(.*\), retrying in 30 s\nError: connection lost; replay with --retry-request req_42/);
});

// A project checkout whose origin holds review branches with the given verdicts, as the Controller's `git pull` leaves it.
function projectWithVerdicts(verdicts) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "af-verdicts-"));
  const g = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  for (const [n, verdict] of Object.entries(verdicts)) {
    fs.mkdirSync(path.join(repo, "docs/reviews"), { recursive: true });
    fs.writeFileSync(path.join(repo, `docs/reviews/T1-review-${n}.md`), `# T1 review, round ${n}\n\nVerdict: ${verdict}\nReviewed commit: ${"a".repeat(40)}\n`);
    g("add", "."); g("commit", "-qm", `review ${n}`);
    g("update-ref", `refs/remotes/origin/agents/t1-review-${n}`, "HEAD");
  }
  return repo;
}

test("beyond the limit, a re-check after a passing round is allowed with --after-pass; the refusal says what happened", () => {
  const repo = projectWithVerdicts({ 2: "pass", 3: "fail" });
  const dir = controllerDir({ reviews: { maxRounds: 2 }, hosts: { controller: { host: "local" }, workers: [{ name: "local", kind: "local", projectDir: repo }] } });
  // Round 2 passed, then e.g. the conformance review failed: no flag gives a refusal that says round 2 PASSED.
  let r = spec(dir, "rework", "T1", "2", "docs/tasks/T1.md", "agents/t1", "agents/t1-conformance:docs/reviews/T1-architecture-conformance.md");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Round 2 passed \(docs\/reviews\/T1-review-2\.md on origin\/agents\/t1-review-2 says Verdict: pass\)/);
  assert.match(r.stderr, /--after-pass "<what happened>"/);
  assert.doesNotMatch(r.stderr, /failed \(|Round 2 failed/);
  r = spec(dir, "rework", "T1", "2", "docs/tasks/T1.md", "agents/t1", "agents/t1-conformance:docs/reviews/T1-architecture-conformance.md", "--after-pass", "the conformance review failed");
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(r.stdout.trim(), "utf8"), /This rework follows round 2, which passed: the conformance review failed\./);
  r = spec(dir, "test", ...TASK, "def", "--round", "3", "--after-pass", "the conformance review failed");
  assert.equal(r.status, 0, r.stderr);
  const three = fs.readFileSync(r.stdout.trim(), "utf8");
  assert.match(three, /This round re-checks the task after round 2 passed: the conformance review failed\./);
  assert.match(three, /round-2 findings docs\/reviews\/T1-review-2\.md/);
  // Round 3 failed: --after-pass cannot reopen it; the refusal says it failed and names reeval on round 3.
  r = spec(dir, "rework", "T1", "3", "docs/tasks/T1.md", "agents/t1", "agents/t1-review-3:docs/reviews/T1-review-3.md", "--after-pass", "try again");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /with --after-pass\. .*Round 3 failed \(docs\/reviews\/T1-review-3\.md on origin\/agents\/t1-review-3 says Verdict: fail\)/);
  assert.match(r.stderr, /reeval T1 docs\/tasks\/T1\.md agents\/t1 "<the 'Reviewed commit' in docs\/reviews\/T1-review-3\.md>" agents\/t1-review-3:docs\/reviews\/T1-review-3\.md/);
  // No findings file for round 4 on origin: the refusal says the verdict could not be read.
  r = spec(dir, "test", ...TASK, "def", "--round", "5", "--after-pass", "x");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /The verdict of round 4 could not be read/);
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
});

test("an octopus merge is skipped by --remerge-diff, so the spec falls back to git show --cc, which shows its changes", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "af-octopus-"));
  const g = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, encoding: "utf8" });
  const commit = (file, msg) => { fs.writeFileSync(path.join(repo, file), msg); g("add", file); g("commit", "-qm", msg); };
  g("init", "-q", "-b", "main"); commit("base", "base");
  for (const b of ["b1", "b2"]) { g("checkout", "-qb", b, "main"); commit(b, b); }
  g("checkout", "-qb", "task", "main"); commit("t", "task");
  g("merge", "-q", "--no-commit", "b1", "b2"); fs.writeFileSync(path.join(repo, "hid.txt"), "hidden\n"); g("add", "hid.txt"); g("commit", "-qm", "octopus");
  const remerge = g("show", "--remerge-diff", "HEAD");
  assert.doesNotMatch(remerge.stdout, /hid\.txt/, "remerge-diff shows nothing for an octopus merge");
  assert.match(remerge.stdout + remerge.stderr, /Skipping remerge-diff for octopus merges/);
  assert.match(g("show", "--cc", "HEAD").stdout, /hid\.txt/);
  fs.rmSync(repo, { recursive: true, force: true });
  const dir = controllerDir({ reviews: { maxRounds: 3 } });
  const two = fs.readFileSync(spec(dir, "test", ...TASK, "def", "--round", "2").stdout.trim(), "utf8");
  assert.match(two, /git show --remerge-diff <merge>; if that errors, as on git before 2\.36, or prints 'Skipping remerge-diff for octopus merges', use git show --cc <merge> instead/);
  assert.match(two, /\(b\) is instead the whole diff against its merge-base with origin\/main, as in round 1; \(a\) stays/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("no installed doc keeps the old rework rule", () => {
  const files = ["controller/CONTROLLER.md", "templates/docs/coordinator.md", "templates/docs/review-protocol.md", "docs/reviews.md", "docs/workflow.md", "docs/de/workflow.md"];
  for (const f of files) {
    const t = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.doesNotMatch(t, /Tester failed → rework in the same worktree with the findings unchanged; after two failures one tier higher|Second failure: one tier higher|a question to the human after the round limit|nach der Rundengrenze Frage an den Menschen/, f);
  }
  assert.match(fs.readFileSync(path.join(ROOT, "templates/docs/coordinator.md"), "utf8"), /After the last round fails: no rework, `mkspec reeval`.*--after-pass/);
});
