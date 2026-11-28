// capacity.mjs: how foreign load is measured and judged, and the two capacity classes. Everything runs on stand-ins: a
// made-up /proc (Linux path) or made-up ps and lsof (macOS path), never the processes of the machine the test runs on.
// Both paths run on every machine: FACTORY_PROC points the probe at the made-up /proc, or at an empty directory for macOS.
//
// The reported case (an almost idle 12-thread host, load1 1.2) was reproduced with these stand-ins on the code before this
// change: it said "foreign load ~6.6", answered wait, and a suite cap of 5 fell to 2 in three steps for that reason alone.
import "./support/safe-env.mjs";
import { tempDir } from "./support/cleanup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { attribute, parseProbe, probeScript, repairCaps } from "../controller/capacity-rules.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sh = (file, body) => fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });

/**
 * A made-up host. procs: [{ pid, ppid, name, at (directory: a key of `dirs`, a path, or null for unreadable),
 * had (CPU seconds before the sample; null: born during it), uses (cores during the 1 s sample) }]. ppid "probe" is the
 * probe's own shell, whose pid only the stand-in `sleep` knows; probeParent is that shell's parent.
 */
function host({ os = "linux", load1 = 1.2, threads = 12, psiCpu = null, psiMem = null, availKb = 40_000_000, capacity = {}, procs = [], probeParent = 1, remote = false, sampleFails = false, locale = null } = {}) {
  const dir = fs.realpathSync(tempDir("af-capacity-"));
  const ctl = path.join(dir, "ctl"), bin = path.join(dir, "bin"), home = path.join(dir, "home"), proc = path.join(dir, "proc"), after = path.join(dir, "after"), tmproot = path.join(dir, "tmproot");
  for (const d of [ctl, bin, home, proc, after, tmproot]) fs.mkdirSync(d);
  for (const f of ["capacity.mjs", "capacity-rules.mjs", "cli.mjs", "lib.mjs", "ticket.mjs"]) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(ctl, f));
  const mk = (...p) => { const d = path.join(dir, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const repo = (...p) => { mk(...p, ".git"); return path.join(dir, ...p); };
  const dirs = {
    root: "/", home, controller: ctl,
    project: repo("projects", "demo"),
    worktree: repo("ws", "demo", "t1"),
    frontAgent: mk("home", "front-agent", "demo"),
    preview: repo("home", "Development", "demo-preview"),
    other: repo("projects", "other"),
    otherWorktree: mk("ws", "other", "t9", "src"),
    prefix: repo("projects", "demo-two"),
    plain: mk("somewhere", "plain"),
    tmpRepo: repo("tmproot", "checkout"),
    linked: mk("elsewhere", "linked-own", "src"),
    linkedOther: mk("elsewhere", "linked-other"),
  };
  repo("ws", "other", "t9");
  fs.writeFileSync(path.join(dir, "elsewhere", "linked-own", ".git"), `gitdir: ${dirs.project}/.git/worktrees/linked-own\n`);
  fs.writeFileSync(path.join(dirs.linkedOther, ".git"), `gitdir: ${dirs.other}/.git/worktrees/linked-other\n`);
  const where = (at) => (at === null || at === undefined ? null : dirs[at] ?? at);

  const config = {
    project: { name: "demo" }, agents: { runner: "terminal" }, capacity,
    hosts: { controller: { host: "ctlhost" }, workers: [{ name: "local", kind: remote ? "remote" : "local", ssh: "stand-in", projectDir: dirs.project, workspacesDir: path.join(dir, "ws") }] },
  };
  fs.writeFileSync(path.join(ctl, "factory.config.json"), JSON.stringify(config));

  sh(path.join(bin, "nproc"), `echo ${threads}`);
  sh(path.join(bin, "getconf"), "echo 100");
  const ticks = (s) => Math.round(s * 100);
  let rewind;
  if (os === "linux") {
    const stat = (p, cpu, ppid) => `${p.pid} (${p.name}) S ${ppid} 1 1 0 -1 0 0 0 0 0 ${ticks(cpu)} 0 999999 999999 20 0 1 0 ${p.had === null ? 100050 : 5000} 0 0`;
    fs.writeFileSync(path.join(proc, "uptime"), "1000.00 0\n");
    fs.writeFileSync(path.join(after, "uptime"), "1001.00 0\n");
    fs.writeFileSync(path.join(proc, "loadavg"), `${load1} 1.00 1.00 1/100 1\n`);
    fs.writeFileSync(path.join(proc, "meminfo"), `MemAvailable: ${availKb} kB\n`);
    if (psiCpu !== null) { fs.mkdirSync(path.join(proc, "pressure")); for (const [k, v] of [["cpu", psiCpu], ["memory", psiMem ?? 0], ["io", 0]]) fs.writeFileSync(path.join(proc, "pressure", k), `some avg10=${v.toFixed(2)} avg60=0.00 avg300=0.00 total=0\n`); }
    const late = [], before = new Map();   // the first sample, written back before every run
    for (const p of procs) {
      fs.mkdirSync(path.join(proc, String(p.pid)));
      if (where(p.at)) fs.symlinkSync(where(p.at), path.join(proc, String(p.pid), "cwd"));
      if (p.ppid === "probe") { late.push(`mkdir -p "${proc}/${p.pid}"; echo "${stat({ ...p, had: null }, p.uses, "$PPID")}" > "${proc}/${p.pid}/stat"`); if (where(p.at)) late.push(`[ -e "${proc}/${p.pid}/cwd" ] || ln -s "${where(p.at)}" "${proc}/${p.pid}/cwd"`); continue; }
      if (p.had !== null) before.set(path.join(proc, String(p.pid), "stat"), stat(p, p.had, p.ppid ?? 1) + "\n");
      fs.mkdirSync(path.join(after, String(p.pid)));
      fs.writeFileSync(path.join(after, String(p.pid), "stat"), stat(p, (p.had ?? 0) + p.uses, p.ppid ?? 1) + "\n");
    }
    rewind = () => { fs.writeFileSync(path.join(proc, "uptime"), "1000.00 0\n"); for (const p of procs) if (p.had === null || p.ppid === "probe") fs.rmSync(path.join(proc, String(p.pid), "stat"), { force: true }); for (const [f, text] of before) fs.writeFileSync(f, text); };
    // The probe's own shell is busy too: the stand-in `sleep` is its child, so $PPID is the shell.
    sh(path.join(bin, "sleep"), [`cp -R "${after}/." "${proc}/"`, ...late,
      `mkdir -p "${proc}/$PPID"; echo "$PPID (sh) S ${probeParent} 1 1 0 -1 0 0 0 0 0 100 0 0 0 20 0 1 0 100050 0 0" > "${proc}/$PPID/stat"; ln -sf "${ctl}" "${proc}/$PPID/cwd"`].join("\n"));
  } else {
    const time = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
    const rows = (second) => procs.filter((p) => p.ppid !== "probe" && (second || p.had !== null)).map((p) => `${p.pid} ${p.ppid ?? 1} ${time((p.had ?? 0) + (second ? p.uses : 0))} /usr/bin/${p.name}`);
    fs.writeFileSync(path.join(dir, "ps1"), rows(false).join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "ps2"), rows(true).join("\n") + "\n");
    // The probe's shell and its own children, listed in the second sample. `ps` runs in a subshell, so the shell's pid
    // comes from the stand-in `sleep`, which the shell starts itself.
    const own = [`echo "$shell ${probeParent} 0:01.00 sh"`, ...procs.filter((p) => p.ppid === "probe").map((p) => `echo "${p.pid} $shell ${time(p.uses)} ${p.name}"`)];
    sh(path.join(bin, "ps"), sampleFails ? "exit 1" : `if [ -e "${dir}/slept" ]; then shell=$(cat "${dir}/slept"); cat "${dir}/ps2"; ${own.join("; ")}; else cat "${dir}/ps1"; fi`);
    sh(path.join(bin, "sleep"), `echo "$PPID" > "${dir}/slept"`);
    rewind = () => fs.rmSync(path.join(dir, "slept"), { force: true });
    // lsof -b -w -a -d cwd -p <pids> -Fpn
    sh(path.join(bin, "lsof"), `echo "$*" >> "${dir}/lsof.log"\nfor p in $(echo "$7"| tr ',' ' '); do case $p in\n${procs.filter((p) => where(p.at)).map((p) => `${p.pid}) printf 'p${p.pid}\\nfcwd\\nn%s\\n' "${where(p.at)}";;`).join("\n")}\n*) :;;\nesac; done\nexit 1`);
    // Like the real one, it prints the load with the locale's decimal comma unless the caller runs under C.
    const comma = String(load1).replace(".", ",");
    sh(path.join(bin, "sysctl"), `case "$*" in *loadavg*) case "$LC_ALL" in C|"") echo "{ ${load1} 1.00 1.00 }";; *) echo "{ ${comma} 1,00 1,00 }";; esac;; *pagesize*) echo 16384;; *) echo ${threads};; esac`);
    sh(path.join(bin, "vm_stat"), `echo "Pages free:                 ${Math.round(availKb / 16)}."`);
  }
  // A stand-in ssh: records the call and gives the command to sh, as the remote login shell would get it.
  sh(path.join(bin, "ssh"), `echo call >> "${dir}/ssh.log"\nshift\ncd "${home}" && exec /bin/sh -c "$1"`);

  const env = { HOME: home, TMPDIR: tmproot, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, FACTORY_PROC: proc, FACTORY_PROBE_TMP: tmproot, ...(locale ? { LANG: locale, LC_ALL: locale } : {}) };
  const run = (...args) => {
    rewind();
    const extraEnv = typeof args[0] === "object" ? args.shift() : {};
    const r = spawnSync(process.execPath, [path.join(ctl, "capacity.mjs"), "--verbose", ...args], { cwd: ctl, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const stateFile = path.join(ctl, "capacity-state.local.json");
  const workers = (n, extra = {}) => fs.writeFileSync(path.join(ctl, "workers.json"), JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [`w${i}`, { host: "local", pid: process.pid, ...extra }]))));
  const journal = () => (fs.existsSync(path.join(ctl, "journal.ndjson")) ? fs.readFileSync(path.join(ctl, "journal.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { dir, ctl, dirs, run, workers, journal, stateFile, state: () => JSON.parse(fs.readFileSync(stateFile, "utf8")), setState: (s) => fs.writeFileSync(stateFile, JSON.stringify(s)) };
}
// Pids far above any real one, so a stand-in never meets the probe shell's own pid.
const P = (n) => 9_000_000 + n;
const busy = (n, at, uses, extra = {}) => ({ pid: P(n), name: `p${n}`, at, had: 10, uses, ...extra });
const BOTH = ["linux", "macos"];

// --- the reported case ------------------------------------------------------------------------------------------------
// What the old probe added up to ~6.6 "foreign" cores on a host with load1 1.2.
const REPORT = (os) => ({
  os, load1: 1.2, threads: 12, probeParent: P(5),
  procs: [
    { pid: P(1), ppid: "probe", name: "ps", at: "controller", had: null, uses: 1.0 },   // the probe's own child: "100 %"
    { pid: P(2), name: "node", at: "home", had: 0.98, uses: 0 },                        // short-lived: busy for its second, idle now
    { pid: P(3), name: "git", at: "home", had: 0.96, uses: 0 },
    { pid: P(4), name: "node", at: "home", had: 0.95, uses: 0 },
    busy(5, "root", 0.64, { name: "sshd" }),                                            // carries the probe
    busy(6, "controller", 1.2, { name: "claude" }),                                     // the factory's own agents
    busy(7, "controller", 0.85, { name: "claude" }),
    busy(8, "frontAgent", 0.72, { name: "node" }),
  ],
});
for (const os of BOTH) test(`${os}: the reported idle host has no foreign load and nothing is held`, () => {
  const v = host(REPORT(os)).run();
  assert.equal(v.foreignLoad, 0, JSON.stringify(v));
  assert.equal(v.unknownLoad, 0, "the probe's tree and what carries it are left out");
  assert.equal(v.measured.own, 2.8);
  assert.deepEqual([v.suite, v.heavy, v.light, v.readonly], ["start", "start", "start", "start"]);
  assert.equal(v.reason, "capacity available");
  assert.equal(v.loadNote, undefined);
});

for (const os of BOTH) test(`${os}: CPU is what a process used during the sample, not over its lifetime`, () => {
  const h = host({ os, procs: [
    { pid: P(1), name: "was-busy", at: "other", had: 500, uses: 0 },          // a long, busy past and idle now
    { pid: P(2), name: "now-busy", at: "other", had: 0.01, uses: 3 },         // little so far, three cores now
    { pid: P(3), name: "born", at: "other", had: null, uses: 0.5 },           // born during the sample: only what it used in it
    { pid: P(4), name: "tiny", at: "other", had: 1, uses: 0.04 },             // under 5 % of a core: left out
    { pid: P(5), name: "a b) (c", at: "other", had: 1, uses: 0.25 },          // a name with spaces and parentheses
  ] });
  assert.equal(h.run().measured.foreign, 3.8);   // 3 + 0.5 + 0.25, shown with one decimal
});

for (const os of BOTH) test(`${os}: only another git checkout is foreign; own directories are own; the rest is unknown`, () => {
  const cases = [
    ["project", "own"], ["worktree", "own"], ["controller", "own"], ["frontAgent", "own"], ["preview", "own"], ["linked", "own"],
    ["other", "foreign"], ["otherWorktree", "foreign"], ["prefix", "foreign"], ["linkedOther", "foreign"],
    ["root", "unknown"], ["home", "unknown"], ["plain", "unknown"], ["tmpRepo", "unknown"], [null, "unknown"],
  ];
  for (const group of ["own", "foreign", "unknown"]) {
    const mine = cases.filter(([, verdict]) => verdict === group);
    // One at a time within the group would be slow: each gets its own size, so a wrong owner changes the sum.
    const h = host({ os, procs: mine.map(([at], i) => busy(i + 1, at, (i + 1) / 10)) });
    const sum = Number((mine.length * (mine.length + 1) / 20).toFixed(1));
    const m = h.run().measured;
    assert.deepEqual([m.own, m.foreign, m.unknown], ["own", "foreign", "unknown"].map((g) => (g === group ? sum : 0)), `${group}: ${mine.map(([at]) => at).join(", ")}`);
  }
});

test("the home directory kept in git makes nothing foreign", () => {
  const h = host({ procs: [busy(1, "home", 2), busy(2, "plain", 1)] });
  fs.mkdirSync(path.join(h.dir, "home", ".git"));
  assert.equal(h.run().foreignLoad, 0);
});

for (const os of BOTH) test(`${os}: a process whose directory says nothing takes its nearest parent's owner`, () => {
  const h = host({ os, procs: [
    { pid: P(1), name: "own-agent", at: "worktree", had: 1, uses: 0 },             // idle parents count as evidence too
    busy(2, "root", 0.1, { ppid: P(1), name: "browser" }),                          // own
    busy(3, "tmpRepo", 0.2, { ppid: P(2) }),                                        // own, two levels up
    { pid: P(4), name: "their-runner", at: "other", had: 1, uses: 0 },
    busy(5, "root", 0.4, { ppid: P(4) }),                                           // foreign
    busy(6, "worktree", 0.8, { ppid: P(4) }),                                       // own directory beats a foreign parent
    busy(7, "other", 1.6, { ppid: P(1) }),                                          // own agent's tool working in another checkout: not clearly foreign
    busy(8, "root", 3.2, { ppid: P(7) }),                                           // and what that tool starts
  ] });
  const m = h.run().measured;
  assert.deepEqual([m.own, m.foreign, m.unknown], [1.1, 0.4, 4.8]);
});

for (const os of BOTH) test(`${os}: foreign load holds a start only when load1 is not clearly below the threads`, () => {
  const procs = [busy(1, "other", 4)];                                              // over 12 x 0.25 = 3
  const idle = host({ os, load1: 5.9, procs }).run();
  assert.deepEqual([idle.heavy, idle.light, idle.foreignLoad], ["start", "start", 4]);
  assert.match(idle.loadNote, /does not hold a start: load1 5\.9 is below 0\.5 x 12 threads/);
  const loaded = host({ os, load1: 6, procs }).run();
  assert.deepEqual([loaded.heavy, loaded.light, loaded.readonly], ["wait", "wait", "start"]);
  assert.match(loaded.reason, /foreign load ~4\.0/); assert.match(loaded.lightReason, /foreign load ~4\.0/);
  assert.equal(loaded.capOnly, false);
  assert.equal(host({ os, load1: 8, procs: [busy(1, "other", 3)] }).run().heavy, "start", "the limit itself is allowed");
  // Both settings are configurable; 0 switches the cross-check off.
  assert.equal(host({ os, load1: 8, procs, capacity: { foreignLoadMaxPerThread: 0.5 } }).run().heavy, "start");
  assert.equal(host({ os, load1: 8, procs, capacity: { foreignLoadMinLoadPerThread: 0.75 } }).run().heavy, "start");
  assert.equal(host({ os, load1: 0.5, procs, capacity: { foreignLoadMinLoadPerThread: 0 } }).run().heavy, "wait");
});

test("unknown load is reported and never holds a start", () => {
  const v = host({ load1: 10, procs: [busy(1, "root", 6), busy(2, null, 2)] }).run();
  assert.deepEqual([v.unknownLoad, v.foreignLoad, v.heavy, v.light], [8, 0, "start", "start"]);
});

test("a host whose processes cannot be sampled says so and skips the foreign-load rule", () => {
  const v = host({ os: "macos", load1: 8, sampleFails: true, procs: [busy(1, "other", 6)] }).run();
  assert.deepEqual([v.foreignLoad, v.unknownLoad, v.heavy], [null, null, "start"]);
  assert.match(v.loadNote, /could not be sampled/);
});

test("macOS asks lsof once, and only about busy processes and their parents", () => {
  const h = host({ os: "macos", procs: [busy(1, "other", 1), { pid: P(2), name: "idle", at: "other", had: 100, uses: 0 }] });
  h.run();
  const calls = fs.readFileSync(path.join(h.dir, "lsof.log"), "utf8").trim().split("\n");
  assert.deepEqual(calls, [`-b -w -a -d cwd -p ${P(1)} -Fpn`]);
});

// 8 cores really in another checkout, but who they belong to cannot be seen.
for (const [what, os, tool, body] of [["lsof is not there (exit 127)", "macos", "lsof", "exit 127"], ["lsof gives nothing", "macos", "lsof", "exit 1"], ["readlink is refused for every process", "linux", "readlink", "exit 1"]]) {
  test(`working directories unreadable, ${what}: foreign load is unknown with a note, never 0`, () => {
    const h = host({ os, load1: 8, procs: [busy(1, "other", 8)] });
    sh(path.join(h.dir, "bin", tool), body);
    const v = h.run();
    assert.deepEqual([v.foreignLoad, v.unknownLoad, v.heavy], [null, 8, "start"]);
    assert.match(v.loadNote, /working directory .* could be read: foreign load unknown/);
  });
}

// A system without lsof anywhere on the PATH: the probe's own check, run with a PATH that has only what it needs.
test("macOS without lsof on the PATH: the probe says so", () => {
  const dir = fs.realpathSync(tempDir("af-capacity-nolsof-"));
  const r = spawnSync("/bin/sh", ["-c", probeScript({ ownDirs: [], project: "demo" })], { encoding: "utf8", timeout: 60_000, env: { PATH: dir, HOME: dir, FACTORY_PROC: dir, FACTORY_PROBE_TMP: "" } });
  assert.equal(parseProbe(r.stdout).kv.lsof, "missing", r.stdout);
});

test("a probe that hangs is cut off and counts as failed", () => {
  const h = host({ remote: true });
  sh(path.join(h.dir, "bin", "ssh"), "exec /bin/sleep 20");
  const started = Date.now();
  const v = h.run({ FACTORY_PROBE_TIMEOUT_MS: "500" });
  assert.ok(Date.now() - started < 15_000);
  assert.deepEqual([v.heavy, v.light, v.readonly], ["wait", "wait", "wait"]); assert.match(v.reason, /^probe failed/);
});

test("a remote host: the probe is one ssh round trip, run by sh, and the figures are those of that host", () => {
  const h = host({ remote: true, load1: 9, procs: [busy(1, "other", 4), busy(2, "worktree", 1)] });
  const v = h.run();
  assert.deepEqual([v.foreignLoad, v.measured.own, v.measured.load1, v.heavy], [4, 1, 9, "wait"]);
  assert.equal(fs.readFileSync(path.join(h.dir, "ssh.log"), "utf8").trim().split("\n").length, 2, "one for the probe, one that writes the gate slots");
});

// --- locale ------------------------------------------------------------------------------------------------------------
// A Mac with LANG=de_DE.UTF-8: load1 came out as NaN (so everything started), and BSD awk cut "1.50" to 1.
test("macOS under a comma-decimal locale: load and per-process CPU are measured as under C", () => {
  const options = { os: "macos", load1: "20.50", procs: [...Array.from({ length: 8 }, (_, i) => busy(i + 1, "other", 0.9, { had: 10.05 })), { ...busy(9, "other", 0.02), had: 10.99 }] };
  const v = host({ ...options, locale: "de_DE.UTF-8" }).run();
  assert.deepEqual([v.measured.load1, v.foreignLoad, v.heavy, v.light], [20.5, 7.2, "wait", "wait"], JSON.stringify(v));
});

test("a load figure that is not a number is unknown: nothing starts", () => {
  const h = host({ os: "macos", load1: "2,99" });   // as a probe would print it that kept the locale
  sh(path.join(h.dir, "bin", "sysctl"), `case "$*" in *loadavg*) echo "{ 2,99 1,00 1,00 }";; *pagesize*) echo 16384;; *) echo 12;; esac`);
  const v = h.run();
  assert.deepEqual([v.measured.load1, v.heavy, v.light, v.readonly, v.capOnly], [null,"wait", "wait", "wait", false], JSON.stringify(v));
  assert.match(v.reason, /^probe failed \(load unknown\)/);
  assert.deepEqual([v.gateUnitSlots, v.gateE2eSlots].map(Number.isFinite), [true, true]);
});

// --- a failed probe ----------------------------------------------------------------------------------------------------
// It used to read as load 0 on 1 thread with unknown memory: everything started, and a quiet cap rose.
test("a failed or partial probe: every class waits, and the cap moves in neither direction", () => {
  const complete = ["load1=1.0", "threads=12", "avail_kb=40000000", "probe=end"];
  for (const [what, stand] of [
    ["ssh fails", "exit 255"],
    ["ssh dies after part of the output", `printf 'load1=1.0\\nthreads=12\\n'; exit 255`],
    ["output cut off", `printf '${complete.slice(0, -1).join("\\n")}\\n'`],
    ["no threads", `printf '${complete.filter((l) => !l.startsWith("threads")).join("\\n")}\\n'`],
    ["no load", `printf '${complete.filter((l) => !l.startsWith("load1")).join("\\n")}\\n'`],
  ]) for (const cap of [2, 5]) {
    const h = host({ remote: true });
    sh(path.join(h.dir, "bin", "ssh"), stand);
    h.workers(cap); h.setState({ foreignRepair: ago(500), suiteMax: cap, readonlyMax: 2, quietSince: ago(90), roQuietSince: ago(90), history: [] });
    const v = h.run();
    assert.deepEqual([v.heavy, v.light, v.readonly, v.caps.suite, v.capOnly], ["wait", "wait", "wait", cap, false], what);
    assert.match(v.reason, /^probe failed \(/, what); assert.match(v.lightReason, /^probe failed \(/, what);
    assert.deepEqual(h.state().history, [], what);
    assert.ok(Date.now() - Date.parse(h.state().quietSince) < 60e3, "an unmeasured time is not a quiet one");
  }
});

// --- two classes -------------------------------------------------------------------------------------------------------
const verdicts = (v) => [v.heavy, v.light];
for (const os of BOTH) test(`${os} without PSI: heavy up to 0.9 x threads, light up to 1.5 x threads`, () => {
  const at = (load1, capacity) => host({ os, load1, capacity }).run();
  assert.deepEqual(verdicts(at(10.8)), ["start", "start"]);
  const between = at(10.9);
  assert.deepEqual(verdicts(between), ["wait", "start"]);
  assert.equal(between.suite, "wait", "`suite` stays the heavy verdict");
  assert.match(between.reason, /cpu pressure load 10\.9/); assert.equal(between.lightReason, "capacity available");
  assert.deepEqual(verdicts(at(18)), ["wait", "start"]);
  assert.deepEqual(verdicts(at(18.1)), ["wait", "wait"]);
  assert.deepEqual(verdicts(at(11, { heavyLoadPerThread: 1, lightLoadPerThread: 2 })), ["start", "start"]);
  assert.deepEqual(verdicts(at(24.1, { heavyLoadPerThread: 1, lightLoadPerThread: 2 })), ["wait", "wait"]);
  assert.deepEqual(verdicts(at(13, { lightLoadPerThread: 0.5 })), ["wait", "wait"], "light is never stricter than heavy");
  assert.deepEqual(verdicts(at(8, { lightLoadPerThread: 0.5 })), ["start", "start"]);
  assert.deepEqual(verdicts(at(11, { heavyLoadPerThread: "nonsense" })), ["wait", "start"], "an unusable value is the default");
});

test("with PSI: heavy up to cpuAvg10MaxPercent, light up to the higher light limit; the load does not decide", () => {
  const at = (psiCpu, capacity) => host({ psiCpu, load1: 30, capacity }).run();
  assert.deepEqual(verdicts(at(20)), ["start", "start"]);
  assert.deepEqual(verdicts(at(21)), ["wait", "start"]);
  assert.deepEqual(verdicts(at(33)), ["wait", "start"]);       // 20 x 1.5 / 0.9 = 33
  assert.deepEqual(verdicts(at(34)), ["wait", "wait"]);
  assert.equal(at(1).measured.limits.lightCpuAvg10, 33);
  assert.deepEqual(verdicts(at(45, { pressure: { lightCpuAvg10MaxPercent: 50 } })), ["wait", "start"]);
});

test("memory, foreign load and the cap hold both classes; the gate queue and load timeouts hold heavy only", () => {
  for (const [what, h] of [["available memory", host({ availKb: 1_000_000 })], ["memory pressure", host({ psiCpu: 1, psiMem: 30 })], ["foreign", host({ load1: 9, procs: [busy(1, "other", 5)] })]]) {
    assert.deepEqual(verdicts(h.run()), ["wait", "wait"], what);
  }
  const queued = host({});
  const q = path.join(queued.dir, "tmproot", "demo-gate-unit");
  fs.mkdirSync(q); for (const n of [1, 2, 3]) fs.writeFileSync(path.join(q, `ticket-${n}`), "1");
  const v = queued.run();
  assert.deepEqual(verdicts(v), ["wait", "start"]); assert.match(v.reason, /gate queue 3/);
  const timeouts = host({});
  fs.writeFileSync(path.join(timeouts.ctl, "journal.ndjson"), JSON.stringify({ ts: new Date().toISOString(), type: "rerun", task: "t", reason: "load-timeout" }) + "\n");
  assert.deepEqual(verdicts(timeouts.run()), ["wait", "start"]);
  const capped = host({}); capped.workers(2);
  const c = capped.run();
  assert.deepEqual(verdicts(c), ["wait", "wait"]); assert.match(c.lightReason, /suite workers 2\/2/); assert.equal(c.capOnly, true);
});

test("capOnly says whether raising a cap would let a start through", () => {
  const between = host({ load1: 12 });
  between.workers(2);
  assert.equal(between.run().capOnly, true, "Developers are held by the cap alone, although the host is too loaded for a heavy start");
  const over = host({ load1: 20 }); over.workers(2);
  assert.equal(over.run().capOnly, false);
  const cpuOnly = host({ load1: 12 });
  assert.equal(cpuOnly.run().capOnly, false, "only heavy waits, and not for a cap");
  const readonlyCap = host({}); readonlyCap.workers(2, { readonly: true });
  assert.equal(readonlyCap.run().capOnly, true);
});

test("the journal records both classes and the load figures", () => {
  const h = host({ load1: 12, procs: [busy(1, "other", 1), busy(2, "root", 2)] });
  h.run();
  const e = h.journal().find((x) => x.type === "capacity");
  assert.deepEqual([e.heavy, e.light, e.readonly, e.load1, e.foreign, e.unknown], ["wait", "start", "start", 12, 1, 2]);
  assert.match(e.note, /^heavy wait, light start, readonly start, cap 2$/);
});

// --- calibration -------------------------------------------------------------------------------------------------------
const ago = (minutes) => new Date(Date.now() - minutes * 60e3).toISOString();
const saved = (extra = {}) => ({ foreignRepair: ago(500), suiteMax: 5, readonlyMax: 2, quietSince: ago(90), roQuietSince: ago(90), history: [], ...extra });

test("calibration: foreign load and load between the two limits hold a heavy start but never lower or raise the cap", () => {
  for (const options of [{ load1: 9, procs: [busy(1, "other", 5)] }, { load1: 14 }]) {
    const h = host(options); h.workers(5); h.setState(saved());
    const v = h.run();
    assert.equal(v.heavy, "wait"); assert.equal(v.caps.suite, 5, JSON.stringify(options));
    assert.ok(Date.now() - Date.parse(h.state().quietSince) < 60e3, "the quiet time starts again");
    assert.ok(!h.journal().some((e) => e.type === "decision"));
  }
});

test("calibration: past the light limit the cap falls, and the recorded reason names the overload only", () => {
  const h = host({ load1: 19, procs: [busy(1, "other", 5)] }); h.workers(5); h.setState(saved());
  assert.equal(h.run().caps.suite, 4);
  assert.equal(h.state().history.at(-1).why, "cpu pressure load 19");
});

// The history the old code wrote on the reproduced host: three steps, foreign load alone.
const down = (suiteMax, why, minutes = 100) => ({ ts: ago(minutes), dir: "down", suiteMax, why });
const up = (suiteMax, minutes = 200) => ({ ts: ago(minutes), dir: "up", suiteMax, why: "quiet 30 min at cap" });
const BUG = [up(5), down(4, "foreign load ~6.6"), down(3, "foreign load ~7.3"), down(2, "foreign load ~6.6")];

test("update: a cap lowered for foreign load alone comes back on the first run, once, and is journaled", () => {
  const h = host({});
  h.setState({ suiteMax: 2, readonlyMax: 2, quietSince: ago(1), history: BUG });   // a state of the old version: no foreignRepair
  assert.equal(h.run().caps.suite, 5);
  const decisions = () => h.journal().filter((e) => e.type === "decision");
  assert.match(decisions()[0].note, /capacity suiteMax restored → 5, was 2 \(3 earlier step-down\(s\) had only foreign load/);
  assert.equal(h.state().history.at(-1).dir, "restore");
  assert.equal(h.run().caps.suite, 5);
  assert.equal(decisions().length, 1);
});

test("update: what the project set by hand and steps with a real reason stay", () => {
  const caps = (history, suiteMax, options = {}) => repairCaps({ suiteMax, history }, { step: 1, max: 12, ...options })?.suiteMax ?? suiteMax;
  assert.equal(caps(BUG, 2), 5);
  assert.equal(caps([up(5), down(4, "memory 3.0 GB available; foreign load ~6.6"), down(3, "foreign load ~7.3")], 3), 4, "a step with a second reason stays");
  assert.equal(caps([up(5), down(4, "gate queue 4"), down(3, "2 load timeouts in 30 min")], 3), 3);
  assert.equal(caps([...BUG, { ts: ago(50), dir: "set", suiteMax: 1, why: "set by Alex: one at a time" }], 1), 1, "set by hand after the steps");
  assert.equal(caps([...BUG, { ts: ago(50), dir: "set", suiteMax: 6, why: "set by Alex" }, down(5, "foreign load ~4.0")], 5), 6, "back to the hand-set cap, not beyond");
  assert.equal(caps([...BUG, up(3), up(4)], 4), 5, "never above the cap before the first wrong step");
  assert.equal(caps(BUG, 2, { max: 4 }), 4, "never above the largest configured cap");
  assert.equal(caps([down(4, "foreign load ~6.6")], 4), 5, "the oldest entry: one configured step");
  assert.equal(caps([up(5), { ts: ago(9), dir: "up", readonlyMax: 3, why: "quiet" }, down(4, "foreign load ~6.6")], 4), 5);
  assert.equal(caps([up(2), down(2, "foreign load ~6.6")], 2), 2);
  assert.equal(repairCaps({ suiteMax: 2, history: [] }, { step: 1, max: 12 }), null);
});

const F = "foreign load ~6.6", M = "memory 3.0 GB available";
test("update: a foreign step that was already won back is not given back again", () => {
  const given = (history, suiteMax, options = {}) => repairCaps({ suiteMax, history }, { step: 1, max: 12, ...options });
  assert.equal(given([up(5), down(4, F), up(5), down(4, M), down(3, M)], 3), null, "one real memory step stays");
  assert.equal(given([up(5), down(4, F), up(5), down(4, F), up(5), down(4, M), down(3, M), down(2, M)], 2), null, "three real memory steps stay");
  assert.equal(given([up(5), down(4, F), down(3, M), up(4), up(5)], 5), null);
  assert.equal(given([up(5), down(4, F), down(3, F), up(4), down(3, M)], 3).suiteMax, 4, "two taken, one won back, one still owed");
  // In doubt nothing is restored.
  assert.match(given(BUG, 1).doubt, /changed by hand/);
  assert.match(given([up(5), down(2, F)], 2).doubt, /does not add up/, "a jump the calibration does not make: edited between two steps");
  assert.match(given([down(4, F)], 4, { step: 2 }).doubt, /does not add up/, "the oldest entry with a step above 1: the cap before it is unknown");
  assert.match(given(BUG, 2, { manual: true }).doubt, /manual/);
  assert.match(given(BUG, 2, { max: 2 }).doubt, /maxSuite is 2/);
});

test("update on a host: within maxSuite only, not in manual mode and not over a hand edit, each said once in the journal", () => {
  const first = (capacity, suiteMax = 2) => {
    const h = host({ capacity });
    h.setState({ suiteMax, readonlyMax: 2, quietSince: ago(1), history: BUG });
    const caps = [h.run().caps.suite, h.run().caps.suite];
    return { caps, notes: h.journal().filter((e) => e.type === "decision").map((e) => e.note) };
  };
  assert.deepEqual(first({ suiteWorkersMax: 8, calibration: { maxSuite: 3 } }).caps, [3, 3]);
  for (const [what, r, cap] of [["manual", first({ suiteWorkersMax: 2, calibration: { mode: "manual" } }), 2], ["hand edit", first({}, 1), 1]]) {
    assert.deepEqual(r.caps, [cap, cap], what);
    assert.equal(r.notes.length, 1, what);
    assert.match(r.notes[0], new RegExp(`NOT restored, stays ${cap}: .*node capacity\\.mjs --on local --set-suite <n> --by`), what);
  }
});

test("update: no restore while the host is unmeasured or short of memory; it comes on a later run; --set-suite settles it", () => {
  const old = { suiteMax: 2, readonlyMax: 2, quietSince: ago(1), history: BUG };
  const h = host({ availKb: 1_000_000 }); h.setState(old);
  assert.equal(h.run().caps.suite, 2);
  assert.equal(h.state().foreignRepair, undefined, "still to be done");
  assert.ok(!h.journal().some((e) => e.type === "decision"));
  fs.writeFileSync(path.join(h.dir, "proc", "meminfo"), "MemAvailable: 40000000 kB\n");
  assert.equal(h.run().caps.suite, 5);
  const failed = host({ remote: true }); failed.setState(old);
  sh(path.join(failed.dir, "bin", "ssh"), "exit 255");
  assert.equal(failed.run().caps.suite, 2); assert.equal(failed.state().foreignRepair, undefined);
  const set = host({}); set.setState(old);
  assert.equal(set.run("--set-suite", "2", "--by", "two only").caps.suite, 2);
  assert.equal(set.run().caps.suite, 2);
  assert.deepEqual(set.journal().filter((e) => e.type === "decision").map((e) => e.note), ["capacity suiteMax set → 2 by hand"]);
});

test("update: a set cap stays set, a fresh or reset state restores nothing", () => {
  const h = host({});
  h.setState({ suiteMax: 1, readonlyMax: 2, quietSince: ago(1), history: [...BUG, { ts: ago(50), dir: "set", suiteMax: 1, why: "set by Alex" }] });
  assert.equal(h.run().caps.suite, 1);
  h.setState({ suiteMax: 2, readonlyMax: 2, quietSince: ago(1), history: BUG });
  assert.equal(h.run("--reset").caps.suite, 2);
});

// --- which class a worker is in ------------------------------------------------------------------------------------------
test("start.mjs: a Developer asks for the light verdict, every other writing worker for the heavy one", () => {
  const dir = fs.realpathSync(tempDir("af-capacity-start-"));
  for (const f of ["start.mjs", "cli.mjs", "lib.mjs", "ticket.mjs"]) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "factory.config.json"), JSON.stringify({ project: { name: "demo" }, agents: { runner: "terminal" }, capacity: {} }));
  fs.writeFileSync(path.join(dir, "capacity.mjs"), `console.log(JSON.stringify({ suite: "wait", heavy: "wait", light: "wait", readonly: "wait", reason: "heavy reason", lightReason: "light reason" }));\n`);
  fs.writeFileSync(path.join(dir, "spec.md"), "a spec\n");
  for (const [role, args, waiting, reason] of [["Developer", [], "light", "light reason"], ["Tester", [], "heavy", "heavy reason"], ["Architect", [], "heavy", "heavy reason"], ["Developer helper", [], "heavy", "heavy reason"], ["Architect", ["--readonly"], "readonly", "heavy reason"]]) {
    const r = spawnSync(process.execPath, [path.join(dir, "start.mjs"), `T1 · Worker ${role}`, "spec.md", "t1", ...args], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { started: false, host: "local", waiting, reason }, role);
  }
});

// --- this machine's sh and awk ------------------------------------------------------------------------------------------
// Only that the script runs and samples on a real system (Linux /proc or macOS ps); nothing about which processes run.
test("the probe runs with this system's sh, awk and process table", () => {
  const r = spawnSync("sh", ["-c", probeScript({ project: "demo", ownDirs: [ROOT, "~/front-agent/demo", "/nowhere/it's not there"] })], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /syntax error|awk:/);
  const p = parseProbe(r.stdout);
  assert.equal(p.kv.procs, "ok", r.stdout.slice(0, 500));
  assert.ok(Number(p.kv.threads) >= 1 && Number.isFinite(Number(p.kv.load1)) && Number(p.kv.avail_kb) > 0, r.stdout.slice(0, 500));
  assert.ok(p.own.includes(fs.realpathSync(ROOT)), "own directories are resolved on the host");
});

// --- parsing ---------------------------------------------------------------------------------------------------------
test("parseProbe and attribute: an incomplete probe output says nothing rather than foreign", () => {
  const p = parseProbe("load1=1.2\nproc=garbage\nproc=7 1 2.000 name with = sign\ncwd=7\ngit=\n");
  assert.equal(p.procs.length, 1);
  assert.deepEqual(attribute(p), { own: 0, foreign: 0, unknown: 2 });
});

test("a path part named like the project makes nothing own: only the own directories and linked worktrees do", () => {
  const at = (cwd, repo = `${cwd}/.git`) => attribute({ procs: [{ pid: 100, ppid: 1, cores: 4, name: "cc", cwd, repo }], own: ["/home/f/projects/orca-demo"], tmp: ["/tmp"] });
  const foreign = { own: 0, foreign: 4, unknown: 0 };
  // Projects named api, orca, projects, web and like the user, each in the review's example directory.
  for (const cwd of ["/home/f/projects/shop/api", "/home/f/orca/workspaces/other/t1", "/home/f/projects/other", "/srv/clientx/web/src"]) assert.deepEqual(at(cwd), foreign, cwd);
  assert.deepEqual(at("/workspace/api", ""), { own: 0, foreign: 0, unknown: 4 }, "a container directory says nothing");
});
