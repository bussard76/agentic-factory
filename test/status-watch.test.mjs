// The status watch runs on a schedule, outside any session, so it works with whichever agent is in front. Fake Orca, real files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin/agentic-factory.mjs");

function setup({ terminals, idle = true, recordedHandle = null }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "af-watch-")));
  const watch = path.join(dir, "front"), ctl = path.join(dir, "controller"), project = path.join(dir, "project");
  for (const d of [watch, ctl, project]) fs.mkdirSync(d);
  for (const f of ["statuswatch.mjs", "hosts.mjs"]) fs.copyFileSync(path.join(ROOT, "front-agent", f), path.join(watch, f));
  fs.writeFileSync(path.join(watch, "factory.config.json"), JSON.stringify({ project: { name: "p", humanName: "H" }, agents: { runner: "orca" }, capacity: {}, hosts: { controller: { host: "local", controllerDir: ctl }, workers: [{ name: "local", kind: "local", workspacesDir: path.join(dir, "ws") }] } }));
  fs.writeFileSync(path.join(watch, "front-agent.json"), JSON.stringify({ projectDir: project, handle: recordedHandle }));
  const state = path.join(dir, "fake.json"), log = path.join(dir, "calls.log");
  const write = (s) => fs.writeFileSync(state, JSON.stringify(s));
  write({ idle, terminals: terminals(project) });
  const fake = path.join(dir, "fake-orca.mjs");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const a = process.argv.slice(2), s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
