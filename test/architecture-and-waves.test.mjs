// The architecture mode as a human's choice, the gate's shell form, and closing finished wave terminals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLI = path.join(ROOT, "bin/agentic-factory.mjs");

function initProject(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-arch-"));
  const home = path.join(dir, "home"), project = path.join(dir, "p");
  fs.mkdirSync(home); fs.mkdirSync(project);
  const env = { ...process.env, HOME: home, FACTORY_SKIP_ORCA: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") };
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: project, env, encoding: "utf8" });
  git("config", "--global", "user.name", "t"); git("config", "--global", "user.email", "t@example.com");
  git("init", "-q", "-b", "main"); git("commit", "-q", "--allow-empty", "-m", "Initial");
  const answers = path.join(dir, "answers.json");
  fs.writeFileSync(answers, JSON.stringify({ "architecture.mode": mode, "rules.confirm": "yes" }));
  const r = spawnSync("node", [CLI, "init", "--yes", "--answers", answers], { cwd: project, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const read = (f) => fs.readFileSync(path.join(project, f), "utf8");
  return { dir, project, env, read, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("choosing an Architect: the loop, the protocol and the specs maintain ARCHITECTURE.md, and no empty file is written", () => {
  const p = initProject("architect");
  assert.equal(JSON.parse(p.read("factory.config.json")).architecture.mode, "architect");
  assert.equal(fs.existsSync(path.join(p.project, "ARCHITECTURE.md")), false, "the Architect writes it from the code");
  assert.match(p.read(".factory/controller/CONTROLLER.md"), /Architecture baseline:[\s\S]*mkspec steward/);
  assert.match(p.read("docs/architect-protocol.md"), /## Keeping ARCHITECTURE\.md current[\s\S]*## Baseline/);
  const ctl = path.join(p.project, ".factory/controller");
  const spec = (...a) => fs.readFileSync(spawnSync("node", ["templates/mkspec.mjs", ...a], { cwd: ctl, encoding: "utf8" }).stdout.trim(), "utf8");
  const baseline = spec("baseline");
  assert.match(baseline, /Describes what the code does at commit `<sha>`/);
  assert.match(baseline, /citing ADR-0001/);
  assert.match(spec("steward", "Wave 1"), /Wave 1[\s\S]*drift/);
  assert.match(spec("conf", "T1", "docs/tasks/T1.md", "agents/t1", "abc", "b:f"), /level 3 change that does not update it in this change fails/);
  p.done();
});

test("choosing no Architect: no baseline, no stewardship step, and conformance does not ask for the document", () => {
  const p = initProject("off");
  assert.doesNotMatch(p.read(".factory/controller/CONTROLLER.md"), /mkspec baseline|mkspec steward "/);
  assert.match(p.read("docs/architect-protocol.md"), /has not chosen a maintained/);
  const ctl = path.join(p.project, ".factory/controller");
  const out = spawnSync("node", ["templates/mkspec.mjs", "conf", "T1", "docs/tasks/T1.md", "agents/t1", "abc", "b:f"], { cwd: ctl, encoding: "utf8" }).stdout.trim();
  assert.doesNotMatch(fs.readFileSync(out, "utf8"), /does not update it/);
  p.done();
});

test("an older project with no choice yet stays off", () => {
  const p = initProject("architect");
  const file = path.join(p.project, "factory.config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  delete config.architecture;
  fs.writeFileSync(file, JSON.stringify(config));
  const r = spawnSync("node", [CLI, "update"], { cwd: p.project, env: p.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(p.read(".factory/controller/CONTROLLER.md"), /mkspec baseline/);
  p.done();
});

test("a release is one runnable command, and a tester's gate runs through bash", () => {
  const p = initProject("off");
  const file = path.join(p.project, "factory.config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.commands.release = ["a-compose-check", "image-check"];
  config.commands.verify = ". ~/.nvm/nvm.sh && pnpm verify";
  fs.writeFileSync(file, JSON.stringify(config));
  assert.equal(spawnSync("node", [CLI, "update"], { cwd: p.project, env: p.env, encoding: "utf8" }).status, 0);
  assert.match(p.read("docs/coordinator.md"), /`a-compose-check && image-check`/);
  const ctl = path.join(p.project, ".factory/controller");
  const out = spawnSync("node", ["templates/mkspec.mjs", "test", "T1", "docs/tasks/T1.md", "agents/t1", "abc"], { cwd: ctl, encoding: "utf8" }).stdout.trim();
  assert.match(fs.readFileSync(out, "utf8"), /gate bash -c '\. ~\/\.nvm\/nvm\.sh && pnpm verify'/);
  p.done();
});

test("gate explains the shell form when it cannot start a command", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-gate-"));
  for (const f of ["gate.mjs", "lib.mjs"]) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "factory.config.json"), JSON.stringify({ project: { name: "p" }, agents: {}, commands: {}, capacity: { gate: {} }, hosts: { controller: { host: "local" }, workers: [{ name: "local", kind: "local" }] } }));
  const r = spawnSync("node", [path.join(dir, "gate.mjs"), "/no/such/program"], { encoding: "utf8", env: { ...process.env, HOME: dir } });
  assert.match(r.stderr, /gate bash -c/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cleanup closes finished wave terminals, keeps a running one and the newest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-waves-"));
  const ctl = path.join(dir, "ctl"), project = path.join(dir, "p");
  fs.mkdirSync(ctl); fs.mkdirSync(project);
  for (const f of ["cleanup.mjs", "lib.mjs", "journal.mjs", "names.mjs"]) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(ctl, f));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project });
  fs.writeFileSync(path.join(ctl, "factory.config.json"), JSON.stringify({ project: { name: "p", mainBranch: "main" }, agents: { runner: "orca" }, commands: {}, hosts: { controller: { host: "local" }, workers: [{ name: "local", kind: "local", projectDir: project }] } }));
  fs.writeFileSync(path.join(ctl, "wave-handle.txt"), "local term_newest\n");
  const integ = "/w/p/coordinator-integration";
  const terminals = [
    { handle: "term_old", title: "p · Integration · T1", worktreePath: integ },
    { handle: "term_legacy", title: "Coordinator T0", worktreePath: integ },
    { handle: "term_running", title: "p · Integration · T2", worktreePath: integ },
    { handle: "term_newest", title: "p · Integration · T3", worktreePath: integ },
    { handle: "term_shell", title: "p · Integration · Shell", worktreePath: integ },
    { handle: "term_other", title: "q · Integration · T9", worktreePath: "/w/q/elsewhere" },
  ];
  const log = path.join(dir, "calls.log");
  const fake = path.join(dir, "fake-orca.mjs");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, a.join(" ") + "\\n");
const handle = a[a.indexOf("--terminal") + 1];
if (a[0] === "terminal" && a[1] === "list") console.log(JSON.stringify({ ok: true, result: { terminals: ${JSON.stringify(terminals)} } }));
else if (a[1] === "read") console.log(JSON.stringify({ ok: true, result: { tail: ["term_old", "term_legacy", "term_other"].includes(handle) ? "PUSHED main\\nWAVE-END" : "cmd; echo WAVE-END\\nrunning" } }));
else if (a[0] === "worktree" && a[1] === "list") console.log(JSON.stringify({ ok: true, result: { worktrees: [] } }));
else console.log(JSON.stringify({ ok: true, result: {} }));`);
  fs.chmodSync(fake, 0o755);
  const r = spawnSync("node", [path.join(ctl, "cleanup.mjs")], { cwd: project, encoding: "utf8", env: { ...process.env, ORCA_CLI_COMMAND: fake, FACTORY_CONFIG: path.join(ctl, "factory.config.json") } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /closed 2 finished wave terminals/);
  const closed = fs.readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("terminal close")).map((l) => l.split(" ")[3]);
  assert.deepEqual(closed.sort(), ["term_legacy", "term_old"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
