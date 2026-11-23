// Two projects on one host: the shared gate, the load log, and the files start writes outside the project.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installGate } from "../bin/gate-install.mjs";
import { applyReadGrants } from "../bin/read-grants.mjs";
import { writeFileAtomic } from "../bin/safe-write.mjs";

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
  // Outside any project: the old fallbacks, a gate.mjs next to the shim, then ~/controller.
  fs.mkdirSync(path.join(home, "controller")); fs.writeFileSync(path.join(home, "controller/gate.mjs"), `console.log("fallback");\n`);
  assert.equal(run(home).stdout.trim(), "fallback");
  fs.rmSync(home, { recursive: true, force: true });
});

test("the load log tags every line with its project, from start's FACTORY_PROJECT or from its own Controller directory", () => {
  const home = tmp("loadlog"); fs.mkdirSync(path.join(home, "controller-one"));
  fs.writeFileSync(path.join(home, "controller-one/factory.config.json"), JSON.stringify({ project: { name: "one" } }));
  fs.copyFileSync(path.join(ROOT, "controller/loadlog.sh"), path.join(home, "controller-one/loadlog.sh"));
  // Another project's file in the old place must not decide the name.
  fs.mkdirSync(path.join(home, "controller")); fs.writeFileSync(path.join(home, "controller/factory.config.json"), JSON.stringify({ project: { name: "other" } }));
  const run = (env) => { spawnSync("bash", [path.join(home, "controller-one/loadlog.sh")], { cwd: "/", timeout: 3000, killSignal: "SIGKILL", env: { ...process.env, HOME: home, ...env } }); const l = fs.readFileSync(path.join(home, "load.log"), "utf8").trim().split("\n"); fs.rmSync(path.join(home, "load.log")); return l[0]; };
  assert.match(run({}), /gatewaiters=\d+ project=one$/);
  assert.match(run({ FACTORY_PROJECT: "named" }), / project=named$/);
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
