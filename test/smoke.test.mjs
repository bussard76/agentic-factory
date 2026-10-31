// End-to-end smoke test: init in a fresh repo, hooks bite, controller scripts run. `npm test` runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLI = path.join(ROOT, "bin/agentic-factory.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-smoke-"));
const git = (...a) => execFileSync("git", a, { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitTry = (...a) => spawnSync("git", a, { cwd: tmp, encoding: "utf8" });
const node = (...a) => execFileSync("node", a, { cwd: tmp, encoding: "utf8", env: { ...process.env, HOME: tmp } }).trim();

test("init in a fresh repo writes the factory files and a local remote", () => {
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "echo ok", lint: "echo lint" } }));
  git("add", "-A"); git("commit", "-qm", "init");
  const out = node(CLI, "init", "--yes");
  assert.match(out, /local bare remote/);
  for (const f of ["factory.config.json", "AGENTS.md", "docs/coordinator.md", "docs/dev-workflow.md", "docs/review-protocol.md", "docs/adr/0001-adopt-agentic-factory.md", ".githooks/pre-push", "tools/factory-guardrails.mjs", ".factory/controller/CONTROLLER.md", ".factory/controller/skills/orchestration/SKILL.md", ".agents/skills/ponytail/SKILL.md"]) assert.ok(fs.existsSync(path.join(tmp, f)), f);
  assert.equal(git("config", "core.hooksPath"), ".githooks");
  assert.equal(git("remote"), "origin");
  const left = spawnSync("grep", ["-rl", "{{[A-Z_]*}}", "AGENTS.md", "docs", ".factory/controller/CONTROLLER.md"], { cwd: tmp, encoding: "utf8" }).stdout.trim();   // grep exits 1 when nothing matches
  assert.equal(left, "", `unresolved placeholders in ${left}`);
});

test("the adoption commit needs the ADR reference", () => {
  git("add", "-A");
  const r = gitTry("commit", "-qm", "adopt without adr");
  assert.notEqual(r.status, 0); assert.match(r.stderr + r.stdout, /ADR-NNNN/);
  git("commit", "-qm", "Adopt agentic-factory (ADR-0001)");
});

test("hooks reject a dropped test, a staged secret and an env file", () => {
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src/a.test.js"), 'test("a",()=>{});\ntest("b",()=>{});\n'); git("add", "-A"); git("commit", "-qm", "tests");
  fs.writeFileSync(path.join(tmp, "src/a.test.js"), 'test("a",()=>{});\n'); git("add", "-A");
  let r = gitTry("commit", "-qm", "drop"); assert.notEqual(r.status, 0); assert.match(r.stderr + r.stdout, /Test count decreased/); git("checkout", "-q", "HEAD", "--", "src"); git("reset", "-q");
  fs.writeFileSync(path.join(tmp, "src/s.js"), 'const k = "sk-abcdefghijklmnopqrstuvwxyz1234567890";\n'); git("add", "-A");
  r = gitTry("commit", "-qm", "secret"); assert.notEqual(r.status, 0); assert.match(r.stderr + r.stdout, /secrets/); fs.rmSync(path.join(tmp, "src/s.js")); git("reset", "-q");
  fs.writeFileSync(path.join(tmp, ".env.local"), "X=1\n"); git("add", "-f", ".env.local");
  r = gitTry("commit", "-qm", "env"); assert.notEqual(r.status, 0); assert.match(r.stderr + r.stdout, /environment files/); fs.rmSync(path.join(tmp, ".env.local")); git("reset", "-q");
});

test("a push to main without review coverage is rejected, a reviewed one passes", () => {
  fs.writeFileSync(path.join(tmp, "src/feature.js"), "export const x = 1;\n"); git("add", "-A"); git("commit", "-qm", "feature");
  let r = gitTry("push", "-q", "origin", "main"); assert.notEqual(r.status, 0); assert.match(r.stderr + r.stdout, /Push to main rejected/);
  const sha = git("rev-parse", "HEAD");
  fs.mkdirSync(path.join(tmp, "docs/reviews"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "docs/reviews/T01-review-1.md"), `# T01 review, round 1\n\nVerdict: pass\nReviewed commit: ${sha}\n`); git("add", "-A"); git("commit", "-qm", "review");
  r = gitTry("push", "-q", "origin", "main"); assert.equal(r.status, 0, r.stderr);
});

test("controller scripts run against the generated config", () => {
  const env = { ...process.env, FACTORY_CONFIG: path.join(tmp, ".factory/controller/factory.config.json") };
  const ctl = path.join(tmp, ".factory/controller");
  const run = (...a) => execFileSync("node", a, { cwd: ctl, encoding: "utf8", env }).trim();
  const verdict = JSON.parse(run("capacity.mjs", "--verbose"));
  assert.ok(["start", "wait"].includes(verdict.suite)); assert.equal(verdict.caps.calibration, "auto");
  assert.match(run("templates/mkspec.mjs", "dev", "T01", "docs/tasks/T01-x.md", "agents/t01"), /t01-dev\.txt$/);
  run("journal.mjs", "decision", "T01", "note=x");
  assert.match(run("cleanup.mjs", "--dry"), /cleanup \(dry\)/);
  assert.match(run("calibrate-models.mjs"), /no change|updated/);
  assert.match(run("calibrate-models.mjs", "--days", "3"), /no change|updated/);
});

test("gate runs commands in slots and survives without flock", () => {
  const r = spawnSync("node", [path.join(ROOT, "controller/gate.mjs"), "sh", "-c", "exit 3"], { env: { ...process.env, HOME: tmp, FACTORY_PROJECT: "smoke" } });
  assert.equal(r.status, 3);
});
