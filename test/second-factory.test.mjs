// Two projects on one host: the shared gate, the load log, and the files start writes outside the project.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gateState, installGate, remoteGateScript } from "../bin/gate-install.mjs";
import { applyReadGrants } from "../bin/read-grants.mjs";
import { withLock, writeFileAtomic } from "../bin/safe-write.mjs";
import { addTomlAllowPaths, scanAllowPaths } from "../bin/read-grants.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `af-${name}-`));
const SHIM = path.join(ROOT, "controller/gate");

test("the shared gate is installed only when it differs, atomically, and never over a newer dispatcher", () => {
  const home = tmp("gate-home"), dst = path.join(home, ".local/bin/gate");
  let r = installGate(SHIM, home);
  assert.equal(r.changed, true); assert.equal(fs.statSync(dst).mode & 0o777, 0o755); assert.equal(fs.readFileSync(dst, "utf8"), fs.readFileSync(SHIM, "utf8"));
  const before = fs.statSync(dst);
  r = installGate(SHIM, home);
  assert.equal(r.changed, false, "same content: nothing is written");
  assert.equal(fs.statSync(dst).ino, before.ino); assert.equal(fs.statSync(dst).mtimeMs, before.mtimeMs);
  // The shim of an older factory (no number) is replaced; a higher number from a newer factory stays.
  fs.writeFileSync(dst, "#!/bin/sh\nexec node \"$HOME/.local/bin/gate.mjs\" \"$@\"\n", { mode: 0o755 });
  assert.equal(installGate(SHIM, home).changed, true); assert.equal(fs.readFileSync(dst, "utf8"), fs.readFileSync(SHIM, "utf8"));
  const newer = "#!/bin/sh\n# gate-shim: 99\nexit 0\n"; fs.writeFileSync(dst, newer, { mode: 0o755 });
  r = installGate(SHIM, home);
  assert.equal(r.kept, true); assert.equal(fs.readFileSync(dst, "utf8"), newer); assert.match(r.message, /newer dispatcher/);
  assert.deepEqual(fs.readdirSync(path.dirname(dst)).filter((f) => f.endsWith(".tmp")), [], "no temporary file is left");
  fs.rmSync(home, { recursive: true, force: true });
});

