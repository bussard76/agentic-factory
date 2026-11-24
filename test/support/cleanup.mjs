// Temp directories and background processes of a test file, removed and stopped when the file ends. Imported (through safe-env.mjs)
// by every test file, and by the runner (test/run.mjs) for the sweep that backs it up.
//
//   tempDir(prefix)          a new directory for this test file (a replacement for fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
//   spawnBackground(...)     child_process.spawn in its own process group; stopped at the end (or with stop(child))
//   expectBackground(dir)    the code under test (agentic-factory start, ...) starts a detached process whose command line names
//                            something under `dir`; it is stopped at the end, and meanwhile found by pid with processesUnder(dir)
//   stopBackground(dir)      stop those processes now (exactly the ones whose command line names a path under `dir`)
//   own(path)                a path made beside a tempDir() one, directly in the temp folder (`${dir}-ctl`): removed too
//   onCleanup(fn)            anything else to undo (a file in a fixed place, ...), run first, newest first
//
// How it works: the file's process makes one scratch directory (inside os.tmpdir(), which under `npm test` is the run's own
// directory) and sets TMPDIR to it, so everything a test or the code it runs puts in the temp folder ends up inside it, whether
// or not the test asked for it. At the end of the file (node:test `after` hook, and again on process exit, SIGINT, SIGTERM and
// SIGHUP) it stops the processes it knows or finds, removes the scratch directory, and fails the file when it had to clean up
// something nobody registered: a directory not made through tempDir(), a process not expected. That is the guard against product
// code that leaves temp files (controller/docsonly.mjs did) and against a test that leaves a logger running.
// What no JavaScript can do: run on SIGKILL, on a crash of node itself, or while the file is stuck in a synchronous call when a
// signal arrives. For those the runner (test/run.mjs) sweeps the run's directory after the file's process is gone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { after } from "node:test";

let scratch = process.env.AF_TEST_SCRATCH;
const owner = !(scratch && fs.existsSync(scratch));   // a child that imports this too (a probe script) shares its parent's scratch
if (owner) {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "af-t-")));   // the real path: it is what ps shows
  process.env.AF_TEST_SCRATCH = scratch;
  process.env.TMPDIR = scratch;
}
export const scratchDir = scratch;

const made = new Set();          // top-level names made through tempDir()
const undo = [];                 // onCleanup callbacks
const tracked = new Set();       // pids started through spawnBackground
const ledger = `${scratch}.pids`;   // the same pids in a file beside the scratch directory: what the runner stops if this process is killed outright
const expected = new Set();      // directories under which background processes are expected

export function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(scratch, prefix));
  made.add(path.basename(dir));
  return dir;
}
// A path directly in the temp folder that a test makes beside a directory of tempDir() (`${dir}-ctl`, `${dir}-rel.git`): owned, removed at the end.
export function own(p) { if (path.dirname(path.resolve(p)) === scratch) made.add(path.basename(p)); return p; }
// What the product itself keeps in $TMPDIR on purpose: not a leak. The gate's queue (<project>-gate-<pool>, gate.mjs: shared between
// processes, that is its job), the logs of a wave when WAVE_LOG_DIR is not set (wave-<pid>, integ-wave.sh: they are what a human reads
// after a failed wave) and node's own compile cache. Removed with the scratch directory like the rest.
const BY_DESIGN = [/^[\w.-]+-gate-[\w-]+$/, /^wave-\d+$/, /^node-compile-cache$/];
export function onCleanup(fn) { undo.unshift(fn); }
export function expectBackground(dir) { expected.add(path.resolve(dir)); }

export function spawnBackground(cmd, args = [], opts = {}) {
  const child = spawn(cmd, args, { stdio: "ignore", ...opts, detached: true });
  if (child.pid) { tracked.add(child.pid); try { fs.appendFileSync(ledger, `${child.pid}\n`); } catch { /* the runner then cannot find it after a SIGKILL */ } }
  child.unref();
  return child;
}

