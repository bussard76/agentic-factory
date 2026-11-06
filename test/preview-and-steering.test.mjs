// The preview's update script run for real against a temporary HOME, and which tickets count as ready in both steering modes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const render = (text, vars) => text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let previews = 0;

// The start command records one variable only, so a failing assertion cannot print the environment.
function preview(envFile) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "af-preview-")));
  const home = path.join(base, "home"), origin = path.join(base, "o.git"), worktree = path.join(base, "wt"), record = path.join(base, "record");
  fs.mkdirSync(home);
  const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, stdio: "ignore" });
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(base, "init", "-q", "-b", "main", worktree);
  git(worktree, "commit", "-q", "--allow-empty", "-m", "first");
  git(worktree, "remote", "add", "origin", origin);
  git(worktree, "push", "-q", "origin", "main");
  const project = `af-test-${process.pid}-${++previews}`;
  const script = path.join(base, "preview-update.sh");
  fs.writeFileSync(script, render(fs.readFileSync(path.join(ROOT, "front-agent/preview-update.sh"), "utf8"), {
    PROJECT: project, PREVIEW_ENV_FILE: envFile, MAIN: "main", PREVIEW_PORT: "1", INSTALL_CMD: "",
    PREVIEW_CMD: "true",
  }), { mode: 0o755 });
  const start = `printf '%s' "\${PREVIEW_TEST_VALUE:-unset}" > "${record}"; exec sleep 30`;
  const pidFile = `/tmp/${project}-preview.pid`;
  const run = (env = {}) => spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, HOME: home, PREVIEW_WORKTREE: worktree, PREVIEW_START: start, ...env } });
  const seen = () => { for (let i = 0; i < 100 && !fs.existsSync(record); i++) pause(50); return fs.existsSync(record) ? fs.readFileSync(record, "utf8") : null; };
  const pid = () => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : null);
  const done = () => {
    const p = pid();
    if (p) try { process.kill(p); } catch { /* already gone */ }
    for (const f of [pidFile, `/tmp/${project}-preview.log`, `/tmp/${project}-preview-install.log`]) fs.rmSync(f, { force: true });
    fs.rmSync(base, { recursive: true, force: true });
  };
  return { base, home, record, run, seen, pid, done };
}
const envFileAt = (file, value = "from-file") => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `# a comment\n\nPREVIEW_TEST_VALUE=${value}\n`); };

test("a preview env file written with ~ is found, and a value with spaces arrives whole", () => {
  const p = preview("~/x/preview.env");
  envFileAt(path.join(p.home, "x/preview.env"), "a value with spaces");
  const r = p.run();
  assert.equal(r.status, 0);
  assert.equal(p.seen(), "a value with spaces");
  p.done();
});

test("a preview env file with an absolute path is found", () => {
  const p = preview("");
  const file = path.join(p.base, "abs/preview.env");
  envFileAt(file);
  assert.equal(p.run({ PREVIEW_ENV_FILE: file }).status, 0);
  assert.equal(p.seen(), "from-file");
  p.done();
});

test("PREVIEW_ENV_FILE wins over the rendered path", () => {
  const p = preview("~/x/preview.env");
  envFileAt(path.join(p.home, "x/preview.env"), "rendered");
  const other = path.join(p.base, "other.env");
  envFileAt(other, "from-environment");
  assert.equal(p.run({ PREVIEW_ENV_FILE: other }).status, 0);
  assert.equal(p.seen(), "from-environment");
  p.done();
});

test("a missing preview env file starts nothing, and names the path", () => {
  const p = preview("~/x/preview.env");
  const r = p.run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, new RegExp(`not starting the preview: env file ${p.home}/x/preview\\.env is missing`));
  pause(300);
  assert.equal(fs.existsSync(p.record), false);
  assert.equal(p.pid(), null);
  p.done();
});

test("a preview that runs stays as it is when its env file disappears", () => {
  const p = preview("~/x/preview.env");
  envFileAt(path.join(p.home, "x/preview.env"));
  p.run();
  assert.equal(p.seen(), "from-file");
  const running = p.pid();
  fs.rmSync(path.join(p.home, "x/preview.env"));
  assert.match(p.run().stdout, /not starting the preview/);
  assert.equal(p.pid(), running);
  process.kill(running, 0);
  p.done();
});

test("a preview without a configured env file starts", () => {
  const p = preview("");
  assert.equal(p.run().status, 0);
  assert.equal(p.seen(), "unset");
  p.done();
});