test("the shared gate runs the gate.mjs of the project it is called in", () => {
  const home = tmp("gate-two");
  installGate(SHIM, home);
  const gate = path.join(home, ".local/bin/gate");
  const project = (name, dirName) => {
    const repo = path.join(home, name, "worktree/sub"); fs.mkdirSync(repo, { recursive: true });
    const ctl = path.join(home, dirName); fs.mkdirSync(ctl);
    fs.writeFileSync(path.join(ctl, "gate.mjs"), `console.log("gate of ${name}", process.argv.slice(2).join(" "));\n`);
    fs.writeFileSync(path.join(home, name, "factory.config.json"), JSON.stringify({ project: { name }, hosts: { controller: { controllerDir: `~/${dirName}` } } }));
    return repo;
  };
  const a = project("alpha", "controller-alpha"), b = project("beta", "controller-beta");
  const run = (cwd, env = {}) => spawnSync(gate, ["x", "y"], { cwd, encoding: "utf8", env: { ...process.env, HOME: home, ...env } });
  assert.equal(run(a).stdout.trim(), "gate of alpha x y");
  assert.equal(run(b).stdout.trim(), "gate of beta x y");
  assert.equal(run(home, { FACTORY_CONFIG: path.join(home, "beta/factory.config.json") }).stdout.trim(), "gate of beta x y", "FACTORY_CONFIG wins over the working directory");
  // Outside any project it never guesses, not even from a stale gate.mjs or ~/controller: a failure with a message, nothing run.
  fs.mkdirSync(path.join(home, "controller")); fs.writeFileSync(path.join(home, "controller/gate.mjs"), `console.log("fallback");\n`);
  fs.writeFileSync(path.join(home, ".local/bin/gate.mjs"), `console.log("stale");\n`);
  const none = run(home); assert.equal(none.status, 1); assert.equal(none.stdout, ""); assert.match(none.stderr, /cannot tell which project/);
  // A project whose Controller directory has no gate.mjs.
  fs.mkdirSync(path.join(home, "gone")); fs.writeFileSync(path.join(home, "gone/factory.config.json"), JSON.stringify({ project: { name: "gone" }, hosts: { controller: { controllerDir: "~/nowhere" } } }));
  const missing = run(path.join(home, "gone")); assert.equal(missing.status, 1); assert.match(missing.stderr, /no gate\.mjs for the project gone/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("the load log tags every line with its project, from start's FACTORY_PROJECT or from its own Controller directory", () => {
  const home = tmp("loadlog"); fs.mkdirSync(path.join(home, "controller-one"));
  fs.writeFileSync(path.join(home, "controller-one/factory.config.json"), JSON.stringify({ project: { name: "one" } }));
  fs.copyFileSync(path.join(ROOT, "controller/loadlog.sh"), path.join(home, "controller-one/loadlog.sh"));
  // Another project's file in the old place must not decide the name.
  fs.mkdirSync(path.join(home, "controller")); fs.writeFileSync(path.join(home, "controller/factory.config.json"), JSON.stringify({ project: { name: "other" } }));
  const run = (env, ...arg) => { spawnSync("bash", [path.join(home, "controller-one/loadlog.sh"), ...arg], { cwd: "/", timeout: 3000, killSignal: "SIGKILL", env: { ...process.env, HOME: home, ...env } }); const l = fs.readFileSync(path.join(home, "load.log"), "utf8").trim().split("\n"); fs.rmSync(path.join(home, "load.log")); return l[0]; };
  assert.match(run({}), /gatewaiters=\d+ project=one$/);
  assert.match(run({ FACTORY_PROJECT: "named" }), / project=named$/);
  assert.match(run({ FACTORY_PROJECT: "env" }, "arg"), / project=arg$/, "the argument start passes wins");
  fs.rmSync(home, { recursive: true, force: true });
});

test("the read grant writes a live config whole or not at all, and leaves it alone when nothing changes", () => {
  const home = tmp("grants"), file = path.join(home, ".lean-ctx/config.toml");
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, `a = 1\nallow_paths = [\n    "/one",\n]\n[t]\nb = 2\n`, { mode: 0o640 });
  const ctl = path.join(home, "ctl");
  let lines = applyReadGrants({ home, paths: ["/one"], controllerDir: ctl });
  assert.match(lines[0], /already has them/);
  const s0 = fs.statSync(file); lines = applyReadGrants({ home, paths: ["/one"], controllerDir: ctl });
  assert.equal(fs.statSync(file).ino, s0.ino); assert.equal(fs.statSync(file).mtimeMs, s0.mtimeMs, "unchanged: not rewritten");
  lines = applyReadGrants({ home, paths: ["/one", "/two"], controllerDir: ctl });
  assert.match(lines[0], /allow_paths \+= \/two/);
  assert.equal(fs.readFileSync(file, "utf8"), `a = 1\nallow_paths = [\n    "/one",\n    "/two",\n]\n[t]\nb = 2\n`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640, "the file keeps its mode");
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp")), []);
  // A symlinked config (a dotfiles manager) stays a link; its target is written.
  const real = path.join(home, "dotfiles-config.toml"); fs.renameSync(file, real); fs.symlinkSync(real, file);
  applyReadGrants({ home, paths: ["/one", "/two", "/three"], controllerDir: ctl });
  assert.ok(fs.lstatSync(file).isSymbolicLink()); assert.match(fs.readFileSync(real, "utf8"), /"\/three"/);
  // allow_paths that is not a list is not extended: a second key would break the file.
  fs.rmSync(file); fs.writeFileSync(file, `allow_paths = "/x"\n`);
  lines = applyReadGrants({ home, paths: ["/y"], controllerDir: ctl });
  assert.match(lines[0], /could not write the grant/); assert.equal(fs.readFileSync(file, "utf8"), `allow_paths = "/x"\n`);
  fs.rmSync(home, { recursive: true, force: true });
});

test("writeFileAtomic does not touch a file that already has the content and mode", () => {
  const dir = tmp("atomic"), f = path.join(dir, "x");
  assert.equal(writeFileAtomic(f, "a\n", 0o644), true);
  const s = fs.statSync(f);
  assert.equal(writeFileAtomic(f, "a\n", 0o644), false); assert.equal(fs.statSync(f).ino, s.ino);
  assert.equal(writeFileAtomic(f, "b\n", 0o644), true); assert.equal(fs.readFileSync(f, "utf8"), "b\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- review of PR 59: probes that were run in throwaway homes ---------------------------------------------
const project = (home, name, dirName, gateBody) => {
  const repo = path.join(home, name); fs.mkdirSync(repo, { recursive: true });
  const ctl = path.join(home, dirName); fs.mkdirSync(ctl, { recursive: true });
  fs.writeFileSync(path.join(ctl, "gate.mjs"), gateBody);
  fs.writeFileSync(path.join(repo, "factory.config.json"), JSON.stringify({ project: { name }, hosts: { controller: { controllerDir: `~/${dirName}` } } }));
  return { repo, ctl };
};

test("a gate call that sits in the dispatcher while the file is overwritten in place never ends with 0 without running", async () => {
  const home = tmp("gate-race"); installGate(SHIM, home);
  const gate = path.join(home, ".local/bin/gate"), p = project(home, "alpha", "ctl-alpha", `process.exit(7);\n`);
  // A node that is slow only for the dispatcher's own lookup (node -e), so the call surely sits inside the dispatcher.
  const fake = path.join(home, "fakebin"); fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, "node"), `#!/bin/sh\nif [ "$1" = -e ]; then : > ${JSON.stringify(path.join(home, "entered"))}; sleep 1.5; fi\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  const child = spawn(gate, ["anything"], { cwd: p.repo, env: { ...process.env, HOME: home, PATH: `${fake}:${process.env.PATH}` }, stdio: ["ignore", "ignore", "inherit"] });
  const done = new Promise((r) => child.on("exit", (code) => r(code)));
  for (let i = 0; i < 200 && !fs.existsSync(path.join(home, "entered")); i++) await new Promise((r) => setTimeout(r, 50));   // the call is inside the dispatcher
  // What an older factory's start does: copyFileSync onto the same inode, with a shorter file.
  const old = "#!/usr/bin/env bash\nexec node \"$HOME/.local/bin/gate.mjs\" \"$@\"\n";
  const before = fs.statSync(gate).ino; fs.copyFileSync(writeTmp(home, old), gate);
  assert.equal(fs.statSync(gate).ino, before, "the same inode, shorter content");
  assert.equal(await done, 7, "the project's gate ran and its status came back");
  fs.rmSync(home, { recursive: true, force: true });
});
const writeTmp = (dir, text) => { const f = path.join(dir, `tmp-${Math.random().toString(36).slice(2)}`); fs.writeFileSync(f, text); return f; };

test("every way the dispatcher can fail is a non-zero exit with a message, and the command does not run", () => {
  const home = tmp("gate-fail"); installGate(SHIM, home);
  const gate = path.join(home, ".local/bin/gate"), marker = path.join(home, "ran");
  const bad = path.join(home, "bad.json"); fs.writeFileSync(bad, "{ not json");
  const run = (env, cwd = home) => spawnSync(gate, ["touch", marker], { cwd, encoding: "utf8", env: { ...process.env, HOME: home, ...env } });
  for (const [name, r] of [["no project", run({})], ["unreadable config", run({ FACTORY_CONFIG: bad })], ["missing config", run({ FACTORY_CONFIG: path.join(home, "nope.json") })]]) { assert.equal(r.status, 1, name); assert.match(r.stderr, /^gate: /m, name); }
  // node cannot be found at all
  const r = spawnSync("/bin/bash", [gate, "x"], { cwd: home, encoding: "utf8", env: { HOME: home, PATH: "/nonexistent" } });
  assert.notEqual(r.status, 0); assert.equal(fs.existsSync(marker), false);
  // a gate.mjs that cannot run the command: the gate says so and fails (gate.mjs: process.exit(r.status ?? 1))
  const p = project(home, "beta", "ctl-beta", fs.readFileSync(path.join(ROOT, "controller/gate.mjs"), "utf8"));
  const missing = spawnSync(gate, ["/no/such/program"], { cwd: p.repo, encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(missing.status, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test("an older factory's shim that was put back is forwarded to the project's gate, with a loud warning, and never exits 0 on its own", () => {
  const home = tmp("gate-forward"); installGate(SHIM, home, path.join(ROOT, "controller/gate-forward.mjs"));
  // The shim of factory versions before the dispatcher.
  const oldShim = path.join(home, ".local/bin/gate");
  fs.writeFileSync(oldShim, `#!/usr/bin/env bash\nhere="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"\nimpl="$here/gate.mjs"; [ -f "$impl" ] || impl="$HOME/controller/gate.mjs"\nexec node "$impl" "$@"\n`, { mode: 0o755 });
  const p = project(home, "alpha", "ctl-alpha", `console.log("alpha's gate", process.argv.slice(2).join(" ")); process.exit(Number(process.argv[2] ?? 0));\n`);
  const run = (cwd, ...a) => spawnSync(oldShim, a, { cwd, encoding: "utf8", env: { ...process.env, HOME: home } });
  let r = run(p.repo, "0"); assert.equal(r.status, 0); assert.match(r.stdout, /alpha's gate 0/); assert.match(r.stderr, /WARNING: this call came through an older factory/);
  assert.equal(run(p.repo, "3").status, 3, "the gate's own status");
  r = run(home, "0"); assert.equal(r.status, 1, "no project: a failure"); assert.doesNotMatch(r.stdout, /alpha/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("doctor and status can tell which gate is installed", () => {
  const home = tmp("gate-state");
  assert.equal(gateState(home, SHIM).state, "missing");
  fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".local/bin/gate"), "#!/usr/bin/env bash\nexec node \"$HOME/.local/bin/gate.mjs\" \"$@\"\n");
  assert.equal(gateState(home, SHIM).state, "older");
  fs.writeFileSync(path.join(home, ".local/bin/gate"), "#!/usr/bin/env bash\n# gate-shim: 1\n"); assert.equal(gateState(home, SHIM).state, "outdated");
  installGate(SHIM, home); assert.deepEqual([gateState(home, SHIM).state, gateState(home, SHIM).number > 1], ["dispatcher", true]);
  // a file that only mentions the marker somewhere is not a dispatcher
  fs.writeFileSync(path.join(home, ".local/bin/gate"), "#!/usr/bin/env bash\necho hi\n# gate-shim: 99\n"); assert.equal(gateState(home, SHIM).state, "older");
  assert.equal(installGate(SHIM, home).replaced, true, "and it is replaced, not kept as 'newer'");
  fs.rmSync(home, { recursive: true, force: true });
});

test("the remote command prints ok only when the gate files are in place or deliberately kept", { skip: process.getuid?.() === 0 }, () => {
  const home = tmp("remote-gate"), rd = path.join(home, "ctl"); fs.mkdirSync(path.join(rd, "skills"), { recursive: true });
  fs.copyFileSync(SHIM, path.join(rd, "gate")); fs.copyFileSync(path.join(ROOT, "controller/gate-forward.mjs"), path.join(rd, "gate-forward.mjs"));
  fs.writeFileSync(path.join(rd, "loadlog.sh"), "#!/bin/sh\nexit 0\n");
  const run = () => spawnSync("sh", ["-c", remoteGateScript(rd, path.join(rd, "loadlog.sh"), "'p'")], { encoding: "utf8", env: { ...process.env, HOME: home } });
  let r = run(); assert.equal(r.stdout.trim(), "ok", r.stderr); assert.equal(fs.readFileSync(path.join(home, ".local/bin/gate"), "utf8"), fs.readFileSync(SHIM, "utf8"));
  assert.ok(fs.existsSync(path.join(home, ".local/bin/gate.mjs")));
  // an older shim is replaced; a higher number is kept (and that is fine)
  fs.writeFileSync(path.join(home, ".local/bin/gate"), "#!/bin/sh\nold\n"); assert.equal(run().stdout.trim(), "ok"); assert.equal(fs.readFileSync(path.join(home, ".local/bin/gate"), "utf8"), fs.readFileSync(SHIM, "utf8"));
  fs.writeFileSync(path.join(home, ".local/bin/gate"), "#!/bin/sh\n# gate-shim: 99\n"); assert.equal(run().stdout.trim(), "ok"); assert.match(fs.readFileSync(path.join(home, ".local/bin/gate"), "utf8"), /99/);
  // the install fails (the directory cannot be written, the shim is the old one): no ok, so start fails
  fs.writeFileSync(path.join(home, ".local/bin/gate"), "#!/bin/sh\nold\n"); fs.chmodSync(path.join(home, ".local/bin"), 0o555);
  r = run(); fs.chmodSync(path.join(home, ".local/bin"), 0o755);
  assert.doesNotMatch(r.stdout, /ok/); assert.equal(fs.readFileSync(path.join(home, ".local/bin/gate"), "utf8"), "#!/bin/sh\nold\n");
  fs.rmSync(home, { recursive: true, force: true });
});

test("stallwatch: a worker in workers.json is watched wherever its worktree is, others are ignored with a notice, and when nothing can be told all are watched", () => {
  const run = (workersJson, terminals) => {
    const dir = tmp("stall-layout");
    for (const f of ["stallwatch.mjs", "lib.mjs"]) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, "factory.config.json"), JSON.stringify({ project: { name: "p", mainBranch: "main" }, agents: { runner: "orca" }, commands: {}, hosts: { controller: { host: "local" }, workers: [{ name: "local", kind: "local" }] } }));
    if (workersJson) fs.writeFileSync(path.join(dir, "workers.json"), JSON.stringify(workersJson));
    const log = path.join(dir, "reads.log"), fake = path.join(dir, "fake-orca.mjs");
    fs.writeFileSync(fake, `#!/usr/bin/env node\nimport fs from "node:fs";\nconst a = process.argv.slice(2);\nif (a[1] === "read") fs.appendFileSync(${JSON.stringify(log)}, a[a.indexOf("--terminal") + 1] + "\\n");\nconsole.log(JSON.stringify({ ok: true, result: { terminals: ${JSON.stringify(terminals)}, terminal: { tail: [] } } }));\n`, { mode: 0o755 });
    const r = spawnSync("node", [path.join(dir, "stallwatch.mjs")], { encoding: "utf8", timeout: 3000, env: { ...process.env, FACTORY_CONFIG: path.join(dir, "factory.config.json"), ORCA_CLI_COMMAND: fake } });
    const reads = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
    fs.rmSync(dir, { recursive: true, force: true });
    return { reads, out: r.stdout ?? "" };
  };
  const t = (handle, wt) => ({ handle, title: "T1 · Worker Developer", worktreePath: wt });
  // own worker outside the configured workspace directory (a changed layout), known by its handle
  let r = run({ t1: { name: "T1 · Worker Developer", host: "local", terminal: "mine" } }, [t("mine", "/elsewhere/p/t1"), t("theirs", "/elsewhere/q/t1")]);
  assert.deepEqual(r.reads, ["mine"]); assert.match(r.out, /1 worker terminal\(s\) on local ignored: not this project's/);
  // nothing can be told: watched all, with a notice, instead of watching nothing
  r = run(null, [t("a", "/elsewhere/p/t1"), t("b", "/elsewhere/q/t1")]);
  assert.deepEqual(r.reads.sort(), ["a", "b"]); assert.match(r.out, /none can be told to be this project's/);
  // the default layout: this project's workspace directory by path
  const home = os.homedir();
  r = run(null, [t("own", path.join(home, "orca/workspaces/p/t1")), t("foreign", path.join(home, "orca/workspaces/other/t1"))]);
  assert.deepEqual(r.reads, ["own"]);
});

test("allow_paths: any path is written as a valid TOML string, comments stay, and a file that cannot be read safely is refused", () => {
  const paths = ["/Users/me/[proj]/src", "/w/with \"quote\" and \\backslash", "/w/tab\there", "/w/ünï", "/w/#hash"];
  const base = `# my config\nminimal = true\nallow_paths = [\n    "/x/one", # work\n    '/x/two',\n    # a note\n]  # done\n[shell]\nallow = ["git"]\n`;
  const { text, added } = addTomlAllowPaths(base, paths);
  assert.deepEqual(added, paths);
  for (const keep of [`# my config`, `"/x/one", # work`, `'/x/two',`, `# a note`, `]  # done`, `[shell]\nallow = ["git"]`]) assert.ok(text.includes(keep), keep);
  assert.deepEqual(scanAllowPaths(text).arr.items.map((x) => x.value), ["/x/one", "/x/two", ...paths], "it reads back, brackets and quotes included");
  assert.equal(addTomlAllowPaths(text, paths).added.length, 0);
  // no key yet, one line, empty, no trailing comma
  assert.deepEqual(scanAllowPaths(addTomlAllowPaths(`a = 1\n[t]\nx = 1\n`, paths).text).arr.items.map((x) => x.value), paths);
  for (const start of [`allow_paths = []\n`, `allow_paths = ["/a"]\n`, `allow_paths = [\n  "/a"\n]\n`, `allow_paths = [ "/a", ]\n`]) assert.deepEqual(scanAllowPaths(addTomlAllowPaths(start, ["/b]"]).text).arr.items.map((x) => x.value).slice(-1), ["/b]"], start);
  // refused: nothing is written
  for (const odd of [`allow_paths = "/x"\n`, `allow_paths = ["/a"]\nallow_paths = ["/b"]\n`, `allow_paths = [1, 2]\n`, `allow_paths = ["/a" "/b"]\n`, `allow_paths = ["/a"\n`, `allow_paths = ["\\q"]\n`, `x = """\nunterminated\n`]) assert.throws(() => addTomlAllowPaths(odd, ["/n"]), undefined, odd);
  // a "]" inside another value or a comment is not the end of anything
  assert.deepEqual(scanAllowPaths(`list = ["a]", 'b]'] # ]\nallow_paths = ["/z"]\n`).arr.items.map((x) => x.value), ["/z"]);
});

test("projects.json updates of two starts at the same moment keep both entries", async () => {
  const dir = tmp("lock"), file = path.join(dir, "projects.json");
  const worker = path.join(dir, "w.mjs");
  fs.writeFileSync(worker, `import fs from "node:fs";\nimport { withLock, writeFileAtomic } from ${JSON.stringify(path.join(ROOT, "bin/safe-write.mjs"))};\nconst name = process.argv[2], file = process.argv[3];\nwhile (Date.now() < Number(process.argv[4])) {}\nwithLock(file, () => { let l = []; try { l = JSON.parse(fs.readFileSync(file, "utf8")); } catch {} l = [...l.filter((p) => p.name !== name), { name }]; writeFileAtomic(file, JSON.stringify(l)); });\n`);
  const go = Date.now() + 1500;
  await Promise.all(["a", "b", "c", "d", "e", "f"].map((n) => new Promise((r) => spawn("node", [worker, n, file, String(go)], { stdio: "ignore" }).on("exit", r))));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).map((p) => p.name).sort(), ["a", "b", "c", "d", "e", "f"]);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
