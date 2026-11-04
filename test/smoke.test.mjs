// End-to-end smoke test: init in a fresh repo, hooks bite, controller scripts run. `npm test` runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createHash } from "node:crypto";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const createHashHex = (s) => createHash("sha256").update(s).digest("hex").slice(0, 6);   // mirrors the CLI's bare-remote key
const CLI = path.join(ROOT, "bin/agentic-factory.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-smoke-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "af-home-"));   // a HOME outside the repo: the local bare remote and skills land here
const git = (...a) => { const r = spawnSync("git", a, { cwd: tmp, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${a.join(" ")} failed:\n${r.stderr}${r.stdout}`); return r.stdout.trim(); };
const gitTry = (...a) => spawnSync("git", a, { cwd: tmp, encoding: "utf8" });
// FACTORY_SKIP_ORCA keeps the test from touching the developer's real Orca (no repo registration).
const node = (...a) => execFileSync("node", a, { cwd: tmp, encoding: "utf8", env: { ...process.env, HOME: home, FACTORY_SKIP_ORCA: "1" } }).trim();

test("two projects on one host: own controller dir everywhere, a foreign one is refused", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "af-two-"));
  const twoHome = path.join(base, "home"), project = path.join(base, "second");
  fs.mkdirSync(twoHome); fs.mkdirSync(project);
  const env = { ...process.env, HOME: twoHome, FACTORY_SKIP_ORCA: "1" };
  const run = (...a) => spawnSync("node", [CLI, ...a], { cwd: project, encoding: "utf8", env });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: project });
  spawnSync("git", ["config", "user.email", "t@example.invalid"], { cwd: project }); spawnSync("git", ["config", "user.name", "T"], { cwd: project });
  fs.writeFileSync(path.join(project, "README.md"), "x\n"); spawnSync("git", ["add", "."], { cwd: project }); spawnSync("git", ["commit", "-qm", "init"], { cwd: project });
  const answers = path.join(base, "answers.json");
  fs.writeFileSync(answers, JSON.stringify({ "project.name": "second", "project.humanName": "Test Human", "agents.default": "claude", "skills.installNow": "no", "rules.confirm": "yes" }));
  let r = run("init", "--answers", answers, "--experimental-terminal-runner"); assert.equal(r.status, 0, r.stdout + r.stderr);
  // Another project already owns the default directory.
  fs.mkdirSync(path.join(twoHome, "controller")); fs.writeFileSync(path.join(twoHome, "controller/factory.config.json"), JSON.stringify({ project: { name: "first" } }));
  const config = JSON.parse(fs.readFileSync(path.join(project, "factory.config.json"), "utf8"));
  r = run("start"); assert.notEqual(r.status, 0); assert.match(r.stdout, /belongs to the project first/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(twoHome, "controller/factory.config.json"), "utf8")).project.name, "first", "the other project's controller stays");
  config.hosts.controller.controllerDir = "~/controller-second"; config.agents.controllerArgs = "--test-flag"; fs.writeFileSync(path.join(project, "factory.config.json"), JSON.stringify(config, null, 2));
  r = run("update"); assert.equal(r.status, 0, r.stdout + r.stderr);
  r = run("start"); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /claude --test-flag "Read/, "the Controller session carries its configured arguments");
  spawnSync("pkill", ["-f", path.join(twoHome, "controller-second", "loadlog.sh")]);
  const ctl = path.join(twoHome, "controller-second");
  assert.ok(fs.existsSync(path.join(ctl, "CONTROLLER.md")));
  for (const f of ["CONTROLLER.md", "templates/mkspec.mjs", "wave.mjs", "runscript.mjs", "wavewait.mjs", "capacity.mjs"]) assert.doesNotMatch(fs.readFileSync(path.join(ctl, f), "utf8"), /~\/controller(?!-second)\b/, f);
  assert.match(fs.readFileSync(path.join(ctl, "CONTROLLER.md"), "utf8"), /~\/controller-second\/status\.md/);
  for (const f of ["wave.mjs", "runscript.mjs", "integ-wave.sh"]) assert.doesNotMatch(fs.readFileSync(path.join(ctl, f), "utf8"), /\/tmp\/(wave|integ-wave)/, `${f}: a fixed /tmp file would mix two projects' waves`);
  // The shared gate serves this project from inside its checkout: its slots and its pool, not the other project's.
  fs.writeFileSync(path.join(ctl, "gate-slots.json"), JSON.stringify({ unit: 1, e2e: 1 }));
  const gate = path.join(twoHome, ".local/bin/gate"); assert.ok(fs.existsSync(path.join(twoHome, ".local/bin/gate.mjs")));
  const tmpDir = path.join(base, "tmp"); fs.mkdirSync(tmpDir);
  r = spawnSync(gate, ["sh", "-c", "ls \"$TMPDIR\""], { cwd: project, encoding: "utf8", env: { ...env, TMPDIR: tmpDir } });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /second-gate-unit/); assert.doesNotMatch(r.stdout, /first-gate/);
});

test("agent entry questions, answers, status and start in an isolated home", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "af-entry-"));
  const project = path.join(base, "project"), entryHome = path.join(base, "home"), bin = path.join(base, "bin");
  fs.mkdirSync(project); fs.mkdirSync(entryHome); fs.mkdirSync(bin);
  for (const name of ["orca", "claude"]) { fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 }); }
  const env = { ...process.env, HOME: entryHome, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FACTORY_SKIP_ORCA: "1" };
  const run = (...args) => spawnSync("node", [CLI, ...args], { cwd: project, env, encoding: "utf8", timeout: 30000 });
  const gitEntry = (...args) => { const r = spawnSync("git", args, { cwd: project, env, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  try {
    gitEntry("init", "-q", "-b", "main"); gitEntry("config", "user.name", "Test"); gitEntry("config", "user.email", "test@example.com");
    fs.writeFileSync(path.join(project, "README.md"), "# Demo\n"); gitEntry("add", "README.md"); gitEntry("commit", "-qm", "initial");
    // Keep stdin open: status must exit without waiting for EOF.
    const status = await new Promise((resolve, reject) => {
      const child = spawn("node", [CLI, "status", "--json"], { cwd: project, env });
      let out = "", err = ""; child.stdout.on("data", (b) => { out += b; }); child.stderr.on("data", (b) => { err += b; });
      const timer = setTimeout(() => { child.kill(); reject(new Error("status waited for stdin")); }, 5000);
      child.on("error", reject); child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    });
    assert.equal(status.code, 0, status.err); assert.equal(JSON.parse(status.out).phase, "onboarding");
    let r = run("init", "--print-questions"); assert.equal(r.status, 0, r.stderr);
    const questions = JSON.parse(r.stdout); assert.ok(questions.open.length);
    assert.equal(questions.questions.find((q) => q.id === "project.repo").recommended, `local:${path.join(entryHome, ".factory-remotes", `project-${createHashHex(fs.realpathSync(project))}.git`)}`);
    const rules = questions.questions.find((q) => q.id === "rules.confirm"); assert.ok(rules); assert.match(rules.context, /no real data or secrets/); assert.match(rules.context, /workers never push to main/);
    assert.equal(gitEntry("status", "--porcelain"), ""); assert.equal(gitEntry("remote"), "");
    const answers = path.join(base, "answers.json"); fs.writeFileSync(answers, JSON.stringify({ "hosts.where": "both" }));
    r = run("init", "--print-questions", "--answers", answers); assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).questions.some((q) => q.id === "hosts.remote.ssh"));
    fs.writeFileSync(answers, JSON.stringify({ "agents.default": "invalid" })); r = run("init", "--answers", answers);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /agents\.default.*codex, claude, pi/);
    for (const [values, pattern] of [
      [{ "preview.port": "abc" }, /preview\.port.*number/], [{ "reviews.maxRounds": "x" }, /reviews\.maxRounds.*number/],
      [{ "project.name": " " }, /project\.name.*empty/], [{ "hosts.remote.name": "" }, /hosts\.remote\.name.*empty/],
      [{ "hosts.remote.ssh": "" }, /hosts\.remote\.ssh.*empty/], [{ "host.where": "local" }, /unknown id.*valid ids/],
      [{ "rules.confirm": "no" }, /rules\.confirm.*yes/], [{ "rules.confirm": true }, /rules\.confirm.*yes/],
    ]) {
      fs.writeFileSync(answers, JSON.stringify({ "rules.confirm": "yes", ...values })); r = run("init", "--answers", answers);
      assert.notEqual(r.status, 0); assert.match(r.stderr, pattern); assert.equal(gitEntry("remote"), ""); assert.equal(gitEntry("status", "--porcelain"), "");
    }
    fs.writeFileSync(answers, "{}"); r = run("init", "--answers", answers); assert.notEqual(r.status, 0); assert.match(r.stderr, /rules\.confirm.*yes/);
    assert.equal(gitEntry("remote"), "", "invalid answers must not create a remote");
    fs.writeFileSync(answers, JSON.stringify({ "project.humanName": "Test Human", "agents.default": "claude", "skills.installNow": "no", "rules.confirm": "yes" }));
    r = run("init", "--answers", answers); assert.equal(r.status, 0, r.stdout + r.stderr);
    const config = JSON.parse(fs.readFileSync(path.join(project, "factory.config.json"), "utf8"));
    assert.equal(config.project.humanName, "Test Human"); assert.equal(config.agents.default, "claude");
    r = run("status", "--json"); assert.equal(r.status, 0, r.stderr); const state = JSON.parse(r.stdout);
    assert.equal(state.phase, "start"); assert.equal(state.work.debtOpen, 0, "template example is not open debt");
    r = run("start"); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Controller session:.*\n\s+cd .*claude/);
    const front = fs.readFileSync(path.join(entryHome, "front-agent", config.project.name, "FRONT_AGENT.md"), "utf8");
    assert.ok(front.includes(CLI)); assert.doesNotMatch(front, /\{\{.*?\}\}/);
    assert.ok(fs.existsSync(path.join(entryHome, "controller", "CONTROLLER.md"))); assert.ok(fs.existsSync(path.join(entryHome, ".local/bin/gate")));
    const statusFile = path.join(entryHome, "controller", "status.md");
    fs.writeFileSync(statusFile, "## Needs human\n| Question | Since |\n|---|---|\n- none\n- Offer a none-of-the-above option?\n");
    r = run("status", "--json"); let updated = JSON.parse(r.stdout); assert.deepEqual(updated.work.needsHuman, ["- Offer a none-of-the-above option?"]); assert.equal(updated.phase, "decisions");
    fs.writeFileSync(statusFile, "## Needs human\n| Question | Since |\n|---|---|\n- nothing\n- keine\n");
    r = run("status", "--json"); assert.deepEqual(JSON.parse(r.stdout).work.needsHuman, []);
    const gh = path.join(bin, "gh"); fs.writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' '[{"number":7,"title":"Choose","labels":[{"name":"needs-human"}]}]'\n`, { mode: 0o755 });
    config.steering.mode = "github-issues"; fs.writeFileSync(path.join(project, "factory.config.json"), JSON.stringify(config));
    r = run("status", "--json"); updated = JSON.parse(r.stdout); assert.equal(updated.work.tickets.byStatus["needs-human"], 1); assert.deepEqual(updated.work.needsHuman, ["Issue #7: Choose"]); assert.equal(updated.phase, "decisions");
    const fakeOrca = path.join(bin, "orca");
    const writeOrca = (title) => fs.writeFileSync(fakeOrca, `#!/bin/sh\nif [ "$1" = status ]; then printf '%s\\n' '{"ok":true}'; else printf '%s\\n' '${JSON.stringify({ result: { terminals: [{ title }] } })}'; fi\n`, { mode: 0o755 });
    fs.unlinkSync(statusFile); writeOrca(`other-${config.project.name} · Controller`);
    const withOrca = () => spawnSync("node", [CLI, "status", "--json"], { cwd: project, encoding: "utf8", env: { ...env, FACTORY_SKIP_ORCA: "0", ORCA_CLI_COMMAND: fakeOrca } });
    assert.equal(JSON.parse(withOrca().stdout).setup.controller.terminal, false);
    writeOrca(`${config.project.name} · Controller`); assert.equal(JSON.parse(withOrca().stdout).setup.controller.terminal, true);
    const calls = path.join(base, "calls");
    fs.writeFileSync(fakeOrca, `#!/bin/sh\nif [ "$1" = terminal ] && [ "$2" = create ]; then printf '%s\\n' "$@" > '${calls}.orca'; printf '%s\\n' '{"ok":true}'; else printf '%s\\n' '{"result":{"terminals":[]}}'; fi\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "rsync"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\ncase "$*" in *'printf '*) printf '/remote/home\\n';; *) printf '%s\\n' "$*" > '${calls}.ssh'; printf 'ok\\n';; esac\n`, { mode: 0o755 });
    config.hosts.workers = [{ name: "remote", kind: "remote", ssh: "fake", projectsDir: "~/projects", orcaEnvironment: "saved-server" }]; config.hosts.controller.host = "remote";
    fs.writeFileSync(path.join(project, "factory.config.json"), JSON.stringify(config));
    r = spawnSync("node", [CLI, "start"], { cwd: project, encoding: "utf8", env: { ...env, FACTORY_SKIP_ORCA: "0", ORCA_CLI_COMMAND: fakeOrca } });
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(fs.readFileSync(`${calls}.ssh`, "utf8"), /pgrep -f "\[b\]ash loadlog\.sh"/);
    const orcaArgs = fs.readFileSync(`${calls}.orca`, "utf8"); assert.match(orcaArgs, /saved-server/); assert.match(orcaArgs, /path:\/remote\/home\/projects\/project/);
    config.hosts.workers[0].orcaEnvironment = ""; fs.writeFileSync(path.join(project, "factory.config.json"), JSON.stringify(config));
    r = spawnSync("node", [CLI, "start"], { cwd: project, encoding: "utf8", env: { ...env, FACTORY_SKIP_ORCA: "0", ORCA_CLI_COMMAND: fakeOrca } });
    assert.notEqual(r.status, 0); assert.match(r.stdout, /hosts\.workers\[\]\.orcaEnvironment/);
  } finally {
    spawnSync("pkill", ["-f", path.join(entryHome, "controller", "loadlog.sh")]);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("init in a fresh repo writes the factory files, a local remote and the pushed adoption commit", () => {
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "echo ok", lint: "echo lint" } }));
  git("add", "-A"); git("commit", "-qm", "init");
  const out = node(CLI, "init", "--yes");
  assert.match(out, /local bare remote/);
  assert.match(out, /Adopt agentic-factory \(ADR-0001\), pushed to origin\/main/);
  assert.match(fs.readFileSync(path.join(tmp, "docs/adr/0001-adopt-agentic-factory.md"), "utf8"), /^# ADR-0001:/m);
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

test("a repo with its own pre-commit (hooksPath already armed, trailing exit 0) keeps it, gets the review gate (merge), and its adoption is pushed; own ADR numbering is respected", () => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "af-own-"));
  const g = (...a) => { const r = spawnSync("git", a, { cwd: own, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
  g("init", "-q", "-b", "main"); g("config", "user.email", "o@example.com"); g("config", "user.name", "o");
  fs.mkdirSync(path.join(own, ".githooks")); fs.writeFileSync(path.join(own, ".githooks/pre-commit"), "#!/bin/sh\nset -e\necho OWN-HOOK-RAN >&2\nexit 0\n"); fs.chmodSync(path.join(own, ".githooks/pre-commit"), 0o755);
  g("config", "core.hooksPath", ".githooks");   // the project already arms its hooks, like most projects with a .githooks/
  fs.mkdirSync(path.join(own, "docs/adr"), { recursive: true }); fs.writeFileSync(path.join(own, "docs/adr/0001-first.md"), "# ADR-0001: First\n\nStatus: accepted\nDecided by: o (2026-01-01)\n");
  fs.writeFileSync(path.join(own, "package.json"), JSON.stringify({ name: "own", scripts: { test: "echo ok" } }));
  g("add", "-A"); g("commit", "-qm", "init");
  const out = execFileSync("node", [CLI, "init", "--yes"], { cwd: own, encoding: "utf8", env: { ...process.env, HOME: home, FACTORY_SKIP_ORCA: "1" } });
  assert.match(out, /hooks\.mode = "merge"/); assert.match(out, /Adopt agentic-factory \(ADR-0002\), pushed to origin\/main/, "adoption pushed although hooks were armed");
  assert.ok(fs.existsSync(path.join(own, "docs/adr/0002-adopt-agentic-factory.md")), "adoption ADR under the next free number");
  assert.ok(fs.existsSync(path.join(own, "docs/adr/0000-template.md")), "ADR template written");
  assert.match(fs.readFileSync(path.join(own, ".githooks/pre-commit"), "utf8"), /pre-commit\.own[\s\S]*factory-guardrails\.mjs static-checks/, "factory pre-commit runs the own hook first");
  assert.match(fs.readFileSync(path.join(own, ".githooks/pre-commit.own"), "utf8"), /OWN-HOOK-RAN/);
  assert.equal(g("status", "--porcelain").split("\n").filter((l) => l && !/\.factory\//.test(l)).join(""), "", "the merged hooks are committed");
  assert.match(g("show", "origin/main:.githooks/pre-commit"), /factory-guardrails/, "origin/main carries the factory pre-commit");
  assert.match(g("ls-tree", "--name-only", "origin/main"), /AGENTS\.md/);
  // The own hook runs, and a staged secret is still rejected (the own hook's exit 0 does not short-circuit the guardrails).
  fs.writeFileSync(path.join(own, "s.js"), 'const k = "sk-abcdefghijklmnopqrstuvwxyz1234567890";\n'); g("add", "s.js");
  const bad = spawnSync("git", ["commit", "-qm", "secret"], { cwd: own, encoding: "utf8" }); assert.notEqual(bad.status, 0); assert.match(bad.stderr, /OWN-HOOK-RAN/); assert.match(bad.stderr + bad.stdout, /secrets/);
  fs.rmSync(path.join(own, "s.js")); g("reset", "-q");
  fs.writeFileSync(path.join(own, "x.js"), "export const x = 1;\n"); g("add", "x.js");
  const c = spawnSync("git", ["commit", "-qm", "x"], { cwd: own, encoding: "utf8" }); assert.equal(c.status, 0, c.stderr); assert.match(c.stderr, /OWN-HOOK-RAN/);
  const p = spawnSync("git", ["push", "-q", "origin", "main"], { cwd: own, encoding: "utf8" }); assert.notEqual(p.status, 0); assert.match(p.stderr, /Push to main rejected/);
  const doc = spawnSync("node", [CLI, "doctor"], { cwd: own, encoding: "utf8", env: { ...process.env, HOME: home } }); assert.match(doc.stdout, /hook \.githooks\/pre-push wired \(merge\)/); assert.match(doc.stdout, /own hook kept as \.githooks\/pre-commit\.own/);
  assert.match(fs.readFileSync(path.join(own, "AGENTS.md"), "utf8"), /<hook>\.own/, "AGENTS.md names the merge");
});

// A husky v8 layout: hooks in .husky, core.hooksPath=.husky, a prepare script that re-points hooksPath on every install.
test("husky v8 hooks are merged in place; the prepare script cannot disarm the gate", () => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "af-husky8-"));
  const g = (...a) => { const r = spawnSync("git", a, { cwd: own, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
  g("init", "-q", "-b", "main"); g("config", "user.email", "h@example.com"); g("config", "user.name", "h");
  fs.mkdirSync(path.join(own, ".husky")); fs.writeFileSync(path.join(own, ".husky/pre-commit"), "#!/bin/sh\necho HUSKY-RAN >&2\n"); fs.chmodSync(path.join(own, ".husky/pre-commit"), 0o755); g("config", "core.hooksPath", ".husky");
  fs.writeFileSync(path.join(own, "package.json"), JSON.stringify({ name: "husky", scripts: { test: "echo ok", prepare: "git config core.hooksPath .husky" } })); g("add", "-A"); g("commit", "-qm", "init");
  const out = execFileSync("node", [CLI, "init", "--yes"], { cwd: own, encoding: "utf8", env: { ...process.env, HOME: home, FACTORY_SKIP_ORCA: "1" } });
  assert.match(out, /own hooks in \.husky \(pre-commit\)/); assert.equal(g("config", "core.hooksPath"), ".husky", "hooksPath stays where husky put it");
  assert.ok(fs.existsSync(path.join(own, ".husky/pre-push")) && fs.readFileSync(path.join(own, ".husky/pre-push"), "utf8").includes("factory-guardrails"), "the factory pre-push lives in .husky");
  g("config", "core.hooksPath", ".husky");   // what `npm install` → prepare does
  fs.writeFileSync(path.join(own, "y.js"), "export const y = 1;\n"); g("add", "y.js");
  const c = spawnSync("git", ["commit", "-qm", "y"], { cwd: own, encoding: "utf8" }); assert.equal(c.status, 0, c.stderr); assert.match(c.stderr, /HUSKY-RAN/, "the husky hook still runs");
  const p = spawnSync("git", ["push", "-q", "origin", "main"], { cwd: own, encoding: "utf8" }); assert.notEqual(p.status, 0); assert.match(p.stderr, /Push to main rejected/, "the review gate survives the prepare script");
});

// A husky v9 layout: core.hooksPath=.husky/_ with shims that run .husky/<hook> through `sh -e`.
test("husky v9 hooks are merged in place and the gate bites", () => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "af-husky9-"));
  const g = (...a) => { const r = spawnSync("git", a, { cwd: own, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
  g("init", "-q", "-b", "main"); g("config", "user.email", "h@example.com"); g("config", "user.name", "h");
  fs.mkdirSync(path.join(own, ".husky/_"), { recursive: true });
  fs.writeFileSync(path.join(own, ".husky/_/h"), '#!/usr/bin/env sh\ns=$(dirname "$(dirname "$0")")/$(basename "$0")\n[ -f "$s" ] || exit 0\nsh -e "$s" "$@"\n');
  for (const h of ["pre-commit", "commit-msg", "pre-push", "pre-merge-commit"]) { fs.writeFileSync(path.join(own, `.husky/_/${h}`), '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n'); fs.chmodSync(path.join(own, `.husky/_/${h}`), 0o755); }
  fs.writeFileSync(path.join(own, ".husky/pre-commit"), "echo HUSKY9-RAN >&2\n"); g("config", "core.hooksPath", ".husky/_");
  fs.writeFileSync(path.join(own, "package.json"), JSON.stringify({ name: "husky9", scripts: { test: "echo ok" } })); g("add", "-A"); g("commit", "-qm", "init");
  const out = execFileSync("node", [CLI, "init", "--yes"], { cwd: own, encoding: "utf8", env: { ...process.env, HOME: home, FACTORY_SKIP_ORCA: "1" } });
  assert.match(out, /husky layout, core.hooksPath stays \.husky\/_/); assert.equal(g("config", "core.hooksPath"), ".husky/_");
  assert.match(fs.readFileSync(path.join(own, ".husky/pre-commit.own"), "utf8"), /HUSKY9-RAN/);
  fs.writeFileSync(path.join(own, "s.js"), 'const k = "sk-abcdefghijklmnopqrstuvwxyz1234567890";\n'); g("add", "s.js");
  const bad = spawnSync("git", ["commit", "-qm", "secret"], { cwd: own, encoding: "utf8" }); assert.notEqual(bad.status, 0, "a secret is rejected behind husky"); assert.match(bad.stderr + bad.stdout, /secrets/);
  fs.rmSync(path.join(own, "s.js")); g("reset", "-q");
  fs.writeFileSync(path.join(own, "y.js"), "export const y = 1;\n"); g("add", "y.js");
  const c = spawnSync("git", ["commit", "-qm", "y"], { cwd: own, encoding: "utf8" }); assert.equal(c.status, 0, c.stderr); assert.match(c.stderr, /HUSKY9-RAN/);
  const p = spawnSync("git", ["push", "-q", "origin", "main"], { cwd: own, encoding: "utf8" }); assert.notEqual(p.status, 0); assert.match(p.stderr, /Push to main rejected/);
  const doc = spawnSync("node", [CLI, "doctor"], { cwd: own, encoding: "utf8", env: { ...process.env, HOME: home } }); assert.equal(doc.status, 0, doc.stdout); assert.match(doc.stdout, /hook \.husky\/pre-push wired \(merge\)/);
  // The hooks directory is protected wherever it lives.
  fs.appendFileSync(path.join(own, ".husky/pre-push"), "\n# tampered\n"); g("add", ".husky/pre-push");
  const t = spawnSync("git", ["commit", "-qm", "weaken the gate"], { cwd: own, encoding: "utf8" }); assert.notEqual(t.status, 0, ".husky/pre-push is a protected path"); assert.match(t.stderr + t.stdout, /Protected files/);
  g("checkout", "-q", "HEAD", "--", ".husky/pre-push"); g("reset", "-q");
  // update on a merged repo changes nothing and does not mistake the factory's pre-merge-commit for an own hook.
  const up = execFileSync("node", [CLI, "update"], { cwd: own, encoding: "utf8", env: { ...process.env, HOME: home, FACTORY_SKIP_ORCA: "1" } });
  assert.match(up, /0 updated, 0 kept/); assert.ok(!fs.existsSync(path.join(own, ".husky/pre-merge-commit.own")), "no phantom .own file");
});

test("init on an empty repository (no commit yet) works and names the project after its directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-empty-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main"); g("config", "user.email", "e@example.com"); g("config", "user.name", "e");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "empty", scripts: { test: "echo ok" } }));
  const out = execFileSync("node", [CLI, "init", "--yes"], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: home, FACTORY_SKIP_ORCA: "1" } });
  assert.match(out, /Adopt agentic-factory \(ADR-0001\), pushed to origin\/main/); assert.match(out, /add\s+package\.json \(untracked/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "factory.config.json"), "utf8")).project.name, path.basename(dir));
  const tree = g("ls-tree", "--name-only", "origin/main"); assert.match(tree, /AGENTS\.md/); assert.match(tree, /package\.json/, "the manifest the install command needs is on origin");
  assert.equal(g("status", "--porcelain"), "", "nothing left untracked");
  // Starting over at the same path without a commit: the stale bare is foreign, init stops cleanly.
  fs.rmSync(path.join(dir, ".git"), { recursive: true }); g("init", "-q", "-b", "main"); g("config", "user.email", "e@example.com"); g("config", "user.name", "e");
  for (const f of fs.readdirSync(dir)) if (f !== "package.json" && f !== ".git") fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  const r = spawnSync("node", [CLI, "init", "--yes"], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: home, FACTORY_SKIP_ORCA: "1" } });
  assert.notEqual(r.status, 0); assert.match(r.stdout, /holds a different history/); assert.equal(g("remote"), "");
});

