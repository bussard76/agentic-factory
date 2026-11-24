// The guard that keeps the suite clean: test/support/cleanup.mjs (per file) and test/run.mjs (per run), and the temp-directory helper of
// the product scripts (controller/lib.mjs scratchDir). Each case runs a small script in a child process with a TMPDIR of its own,
// the way a test file runs, and looks at what is left of it.
import "./support/safe-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir } from "./support/cleanup.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = pathToFileURL(path.join(ROOT, "test/support/cleanup.mjs")).href;
const LIB = pathToFileURL(path.join(ROOT, "controller/lib.mjs")).href;
// The environment of a child that is its own test run or its own file: not the one of the test runner this file runs in.
const childEnv = (extra) => { const e = { ...process.env, AF_TEST_SCRATCH: "", ...extra }; delete e.NODE_TEST_CONTEXT; return e; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = async (pid) => { for (let i = 0; i < 60 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50)); return !alive(pid); };

// Runs `body` as a module in a child that has its own TMPDIR; the child prints "pid <n>" lines for processes it started.
function fixture(body, { signal, env = {}, args = [], viaTest = false } = {}) {
  const home = tempDir("af-guard-");
  const outer = path.join(home, "tmp"); fs.mkdirSync(outer);
  const file = path.join(home, "fixture.mjs");
  fs.writeFileSync(file, `import fs from "node:fs"; import os from "node:os"; import path from "node:path";\n${body}`);
  const child = spawn(process.execPath, [...(viaTest ? ["--test"] : []), file, ...args], { env: childEnv({ TMPDIR: outer, ...env }), stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (b) => { out += b; if (signal && out.includes("ready")) child.kill(signal); });
  child.stderr.on("data", (b) => { err += b; });
  return new Promise((resolve) => child.on("close", (code, sig) => resolve({
    code, sig, out, err, outer, home, left: fs.readdirSync(outer),
    pids: [...out.matchAll(/^pid (\d+)$/gm)].map((m) => +m[1]),
  })));
}
const started = `import { tempDir, spawnBackground } from ${JSON.stringify(HELPER)};
const dir = tempDir("af-x-"); fs.writeFileSync(path.join(dir, "f"), "x");
const logger = spawnBackground("sleep", ["300"]); console.log("pid " + logger.pid);
`;

test("a file that ends normally leaves no directory and no process", async () => {
  const r = await fixture(`${started}console.log("ready");`);
  assert.equal(r.code, 0, r.err); assert.deepEqual(r.left, []);
  assert.ok(await gone(r.pids[0]), "the process it started is stopped");
});

test("process.exit and a signal leave nothing either", async () => {
  for (const [name, tail, opts] of [
    ["process.exit", `process.exit(3);`, {}],
    ["SIGTERM", `console.log("ready"); setInterval(() => {}, 1000);`, { signal: "SIGTERM" }],
    ["SIGINT", `console.log("ready"); setInterval(() => {}, 1000);`, { signal: "SIGINT" }],
  ]) {
    const r = await fixture(`${started}${tail}`, opts);
    assert.notEqual(r.code, 0, `${name}: the exit status says it did not end well`);
    assert.deepEqual(r.left, [], `${name}: temp folder is empty`);
    assert.ok(await gone(r.pids[0]), `${name}: the process it started is stopped`);
  }
});

test("a failing test and an error thrown in one leave nothing either (under node --test, as in npm test)", async () => {
  for (const [name, fail] of [["a failed assertion", `assert.equal(1, 2)`], ["a thrown error", `throw new Error("boom")`]]) {
    const pids = path.join(tempDir("af-pids-"), "pids");
    const r = await fixture(`import { test } from "node:test"; import assert from "node:assert/strict";
import { tempDir, spawnBackground } from ${JSON.stringify(HELPER)};
test("fails", () => { const dir = tempDir("af-x-"); fs.writeFileSync(path.join(dir, "f"), "x"); const p = spawnBackground("sleep", ["300"]); fs.writeFileSync(process.env.PIDS, String(p.pid)); ${fail}; });`, { viaTest: true, env: { PIDS: pids } });
    assert.notEqual(r.code, 0, `${name}: the run fails`);
    assert.deepEqual(r.left, [], `${name}: temp folder is empty`);
    assert.ok(await gone(Number(fs.readFileSync(pids, "utf8"))), `${name}: the process it started is stopped`);
  }
});

test("a directory made without the helper, and a process nobody expected, fail the file and are cleaned up", async () => {
  const r = await fixture(`import "${HELPER}"; import { spawn } from "node:child_process"; fs.mkdtempSync(path.join(os.tmpdir(), "docs-only-"));
const q = spawn("sh", ["-c", "sleep 301; : " + os.tmpdir() + "/"], { stdio: "ignore", detached: true }); console.log("pid " + q.pid); q.unref(); await new Promise((r) => setTimeout(r, 300)); process.exit(0);`);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /without tempDir\(\): docs-only-/);
  assert.match(r.err, /left running from the scratch directory/);
  assert.deepEqual(r.left, []);
  assert.ok(await gone(r.pids[0]), "a detached process that names the scratch directory is stopped");
});

