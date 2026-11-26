// cleanup.mjs deletes only with --apply. Without it (or with --dry) it prints an inventory and changes nothing, and exits
// with code 3 when something would have been removed. Throwaway repositories and a fake Orca; no ORCA_* variable reaches a child.
import "./support/safe-env.mjs";
import { tempDir } from "./support/cleanup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["cli.mjs", "cleanup.mjs", "lib.mjs", "ticket.mjs", "journal.mjs", "names.mjs"];

function setup() {
  const dir = fs.realpathSync(tempDir("af-cleanup-apply-"));
  const ctl = path.join(dir, "ctl"), project = path.join(dir, "p"), ws = path.join(dir, "ws"), log = path.join(dir, "calls.log"), fake = path.join(dir, "fake-orca.mjs");
  fs.mkdirSync(ctl); fs.mkdirSync(project);
  for (const f of FILES) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(ctl, f));
  fs.writeFileSync(path.join(ctl, "factory.config.json"), JSON.stringify({ project: { name: "p", mainBranch: "main", humanName: "Alex" }, agents: { runner: "orca" }, commands: {}, capacity: { gate: {} }, hosts: { controller: { host: "local", controllerDir: ctl }, workers: [{ name: "local", kind: "local", projectsDir: dir, workspacesDir: ws, capacity: {} }, { name: "b", kind: "local", projectsDir: dir, workspacesDir: ws, capacity: {} }] } }));
  fs.writeFileSync(path.join(ctl, "workers.json"), "{}");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, a.join(" ") + "\\n");