if (a[1] === "send" || a[1] === "set") fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
if (s.broken) { console.error("orca: not available"); process.exit(1); }
if (a[1] === "wait" && !s.idle) process.exit(1);
console.log(JSON.stringify({ ok: true, result: { terminals: s.terminals, wait: { satisfied: s.idle } } }));`, { mode: 0o755 });
  const status = (needs, age = 0) => { const f = path.join(ctl, "status.md"); fs.writeFileSync(f, `## On main\nabc\n\n## Needs H\n${needs}\n\n## Problems\n`); const t = new Date(Date.now() - age * 60_000); fs.utimesSync(f, t, t); };
  const run = () => { const r = spawnSync("node", [path.join(watch, "statuswatch.mjs")], { encoding: "utf8", env: { ...process.env, ORCA_CLI_COMMAND: fake } }); assert.equal(r.status, 0, r.stderr); };
  const calls = (sub) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((a) => a[1] === sub) : []);
  return { dir, watch, project, write, status, run, calls, terminals, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const agentIn = (project, handle = "t1", title = "My session name") => ({ handle, title, worktreePath: project, agentIdentity: "whichever" });

test("a change reaches the Front agent's terminal, found by what Orca knows, whatever the agent calls itself", () => {
  const h = setup({ terminals: (p) => [agentIn(p), { handle: "shell", title: "user@host: x", worktreePath: p }, agentIn(p, "ctl", "p · Controller")] });
  h.status("nothing"); h.run();
  assert.equal(h.calls("send").length, 0, "the first run only sets the baseline");
  assert.ok(fs.existsSync(path.join(h.watch, "statuswatch.alive")));
  h.status("a question"); h.run();
  const sent = h.calls("send");
  assert.equal(sent.length, 1);
  assert.equal(sent[0][sent[0].indexOf("--terminal") + 1], "t1");
  assert.match(sent[0][sent[0].indexOf("--text") + 1], /NEEDS HUMAN: a question/);
  h.run();
  assert.equal(h.calls("send").length, 1, "nothing new, nothing sent");
  h.done();
});

test("a busy terminal is left alone: the alert waits, the sidebar shows it, and it arrives once", () => {
  const h = setup({ terminals: (p) => [agentIn(p)], idle: false });
  h.status("nothing"); h.run(); h.status("a question"); h.run();
  assert.equal(h.calls("send").length, 0);
  assert.match(JSON.stringify(h.calls("set")), /NEEDS HUMAN/);
  h.write({ idle: true, terminals: h.terminals(h.project) }); h.run();
  assert.equal(h.calls("send").length, 1);
  h.run();
  assert.equal(h.calls("send").length, 1);
  h.done();
});

test("two possible terminals are a guess, so nothing is sent; the name decides when it is there", () => {
  const h = setup({ terminals: (p) => [agentIn(p), agentIn(p, "t2", "Other")] });
  h.status("nothing"); h.run(); h.status("a question"); h.run();
  assert.equal(h.calls("send").length, 0);
  h.write({ idle: true, terminals: [agentIn(h.project), agentIn(h.project, "named", "p · Front Agent")] }); h.run();
  const sent = h.calls("send");
  assert.equal(sent[0][sent[0].indexOf("--terminal") + 1], "named");
  h.done();
});

test("a name or handle that outlived the agent does not win over the real agent", () => {
  const h = setup({ recordedHandle: "shell", terminals: (p) => [{ handle: "shell", title: "p · Front Agent", worktreePath: p }, { handle: "other", title: "p · Front Agent", worktreePath: "/another/project", agentIdentity: "x" }, agentIn(p, "real")] });
  h.status("nothing"); h.run(); h.status("a question"); h.run();
  const sent = h.calls("send");
  assert.equal(sent.length, 1);
  assert.equal(sent[0][sent[0].indexOf("--terminal") + 1], "real");
  h.done();
});

test("status text cannot submit early, and a broken Orca is reported instead of hidden", () => {
  const h = setup({ terminals: (p) => [agentIn(p)] });
  h.status("nothing"); h.run(); h.status("line one\r\nline \u001b[31mtwo \u009b3m"); h.run();
  const text = h.calls("send")[0]; assert.doesNotMatch(text[text.indexOf("--text") + 1], /[\x00-\x1f\x7f-\x9f]/);
  h.write({ broken: true, idle: true, terminals: [] }); h.status("another question"); h.run();
  assert.match(fs.readFileSync(path.join(h.watch, "statuswatch.problem"), "utf8"), /not available|failed/i);
  h.write({ idle: true, terminals: h.terminals(h.project) }); h.run();
  assert.equal(fs.existsSync(path.join(h.watch, "statuswatch.problem")), false);
  assert.match(JSON.stringify(h.calls("send").at(-1)), /another question/, "it still arrives");
  h.done();
});

test("a second run waits its turn, an old lock expires, and a broken state file loses no run", () => {
  const h = setup({ terminals: (p) => [agentIn(p)] });
  h.status("nothing"); h.run(); h.status("a question");
  const lock = path.join(h.watch, "statuswatch.lock"); fs.mkdirSync(lock);
  h.run();
  assert.equal(h.calls("send").length, 0, "another run holds the lock");
  const old = new Date(Date.now() - 11 * 60_000); fs.utimesSync(lock, old, old);
  h.run();
  assert.equal(h.calls("send").length, 1);
  assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(path.join(h.watch, "statuswatch-state.json"), '{"pending":null}');
  h.run();
  h.done();
});

test("a fresh start gives no false alert while the Controller has not written its status", () => {
  const h = setup({ terminals: (p) => [agentIn(p)] });
  h.run(); h.run();
  assert.equal(h.calls("send").length, 0);
  const f = path.join(h.watch, "statuswatch-state.json");
  const state = JSON.parse(fs.readFileSync(f, "utf8")); state.firstRun = Date.now() - 16 * 60_000; fs.writeFileSync(f, JSON.stringify(state));
  h.run();
  assert.match(JSON.stringify(h.calls("send")), /NO STATUS/, "after a while it is a real problem");
  h.done();
});

test("a lasting problem is announced once, and again after it went away", () => {
  const h = setup({ terminals: (p) => [agentIn(p)] });
  h.status("nothing", 40); h.run(); h.run();
  assert.equal(h.calls("send").length, 1);
  assert.match(JSON.stringify(h.calls("send")), /STALE/);
  h.status("nothing"); h.run(); h.status("nothing", 40); h.run();
  assert.equal(h.calls("send").length, 2);
  h.done();
});

test("the schedule keeps the rest of the crontab and can be repeated", async () => {
  const { statusWatchCronScript } = await import(path.join(ROOT, "bin/heartbeat-cron.mjs"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-sched-"));
  const tab = path.join(dir, "tab");
  fs.writeFileSync(tab, "0 1 * * * something-else\n");
  fs.writeFileSync(path.join(dir, "crontab"), `#!/bin/sh\nif [ "$1" = "-l" ]; then cat ${tab}; else cat > ${tab}.new && mv ${tab}.new ${tab}; fi\n`, { mode: 0o755 });
  const run = () => spawnSync("bash", ["-c", statusWatchCronScript("~/front-agent/p", "p", "/opt/node/bin")], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(run().stdout.trim(), "added");
  assert.equal(run().stdout.trim(), "exists");
  // A node version that is gone is replaced, not kept.
  const again = spawnSync("bash", ["-c", statusWatchCronScript("~/front-agent/p", "p", "/opt/node2/bin")], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(again.stdout.trim(), "added");
  assert.doesNotMatch(fs.readFileSync(tab, "utf8"), /\/opt\/node\/bin/);
  assert.equal(run().stdout.trim(), "added");
  const lines = fs.readFileSync(tab, "utf8");
  assert.match(lines, /something-else/);
  assert.equal(lines.split("statuswatch.mjs").length, 2, "one line");
  assert.match(lines, /^\*\/5 /m);
  assert.match(lines, /PATH="\/opt\/node\/bin:/, "cron finds node under nvm and the like");
  // A heartbeat and a watch in one directory do not hide each other.
  const { heartbeatCronScript } = await import(path.join(ROOT, "bin/heartbeat-cron.mjs"));
  assert.equal(spawnSync("bash", ["-c", heartbeatCronScript("~/front-agent/p", "p")], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }).stdout.trim(), "added");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("start schedules the watch and runs it once; status shows whether it runs, and a project that opted out is left alone", async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "af-sw-")));
  const home = path.join(base, "home"), project = path.join(base, "project"), bin = path.join(base, "bin"), tab = path.join(base, "tab");
  for (const d of [home, project, bin]) fs.mkdirSync(d);
  fs.writeFileSync(tab, "");
  fs.writeFileSync(path.join(bin, "crontab"), `#!/bin/sh\nif [ "$1" = "-l" ]; then cat ${tab}; else cat > ${tab}.new && mv ${tab}.new ${tab}; fi\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // launchd as a fake too: no test may ever reach the real scheduler.
  const launchLog = path.join(base, "launchctl.log");
  fs.writeFileSync(path.join(bin, "launchctl"), `#!/bin/sh\necho "$@" >> ${launchLog}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "orca"), `#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true, result: { terminals: [], repos: [] } }));\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: "1", FACTORY_SCHEDULER: "cron" };
  delete env.ORCA_TERMINAL_HANDLE; delete env.ORCA_CLI_COMMAND;
  const git = (...a) => { const r = spawnSync("git", a, { cwd: project, encoding: "utf8", env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const cli = (...a) => spawnSync("node", [CLI, ...a], { cwd: project, encoding: "utf8", env });
  git("init", "-q", "-b", "main"); git("config", "user.name", "T"); git("config", "user.email", "t@example.invalid");
  fs.writeFileSync(path.join(project, "README.md"), "x\n"); git("add", "."); git("commit", "-qm", "initial");
  fs.writeFileSync(path.join(base, "a.json"), JSON.stringify({ "project.name": "demo", "project.humanName": "H", "agents.default": "claude", "skills.installNow": "no", "rules.confirm": "yes" }));
  assert.equal(spawnSync("node", [CLI, "init", "--answers", path.join(base, "a.json"), "--experimental-terminal-runner"], { cwd: project, encoding: "utf8", env: { ...env, FACTORY_SKIP_ORCA: "1" } }).status, 0);
  const configFile = path.join(project, "factory.config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8")); config.agents.runner = "orca"; fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  assert.equal(cli("update").status, 0);
  const before = JSON.parse(cli("status", "--json").stdout);
  assert.equal(before.setup.statusWatch, false);
  assert.equal(before.setup.statusWatch, false);
  const r = cli("start");
  spawnSync("pkill", ["-f", path.join(home, "controller", "loadlog.sh")]);
  assert.match(r.stdout, /Status watch: scheduled/, r.stdout + r.stderr);
  assert.match(fs.readFileSync(tab, "utf8"), /statuswatch\.mjs/);
  const dir = path.join(home, "front-agent/demo");
  const recorded = JSON.parse(fs.readFileSync(path.join(dir, "front-agent.json"), "utf8"));
  assert.equal(recorded.projectDir, fs.realpathSync(project));
  assert.equal(recorded.orcaCommand, path.join(bin, "orca"), "a bare name would not be found under cron's PATH");
  for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, "statuswatch.alive")); i++) await new Promise((done) => setTimeout(done, 100));
  assert.equal(JSON.parse(cli("status", "--json").stdout).setup.statusWatch, true);
  assert.match(cli("doctor").stdout, /status watch running/);
  // Stopped polling: gone, whatever the file says.
  const old = new Date(Date.now() - 12 * 60_000); fs.utimesSync(path.join(dir, "statuswatch.alive"), old, old);
  assert.equal(JSON.parse(cli("status", "--json").stdout).setup.statusWatch, false);
  assert.match(JSON.parse(cli("status", "--json").stdout).next, /status watch is not running/);
  // A machine without a working cron still works, is told, and is not held in a phase.
  fs.writeFileSync(tab, ""); fs.writeFileSync(path.join(bin, "crontab"), `#!/bin/sh\nif [ "$1" = "-l" ]; then exit 0; fi\nexit 1\n`, { mode: 0o755 });
  const failed = cli("start");
  spawnSync("pkill", ["-f", path.join(home, "controller", "loadlog.sh")]);
  assert.match(failed.stdout, /Status watch: could not schedule.*statusWatch/);
  assert.equal(JSON.parse(cli("status", "--json").stdout).phase, before.phase, "the watch never decides the phase");
  // macOS: launchd, replaced each time, with the running node.
  fs.rmSync(path.join(dir, "statuswatch.alive"), { force: true });
  const launchd = spawnSync("node", [CLI, "start"], { cwd: project, encoding: "utf8", env: { ...env, FACTORY_SCHEDULER: "launchd" } });
  spawnSync("pkill", ["-f", path.join(home, "controller", "loadlog.sh")]);
  assert.match(launchd.stdout, /Status watch: scheduled/);
  const calls = fs.readFileSync(launchLog, "utf8").trim().split("\n");
  assert.match(calls[0], /^bootout gui\/\d+\/de\.agentic-factory\.statuswatch\.demo$/);
  assert.match(calls[1], /^bootstrap gui\/\d+ .*LaunchAgents\/de\.agentic-factory\.statuswatch\.demo\.plist$/);
  const plist = fs.readFileSync(path.join(home, "Library/LaunchAgents/de.agentic-factory.statuswatch.demo.plist"), "utf8");
  assert.ok(plist.includes(`<string>${process.execPath}</string>`)); assert.match(plist, /<integer>300<\/integer>/);
  assert.ok(plist.includes(`<string>${dir}</string>`));
  fs.writeFileSync(path.join(bin, "launchctl"), `#!/bin/sh\necho refused >&2\nexit 1\n`, { mode: 0o755 });
  const refused = spawnSync("node", [CLI, "start"], { cwd: project, encoding: "utf8", env: { ...env, FACTORY_SCHEDULER: "launchd" } });
  spawnSync("pkill", ["-f", path.join(home, "controller", "loadlog.sh")]);
  assert.match(refused.stdout, /could not schedule it \(refused\)/);
  config.hosts.frontAgent.statusWatch = false; fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  assert.doesNotMatch(JSON.parse(cli("status", "--json").stdout).next, /status watch/);
  fs.rmSync(base, { recursive: true, force: true });
});
