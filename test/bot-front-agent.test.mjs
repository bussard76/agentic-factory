// An Orca bot as the Front agent (hosts.frontAgent.kind = "orca-bot"): the precheck that decides when the bot wakes,
// start's one automation per bot, status and doctor, and the optional read grants. Fake Orca, fake ssh, a temporary HOME:
// no test may reach a real bot, a real automation or the real tool configs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addTomlAllowPaths, applyReadGrants } from "../bin/read-grants.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin/agentic-factory.mjs");
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

// --- the precheck ---------------------------------------------------------------------------------------
function watchSetup() {
  const dir = tmp("af-botwatch-");
  const watch = path.join(dir, "watch"), bin = path.join(dir, "bin");
  for (const d of [watch, bin]) fs.mkdirSync(d);
  for (const f of ["botwatch.mjs", "hosts.mjs"]) fs.copyFileSync(path.join(ROOT, "front-agent", f), path.join(watch, f));
  // A fake ssh: prints the "remote" status file the way the precheck's remote command does, or fails like a lost host.
  const remoteStatus = path.join(dir, "remote-status.md"), down = path.join(dir, "down");
  fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\n[ -f ${down} ] && { echo "ssh: connect to host srv: timed out" >&2; exit 255; }\nif [ -f ${remoteStatus} ]; then stat -c %Y ${remoteStatus} 2>/dev/null || stat -f %m ${remoteStatus}; cat ${remoteStatus}; else echo 0; fi\n`, { mode: 0o755 });
  const project = (name, remote) => {
    const fa = path.join(dir, "front-agent", name), ctl = path.join(dir, `controller-${name}`);
    fs.mkdirSync(fa, { recursive: true }); fs.mkdirSync(ctl);
    const workers = remote ? [{ name: "srv", kind: "remote", ssh: "srv" }] : [{ name: "local", kind: "local" }];
    fs.writeFileSync(path.join(fa, "factory.config.json"), JSON.stringify({ project: { name, humanName: "Hu" }, hosts: { controller: { host: workers[0].name, controllerDir: remote ? "~/ctl" : ctl }, workers, frontAgent: { kind: "orca-bot", bot: "front-bot", staleMinutes: 25 } } }));
    return { name, dir: fa, status: remote ? remoteStatus : path.join(ctl, "status.md") };
  };
  const alpha = project("alpha", false), beta = project("beta", true);
  fs.writeFileSync(path.join(watch, "projects.json"), JSON.stringify([alpha, beta].map(({ name, dir: d }) => ({ name, dir: d }))));
  const write = (p, { needs = "- none", front = "", problems = "", age = 0 } = {}) => {
    fs.writeFileSync(p.status, `# Status\n## Running\n| a |\n## Needs Hu\n${needs}\n${front ? `## Needs front agent\n${front}\n` : ""}## Problems\n${problems}\n## Next\n- more\n`);
    const t = new Date(Date.now() - age * 60_000); fs.utimesSync(p.status, t, t);
  };
  const run = () => spawnSync("node", [path.join(watch, "botwatch.mjs")], { encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  const wake = () => fs.readFileSync(path.join(watch, "wake.md"), "utf8");
  return { dir, watch, alpha, beta, write, run, wake, down: (on) => (on ? fs.writeFileSync(down, "") : fs.rmSync(down, { force: true })), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("the precheck sets a baseline, then wakes the bot only for a change, local and over ssh", () => {
  const h = watchSetup();
  h.write(h.alpha); h.write(h.beta);
  assert.equal(h.run().status, 1, "the first sight of a project is a baseline");
  const state = fs.readFileSync(path.join(h.watch, "botwatch.state"), "utf8").trim().split("\n");
  assert.deepEqual(state.map((l) => l.split("\t")[0]), ["alpha", "beta"], "one state line per project");
  assert.equal(h.run().status, 1, "nothing changed, the run is skipped");
  // Running activities and Next change all the time and wake nobody.
  fs.appendFileSync(h.alpha.status, "- even more\n");
  assert.equal(h.run().status, 1);
  h.write(h.beta, { needs: "- Q1: which colour? A or B" });
  const r = h.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(h.wake(), /## beta\nRules: .*front-agent\/beta\/FRONT_BOT\.md\n- NEEDS HU: - Q1: which colour\? A or B/);
  assert.doesNotMatch(h.wake(), /## alpha/);
  assert.equal(h.run().status, 1, "reported once");
  h.write(h.alpha, { front: "- may the worker use fixtures?" });
  assert.equal(h.run().status, 0);
  assert.match(h.wake(), /## alpha[\s\S]*NEEDS FRONT AGENT: - may the worker use fixtures\?/);
  h.write(h.alpha, { front: "- may the worker use fixtures?", problems: "- gate red twice" });
  assert.equal(h.run().status, 0);
  assert.match(h.wake(), /PROBLEMS: - gate red twice/);
  h.done();
});

test("a stale status and an unreachable host wake the bot once, not every 5 minutes", () => {
  const h = watchSetup();
  h.write(h.alpha); h.write(h.beta);
  h.run();
  h.write(h.alpha, { age: 30 });
  assert.equal(h.run().status, 0);
  assert.match(h.wake(), /## alpha[\s\S]*STALE: status\.md is 30 min old \(limit 25\)/);
  h.write(h.alpha, { age: 40 });
  assert.equal(h.run().status, 1, "still stale is not news");
  h.down(true);
  assert.equal(h.run().status, 0);
  assert.match(h.wake(), /## beta[\s\S]*UNREACHABLE: ssh: connect to host srv: timed out/);
  assert.equal(h.run().status, 1);
  // Back: the change seen while away is still news, compared with the last state that was read.
  h.down(false); h.write(h.beta, { needs: "- Q2" });
  assert.equal(h.run().status, 0);
  assert.match(h.wake(), /NEEDS HU: - Q2/);
  h.write(h.alpha); h.run(); h.write(h.alpha, { age: 30 });
  assert.equal(h.run().status, 0, "a new stale period is news again");
  h.done();
});

test("a project whose bundle is gone does not stop the others", () => {
  const h = watchSetup();
  h.write(h.alpha); h.write(h.beta); h.run();
  fs.rmSync(path.join(h.alpha.dir, "factory.config.json"));
  h.write(h.beta, { needs: "- Q3" });
  const r = h.run();
  assert.equal(r.status, 0);
  assert.match(r.stderr, /alpha:/);
  assert.match(h.wake(), /## beta/);
  assert.match(fs.readFileSync(path.join(h.watch, "botwatch.state"), "utf8"), /^alpha\t/m, "its state is kept");
  h.done();
});

// --- read grants ------------------------------------------------------------------------------------------
test("read grants are written only for the tools that are there, once, and never fail", () => {
  const home = tmp("af-grants-"), ctl = path.join(home, "controller");
  const paths = ["/w/project", "/w/workspaces/project/"];
  assert.deepEqual(applyReadGrants({ home, paths, controllerDir: ctl }), [], "no tool, nothing written");
  assert.equal(fs.existsSync(path.join(ctl, ".claude")), false);
  fs.mkdirSync(path.join(home, ".lean-ctx"));
  const toml = path.join(home, ".lean-ctx", "config.toml");
  fs.writeFileSync(toml, `minimal_overhead = true\n\n[shell]\nallow = ["git"]\n`);
  fs.mkdirSync(path.join(home, ".pi/agent/npm/node_modules/context-mode"), { recursive: true });
  const lines = applyReadGrants({ home, paths, controllerDir: ctl });
  assert.equal(lines.length, 2);
  const text = fs.readFileSync(toml, "utf8");
  assert.ok(text.indexOf("allow_paths") < text.indexOf("[shell]"), "a top-level key goes before the first table");
  assert.match(text, /"\/w\/workspaces\/project",/);
  const settings = JSON.parse(fs.readFileSync(path.join(ctl, ".claude/settings.local.json"), "utf8"));
  assert.deepEqual(settings.permissions.allow, ["Read(/w/project/**)", "Read(/w/workspaces/project/**)"]);
  // Idempotent.
  applyReadGrants({ home, paths, controllerDir: ctl });
  assert.equal(fs.readFileSync(toml, "utf8"), text);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctl, ".claude/settings.local.json"), "utf8")).permissions.allow.length, 2);
  // A file that cannot be read is reported, and the other tool still gets its grant.
  fs.writeFileSync(path.join(ctl, ".claude/settings.local.json"), "{ broken");
  const again = applyReadGrants({ home, paths: [...paths, "/w/more"], controllerDir: ctl });
  assert.match(again.find((l) => l.startsWith("context-mode")), /could not write the grant/);
  assert.match(fs.readFileSync(toml, "utf8"), /"\/w\/more"/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("an existing allow_paths keeps its entries and gains only the missing ones", () => {
  const { text, added } = addTomlAllowPaths(`a = 1\nallow_paths = [\n    "/one",\n    '/two',\n]\nb = 2\n`, ["/two", "/three"]);
  assert.deepEqual(added, ["/three"]);
  assert.equal(text, `a = 1\nallow_paths = [\n    "/one",\n    "/two",\n    "/three",\n]\nb = 2\n`);
  assert.equal(addTomlAllowPaths("", ["/x"]).text, `allow_paths = [\n    "/x",\n]\n`);
});

// --- start, status and doctor ----------------------------------------------------------------------------
function machine() {
  const base = tmp("af-bot-");
  const home = path.join(base, "home"), bin = path.join(base, "bin"), tab = path.join(base, "tab"), orcaState = path.join(base, "orca.json"), orcaLog = path.join(base, "orca.log");
  for (const d of [home, bin]) fs.mkdirSync(d);
  fs.writeFileSync(tab, "");
  fs.writeFileSync(path.join(bin, "crontab"), `#!/bin/sh\nif [ "$1" = "-l" ]; then cat ${tab}; else cat > ${tab}.new && mv ${tab}.new ${tab}; fi\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "launchctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(orcaState, JSON.stringify({ bots: [{ id: "b1", name: "front-bot" }, { id: "b2", name: "other-bot" }], automations: [{ id: "a0", name: "something else", bot: { botId: "b2" }, precheck: null }] }));
  fs.writeFileSync(path.join(bin, "orca"), `#!/usr/bin/env node
import fs from "node:fs";
const a = process.argv.slice(2), s = JSON.parse(fs.readFileSync(${JSON.stringify(orcaState)}, "utf8"));
const opt = (f) => a[a.indexOf(f) + 1];
const out = (result) => console.log(JSON.stringify({ ok: true, result }));
if (a[0] === "bot" && a[1] === "list") out({ bots: s.bots });
else if (a[0] === "automations" && a[1] === "list") out({ automations: s.automations });
else if (a[0] === "automations" && a[1] === "create") {
  fs.appendFileSync(${JSON.stringify(orcaLog)}, JSON.stringify(a) + "\\n");
  const bot = s.bots.find((b) => b.name === opt("--bot"));
  s.automations.push({ id: "a" + s.automations.length, name: opt("--name"), bot: { botId: bot.id, runsIn: opt("--runs-in"), resultsTo: opt("--results-to") }, precheck: { command: opt("--precheck") } });
  fs.writeFileSync(${JSON.stringify(orcaState)}, JSON.stringify(s));
  out({ automation: s.automations.at(-1) });
} else out({ terminals: [], repos: [] });
`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: "1", FACTORY_SCHEDULER: "cron" };
  delete env.ORCA_TERMINAL_HANDLE; delete env.ORCA_CLI_COMMAND; delete env.ORCA_CLI_BIN_DIR;
  const project = (name, front) => {
    const dir = path.join(base, name);
    fs.mkdirSync(dir);
    const git = (...a) => { const r = spawnSync("git", a, { cwd: dir, encoding: "utf8", env }); assert.equal(r.status, 0, r.stderr); };
    git("init", "-q", "-b", "main"); git("config", "user.name", "T"); git("config", "user.email", "t@example.invalid");
    fs.writeFileSync(path.join(dir, "README.md"), "x\n"); git("add", "."); git("commit", "-qm", "initial");
    const answers = path.join(base, `${name}.json`);
    fs.writeFileSync(answers, JSON.stringify({ "project.name": name, "project.humanName": "Hu", "agents.default": "claude", "skills.installNow": "no", "rules.confirm": "yes" }));
    assert.equal(spawnSync("node", [CLI, "init", "--answers", answers, "--experimental-terminal-runner"], { cwd: dir, encoding: "utf8", env: { ...env, FACTORY_SKIP_ORCA: "1" } }).status, 0);
    const file = path.join(dir, "factory.config.json"), c = JSON.parse(fs.readFileSync(file, "utf8"));
    c.agents.runner = "orca";
    c.hosts.controller.controllerDir = `~/controller-${name}`;
    Object.assign(c.hosts.frontAgent, front);
    fs.writeFileSync(file, JSON.stringify(c, null, 2));
    const cli = (...a) => { const r = spawnSync("node", [CLI, ...a], { cwd: dir, encoding: "utf8", env }); spawnSync("pkill", ["-f", path.join(home, `controller-${name}`, "loadlog.sh")]); return r; };
    assert.equal(cli("update").status, 0);
    return { dir, cli };
  };
  const creates = () => (fs.existsSync(orcaLog) ? fs.readFileSync(orcaLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { base, home, tab, orcaState, project, creates, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test("start with a bot creates one automation with the precheck instead of the terminal watch; a second project shares it", () => {
  const m = machine();
  // lean-ctx is installed on this machine: start gives the Controller read access to the project and its workspaces.
  fs.mkdirSync(path.join(m.home, ".lean-ctx")); fs.writeFileSync(path.join(m.home, ".lean-ctx/config.toml"), "[shell]\n");
  const alpha = m.project("alpha", { kind: "orca-bot", bot: "front-bot" });
  const before = JSON.parse(alpha.cli("status", "--json").stdout);
  assert.deepEqual(before.setup.frontAgent, { kind: "orca-bot", bot: "front-bot", botExists: true, watchAutomation: false });
  assert.match(before.next, /no watch automation.*run `start`/);
  const r = alpha.cli("start");
  assert.match(r.stdout, /Bot watch: automation "agentic-factory watch · front-bot" created/, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /Status watch: scheduled/);
  assert.doesNotMatch(fs.readFileSync(m.tab, "utf8"), /statuswatch\.mjs/, "no terminal watch beside the bot");
  const [create] = m.creates();
  const arg = (f) => create[create.indexOf(f) + 1];
  assert.equal(arg("--bot"), "front-bot");
  assert.equal(arg("--trigger"), "*/5 * * * *");
  assert.equal(arg("--runs-in"), "chat");
  assert.equal(arg("--results-to"), "chat");
  const watchDir = path.join(m.home, "front-agent/.bots", fs.readdirSync(path.join(m.home, "front-agent/.bots"))[0]);
  assert.equal(arg("--precheck"), `sh ${JSON.stringify(path.join(watchDir, "botwatch.sh"))}`);
  assert.match(arg("--prompt"), /wake\.md/);
  for (const f of ["botwatch.mjs", "hosts.mjs", "botwatch.sh"]) assert.ok(fs.existsSync(path.join(watchDir, f)), f);
  assert.ok(fs.readFileSync(path.join(watchDir, "botwatch.sh"), "utf8").includes(path.dirname(process.execPath)), "node is found without this session's PATH");
  assert.match(fs.readFileSync(path.join(m.home, "front-agent/alpha/FRONT_BOT.md"), "utf8"), /Orca bot `front-bot`/);
  const ctl = fs.readFileSync(path.join(m.home, "controller-alpha/CONTROLLER.md"), "utf8");
  assert.match(ctl, /orca orchestration send --to "bot:front-bot" --type question/);
  assert.match(r.stdout, /Read access: lean-ctx: allow_paths \+= /);
  assert.ok(fs.readFileSync(path.join(m.home, ".lean-ctx/config.toml"), "utf8").includes(JSON.stringify(alpha.dir)));
  const after = JSON.parse(alpha.cli("status", "--json").stdout);
  assert.equal(after.setup.frontAgent.watchAutomation, true);
  assert.equal(after.setup.statusWatch, true);
  assert.doesNotMatch(after.next, /status watch|watch automation/);
  const doctor = alpha.cli("doctor").stdout;
  assert.match(doctor, /OK {6}Front agent bot front-bot/);
  assert.match(doctor, /OK {6}bot watch automation for front-bot/);
  assert.doesNotMatch(doctor, /status watch not running/);
  // Started again, and a second project naming the same bot: no second automation, one list with both.
  alpha.cli("start");
  const beta = m.project("beta", { kind: "orca-bot", bot: "front-bot" });
  const second = beta.cli("start");
  assert.match(second.stdout, /already exists for "front-bot"; this project is in its list/, second.stdout);
  assert.equal(m.creates().length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(watchDir, "projects.json"), "utf8")).map((p) => p.name), ["alpha", "beta"]);
  assert.equal(JSON.parse(beta.cli("status", "--json").stdout).setup.frontAgent.watchAutomation, true);
  // The precheck as Orca runs it (through a shell, without this session's PATH): a baseline, then news for beta.
  const precheck = () => spawnSync(arg("--precheck"), { shell: true, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: m.home } });
  const status = path.join(m.home, "controller-beta/status.md");
  fs.writeFileSync(status, "## Needs Hu\n- nothing\n## Problems\n");
  assert.equal(precheck().status, 1, precheck().stderr);
  fs.writeFileSync(status, "## Needs Hu\n- Q1: A or B?\n## Problems\n");
  assert.equal(precheck().status, 0);
  const wake = fs.readFileSync(path.join(watchDir, "wake.md"), "utf8");
  assert.ok(wake.includes(`## beta\nRules: ${path.join(m.home, "front-agent/beta/FRONT_BOT.md")}\nProject: ${beta.dir}\n- NEEDS HU: - Q1: A or B?`), wake);
  m.done();
});

test("a bot that Orca does not know fails start and shows in status and doctor; the terminal kind is untouched", () => {
  const m = machine();
  const p = m.project("gamma", { kind: "orca-bot", bot: "missing-bot" });
  const r = p.cli("start");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Orca has no bot named "missing-bot"/);
  assert.equal(m.creates().length, 0);
  assert.match(JSON.parse(p.cli("status", "--json").stdout).next, /"missing-bot" is not in `orca bot list`/);
  assert.match(p.cli("doctor").stdout, /MISSING Front agent bot missing-bot/);
  // The default: no bot fields, the terminal watch as before, and a CONTROLLER.md without the bot paragraph.
  const t = m.project("delta", {});
  const s = JSON.parse(t.cli("status", "--json").stdout);
  assert.equal(s.setup.frontAgent, undefined);
  assert.match(t.cli("start").stdout, /Status watch: scheduled/);
  assert.match(fs.readFileSync(m.tab, "utf8"), /front-agent\/delta.*statuswatch\.mjs/);
  assert.doesNotMatch(fs.readFileSync(path.join(t.dir, ".factory/controller/CONTROLLER.md"), "utf8"), /bot:|Orca bot/);
  assert.doesNotMatch(fs.readFileSync(path.join(t.dir, ".factory/controller/CONTROLLER.md"), "utf8"), /\{\{/);
  assert.equal(m.creates().length, 0);
  spawnSync("pkill", ["-f", path.join(m.home, "front-agent")]);
  // A Controller on another host cannot reach the bot: its handbook says so and sends nothing.
  const remote = m.project("epsilon", { kind: "orca-bot", bot: "front-bot" });
  const file = path.join(remote.dir, "factory.config.json"), c = JSON.parse(fs.readFileSync(file, "utf8"));
  c.hosts.workers.push({ name: "srv", kind: "remote", ssh: "srv", projectsDir: "~/projects", workspacesDir: "~/orca/workspaces" });
  c.hosts.controller.host = "srv";
  fs.writeFileSync(file, JSON.stringify(c, null, 2));
  assert.equal(remote.cli("update").status, 0);
  const handbook = fs.readFileSync(path.join(remote.dir, ".factory/controller/CONTROLLER.md"), "utf8");
  assert.match(handbook, /Do not send it to the bot: `bot:` only reaches bots on the same machine/);
  assert.doesNotMatch(handbook, /--to "bot:/);
  assert.match(fs.readFileSync(path.join(remote.dir, ".factory/front-agent/FRONT_BOT.md"), "utf8"), /ssh srv cat ~\/controller-epsilon\/status\.md/);
  m.done();
});
