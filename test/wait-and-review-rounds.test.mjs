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
function waitWith(batches) {
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
console.log(typeof next === "string" ? next : JSON.stringify(next));
`);
  fs.chmodSync(fake, 0o755);
  const r = spawnSync("node", ["wait.mjs", "--hours", "0.002"], { cwd: dir, encoding: "utf8", timeout: 20_000, env: { ...process.env, ORCA_CLI_COMMAND: fake, FACTORY_CONFIG: "" } });
  const log = fs.readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...r, calls: log };
}

test("wait.mjs reads the dispatch id from an object payload (current Orca) and needs no deliveryId", () => {
  const r = waitWith([{ ok: true, result: { messages: [{ id: "msg_1", type: "worker_done", subject: "T1 done", body: "pushed", payload: { taskId: "task_1", dispatchId: "ctx_1" } }] } }]);
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

test("wait.mjs keeps waiting past a heartbeat-only batch and a broken response, acks only a delivery it was given", () => {
  const r = waitWith([
    { ok: true, result: { messages: [{ id: "h", type: "heartbeat" }] } },
    { ok: true, result: { deliveryId: "d_old", messages: [{ id: "h2", type: "heartbeat" }] } },
    { ok: true, result: { messages: "not a list" } },
    { ok: true, result: { messages: [{ id: "msg_9", type: "worker_done", subject: "late", payload: { dispatchId: "ctx_9" } }] } },
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^# msg_9 worker_done late ctx_9 \|/m);
  const acks = r.calls.map((a) => (a.includes("--ack") ? a[a.indexOf("--ack") + 1] : null));
  assert.deepEqual(acks, [null, null, "d_old", null], "only the batch that came with a deliveryId is acked, on the next check");
});

const spec = (dir, ...args) => spawnSync("node", ["templates/mkspec.mjs", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, FACTORY_CONFIG: "" } });

test("mkspec refuses a review round beyond reviews.maxRounds and names reeval", () => {
  const dir = controllerDir({ reviews: { maxRounds: 2 } });
  const r = spec(dir, "test", "T1", "docs/tasks/T1.md", "agents/t1", "abc", "--round", "3");
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "", "no spec path printed");
  assert.match(r.stderr, /round 3 is beyond reviews\.maxRounds \(2\)/);
  assert.match(r.stderr, /mkspec\.mjs reeval T1 docs\/tasks\/T1\.md agents\/t1 abc agents\/t1-review-2:docs\/reviews\/T1-review-2\.md/);
  assert.doesNotMatch(r.stderr, /at .*mkspec\.mjs:\d+/, "a message, not a stack trace");
  assert.ok(!fs.existsSync(path.join(dir, "specs/t1-test.txt")), "no spec written");
  assert.notEqual(spec(dir, "test", "T1", "docs/tasks/T1.md", "agents/t1", "abc", "--round", "x").status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("from round 2 the Tester re-checks the previous findings and the rework diff; round 1 reviews the whole diff", () => {
  const dir = controllerDir({ reviews: { maxRounds: 3 } });
  const one = fs.readFileSync(spec(dir, "test", "T1", "docs/tasks/T1.md", "agents/t1", "abc").stdout.trim(), "utf8");
  assert.match(one, /Review the whole diff against its merge-base with origin\/main/);
  assert.match(one, /Run 'ponytail-review' on the full diff/);
  const r = spec(dir, "test", "T1", "docs/tasks/T1.md", "agents/t1", "def", "--round", "2");
  assert.equal(r.status, 0, r.stderr);
  const two = fs.readFileSync(r.stdout.trim(), "utf8");
  assert.match(two, /round-1 findings docs\/reviews\/T1-review-1\.md \(git show origin\/agents\/t1-review-1:docs\/reviews\/T1-review-1\.md\)/);
  assert.match(two, /the diff from that file's 'Reviewed commit' to the reviewed head/);
  assert.match(two, /new finding only for a functional defect or a safety problem/);
  assert.doesNotMatch(two, /Review the whole diff/);
  assert.match(two, /gate bash -c 'npm run verify' once/, "the full gate still runs");
  assert.match(two, /docs\/reviews\/T1-review-2\.md/);
  assert.equal(spec(dir, "test", "T1", "docs/tasks/T1.md", "agents/t1", "def", "--round", "3").status, 0, "round 3 is allowed with maxRounds 3");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CONTROLLER.md and the review protocol state the same round rule and the event-driven loop", () => {
  const ctl = fs.readFileSync(path.join(ROOT, "controller/CONTROLLER.md"), "utf8");
  const protocol = fs.readFileSync(path.join(ROOT, "templates/docs/review-protocol.md"), "utf8");
  assert.doesNotMatch(ctl, /every 10 minutes/);
  assert.match(ctl, /do not poll workers yourself/);
  for (const doc of [ctl, protocol]) {
    assert.match(doc, /refuses a round beyond \{\{MAX_ROUNDS\}\}/);
    assert.match(doc, /mkspec reeval/);
    assert.match(doc, /functional defect or a safety problem/);
    assert.match(doc, /independent review/);
  }
});
