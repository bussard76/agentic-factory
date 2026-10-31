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
  fs.writeFileSync(path.join(tmp, "src/a.test.js"), 'test("a",()=>{});\ntest("b",()=>{});\n'); git("add", "src/a.test.js"); git("commit", "-qm", "tests");
  fs.writeFileSync(path.join(tmp, "src/a.test.js"), 'test("a",()=>{});\n'); git("add", "src/a.test.js");
  let r = gitTry("commit", "-qm", "drop"); assert.notEqual(r.status, 0); assert.match(r.stderr + r.stdout, /Test count decreased/); git("checkout", "-q", "HEAD", "--", "src"); git("reset", "-q");
  fs.writeFileSync(path.join(tmp, "src/s.js"), 'const k = "sk-abcdefghijklmnopqrstuvwxyz1234567890";\n'); git("add", "src/s.js");
  r = gitTry("commit", "-qm", "secret"); assert.notEqual(r.status, 0); assert.match(r.stderr + r.stdout, /secrets/); fs.rmSync(path.join(tmp, "src/s.js")); git("reset", "-q");
  fs.writeFileSync(path.join(tmp, ".env.local"), "X=1\n"); git("add", "-f", ".env.local");
  r = gitTry("commit", "-qm", "env"); assert.notEqual(r.status, 0); assert.match(r.stderr + r.stdout, /environment files/); fs.rmSync(path.join(tmp, ".env.local")); git("reset", "-q");
});

test("a push to main without review coverage is rejected, a reviewed one passes", () => {
  fs.writeFileSync(path.join(tmp, "src/feature.js"), "export const x = 1;\n"); git("add", "src/feature.js"); git("commit", "-qm", "feature");
  let r = gitTry("push", "-q", "origin", "main"); assert.notEqual(r.status, 0); assert.match(r.stderr + r.stdout, /Push to main rejected/);
  const sha = git("rev-parse", "HEAD");
  fs.mkdirSync(path.join(tmp, "docs/reviews"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "docs/reviews/T01-review-1.md"), `# T01 review, round 1\n\nVerdict: pass\nReviewed commit: ${sha}\n`); git("add", "docs/reviews/T01-review-1.md"); git("commit", "-qm", "review");
  r = gitTry("push", "-q", "origin", "main"); assert.equal(r.status, 0, r.stderr);
});

// The hooks' lint may auto-install (pnpm) and leave a lockfile or node_modules behind; the test repo must not carry
// that noise into commits or block checkouts. Only named files are ever added.
function tidy() { spawnSync("git", ["checkout", "-q", "--", "."], { cwd: tmp }); spawnSync("git", ["clean", "-fdq", "-e", ".factory"], { cwd: tmp }); }
// A wave the way integ-wave.sh builds it: integration reset to origin/main, task branch plus its review branch merged.
function reviewedTask(name) {
  tidy();
  const base = git("rev-parse", "origin/main");
  git("checkout", "-q", "-b", `agents/${name}`, base);
  fs.writeFileSync(path.join(tmp, `src/${name}.js`), `export const ${name} = true;\n`); git("add", `src/${name}.js`); git("commit", "-qm", `${name} feature`);
  const sha = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", `agents/${name}-review-1`);
  fs.writeFileSync(path.join(tmp, `docs/reviews/${name}-review-1.md`), `# ${name} review, round 1\n\nVerdict: pass\nReviewed commit: ${sha}\n`); git("add", `docs/reviews/${name}-review-1.md`); git("commit", "-qm", `${name} review`);
  tidy(); git("checkout", "-q", "main");
  return [`agents/${name}`, `agents/${name}-review-1`];
}
function wave(branches) {
  tidy(); git("checkout", "-q", "-B", "integration", "origin/main");
  for (const b of branches) git("merge", "-q", "--no-ff", "--no-edit", b);
  return gitTry("push", "-q", "origin", "integration:main");
}

test("a wave of two reviewed tasks is accepted, one without its review branch is rejected", () => {
  const [t2, r2] = reviewedTask("t2"), [t3, r3] = reviewedTask("t3");
  const r = wave([t2, r2, t3, r3]); assert.equal(r.status, 0, r.stderr);
  const [t4] = reviewedTask("t4");
  const bad = wave([t4]); assert.notEqual(bad.status, 0); assert.match(bad.stderr + bad.stdout, /Push to main rejected/);
});

