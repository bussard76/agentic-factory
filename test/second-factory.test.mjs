// Two projects on one host: the shared gate, the load log, and the files start writes outside the project.
import "./support/safe-env.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyReadGrants } from "../bin/read-grants.mjs";
import { copyTreeAtomic, withLock, writeFileAtomic } from "../bin/safe-write.mjs";
import { addTomlAllowPaths, scanAllowPaths } from "../bin/read-grants.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `af-${name}-`));
const SHIM = path.join(ROOT, "controller/gate");

// --- the gate is the project's own file, called by its own path --------------------------------------------
// A Controller directory as start leaves it: gate, gate.mjs, factory.config.json. `body` replaces gate.mjs when a test needs a fake.
const controllerDir = (home, name, body) => {
  const ctl = path.join(home, `controller-${name}`); fs.mkdirSync(ctl, { recursive: true });
  fs.copyFileSync(SHIM, path.join(ctl, "gate")); fs.chmodSync(path.join(ctl, "gate"), 0o755);
  fs.writeFileSync(path.join(ctl, "gate.mjs"), body ?? fs.readFileSync(path.join(ROOT, "controller/gate.mjs"), "utf8"));
  fs.writeFileSync(path.join(ctl, "factory.config.json"), JSON.stringify({ project: { name }, hosts: { controller: { controllerDir: ctl } } }));
  const repo = path.join(home, name); fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "factory.config.json"), JSON.stringify({ project: { name }, hosts: { controller: { controllerDir: ctl } } }));
  return { ctl, repo, gate: path.join(ctl, "gate") };
};

test("two projects on one host each run their own gate, queue and slots, and neither knows the shared one", () => {
  const home = tmp("gate-own"), sharedDir = path.join(home, ".local/bin"); fs.mkdirSync(sharedDir, { recursive: true });
  // What an older factory left in the shared place.
  fs.writeFileSync(path.join(sharedDir, "gate"), "#!/bin/sh\nexec node \"$HOME/.local/bin/gate.mjs\" \"$@\"\n", { mode: 0o755 });
  fs.writeFileSync(path.join(sharedDir, "gate.mjs"), `console.log("SHARED OLD GATE"); process.exit(0);\n`);
  const a = controllerDir(home, "alpha"), b = controllerDir(home, "beta");
  const run = (p, cwd, ...cmd) => spawnSync(p.gate, cmd, { cwd, encoding: "utf8", env: { ...process.env, HOME: home, TMPDIR: path.join(home, "tmp") } });
  fs.mkdirSync(path.join(home, "tmp"));
  let r = run(a, a.repo, "sh", "-c", "echo RAN; exit 3"); assert.equal(r.status, 3); assert.match(r.stdout, /RAN/); assert.doesNotMatch(r.stdout, /SHARED/);
  assert.equal(run(b, b.repo, "sh", "-c", "exit 4").status, 4);
  assert.deepEqual(fs.readdirSync(path.join(home, "tmp")).sort(), ["alpha-gate-unit", "beta-gate-unit"], "a queue each");
  // slots come from the project's own directory
  fs.writeFileSync(path.join(a.ctl, "gate-slots.json"), JSON.stringify({ unit: 1, e2e: 1 }));
  assert.equal(run(a, a.repo, "true").status, 0);
  // another project's worktree is refused, nothing runs
  r = run(a, b.repo, "touch", path.join(home, "ran")); assert.equal(r.status, 1); assert.match(r.stderr, /gate of the project alpha.*worktree of beta/); assert.equal(fs.existsSync(path.join(home, "ran")), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a config in the worktree being judged cannot choose the gate: not exit 0, not a loop", () => {
  const home = tmp("gate-worktree"), a = controllerDir(home, "alpha");
  const evil = path.join(home, "evil"); fs.mkdirSync(evil);
  fs.writeFileSync(path.join(evil, "gate.mjs"), "process.exit(0);\n");
  // the branch's own config names a Controller directory with a gate that always passes, and the directory of the old shared files
  for (const dir of [evil, path.join(home, ".local/bin")]) {
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "gate.mjs"), "process.exit(0);\n");
    fs.writeFileSync(path.join(a.repo, "factory.config.json"), JSON.stringify({ project: { name: "alpha" }, hosts: { controller: { controllerDir: dir } } }));
    const r = spawnSync(a.gate, ["false"], { cwd: a.repo, encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 20000 });
    assert.equal(r.status, 1, `controllerDir ${dir}: the gate ran \`false\` and failed`);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test("a gate call that sits in the gate shim while it is replaced in place never ends with 0 without running", async () => {
  const home = tmp("gate-race"), a = controllerDir(home, "alpha", `process.exit(7);\n`);
  // A dirname that is slow: the shim runs it inside its body, so the call certainly sits in the shim while the file is replaced.
  const fake = path.join(home, "fakebin"); fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, "dirname"), `#!/bin/sh\n: > ${JSON.stringify(path.join(home, "entered"))}\nsleep 1.5\nexec /usr/bin/dirname "$@"\n`, { mode: 0o755 });
  const child = spawn(a.gate, ["anything"], { cwd: a.repo, env: { ...process.env, HOME: home, PATH: `${fake}:${process.env.PATH}` }, stdio: ["ignore", "ignore", "inherit"] });
  const done = new Promise((r) => child.on("exit", (code) => r(code)));
  for (let i = 0; i < 200 && !fs.existsSync(path.join(home, "entered")); i++) await new Promise((r) => setTimeout(r, 50));
  // what start does to the Controller directory on every run: copy the bundle's file over the old one, in place
  const before = fs.statSync(a.gate).ino; fs.writeFileSync(a.gate, "#!/usr/bin/env bash\nexit 0\n");
  assert.equal(fs.statSync(a.gate).ino, before, "the same inode, other content");
  assert.equal(await done, 7, "the project's gate ran and its status came back");
  fs.rmSync(home, { recursive: true, force: true });
});

