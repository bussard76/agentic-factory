// `npm test`: runs every test file with node --test inside a directory of its own for this run, then checks that nothing is left.
//
// The run gets af-run-<pid>-<random> in the temp folder and passes it to the test files as their TMPDIR, so everything the suite
// and the code it runs put in the temp folder lands there (test/support/cleanup.mjs removes each file's part when the file ends).
// When all files are done this checks the run's directory: a directory left in it, or a process whose command line names a path
// in it, fails the run, and is removed and stopped. The name carries the pid and the random part, so a second `npm test` on the
// same machine has its own directory and is neither checked nor disturbed by this one; "this run's leftovers" are exactly what is
// inside this run's directory or named by a process's command line with its path.
// Before it starts it also sweeps runs that died without their check (SIGKILL, a power cut): af-run-<pid>-* of a pid that no longer
// exists, nothing else, and nothing whose pid is alive (a pid reused by another process makes it leave the directory alone).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const outer = fs.realpathSync(os.tmpdir());
const psRows = () => spawnSync("ps", ["-ax", "-o", "pid=,pgid=,command="], { encoding: "utf8" }).stdout.split("\n")
  .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: +m[1], pgid: +m[2], command: m[3] }));
const under = (command, dir) => command.includes(`${dir}${path.sep}`) || command.endsWith(dir) || command.includes(`${dir} `);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

// Stops the processes that name a path inside `root` (and their groups, when they are not this run's own); returns how many.
function stopUnder(root) {
  const all = psRows(), own = all.find((r) => r.pid === process.pid)?.pgid;
  const found = all.filter((r) => r.pid !== process.pid && under(r.command, root));
  for (const g of new Set(found.map((r) => r.pgid))) if (g !== own) try { process.kill(-g, "SIGKILL"); } catch { /* gone */ }
  for (const r of found) try { process.kill(r.pid, "SIGKILL"); } catch { /* gone */ }
  return found;
}

for (const name of fs.readdirSync(outer)) {
  const m = /^af-run-(\d+)-[A-Za-z0-9]+$/.exec(name);
  if (!m || alive(+m[1])) continue;
  const stale = path.join(outer, name);
  stopUnder(stale);
  fs.rmSync(stale, { recursive: true, force: true });
  console.error(`removed ${stale}: left by a test run (pid ${m[1]}) that was killed before it could clean up`);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(outer, `af-run-${process.pid}-`)));
const argv = process.argv.slice(2);
const given = argv.filter((a) => a.endsWith(".mjs"));   // `npm test -- test/x.test.mjs`, or flags of node --test (--test-name-pattern ...)
const files = given.length ? [] : fs.readdirSync(here).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => path.join(here, f));
// node --test and the test files run in a group of their own, so that a signal to this process reaches all of them (below), also when
// it was not sent through the terminal; each file then cleans up itself, and this run's check at the end backs it up.
const child = spawn(process.execPath, ["--test", ...argv, ...files], { stdio: "inherit", detached: true, env: { ...process.env, TMPDIR: root, AF_TEST_RUN_ROOT: root } });
const toGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* gone */ } };
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { toGroup(sig); setTimeout(() => toGroup("SIGKILL"), 10000).unref(); });

child.on("exit", (code, signal) => {
  const problems = [];
  const procs = stopUnder(root);
  for (const r of procs) problems.push(`a process of this run is still alive (pid ${r.pid}): ${r.command.slice(0, 160)}`);
  // Processes a test file started with spawnBackground are listed in <scratch>.pids; a file that ended normally removed its list.
  // They are group leaders (detached): only a pid that still leads its own group is stopped, so a reused pid is left alone.
  let left = [];
  try { left = fs.readdirSync(root); } catch { /* already gone */ }
  const rows = psRows();
  for (const f of left.filter((n) => n.endsWith(".pids"))) {
    for (const pid of fs.readFileSync(path.join(root, f), "utf8").split("\n").filter(Boolean).map(Number)) {
      const r = rows.find((x) => x.pid === pid && x.pgid === pid);
      if (!r) continue;
      try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
      problems.push(`a process a test file started is still alive (pid ${pid}): ${r.command.slice(0, 160)}`);
    }
  }
  left = left.filter((n) => !n.endsWith(".pids"));
  for (const e of left) problems.push(`left in the run's temp directory: ${e}${fs.statSync(path.join(root, e), { throwIfNoEntry: false })?.isDirectory() ? ` (${fs.readdirSync(path.join(root, e)).slice(0, 6).join(", ")})` : ""}`);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  if (problems.length) {
    console.error(`\nThe test run left things behind (run directory ${root}); they are removed and stopped now:\n  ${problems.join("\n  ")}`);
    process.exit(code || 1);
  }
  process.exit(code ?? (signal ? 1 : 0));
});