// The wave environment exactly as controller/wave.mjs builds it from the generated config.
function waveEnv() {
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, "factory.config.json"), "utf8"));
  return { ...process.env, MAIN: cfg.project.mainBranch, INSTALL_CMD: cfg.commands.install ?? "", VERIFY_CMD: cfg.commands.verify ?? "", E2E_CMD: cfg.commands.e2e ?? "", GATE: path.join(ROOT, "controller/gate"), TRAILER: "", HOME: home, FACTORY_PROJECT: "smoke", WAVE_WORKTREE_OK: "1" };
}
function runWave(title, branches) {
  const integ = path.join(tmp, "..", path.basename(tmp) + "-integration");
  git("worktree", "add", "-q", "-B", "integration", integ, "origin/main");
  const r = spawnSync("bash", [path.join(ROOT, "controller/integ-wave.sh"), title, "wave", ...branches.map((b) => `origin/${b}`)], { cwd: integ, encoding: "utf8", env: waveEnv() });
  git("worktree", "remove", "--force", integ);
  return r;
}

test("integ-wave.sh with the Controller's own environment pushes a two-task wave, also when a task adds an ADR and a dependency", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, "factory.config.json"), "utf8"));
  const lock = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"].find((f) => fs.existsSync(path.join(tmp, f)));
  if (lock) { assert.match(cfg.commands.install, /frozen-lockfile|npm ci/, "lockfile created at init: frozen install"); assert.match(git("ls-tree", "--name-only", "origin/main"), new RegExp(lock), "lockfile committed with the adoption"); }
  else assert.match(cfg.commands.install, /^(pnpm|npm|yarn) install$/, "no lockfile: a plain install, not a frozen one");
  // The wave script refuses to run outside the integration worktree.
  const wrong = spawnSync("bash", [path.join(ROOT, "controller/integ-wave.sh"), "x", "y", "origin/main"], { cwd: tmp, encoding: "utf8", env: { ...waveEnv(), WAVE_WORKTREE_OK: "" } });
  assert.notEqual(wrong.status, 0); assert.match(wrong.stdout, /WRONG-DIRECTORY/);
  const [t7, r7] = reviewedTask("t7"), [t8, r8] = reviewedTask("t8");
  for (const b of [t7, r7, t8, r8]) git("push", "-q", "origin", b);
  const r = runWave("Wave 7+8", [t7, r7, t8, r8]);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /PUSHED main/);
  // A reviewed task that adds an accepted ADR (protected path) and a dependency: its commits carry ADR-0002, the wave carries it on.
  tidy(); git("checkout", "-q", "-b", "agents/t11", "origin/main");
  fs.writeFileSync(path.join(tmp, "docs/adr/0002-use-left-pad.md"), "# ADR-0002: Use left-pad\n\nStatus: accepted\nDate: 2026-01-01\nDecided by: t (2026-01-01), option A\n\n## Decision\n\nUse it.\n");
  // A local file: dependency keeps the install offline.
  fs.mkdirSync(path.join(tmp, "vendor/tiny"), { recursive: true }); fs.writeFileSync(path.join(tmp, "vendor/tiny/package.json"), '{ "name": "tiny", "version": "1.0.0" }\n');
  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, "package.json"), "utf8")); pkg.dependencies = { tiny: "file:vendor/tiny" }; fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  // A Developer who adds a dependency updates the lockfile in the same commit (the wave installs frozen).
  const pm = lock === "pnpm-lock.yaml" ? "pnpm" : lock === "yarn.lock" ? "yarn" : lock ? "npm" : null;
  if (pm) spawnSync(pm, ["install"], { cwd: tmp, stdio: "ignore" });
  git("add", "docs/adr/0002-use-left-pad.md", "vendor/tiny/package.json", "package.json", ...(lock && fs.existsSync(path.join(tmp, lock)) ? [lock] : [])); git("commit", "-qm", "t11: adopt tiny (ADR-0002)");
  const sha11 = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "agents/t11-review-1");
  fs.writeFileSync(path.join(tmp, "docs/reviews/t11-review-1.md"), `# t11 review, round 1\n\nVerdict: pass\nReviewed commit: ${sha11}\n`); git("add", "docs/reviews/t11-review-1.md"); git("commit", "-qm", "t11 review");   // a Tester commits only its findings file
  tidy(); git("checkout", "-q", "main"); for (const b of ["agents/t11", "agents/t11-review-1"]) git("push", "-q", "origin", b);
  const r11 = runWave("Wave 11", ["agents/t11", "agents/t11-review-1"]);
  assert.equal(r11.status, 0, r11.stdout + r11.stderr); assert.match(r11.stdout, /PUSHED main/);
  assert.match(git("log", "-1", "--format=%B", "origin/main"), /ADR-0002/, "the merge message carries the ADR reference");
  // An octopus merge of two reviewed tasks must be rejected by the gate.
  const [t9, r9] = reviewedTask("t9"), [t10, r10] = reviewedTask("t10");
  tidy(); git("checkout", "-q", "-B", "integration", "origin/main");
  git("merge", "-q", "--no-ff", "--no-edit", t9, r9, t10, r10);
  const bad = gitTry("push", "-q", "origin", "integration:main"); assert.notEqual(bad.status, 0); assert.match(bad.stderr + bad.stdout, /octopus/);
  tidy(); git("checkout", "-q", "main");
});

