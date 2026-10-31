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
const home = fs.mkdtempSync(path.join(os.tmpdir(), "af-home-"));   // a HOME outside the repo: the local bare remote and skills land here
const git = (...a) => { const r = spawnSync("git", a, { cwd: tmp, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${a.join(" ")} failed:\n${r.stderr}${r.stdout}`); return r.stdout.trim(); };
const gitTry = (...a) => spawnSync("git", a, { cwd: tmp, encoding: "utf8" });
// FACTORY_SKIP_ORCA keeps the test from touching the developer's real Orca (no repo registration).
const node = (...a) => execFileSync("node", a, { cwd: tmp, encoding: "utf8", env: { ...process.env, HOME: home, FACTORY_SKIP_ORCA: "1" } }).trim();

test("init in a fresh repo writes the factory files, a local remote and the pushed adoption commit", () => {
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "echo ok", lint: "echo lint" } }));
  git("add", "-A"); git("commit", "-qm", "init");
  const out = node(CLI, "init", "--yes");
  assert.match(out, /local bare remote/);
  assert.match(out, /Adopt agentic-factory \(ADR-0001\), pushed to origin\/main/);
  for (const f of ["factory.config.json", "AGENTS.md", "docs/coordinator.md", "docs/dev-workflow.md", "docs/review-protocol.md", "docs/adr/0001-adopt-agentic-factory.md", ".githooks/pre-push", "tools/factory-guardrails.mjs", ".factory/controller/CONTROLLER.md", ".factory/controller/skills/orchestration/SKILL.md", ".agents/skills/ponytail/SKILL.md"]) assert.ok(fs.existsSync(path.join(tmp, f)), f);
  assert.equal(git("config", "core.hooksPath"), ".githooks");
  assert.equal(git("remote"), "origin");
  assert.match(git("ls-tree", "--name-only", "origin/main"), /AGENTS\.md/, "origin/main must carry AGENTS.md");
  assert.equal(git("status", "--porcelain").replace(/^\?\? \.factory\/.*$/gm, "").trim(), "", "nothing but the bundle dir left uncommitted");
  const left = spawnSync("grep", ["-rl", "{{[A-Z_]*}}", "AGENTS.md", "docs", ".factory/controller/CONTROLLER.md"], { cwd: tmp, encoding: "utf8" }).stdout.trim();   // grep exits 1 when nothing matches
  assert.equal(left, "", `unresolved placeholders in ${left}`);
  assert.doesNotMatch(fs.readFileSync(path.join(tmp, "docs/dev-workflow.md"), "utf8"), /\]\((\.\.\/)?[a-z-]+\.md/, "no dangling relative links to factory docs that were not copied");
});

test("protected files need the ADR reference once the hooks are armed", () => {
  fs.appendFileSync(path.join(tmp, "AGENTS.md"), "\n<!-- note -->\n"); git("add", "-A");
  const r = gitTry("commit", "-qm", "touch agents without adr");
  assert.notEqual(r.status, 0); assert.match(r.stderr + r.stdout, /ADR-NNNN/);
  git("checkout", "-q", "HEAD", "--", "AGENTS.md"); git("reset", "-q");
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

// A wave the way integ-wave.sh builds it: integration reset to origin/main, task branch plus its review branch merged.
function reviewedTask(name) {
  const base = git("rev-parse", "origin/main");
  git("checkout", "-q", "-b", `agents/${name}`, base);
  fs.writeFileSync(path.join(tmp, `src/${name}.js`), `export const ${name} = true;\n`); git("add", "-A"); git("commit", "-qm", `${name} feature`);
  const sha = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", `agents/${name}-review-1`);
  fs.writeFileSync(path.join(tmp, `docs/reviews/${name}-review-1.md`), `# ${name} review, round 1\n\nVerdict: pass\nReviewed commit: ${sha}\n`); git("add", "-A"); git("commit", "-qm", `${name} review`);
  git("checkout", "-q", "main");
  return [`agents/${name}`, `agents/${name}-review-1`];
}
function wave(branches) {
  git("checkout", "-q", "-B", "integration", "origin/main");
  for (const b of branches) git("merge", "-q", "--no-ff", "--no-edit", b);
  return gitTry("push", "-q", "origin", "integration:main");
}

test("a wave of two reviewed tasks is accepted, one without its review branch is rejected", () => {
  const [t2, r2] = reviewedTask("t2"), [t3, r3] = reviewedTask("t3");
  const r = wave([t2, r2, t3, r3]); assert.equal(r.status, 0, r.stderr);
  const [t4] = reviewedTask("t4");
  const bad = wave([t4]); assert.notEqual(bad.status, 0); assert.match(bad.stderr + bad.stdout, /Push to main rejected/);
});

test("a wave after main moved is accepted when its review branch is included", () => {
  const [t5, r5] = reviewedTask("t5");
  const [t6, r6] = reviewedTask("t6");
  assert.equal(wave([t6, r6]).status, 0);            // main moves
  const r = wave([t5, r5]); assert.equal(r.status, 0, r.stderr);   // t5 was reviewed before main moved
});

test("wait.mjs honours --hours and rejects a missing value", () => {
  const env = { ...process.env, FACTORY_CONFIG: path.join(tmp, ".factory/controller/factory.config.json") };
  const ctl = path.join(tmp, ".factory/controller");
  const cfg = JSON.parse(fs.readFileSync(env.FACTORY_CONFIG, "utf8")); cfg.agents.runner = "terminal";
  const tcfg = path.join(tmp, "terminal.config.json"); fs.writeFileSync(tcfg, JSON.stringify(cfg));
  const t0 = Date.now();
  const r = spawnSync("node", ["wait.mjs", "--hours", "0.0006"], { cwd: ctl, encoding: "utf8", env: { ...env, FACTORY_CONFIG: tcfg } });   // ≈2 s
  assert.match(r.stdout, /no event after 0\.0006h/); assert.ok(Date.now() - t0 >= 1500, "waited the window");
  const bad = spawnSync("node", ["wait.mjs", "--hours"], { cwd: ctl, encoding: "utf8", env: { ...env, FACTORY_CONFIG: tcfg } });
  assert.notEqual(bad.status, 0);
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
  const r = spawnSync("node", [path.join(ROOT, "controller/gate.mjs"), "sh", "-c", "exit 3"], { env: { ...process.env, HOME: home, FACTORY_PROJECT: "smoke" } });
  assert.equal(r.status, 3);
});