test("the gate shim fails with a message when it cannot run the gate, and the command does not run", () => {
  const home = tmp("gate-fail"), a = controllerDir(home, "alpha"), marker = path.join(home, "ran");
  fs.rmSync(path.join(a.ctl, "gate.mjs"));
  let r = spawnSync(a.gate, ["touch", marker], { cwd: a.repo, encoding: "utf8" }); assert.equal(r.status, 1); assert.match(r.stderr, /no gate\.mjs next to/);
  fs.copyFileSync(path.join(ROOT, "controller/gate.mjs"), path.join(a.ctl, "gate.mjs")); fs.writeFileSync(path.join(a.ctl, "factory.config.json"), "{ not json");
  r = spawnSync(a.gate, ["touch", marker], { cwd: a.repo, encoding: "utf8" }); assert.equal(r.status, 1); assert.match(r.stderr, /cannot read/);
  fs.writeFileSync(path.join(a.ctl, "factory.config.json"), JSON.stringify({ project: { name: "alpha" } }));
  r = spawnSync("/bin/bash", [a.gate, "x"], { cwd: a.repo, encoding: "utf8", env: { HOME: home, PATH: "/nonexistent" } }); assert.notEqual(r.status, 0);
  r = spawnSync(a.gate, ["/no/such/program"], { cwd: a.repo, encoding: "utf8" }); assert.equal(r.status, 1);
  assert.equal(spawnSync(a.gate, [], { cwd: a.repo, encoding: "utf8" }).status, 2);
  assert.equal(fs.existsSync(marker), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("the callers use the project's own gate by an absolute path from its own configuration", () => {
  const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
  for (const f of ["controller/wave.mjs", "controller/integ-wave.sh", "controller/templates/mkspec.mjs", "controller/CONTROLLER.md", "controller/runscript.mjs"]) assert.doesNotMatch(src(f), /\.local\/bin\/gate/, `${f} does not name the shared gate`);
  assert.match(src("controller/wave.mjs"), /GATE: `\$\{CONTROLLER_HOME\.replace/);
  assert.match(src("controller/templates/mkspec.mjs"), /\{\{CONTROLLER_DIR\}\}\/gate bash -c/);
  // the wave script never guesses a gate on the PATH or in ~/.local/bin: without GATE it stops
  const dir = tmp("wave-gate"); fs.copyFileSync(path.join(ROOT, "controller/integ-wave.sh"), path.join(dir, "integ-wave.sh"));
  const r = spawnSync("bash", [path.join(dir, "integ-wave.sh"), "t", "s", "origin/x"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir } });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /is refused: not an absolute path/);
  fs.rmSync(dir, { recursive: true, force: true });
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

test("stallwatch: a worker in workers.json is watched wherever its worktree is, others are ignored with a notice, and with none of its own there is nothing to watch", () => {
  const run = (workersJson, terminals) => {
    const dir = tmp("stall-layout");
    for (const f of ["stallwatch.mjs", "cli.mjs", "lib.mjs"]) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(dir, f));
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
  // this project has no worker running, other projects do: nothing is read, nothing is reported, nothing reaches the journal
  r = run(null, [t("a", "/elsewhere/p/t1"), t("b", "/elsewhere/q/t1")]);
  assert.deepEqual(r.reads, []); assert.doesNotMatch(r.out, /IDLE|GONE|CAPACITY/);
  // a stale workers.json entry (its terminal is gone) does not make the others this project's
  r = run({ t1: { name: "T1 · Worker Developer", host: "local", terminal: "gone" } }, [t("a", "/elsewhere/q/t1")]);
  assert.deepEqual(r.reads, []);
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
  // a quoted key is the same key: no second one
  const q = addTomlAllowPaths(`"allow_paths" = ["/a"]\n`, ["/b"]); assert.equal(q.text, `"allow_paths" = ["/a", "/b"]\n`);
  assert.throws(() => addTomlAllowPaths(`allow_paths = ["/a"]\n'allow_paths' = ["/b"]\n`, ["/c"]), /twice/);
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

// --- last review: files that are run or read while start writes them; no bare gate anywhere ---------------
test("copyTreeAtomic never shows a reader an empty or half file, keeps modes, and leaves unchanged files alone", async () => {
  const dir = tmp("atomic-tree"), src = path.join(dir, "src"), dst = path.join(dir, "dst");
  fs.mkdirSync(path.join(src, "sub"), { recursive: true }); fs.mkdirSync(dst);
  const big = (c) => c.repeat(3_000_000);
  fs.writeFileSync(path.join(src, "gate.mjs"), big("a")); fs.writeFileSync(path.join(src, "run.sh"), "#!/bin/sh\n", { mode: 0o755 }); fs.writeFileSync(path.join(src, "sub/bin.dat"), Buffer.from([0, 255, 1, 2]));
  assert.deepEqual(copyTreeAtomic(src, dst).sort(), [path.join(dst, "gate.mjs"), path.join(dst, "run.sh"), path.join(dst, "sub/bin.dat")].sort());
  assert.equal(fs.statSync(path.join(dst, "run.sh")).mode & 0o777, 0o755); assert.deepEqual([...fs.readFileSync(path.join(dst, "sub/bin.dat"))], [0, 255, 1, 2]);
  const ino = fs.statSync(path.join(dst, "run.sh")).ino; assert.deepEqual(copyTreeAtomic(src, dst), [], "nothing changed, nothing written"); assert.equal(fs.statSync(path.join(dst, "run.sh")).ino, ino);
  fs.writeFileSync(path.join(dst, "state.json"), "{}");   // a file without a source stays
  // A reader that looks at the file all the time while it is replaced again and again.
  const reader = path.join(dir, "reader.mjs");
  fs.writeFileSync(reader, `import fs from "node:fs";\nconst f = ${JSON.stringify(path.join(dst, "gate.mjs"))}; const bad = new Set(); const end = Date.now() + 2500;\nwhile (Date.now() < end) { try { const n = fs.readFileSync(f).length; if (n !== 3000000) bad.add(n); } catch (e) { bad.add(e.code); } }\nconsole.log(JSON.stringify([...bad]));\n`);
  const out = new Promise((r) => { let s = ""; const c = spawn("node", [reader], { stdio: ["ignore", "pipe", "inherit"] }); c.stdout.on("data", (d) => (s += d)); c.on("exit", () => r(s)); });
  await new Promise((r) => setTimeout(r, 300));
  for (let i = 0; i < 12; i++) { fs.writeFileSync(path.join(src, "gate.mjs"), big(i % 2 ? "a" : "b")); copyTreeAtomic(src, dst); }
  assert.equal((await out).trim(), "[]", "every read saw a whole file");
  assert.ok(fs.existsSync(path.join(dst, "state.json")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("no spec, template or doc tells an agent to run a bare gate", () => {
  const roots = ["templates", "controller", "front-agent", "standard", "docs", "START.md", "README.md", "server"];
  const skip = (f) => /^docs\/(reviews|decisions|learnings)/.test(f) || /node_modules|\.test\./.test(f) || f === "docs/improvement.md";
  const files = []; const walk = (p) => { const full = path.join(ROOT, p); if (!fs.existsSync(full)) return; if (fs.statSync(full).isDirectory()) fs.readdirSync(full).forEach((e) => walk(path.join(p, e))); else if (/\.(md|mjs|sh|json|txt)$/.test(p) && !skip(p)) files.push(p); };
  roots.forEach(walk);
  // `gate bash -c …` or `gate <command>` not reached through a path, and "through `gate`" (or über `gate`): all of it runs whatever `gate` the PATH finds
  const bare = [/(^|[\s'"`(])gate (bash|sh|node|pnpm|npm|yarn|npx)\b/, /(through|via|über) ['"`]gate['"`]/i];
  const hits = [];
  for (const f of files) fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").forEach((line, i) => { if (bare.some((re) => re.test(line))) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`); });
  assert.deepEqual(hits, [], "name the project's gate by its path ({{CONTROLLER_DIR}}/gate)");
  // and the specs the Controller renders
  const spec = fs.readFileSync(path.join(ROOT, "controller/templates/mkspec.mjs"), "utf8");
  assert.match(spec, /\(through '\{\{CONTROLLER_DIR\}\}\/gate'\)/);
});