test("the preview's launchd agent keeps what the script left running, and parses", () => {
  const text = render(fs.readFileSync(path.join(ROOT, "front-agent/preview.plist.template"), "utf8"), { PREVIEW_LABEL: "de.p.preview", PREVIEW_SCRIPT: "/x/preview-update.sh", HOME: "/x", PROJECT: "p" });
  assert.match(text, /<key>AbandonProcessGroup<\/key><true\/>/);
  assert.doesNotMatch(text, /\{\{/);
  if (process.platform !== "darwin") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-plist-")), file = path.join(dir, "p.plist");
  fs.writeFileSync(file, text);
  assert.equal(spawnSync("plutil", ["-lint", file], { encoding: "utf8" }).status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

function steering(script, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-steering-"));
  const ctl = path.join(dir, "ctl"), project = path.join(dir, "p"), bin = path.join(dir, "bin");
  for (const d of [path.join(ctl, "steering"), path.join(project, "docs/tasks"), bin]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "controller/lib.mjs"), path.join(ctl, "lib.mjs"));
  fs.copyFileSync(path.join(ROOT, "controller/steering", script), path.join(ctl, "steering", script));
  fs.writeFileSync(path.join(ctl, "factory.config.json"), JSON.stringify({ project: { name: "p", mainBranch: "main" }, agents: { runner: "orca" }, commands: {}, steering: config, hosts: { controller: { host: "local" }, workers: [{ name: "local", kind: "local", projectDir: project }] } }));
  const run = (...args) => spawnSync("node", [path.join(ctl, "steering", script), ...args], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  return { dir, project, bin, run, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const issue = (number, blockedBy, extra = {}) => ({ number, title: `issue ${number}`, body: "Level 2", assignees: { nodes: [] }, labels: { nodes: [{ name: "go" }] }, issueDependenciesSummary: blockedBy === null ? null : { blockedBy }, ...extra });

test("ready lists only issues without an open blocker, in one query, and leaves out what it cannot read", () => {
  const s = steering("issues.mjs", { readyLabel: "go" });
  const log = path.join(s.dir, "gh.log");
  const nodes = [issue(1, 0), issue(2, 1), issue(3, 2), issue(4, null), issue(5, 0, { assignees: { nodes: [{ login: "x" }] } })];
  fs.writeFileSync(path.join(s.bin, "gh"), `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({ data: { repository: { issues: { nodes: ${JSON.stringify(nodes)} } } } }));`, { mode: 0o755 });
  const r = s.run("ready");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [{ number: 1, title: "issue 1", level: "2", labels: ["go"] }]);
  assert.match(r.stderr, /#4: its blockers cannot be read/);
  assert.doesNotMatch(r.stderr, /#[1235]:/);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(calls.length, 1);
  for (const arg of ["owner={owner}", "name={repo}", "label=go"]) assert.ok(calls[0].includes(arg), arg);
  s.done();
});

test("ready fails loudly when the server cannot answer, and hands out nothing", () => {
  const s = steering("issues.mjs");
  fs.writeFileSync(path.join(s.bin, "gh"), `#!/bin/sh\necho "Field 'issueDependenciesSummary' doesn't exist" >&2\nexit 1\n`, { mode: 0o755 });
  const r = s.run("ready");
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "");
  s.done();
});

test("a ready task waits for the tasks it depends on, and other lists stay whole", () => {
  const s = steering("tasks.mjs");
  const task = (name, status, depends) => fs.writeFileSync(path.join(s.project, "docs/tasks", `${name}.md`), `# ${name}\n\nStatus: ${status}\n${depends === undefined ? "" : `Depends on: ${depends}\n`}`);
  task("T01-done", "integrated", "nothing");
  task("T02-free", "ready", "nothing");
  task("T03-after-done", "ready", "T01");
  task("T04-after-open", "ready", "T05");
  task("T05-open", "building", "T01");
  task("T06-mixed", "ready", "T01, T05");
  task("T07-unknown", "ready", "T99");
  task("T08-unpadded", "ready", "T1 and the auth interface");
  task("T09-no-line", "ready");
  task("T10-interface-only", "ready", "the auth interface");
  task("T11-passed-only", "passed", "T01");
  task("T12-after-passed", "ready", "T11");
  const list = (...a) => { const r = s.run("list", ...a); assert.equal(r.status, 0, r.stderr); return { ids: JSON.parse(r.stdout).map((t) => t.id), stderr: r.stderr }; };
  const ready = list("ready");
  assert.deepEqual(ready.ids, ["T02", "T03", "T08", "T09", "T10"]);
  assert.match(ready.stderr, /T07: it depends on T99, which does not exist/);
  assert.deepEqual(list("building").ids, ["T05"]);
  assert.equal(list().ids.length, 12);
  s.done();
});
