// Onboarding: the Front agent kind (terminal or an Orca bot), the Controller directory, and install and release
// commands that come from what the project has. Throwaway repositories and a temporary HOME; no real Orca (FACTORY_SKIP_ORCA).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin/agentic-factory.mjs");

// A project with git, a temporary HOME, and fake package managers that create their lockfile like the real ones.
function setup({ pkg, managers = [] } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "af-onb-")));
  const project = path.join(base, "demo"), home = path.join(base, "home"), bin = path.join(base, "bin");
  for (const d of [project, home, bin]) fs.mkdirSync(d);
  const lock = { pnpm: "pnpm-lock.yaml", npm: "package-lock.json", yarn: "yarn.lock" };
  for (const m of ["orca", "claude", ...managers]) fs.writeFileSync(path.join(bin, m), `#!/bin/sh\n${lock[m] ? `[ "$1" = install ] && echo '# fake' > ${lock[m]}\n` : ""}exit 0\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FACTORY_SKIP_ORCA: "1" };
  const git = (...a) => { const r = spawnSync("git", a, { cwd: project, env, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git("init", "-q", "-b", "main"); git("config", "user.name", "T"); git("config", "user.email", "t@example.invalid");
  fs.writeFileSync(path.join(project, "README.md"), "x\n");
  if (pkg) fs.writeFileSync(path.join(project, "package.json"), JSON.stringify(pkg));
  git("add", "-A"); git("commit", "-qm", "initial");
  const answers = path.join(base, "answers.json");
  const run = (given, ...extra) => {
    fs.writeFileSync(answers, JSON.stringify(given));
    return spawnSync("node", [CLI, "init", "--answers", answers, ...extra], { cwd: project, env, encoding: "utf8", timeout: 60000 });
  };
  const config = () => JSON.parse(fs.readFileSync(path.join(project, "factory.config.json"), "utf8"));
  return { base, project, home, env, run, config };
}
const base = { "project.humanName": "Test Human", "agents.default": "claude", "skills.installNow": "no", "rules.confirm": "yes" };

test("the Front agent kind defaults to terminal, and the bot is a question of its own", () => {
  const t = setup();
  let r = spawnSync("node", [CLI, "init", "--print-questions"], { cwd: t.project, env: t.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const q = JSON.parse(r.stdout).questions;
  const kind = q.find((x) => x.id === "hosts.frontAgent.kind");
  assert.deepEqual(kind.options.map((o) => o.value), ["terminal", "orca-bot"]);
  assert.equal(kind.recommended, "terminal");
  assert.ok(q.find((x) => x.id === "hosts.controller.controllerDir"));
  assert.ok(!q.some((x) => x.id === "hosts.frontAgent.bot"), "no bot question while the kind is terminal");
  fs.writeFileSync(path.join(t.base, "a.json"), JSON.stringify({ "hosts.frontAgent.kind": "orca-bot" }));
  r = spawnSync("node", [CLI, "init", "--print-questions", "--answers", path.join(t.base, "a.json")], { cwd: t.project, env: t.env, encoding: "utf8" });
  const out = JSON.parse(r.stdout);
  assert.ok(out.open.includes("hosts.frontAgent.bot"), "the bot's name is the next open question");
});

test("without the new answers a project gets the terminal Front agent and ~/controller, as before", () => {
  const t = setup();
  const r = t.run(base); assert.equal(r.status, 0, r.stdout + r.stderr);
  const c = t.config();
  assert.equal(c.hosts.frontAgent.kind, "terminal"); assert.equal(c.hosts.frontAgent.bot, "");
  assert.equal(c.hosts.controller.controllerDir, "~/controller");
  assert.doesNotMatch(r.stdout, /Front agent bot/);
});

test("an orca-bot answer lands in the config, the bot's rules file and the checklist", () => {
  const t = setup();
  const r = t.run({ ...base, "hosts.frontAgent.kind": "orca-bot", "hosts.frontAgent.bot": "Helper Bot", "hosts.controller.controllerDir": "~/controller-demo" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const c = t.config();
  assert.equal(c.hosts.frontAgent.kind, "orca-bot"); assert.equal(c.hosts.frontAgent.bot, "Helper Bot");
  assert.equal(c.hosts.controller.controllerDir, "~/controller-demo");
  assert.match(r.stdout, /Front agent bot "Helper Bot".*create it in Orca first.*SOUL\.md.*FRONT_BOT\.md.*then run start/s);
  assert.match(r.stdout, /Controller bundle to ~\/controller-demo/, "the closing text names the chosen directory, not ~/controller");
  const rules = fs.readFileSync(path.join(t.project, ".factory/front-agent/FRONT_BOT.md"), "utf8");
  assert.match(rules, /`bot:Helper Bot`|--to "bot:Helper Bot"/);
  assert.match(rules, /orca bot item add --title/);
  assert.match(rules, /only inside your own run/);
  assert.doesNotMatch(rules, /orca bot item --help/, "no instruction to look the command up");
});

test("answers for the bot are checked", () => {
  const t = setup();
  for (const [given, pattern] of [
    [{ "hosts.frontAgent.kind": "robot" }, /hosts\.frontAgent\.kind.*terminal, orca-bot/],
    [{ "hosts.frontAgent.bot": "Helper" }, /hosts\.frontAgent\.bot.*orca-bot/],
    [{ "hosts.frontAgent.kind": "orca-bot", "hosts.frontAgent.bot": " " }, /hosts\.frontAgent\.bot.*must not be empty/],
    [{ "hosts.frontAgent.kind": "orca-bot" }, /needs the bot's name/],
    [{ "hosts.controller.controllerDir": "" }, /controllerDir.*must not be empty/],
  ]) {
    const r = t.run({ ...base, ...given });
    assert.notEqual(r.status, 0, JSON.stringify(given)); assert.match(r.stderr, pattern);
    assert.ok(!fs.existsSync(path.join(t.project, "factory.config.json")), "nothing written");
  }
});

test("a Controller directory that belongs to another project is not proposed; an answer always wins", () => {
  const t = setup();
  fs.mkdirSync(path.join(t.home, "controller")); fs.writeFileSync(path.join(t.home, "controller/factory.config.json"), JSON.stringify({ project: { name: "other" } }));
  const q = JSON.parse(spawnSync("node", [CLI, "init", "--print-questions"], { cwd: t.project, env: t.env, encoding: "utf8" }).stdout).questions.find((x) => x.id === "hosts.controller.controllerDir");
  assert.equal(q.recommended, "~/controller-demo");
  assert.match(q.context, /already holds the Controller of another project/); assert.match(q.context, /absolute path/);
  let r = t.run(base); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(t.config().hosts.controller.controllerDir, "~/controller-demo", "the proposal is the default");
  const u = setup(); fs.mkdirSync(path.join(u.home, "controller")); fs.writeFileSync(path.join(u.home, "controller/factory.config.json"), JSON.stringify({ project: { name: "other" } }));
  const abs = path.join(u.base, "ctl");
  r = u.run({ ...base, "hosts.controller.controllerDir": abs }); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(u.config().hosts.controller.controllerDir, abs);
});

test("the shared ~/controller stays the proposal where it is free or already this project's", () => {
  const t = setup();
  const ask = () => JSON.parse(spawnSync("node", [CLI, "init", "--print-questions"], { cwd: t.project, env: t.env, encoding: "utf8" }).stdout).questions.find((x) => x.id === "hosts.controller.controllerDir").recommended;
  assert.equal(ask(), "~/controller");
  fs.mkdirSync(path.join(t.home, "controller")); fs.writeFileSync(path.join(t.home, "controller/factory.config.json"), JSON.stringify({ project: { name: "demo" } }));
  assert.equal(ask(), "~/controller");
});

test("an answered install command wins over the detected package manager", () => {
  const t = setup({ pkg: { name: "demo", version: "1.0.0", packageManager: "npm@10.0.0", scripts: {} }, managers: ["pnpm", "npm"] });
  const r = t.run({ ...base, "commands.install": "npm install" }); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(t.config().commands.install, "npm install", "not replaced by a frozen pnpm command");
  assert.ok(fs.existsSync(path.join(t.project, "package-lock.json")), "the lockfile comes from the manager that was answered");
  assert.ok(!fs.existsSync(path.join(t.project, "pnpm-lock.yaml")));
});

test("an unanswered install proposal still becomes the frozen form once the lockfile exists", () => {
  const t = setup({ pkg: { name: "demo", version: "1.0.0", packageManager: "npm@10.0.0", scripts: {} }, managers: ["npm"] });
  const r = t.run(base); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(t.config().commands.install, "npm ci");
});

test("commands come from what the project has: nothing is invented", () => {
  const t = setup();   // no package.json, no lockfile
  const q = JSON.parse(spawnSync("node", [CLI, "init", "--print-questions"], { cwd: t.project, env: t.env, encoding: "utf8" }).stdout).questions.find((x) => x.id === "commands.install");
  const r = t.run(base); assert.equal(r.status, 0, r.stdout + r.stderr);
  const c = t.config();
  for (const k of ["install", "typecheck", "lint", "unit", "verify", "e2e"]) assert.equal(c.commands[k], "", `${k} stays empty`);
  assert.deepEqual(c.commands.release, []);
  assert.doesNotMatch(JSON.stringify(c.commands), /pnpm/);
  assert.equal(q.recommended, ""); assert.match(q.context, /none was found.*nothing is invented/s);
});

test("release commands are taken from the project's own scripts", () => {
  const t = setup({ pkg: { name: "demo", version: "1.0.0", packageManager: "npm@10.0.0", scripts: { "e2e:compose": "true", lint: "true" } }, managers: ["npm"] });
  const r = t.run(base); assert.equal(r.status, 0, r.stdout + r.stderr);
  const c = t.config();
  assert.deepEqual(c.commands.release, ["npm run e2e:compose"]);
  assert.equal(c.commands.lint, "npm run lint"); assert.equal(c.commands.typecheck, "");
});

test("START.md names the answer ids it tells the agent to use, in the order of the bot setup", () => {
  const t = setup();
  const ids = JSON.parse(spawnSync("node", [CLI, "init", "--print-questions"], { cwd: t.project, env: t.env, encoding: "utf8" }).stdout).questions.map((q) => q.id);
  const start = fs.readFileSync(path.join(ROOT, "START.md"), "utf8");
  for (const id of start.match(/`(hosts\.[A-Za-z.]+)`/g).map((m) => m.slice(1, -1)).filter((id) => id.startsWith("hosts.frontAgent") || id.startsWith("hosts.controller."))) assert.ok(ids.includes(id) || id === "hosts.frontAgent.bot", `${id} is a question id`);
  const at = (needle) => { const i = start.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  assert.ok(at("orca bot list") < at("SOUL.md") && at("SOUL.md") < at("`init`") && at("`init`") < at("Run `factory start`") && at("Run `factory start`") < at("`doctor`", at("Run `factory start`")));
});