const psRows = () => spawnSync("ps", ["-ax", "-o", "pid=,ppid=,pgid=,command="], { encoding: "utf8" }).stdout.split("\n")
  .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], pgid: +m[3], command: m[4] }));
const names = (command, dir) => command.includes(`${dir}${path.sep}`) || command.endsWith(dir) || command.includes(`${dir} `);

// Processes whose command line names a path under `dir` (default: this file's whole scratch directory), except this one.
export function processesUnder(dir = scratch) {
  const d = path.resolve(dir);
  return psRows().filter((r) => r.pid !== process.pid && names(r.command, d));
}

function kill(rows, all) {
  const own = all.find((r) => r.pid === process.pid)?.pgid;
  const doomed = new Set(), groups = new Set();
  const add = (r) => { if (doomed.has(r.pid) || r.pid === process.pid) return; doomed.add(r.pid); for (const c of all) if (c.ppid === r.pid) add(c); };
  for (const r of rows) { add(r); if (r.pgid !== own) groups.add(r.pgid); }   // never the group this process is in: that is the whole run
  for (const g of groups) try { process.kill(-g, "SIGKILL"); } catch { /* gone */ }
  for (const pid of doomed) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  return doomed.size;
}
export function stop(child) { kill(psRows().filter((r) => r.pid === child.pid), psRows()); tracked.delete(child.pid); }
export function stopBackground(dir) { const all = psRows(); return kill(all.filter((r) => r.pid !== process.pid && names(r.command, path.resolve(dir))), all); }

let finished = false;
function cleanup() {
  const problems = [];
  if (finished) return problems;
  finished = true;
  for (const fn of undo) try { fn(); } catch (e) { problems.push(`cleanup callback failed: ${e?.message ?? e}`); }
  const all = psRows();
  const mine = all.filter((r) => r.pid !== process.pid && (tracked.has(r.pid) || names(r.command, scratch)));
  const stray = mine.filter((r) => !tracked.has(r.pid) && ![...expected].some((d) => names(r.command, d)));
  for (const r of stray) problems.push(`a process was left running from the scratch directory (pid ${r.pid}): ${r.command.slice(0, 200)}`);
  kill(mine, all);
  let entries = [];
  try { entries = fs.readdirSync(scratch); } catch { /* already gone */ }
  for (const e of entries) if (e !== path.basename(ledger) && !made.has(e) && !BY_DESIGN.some((re) => re.test(e))) problems.push(`a directory or file was left in the temp folder without tempDir(): ${e}`);
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  fs.rmSync(ledger, { force: true });
  // Product scripts that write to a fixed /tmp path ignore TMPDIR: preview-update.sh (/tmp/<project>-preview.*, the tests name the project
  // af-test-<pid>-<n>) and the wave scripts (/tmp/<name>-integ-wave.sh, -wave.out, -wave, the tests name it rev<pid><6 characters>). The
  // tests remove them (onCleanup); what is still there, with this file's pid in its name, is reported and removed. The pid makes it this file's.
  const mark = new RegExp(`^(af-test-${process.pid}-\\d+-|rev${process.pid}[a-z0-9]{6}-)`);
  try { for (const e of fs.readdirSync("/tmp")) if (mark.test(e)) { problems.push(`a file in /tmp was left: ${e}`); fs.rmSync(path.join("/tmp", e), { recursive: true, force: true }); } } catch { /* no /tmp to look at */ }
  return problems;
}

if (owner) {
  after(() => {
    const problems = cleanup();
    if (problems.length) throw new Error(`the test file left things behind:\n  ${problems.join("\n  ")}`);
  });
  process.on("exit", () => {
    const problems = cleanup();
    if (problems.length) { process.stderr.write(`the test file left things behind:\n  ${problems.join("\n  ")}\n`); process.exitCode = 1; }
  });
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(sig, () => process.exit(code));
}