if (a[0] === "terminal" && a[1] === "list" && fs.existsSync(${JSON.stringify(path.join(dir, "list-fails"))})) { console.log(JSON.stringify({ ok: false })); process.exit(1); }
console.log(JSON.stringify({ ok: true, result: a[0] === "terminal" && a[1] === "list" ? { terminals: [] } : {} }));`);
  fs.chmodSync(fake, 0o755);
  const env = { ...process.env, ORCA_CLI_COMMAND: fake, FACTORY_CONFIG: path.join(ctl, "factory.config.json") };
  for (const k of Object.keys(env)) if (k.startsWith("ORCA_") && k !== "ORCA_CLI_COMMAND") delete env[k];
  const run = (...args) => spawnSync("node", [path.join(ctl, "cleanup.mjs"), ...args], { cwd: ctl, encoding: "utf8", env });
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
  const wt = (n) => path.join(ws, "p", n);
  // origin/main with a .gitignore, and one merged worktree "t1" that holds an ignored file.
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(project, ".gitignore"), ".env\n");
  git("add", "."); git("commit", "-q", "-m", "first");
  const bare = path.join(dir, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  git("remote", "add", "origin", bare); git("push", "-q", "origin", "main"); git("fetch", "-q", "origin");
  git("worktree", "add", "-q", "-b", "agents/t1", wt("t1"), "origin/main");
  fs.writeFileSync(path.join(wt("t1"), ".env"), "SECRET=1\n");
  return { dir, ctl, project, env, run, git, calls, wt, bare, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("without --apply, and with --dry, nothing is removed: an inventory, the ignored files that would be lost, one closing line, exit code 3", () => {
  const h = setup();
  for (const args of [[], ["--dry"]]) {
    const r = h.run(...args);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /would remove t1 \(merged\)/);
    assert.match(r.stdout, /would lose 1 ignored entry that git does not keep: \.env/);
    const last = r.stdout.trim().split("\n").at(-1);
    assert.match(last, /^NOTHING WAS REMOVED OR RELEASED\. To do it, run: node cleanup\.mjs .*--apply\./);
    assert.match(last, /without --apply.*\.factory\/new\/.*exit code 3/);
    assert.ok(fs.existsSync(h.wt("t1")), "the worktree is still there");
    assert.ok(!h.calls().some((c) => /worktree rm|worker-release|terminal close/.test(c)), "no Orca call changes anything");
  }
  assert.ok(fs.existsSync(path.join(h.ctl, "cleanup-pending.json")), "a run without --apply records since when removable work waits");
  assert.ok(!fs.existsSync(path.join(h.ctl, "journal.ndjson")), "no journal entry");
  // --apply wins nothing over --dry: both given means dry.
  assert.equal(h.run("--apply", "--dry").status, 3);
  assert.ok(!h.calls().some((c) => /worktree rm/.test(c)));
  h.done();
});

test("--apply prints the same inventory first, then removes, exits 0 and clears the pending marker", () => {
  const h = setup();
  assert.equal(h.run().status, 3);
  const r = h.run("--apply");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.split("\n");
  const inv = lines.findIndex((l) => /^Inventory/.test(l)), would = lines.findIndex((l) => /would remove t1 \(merged\)/.test(l)), done = lines.findIndex((l) => /^cleanup: removed 1 worktrees/.test(l));
  assert.ok(inv >= 0 && inv < would && would < done, r.stdout);
  assert.match(r.stdout, /would lose 1 ignored entry/);
  assert.equal(h.calls().filter((c) => c.startsWith("worktree rm ")).length, 1, "one removal");
  assert.ok(!fs.existsSync(path.join(h.ctl, "cleanup-pending.json")));
  assert.ok(fs.existsSync(path.join(h.ctl, "journal.ndjson")));
  h.done();
});

test("nothing to remove is exit code 0 without --apply, and says so", () => {
  const h = setup();
  fs.writeFileSync(path.join(h.wt("t1"), "work.txt"), "uncommitted");
  const r = h.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /kept t1: uncommitted or untracked changes/);
  assert.match(r.stdout.trim().split("\n").at(-1), /Nothing was found to remove or release/);
  assert.ok(!fs.existsSync(path.join(h.ctl, "cleanup-pending.json")));
  h.done();
});

test("cleanup never deletes a status-wave branch, whatever the options; it lists the merged ones as left over; agents/ branches still go", () => {
  const h = setup();
  const remote = () => execFileSync("git", ["-C", h.bare, "branch", "--list"], { encoding: "utf8" }).split("\n").map((x) => x.replace(/^[* ]+/, "")).filter(Boolean).sort();
  h.git("push", "-q", "origin", "origin/main:refs/heads/status-wave-1", "origin/main:refs/heads/agents/x");
  h.git("checkout", "-q", "-b", "status-wave-2"); h.git("commit", "-q", "--allow-empty", "-m", "wave 2"); h.git("push", "-q", "origin", "status-wave-2"); h.git("checkout", "-q", "main");
  h.git("fetch", "-q", "origin");
  const dead = spawnSync("node", ["--version"]).pid;
  const states = [null, "b term_wave\n", `local pid:${dead}\n`, `local pid:${process.pid}\n`];   // no wave file, another host, a finished wave, a live one
  for (const handle of states) {
    const file = path.join(h.ctl, "wave-handle.txt");
    if (handle === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, handle);
    for (const args of [["--apply", "--prune-remote"], ["--apply", "--prune-remote", "--pushed"], ["--apply", "--prune-remote", "--all"], ["--prune-remote"], ["--dry", "--prune-remote"]]) {
      const r = h.run(...args);
      assert.ok(remote().includes("status-wave-1") && remote().includes("status-wave-2"), `${args.join(" ")} with wave file ${JSON.stringify(handle)} deleted a status-wave branch`);
      assert.doesNotMatch(r.stdout, /would delete the merged branch origin\/status-wave/);
    }
  }
  assert.ok(!remote().includes("agents/x"), "a merged branch with the prefix is still pruned");
  const r = h.run("--prune-remote");
  assert.match(r.stdout, /left over, not removed by cleanup: origin\/status-wave-1 \(merged into origin\/main\)\. When no wave needs it: git push origin --delete status-wave-1/);
  assert.doesNotMatch(r.stdout, /left over.*status-wave-2/, "an unmerged one is not listed");
  assert.equal(r.stdout.split("\n").filter((l) => /left over.*status-wave-1/.test(l)).length, 1, "listed once");
  h.done();
});

test("cleanup with an empty branch prefix still leaves status-wave branches alone", () => {
  const h = setup();
  const cfgFile = path.join(h.ctl, "factory.config.json"), cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  cfg.project.branchPrefix = ""; fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  h.git("push", "-q", "origin", "origin/main:refs/heads/status-wave-3", "origin/main:refs/heads/other"); h.git("fetch", "-q", "origin");
  assert.equal(h.run("--apply", "--prune-remote").status, 0);
  const remote = execFileSync("git", ["-C", h.bare, "branch", "--list"], { encoding: "utf8" });
  assert.match(remote, /status-wave-3/);
  assert.doesNotMatch(remote, /other/);
  h.done();
});

test("the cleanup call in the Controller's handbook and the coordinator template carries --apply", () => {
  for (const rel of ["controller/CONTROLLER.md", "templates/docs/coordinator.md"]) {
    const calls = [...fs.readFileSync(path.join(ROOT, rel), "utf8").matchAll(/`(node cleanup\.mjs[^`]*)`/g)].map((m) => m[1]);
    assert.ok(calls.length, rel);
    for (const c of calls) assert.match(c, /--apply|--help/, `${rel}: ${c}`);
  }
});

