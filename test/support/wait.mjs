// Timing helpers for tests that must hold on a busy machine (several suites run at once here, load average 10 to 25).
//
//   scaled(ms)                  an upper bound for "something is broken", stretched by the machine's load
//   waitUntil(check, opts)      wait until check() is truthy, polling, with a generous upper bound; resolves as soon as it is
//   stallwatchPass(dir, opts)   run controller/stallwatch.mjs for exactly its first pass and return what it printed
//
// A passing test never waits longer than the thing it waits for: the bounds below only matter when something is really stuck.
// Where the timeout is the test's subject (a call that must end by itself), keep the semantics and pass the margin through scaled().
//
// AF_TEST_TIMEOUT_SCALE=<number> pins the factor (1 = no stretch, for a quiet machine or to see the bare numbers).
// Without it the factor is 1 plus the 1-minute load average per CPU, so an idle machine gets 1 and a load of 25 on 10 CPUs gets 3.5.
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function factor() {
  const pinned = Number(process.env.AF_TEST_TIMEOUT_SCALE);
  if (Number.isFinite(pinned) && pinned > 0) return pinned;
  return 1 + os.loadavg()[0] / Math.max(1, os.cpus().length);
}
export const scaled = (ms) => Math.round(ms * factor());

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polls check() every `interval` ms until it returns something truthy (returned), for at most scaled(`timeout`) ms; then throws `what`.
export async function waitUntil(check, { timeout = 30_000, interval = 25, what = "the condition" } = {}) {
  const end = Date.now() + scaled(timeout);
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() >= end) throw new Error(`timed out waiting for ${what}`);
    await sleep(interval);
  }
}

const childrenOf = (pid) => spawnSync("ps", ["-ax", "-o", "pid=,ppid="], { encoding: "utf8" }).stdout.split("\n")
  .map((l) => l.trim().split(/\s+/).map(Number)).filter(([, ppid]) => ppid === pid).map(([p]) => p);

// stallwatch.mjs runs until killed and sleeps two minutes after each pass. Start it, wait until its first pass is over, stop it.
// The test's fake Orca must append a line to `passLog` as its `terminal list` call exits (the list is the first call of a pass);
// `ready()` says more when the test knows what the pass must have done (for instance, that the expected reads are logged).
// The pass is over when both hold and the watcher has then stayed without a child process (every read is one) and with unchanged
// output for a settle time, which is what a test of "nothing is read" has to rely on: a starved watcher can pause between two calls.
// Returns { out } (stdout).
export async function stallwatchPass(dir, { env, passLog, ready = () => true, settle = 400, timeout = 60_000 }) {
  const child = spawn("node", [path.join(dir, "stallwatch.mjs")], { cwd: dir, env, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (b) => { out += b; });
  const closed = new Promise((r) => child.on("close", r));
  try {
    const read = () => (fs.existsSync(passLog) ? fs.readFileSync(passLog, "utf8") : "");
    await waitUntil(() => read().includes("list") && ready(), { timeout, what: "stallwatch's first terminal list and the reads that follow" });
    let seen = null, since = Date.now();
    await waitUntil(() => {
      const now = read() + out;
      if (childrenOf(child.pid).length || now !== seen) { seen = now; since = Date.now(); return false; }
      return Date.now() - since >= scaled(settle);
    }, { timeout, interval: 50, what: "stallwatch to finish its first pass" });
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
  return { out };
}