test("a hand-edited merge commit runs the static checks; a clean merge skips them", () => {
  tidy(); git("checkout", "-q", "-B", "main", "origin/main");
  const cfgPath = path.join(tmp, "factory.config.json"); const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const saved = cfg.commands.lint; cfg.commands.lint = "sh -c 'exit 1'"; fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");   // lint fails from now on
  git("checkout", "-q", "-b", "agents/merge-src", "origin/main"); fs.writeFileSync(path.join(tmp, "src/m.js"), "export const m = 1;\n"); git("add", "src/m.js");
  assert.notEqual(gitTry("commit", "-qm", "plain commit with failing lint").status, 0, "a plain commit is blocked by lint");
  cfg.commands.lint = saved; fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n"); git("commit", "-qm", "m feature");
  cfg.commands.lint = "sh -c 'exit 1'"; fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  git("checkout", "-q", "-B", "integration-x", "origin/main");
  git("merge", "-q", "--no-ff", "--no-commit", "agents/merge-src"); fs.writeFileSync(path.join(tmp, "src/smuggled.js"), "bad\n"); git("add", "src/smuggled.js");
  const r = gitTry("commit", "-qm", "merge with a smuggled file"); assert.notEqual(r.status, 0, "hand-edited merge must run lint"); assert.match(r.stderr + r.stdout, /hand edits|lint failed/);
  git("merge", "--abort"); git("merge", "-q", "--no-ff", "--no-commit", "agents/merge-src");
  const ok = gitTry("commit", "-qm", "clean merge"); assert.equal(ok.status, 0, ok.stderr + ok.stdout); assert.match(ok.stdout + ok.stderr, /clean merge commit/);
  cfg.commands.lint = saved; fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  tidy(); git("checkout", "-q", "main");
});

test("a fresh clone armed with init --yes rejects an unreviewed push", () => {
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "af-clone-"));
  const bare = git("remote", "get-url", "origin");
  execFileSync("git", ["clone", "-q", bare, clone]); execFileSync("git", ["config", "user.email", "c@example.com"], { cwd: clone }); execFileSync("git", ["config", "user.name", "c"], { cwd: clone });
  const out = execFileSync("node", [CLI, "init", "--yes"], { cwd: clone, encoding: "utf8", env: { ...process.env, HOME: home, FACTORY_SKIP_ORCA: "1" } });
  assert.match(out, /Already initialised/);
  assert.equal(execFileSync("git", ["config", "core.hooksPath"], { cwd: clone, encoding: "utf8" }).trim(), ".githooks", "a clone arms the hooks");
  fs.writeFileSync(path.join(clone, "src/clone.js"), "export const c = 1;\n"); execFileSync("git", ["add", "src/clone.js"], { cwd: clone }); execFileSync("git", ["commit", "-qm", "clone feature"], { cwd: clone });
  const r = spawnSync("git", ["push", "-q", "origin", "main"], { cwd: clone, encoding: "utf8" }); assert.notEqual(r.status, 0); assert.match(r.stderr, /Push to main rejected/);
});