test("F2: a run without --apply says its refs are as of the last fetch, with the time, and --apply fetches first", () => {
  const h = setup();
  const r = h.run();
  assert.match(r.stdout, /Refs as of the last fetch of origin \(local: \d{4}-\d\d-\d\dT[\d:.]+Z\); --apply fetches first\./);
  fs.rmSync(path.join(h.wt("t1"), ".env"));
  fs.writeFileSync(path.join(h.wt("t1"), "work.txt"), "x");   // nothing to remove now
  const none = h.run();
  assert.equal(none.status, 0);
  assert.match(none.stdout.trim().split("\n").at(-1), /Nothing was found to remove or release in the refs of the last fetch of origin; --apply fetches first\./);
  h.done();
});

test("F4: when Orca's terminal list does not answer, the state is unknown, never nothing; the marker stays; exit 3", () => {
  const h = setup();
  assert.equal(h.run().status, 3);
  const marker = path.join(h.ctl, "cleanup-pending.json");
  assert.ok(fs.existsSync(marker));
  fs.writeFileSync(path.join(h.dir, "list-fails"), "");
  const r = h.run();
  assert.equal(r.status, 3, r.stdout + r.stderr);
  const last = r.stdout.trim().split("\n").at(-1);
  assert.match(last, /NOT KNOWN WHETHER ANYTHING WAITS/);
  assert.match(last, /STATE UNKNOWN for local/);
  assert.doesNotMatch(r.stdout, /there is nothing to remove or release/);
  assert.ok(fs.existsSync(marker), "unknown does not clear the signal");
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")).unknown, ["local"], "the marker names the host it could not look at");
  const applied = h.run("--apply");
  assert.equal(applied.status, 3, applied.stdout + applied.stderr);
  assert.match(applied.stdout, /STATE UNKNOWN for local.*Nothing was done there\. Exit code 3\./);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")).unknown, ["local"], "an --apply that could not look leaves the signal for status and doctor");
  fs.rmSync(path.join(h.dir, "list-fails"));
  assert.equal(h.run("--apply").status, 0);
  assert.ok(!fs.existsSync(marker), "a run that can look at every host clears it");
  h.done();
});

test("F5/F6: an unwritable marker does not end the run; --on without a host and a failing inventory do nothing", () => {
  const h = setup();
  fs.mkdirSync(path.join(h.ctl, "cleanup-pending.json"));   // cannot be replaced by a file
  const r = h.run();
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /cleanup-pending\.json could not be updated/);
  assert.match(r.stdout.trim().split("\n").at(-1), /NOTHING WAS REMOVED OR RELEASED/);
  const noHost = h.run("--apply", "--on");
  assert.equal(noHost.status, 2, noHost.stdout + noHost.stderr);
  assert.match(noHost.stderr, /--on needs a host name/);
  assert.ok(!h.calls().some((c) => /worktree rm/.test(c)), "nothing was removed");
  // The inventory run fails (an unknown host): the real run does not start.
  const bad = h.run("--apply", "--on", "nowhere");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /inventory run failed|nowhere/);
  assert.ok(!h.calls().some((c) => /worktree rm/.test(c)));
  // An --apply run ignores the inventory switch in the environment and still clears the marker.
  fs.rmSync(path.join(h.ctl, "cleanup-pending.json"), { recursive: true });
  assert.equal(h.run().status, 3);
  const withVar = spawnSync("node", [path.join(h.ctl, "cleanup.mjs"), "--apply"], { cwd: h.ctl, encoding: "utf8", env: { ...h.env, FACTORY_CLEANUP_PREVIEW: "1" } });
  assert.equal(withVar.status, 0, withVar.stdout + withVar.stderr);
  assert.ok(!fs.existsSync(path.join(h.ctl, "cleanup-pending.json")));
  h.done();
});

test("F4b: a record whose process is gone is counted and printed by a run without --apply", () => {
  const h = setup();
  fs.writeFileSync(path.join(h.wt("t1"), "work.txt"), "x");   // keeps t1, so only the record is pending
  fs.rmSync(path.join(h.wt("t1"), ".env"));
  fs.writeFileSync(path.join(h.ctl, "workers.json"), JSON.stringify({ x: { name: "Old runner", host: "local", pid: spawnSync("node", ["--version"]).pid } }));
  const r = h.run();
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /would forget the record of "Old runner"/);
  h.done();
});