test("a relative filesystem remote names the project after its directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-rel-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main"); g("config", "user.email", "r@example.com"); g("config", "user.name", "r");
  execFileSync("git", ["init", "-q", "--bare", path.join(dir, "..", `${path.basename(dir)}-rel.git`)]); g("remote", "add", "origin", `../${path.basename(dir)}-rel.git`);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "rel", scripts: { test: "echo ok" } })); g("add", "-A"); g("commit", "-qm", "init");
  execFileSync("node", [CLI, "init", "--yes"], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: home, FACTORY_SKIP_ORCA: "1" } });
  const c = JSON.parse(fs.readFileSync(path.join(dir, "factory.config.json"), "utf8")); assert.equal(c.project.name, path.basename(dir)); assert.match(c.project.repo, /^local:\//);
});

test("a foreign local bare remote makes init stop cleanly, without a dangling origin", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "af-foreign-")));   // the CLI keys the bare by process.cwd(), the real path
  const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main"); g("config", "user.email", "f@example.com"); g("config", "user.name", "f");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n"); g("add", "a.txt"); g("commit", "-qm", "a");
  // Plant a bare with a different history where init would create this project's remote.
  const bare = path.join(home, ".factory-remotes", `${path.basename(dir)}-${createHashHex(dir)}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true }); execFileSync("git", ["init", "-q", "--bare", bare]);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "af-other-")); execFileSync("git", ["init", "-q", "-b", "main"], { cwd: other }); execFileSync("git", ["-c", "user.email=x@x", "-c", "user.name=x", "commit", "-q", "--allow-empty", "-m", "foreign"], { cwd: other }); execFileSync("git", ["push", "-q", bare, "main"], { cwd: other });
  const r = spawnSync("node", [CLI, "init", "--yes"], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: home, FACTORY_SKIP_ORCA: "1" } });
  assert.notEqual(r.status, 0); assert.match(r.stdout, /holds a different history/); assert.equal(g("remote"), "", "origin was not kept");
});

test("an absolute core.hooksPath inside the worktree is merged, not rejected", () => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "af-abs-"));
  const g = (...a) => { const r = spawnSync("git", a, { cwd: own, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
  g("init", "-q", "-b", "main"); g("config", "user.email", "a@example.com"); g("config", "user.name", "a");
  fs.mkdirSync(path.join(own, ".hooks")); fs.writeFileSync(path.join(own, ".hooks/pre-commit"), "#!/bin/sh\necho OWN-ABS-RAN >&2\n"); fs.chmodSync(path.join(own, ".hooks/pre-commit"), 0o755);
  g("config", "core.hooksPath", fs.realpathSync(path.join(own, ".hooks")));
  fs.writeFileSync(path.join(own, "package.json"), JSON.stringify({ name: "abs", scripts: { test: "echo ok" } })); g("add", "-A"); g("commit", "-qm", "init");
  const out = execFileSync("node", [CLI, "init", "--yes"], { cwd: fs.realpathSync(own), encoding: "utf8", env: { ...process.env, HOME: home, FACTORY_SKIP_ORCA: "1" } });
  assert.match(out, /own hooks in \.hooks \(pre-commit\)/);
  fs.writeFileSync(path.join(own, "y.js"), "export const y = 1;\n"); g("add", "y.js");
  const c = spawnSync("git", ["commit", "-qm", "y"], { cwd: own, encoding: "utf8" }); assert.equal(c.status, 0, c.stderr); assert.match(c.stderr, /OWN-ABS-RAN/);
});

test("a global core.hooksPath is left alone: the factory uses .githooks, commits and pushes the adoption, the gate bites", () => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "af-global-"));
  const ghome = fs.mkdtempSync(path.join(os.tmpdir(), "af-ghome-"));
  const genv = { ...process.env, HOME: ghome, FACTORY_SKIP_ORCA: "1" };
  const g = (...a) => { const r = spawnSync("git", a, { cwd: own, encoding: "utf8", env: genv }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
  fs.mkdirSync(path.join(ghome, "hooks")); fs.writeFileSync(path.join(ghome, "hooks/pre-commit"), "#!/bin/sh\necho GLOBAL-HOOK >&2\n"); fs.chmodSync(path.join(ghome, "hooks/pre-commit"), 0o755);
  g("init", "-q", "-b", "main"); g("config", "user.email", "g@example.com"); g("config", "user.name", "g"); g("config", "--global", "core.hooksPath", path.join(ghome, "hooks"));
  fs.writeFileSync(path.join(own, "package.json"), JSON.stringify({ name: "glob", scripts: { test: "echo ok" } })); g("add", "-A"); g("commit", "-qm", "init");
  const out = execFileSync("node", [CLI, "init", "--yes"], { cwd: own, encoding: "utf8", env: genv });
  assert.match(out, /NOTE: a global core.hooksPath/); assert.match(out, /Adopt agentic-factory \(ADR-0001\), pushed to origin\/main/);
  assert.ok(fs.existsSync(path.join(ghome, "hooks/pre-commit")), "the global hook file is untouched"); assert.ok(!fs.existsSync(path.join(ghome, "hooks/pre-commit.own")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(own, "factory.config.json"), "utf8")).hooks.mode, "factory");
  assert.equal(g("config", "--local", "core.hooksPath"), ".githooks");
  fs.writeFileSync(path.join(own, "s.js"), 'const k = "sk-abcdefghijklmnopqrstuvwxyz1234567890";\n'); g("add", "s.js");
  const bad = spawnSync("git", ["commit", "-qm", "secret"], { cwd: own, encoding: "utf8", env: genv }); assert.notEqual(bad.status, 0); assert.match(bad.stderr + bad.stdout, /secrets/);
});

test("own commit-msg and own pre-push are merged too: the protected-files gate and the review gate exist", () => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "af-ownmsg-"));
  const g = (...a) => { const r = spawnSync("git", a, { cwd: own, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
  g("init", "-q", "-b", "main"); g("config", "user.email", "m@example.com"); g("config", "user.name", "m");
  fs.mkdirSync(path.join(own, ".githooks"));
  fs.writeFileSync(path.join(own, ".githooks/commit-msg"), "#!/bin/sh\necho OWN-MSG-RAN >&2\n"); fs.writeFileSync(path.join(own, ".githooks/pre-push"), "#!/bin/sh\necho OWN-PUSH-RAN >&2\ncat > /dev/null\n");
  for (const h of ["commit-msg", "pre-push"]) fs.chmodSync(path.join(own, `.githooks/${h}`), 0o755);
  g("config", "core.hooksPath", ".githooks");
  fs.writeFileSync(path.join(own, "package.json"), JSON.stringify({ name: "ownmsg", scripts: { test: "echo ok" } })); g("add", "-A"); g("commit", "-qm", "init");
  const out = execFileSync("node", [CLI, "init", "--yes"], { cwd: own, encoding: "utf8", env: { ...process.env, HOME: home, FACTORY_SKIP_ORCA: "1" } });
  assert.match(out, /own hooks in \.githooks \(commit-msg, pre-push\)/);
  fs.appendFileSync(path.join(own, "AGENTS.md"), "\n<!-- x -->\n"); g("add", "AGENTS.md");
  const bad = spawnSync("git", ["commit", "-qm", "touch agents"], { cwd: own, encoding: "utf8" }); assert.notEqual(bad.status, 0, "protected file without ADR rejected"); assert.match(bad.stderr + bad.stdout, /ADR-NNNN/); assert.match(bad.stderr, /OWN-MSG-RAN/, "the own commit-msg ran first");
  g("checkout", "-q", "HEAD", "--", "AGENTS.md"); g("reset", "-q");
  fs.writeFileSync(path.join(own, "z.js"), "export const z = 1;\n"); g("add", "z.js"); g("commit", "-qm", "z");
  const p = spawnSync("git", ["push", "-q", "origin", "main"], { cwd: own, encoding: "utf8" }); assert.notEqual(p.status, 0); assert.match(p.stderr, /OWN-PUSH-RAN/, "the own pre-push ran (and consumed stdin)"); assert.match(p.stderr, /Push to main rejected/, "the review gate still saw the ref updates");
});

test("init --keep-own-hooks leaves the project's hooks untouched (hooks.mode own) and says so", () => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "af-own2-"));
  const g = (...a) => execFileSync("git", a, { cwd: own, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main"); g("config", "user.email", "o@example.com"); g("config", "user.name", "o");
  fs.mkdirSync(path.join(own, ".githooks")); for (const h of ["pre-commit", "pre-push"]) { fs.writeFileSync(path.join(own, `.githooks/${h}`), "#!/bin/sh\nexit 0\n"); fs.chmodSync(path.join(own, `.githooks/${h}`), 0o755); }
  g("config", "core.hooksPath", ".githooks");
  fs.writeFileSync(path.join(own, "package.json"), JSON.stringify({ name: "own2", scripts: { test: "echo ok" } })); g("add", "-A"); g("commit", "-qm", "init");
  const out = execFileSync("node", [CLI, "init", "--yes", "--keep-own-hooks"], { cwd: own, encoding: "utf8", env: { ...process.env, HOME: home, FACTORY_SKIP_ORCA: "1" } });
  assert.match(out, /HOOKS: --keep-own-hooks: the project's hooks in \.githooks stay as they are; the factory hooks are NOT installed/);
  assert.equal(fs.readFileSync(path.join(own, ".githooks/pre-push"), "utf8"), "#!/bin/sh\nexit 0\n"); assert.ok(!fs.existsSync(path.join(own, "tools/factory-guardrails.mjs")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(own, "factory.config.json"), "utf8")).hooks.mode, "own");
  assert.match(fs.readFileSync(path.join(own, "AGENTS.md"), "utf8"), /hooks\.mode = own/, "the rendered docs say the own hooks enforce the gate");
  assert.match(fs.readFileSync(path.join(own, "docs/review-protocol.md"), "utf8"), /hooks\.mode = own/);
  const doc = spawnSync("node", [CLI, "doctor"], { cwd: own, encoding: "utf8", env: { ...process.env, HOME: home } }); assert.equal(doc.status, 0, doc.stdout); assert.match(doc.stdout, /own hook \.githooks\/pre-push/);
});

test("update derives and records adoptedOn for a project adopted before the field existed", () => {
  const cfgPath = path.join(tmp, "factory.config.json"); const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); const recorded = cfg.project.adoptedOn; delete cfg.project.adoptedOn; fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  const adr = fs.readFileSync(path.join(tmp, "docs/adr/0001-adopt-agentic-factory.md"), "utf8");
  const out = execFileSync("node", [CLI, "update"], { cwd: tmp, encoding: "utf8", env: { ...process.env, HOME: home, FACTORY_SKIP_ORCA: "1", FACTORY_TODAY: "2030-01-01" } });
  assert.match(out, /recorded project.adoptedOn = \d{4}-\d{2}-\d{2}/);
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, "utf8")).project.adoptedOn, recorded, "the adoption day is derived from git, not from the clock");
  assert.equal(fs.readFileSync(path.join(tmp, "docs/adr/0001-adopt-agentic-factory.md"), "utf8"), adr);
  tidy();
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