test("update keeps the recorded decision dates", () => {
  const adr = fs.readFileSync(path.join(tmp, "docs/adr/0001-adopt-agentic-factory.md"), "utf8");
  execFileSync("node", [CLI, "update"], { cwd: tmp, encoding: "utf8", env: { ...process.env, HOME: home, FACTORY_SKIP_ORCA: "1", FACTORY_TODAY: "2030-01-01" } });
  assert.equal(fs.readFileSync(path.join(tmp, "docs/adr/0001-adopt-agentic-factory.md"), "utf8"), adr, "the adoption ADR keeps its date");
  tidy();
});

test("reviewer standards need review coverage, ordinary docs do not", () => {
  tidy(); git("checkout", "-q", "-B", "main", "origin/main");
  fs.appendFileSync(path.join(tmp, "docs/dev-workflow.md"), "\nA note.\n"); git("add", "docs/dev-workflow.md"); git("commit", "-qm", "docs note");
  const ok = gitTry("push", "-q", "origin", "main"); assert.equal(ok.status, 0, `plain docs are exempt: ${ok.stderr}`);
  fs.appendFileSync(path.join(tmp, "docs/review-protocol.md"), "\nA weaker rule.\n"); git("add", "docs/review-protocol.md"); git("commit", "-qm", "protocol change");
  const r = gitTry("push", "-q", "origin", "main"); assert.notEqual(r.status, 0, "review-protocol.md needs coverage");
  git("reset", "-q", "--hard", "origin/main");
});

test("a wave after main moved is accepted when its review branch is included", () => {
  const [t5, r5] = reviewedTask("t5");
  const [t6, r6] = reviewedTask("t6");
  assert.equal(wave([t6, r6]).status, 0);            // main moves
  const r = wave([t5, r5]); assert.equal(r.status, 0, r.stderr);   // t5 was reviewed before main moved
});

test("capacity counts every recorded Orca worker as live when the Orca CLI fails", () => {
  const env = { ...process.env, FACTORY_CONFIG: path.join(tmp, ".factory/controller/factory.config.json"), ORCA_CLI_COMMAND: "/usr/bin/false" };
  const ctl = path.join(tmp, ".factory/controller");
  fs.writeFileSync(path.join(ctl, "workers.json"), JSON.stringify({ a: { host: "local", terminal: "term_x", name: "A · Worker Developer" }, b: { host: "local", terminal: "term_y", name: "B · Worker Developer" } }));
  const v = JSON.parse(execFileSync("node", ["capacity.mjs", "--verbose"], { cwd: ctl, encoding: "utf8", env }));
  assert.equal(v.measured.suite, 2); assert.match(v.reason, /counted as live/);
  fs.unlinkSync(path.join(ctl, "workers.json"));
});

test("a second init run refreshes files from the recorded answers without a new adoption commit", () => {
  tidy(); git("checkout", "-q", "-B", "main", "origin/main");
  const before = git("rev-parse", "HEAD");
  const cfgPath = path.join(tmp, "factory.config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); cfg.project.humanName = "Alex"; cfg.reviews.maxRounds = 3; fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  const out = node(CLI, "init", "--yes");
  assert.match(out, /Already initialised/); assert.equal(git("rev-parse", "HEAD"), before, "no new commit on a re-run");
  const bundleCfg = JSON.parse(fs.readFileSync(path.join(tmp, ".factory/controller/factory.config.json"), "utf8"));
  assert.equal(bundleCfg.project.humanName, "Alex"); assert.equal(bundleCfg.reviews.maxRounds, 3);
  assert.match(fs.readFileSync(path.join(tmp, ".factory/controller/CONTROLLER.md"), "utf8"), /After 3 rounds/);
  // Refreshed files stay as working-tree changes for the human; nothing outside the factory's own files is touched.
  const changed = git("status", "--porcelain").split("\n").filter(Boolean).map((l) => l.trim().replace(/^\S+\s+/, ""));   // git() trims, so parse the status code by whitespace
  for (const f of changed) assert.match(f, /^(\.factory\/|factory\.config\.json|AGENTS\.md|CODING_STANDARDS\.md|docs\/|\.githooks\/|tools\/|\.agents\/|design\/|\.gitignore)/, `unexpected change: ${f}`);
  git("checkout", "-q", "--", "."); git("clean", "-fdq", "-e", ".factory");
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
  const env = { ...process.env, FACTORY_CONFIG: path.join(tmp, ".factory/controller/factory.config.json"), ORCA_CLI_COMMAND: "/usr/bin/false" };   // never the developer's real Orca
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