test("what the code under test starts and the test said to expect is stopped without a complaint", async () => {
  const r = await fixture(`import { tempDir, expectBackground, stopBackground } from ${JSON.stringify(HELPER)}; import { spawn } from "node:child_process";
const dir = tempDir("af-y-"); expectBackground(dir); fs.writeFileSync(path.join(dir, "logger.sh"), "sleep 300\\n");
const p = spawn("bash", [path.join(dir, "logger.sh")], { detached: true, stdio: "ignore" }); p.unref(); console.log("pid " + p.pid);
await new Promise((r) => setTimeout(r, 300)); console.log("ready");`);
  assert.equal(r.code, 0, r.err); assert.deepEqual(r.left, []);
  assert.ok(await gone(r.pids[0]));
});

test("stopBackground stops exactly the processes under its directory, not another one with a similar name", async () => {
  const r = await fixture(`import { tempDir, stopBackground, spawnBackground } from ${JSON.stringify(HELPER)};
const a = tempDir("af-a-"), b = tempDir("af-a-b-");
for (const d of [a, b]) fs.writeFileSync(path.join(d, "loadlog.sh"), "sleep 300\\n");
const pa = spawnBackground("bash", [path.join(a, "loadlog.sh")]), pb = spawnBackground("bash", [path.join(b, "loadlog.sh")]);
await new Promise((r) => setTimeout(r, 300));
stopBackground(a); await new Promise((r) => setTimeout(r, 300));
const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
console.log("a alive: " + alive(pa.pid) + ", b alive: " + alive(pb.pid));`);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /a alive: false, b alive: true/);
});

test("the runner fails a run whose file was killed outright, cleans up after it, and leaves a live run and its directory alone", async () => {
  const home = tempDir("af-runner-"), outer = path.join(home, "tmp"); fs.mkdirSync(outer);
  const file = path.join(home, "killed.test.mjs");
  fs.writeFileSync(file, `import ${JSON.stringify(pathToFileURL(path.join(ROOT, "test/support/safe-env.mjs")).href)}; import { tempDir, spawnBackground } from ${JSON.stringify(HELPER)}; import fs from "node:fs";
import { test } from "node:test";
test("dies", () => { const dir = tempDir("af-k-"); fs.writeFileSync(dir + "/f", "x"); const p = spawnBackground("sleep", ["300"]); fs.writeFileSync(process.env.PIDFILE, String(p.pid)); process.kill(process.pid, "SIGKILL"); });`);
  const pidfile = path.join(home, "pid");
  const live = path.join(outer, `af-run-${process.pid}-live`); fs.mkdirSync(live);   // another run that is alive (this process)
  const dead = spawnSync(process.execPath, ["-e", "0"]); const stale = path.join(outer, `af-run-${dead.pid}-old`); fs.mkdirSync(stale);   // a run that died
  const r = spawnSync(process.execPath, [path.join(ROOT, "test/run.mjs"), file], { encoding: "utf8", env: childEnv({ TMPDIR: outer, PIDFILE: pidfile }) });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /The test run left things behind/); assert.match(r.stderr, /removed .*af-run-\d+-old/);
  assert.deepEqual(fs.readdirSync(outer), [path.basename(live)], "only the live run's directory is left");
  assert.ok(await gone(Number(fs.readFileSync(pidfile, "utf8"))), "the process of the killed file is stopped");
});

test("a product script's scratchDir is removed on every way out", async () => {
  const cfg = path.join(tempDir("af-cfg-"), "factory.config.json"); fs.writeFileSync(cfg, JSON.stringify({ project: { name: "p" } }));
  for (const [name, tail, opts] of [
    ["the normal end", `console.log("ready");`, {}],
    ["process.exit", `process.exit(4);`, {}],
    ["an error", `throw new Error("boom");`, {}],
    ["SIGTERM", `console.log("ready"); setInterval(() => {}, 1000);`, { signal: "SIGTERM" }],
  ]) {
    const r = await fixture(`import { scratchDir } from ${JSON.stringify(LIB)}; const d = scratchDir("docs-only-"); fs.writeFileSync(path.join(d, "x"), "x"); ${tail}`, { ...opts, env: { FACTORY_CONFIG: cfg } });
    assert.deepEqual(r.left, [], `${name}: the scratch directory is gone`);
  }
});
