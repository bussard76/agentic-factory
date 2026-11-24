// update, doctor and start on an existing project: the Controller on the machine the CLI runs on (its configured ssh target does not
// resolve there), a handbook or config changed where the template put it, and the tracked config's formatting. A fake ssh and rsync fail
// for the alias as the real ones did on the server; they log every call, so "no ssh" is a fact the tests check.
import "./support/safe-env.mjs";
import { tempDir, expectBackground, stopBackground } from "./support/cleanup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin/agentic-factory.mjs");
const USER = os.userInfo().username;
const ALIAS = `${USER}@alias`;
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// A project on a "server": its configured host `server` has the ssh target user@alias, which fails to resolve (the fake ssh and rsync say
// so and log the call). The Controller directory and the clone are directories of this machine.
function world({ minimal = false, marker = true } = {}) {
  const base = fs.realpathSync(tempDir("af-ep-")); expectBackground(base);   // start launches a load logger and the status watch from here
  const home = path.join(base, "home"), project = path.join(base, "project"), bin = path.join(base, "bin"), ctl = path.join(base, "controller-demo");
  for (const d of [home, project, bin]) fs.mkdirSync(d);
  const log = (name) => path.join(base, `${name}.calls`);
  const fake = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const cron = path.join(base, "crontab.txt");
  fake("ssh", `printf '%s\\n' "$*" >> '${log("ssh")}'\necho "ssh: Could not resolve hostname alias: Name or service not known" >&2\nexit 255`);
  fake("rsync", `printf '%s\\n' "$*" >> '${log("rsync")}'\necho "rsync: connection unexpectedly closed" >&2\nexit 255`);
  fake("crontab", `if [ "$1" = -l ]; then cat '${cron}' 2>/dev/null; exit 0; fi\ncat > '${cron}'`);
  fake("launchctl", "exit 0");
  const orcaCalls = log("orca"), orca = path.join(bin, "orca-fake");
  fake("orca-fake", `printf '%s\\n' "$*" >> '${orcaCalls}'\ncase "$1 $2" in\n"terminal create") printf '%s\\n' '{"ok":true,"result":{"terminal":{"handle":"term-1","surface":"background"}}}';;\n"terminal list") printf '%s\\n' '{"result":{"terminals":[]}}';;\n*) printf '%s\\n' '{"ok":true}';;\nesac`);
  const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FACTORY_SCHEDULER: "cron", FACTORY_MACHINE_ID: "machine-A", FACTORY_HOSTNAME: "host-A", GIT_CONFIG_NOSYSTEM: "1" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
  const live = { ...env, FACTORY_SKIP_ORCA: "0", ORCA_CLI_COMMAND: orca };   // with the fake Orca
  const git = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, encoding: "utf8", env }); assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stdout}${r.stderr}`); return r.stdout.trim(); };
  git(project, "init", "-q", "-b", "main"); git(project, "config", "user.name", "T"); git(project, "config", "user.email", "t@example.invalid");
  fs.writeFileSync(path.join(project, "README.md"), "x\n"); git(project, "add", "."); git(project, "commit", "-qm", "initial");
  const answers = path.join(base, "answers.json");
  fs.writeFileSync(answers, JSON.stringify({ "project.name": "demo", "project.humanName": "Test Human", "agents.default": "claude", "skills.installNow": "no", "rules.confirm": "yes", "preview.enabled": "no" }));
  const init = spawnSync("node", [CLI, "init", "--answers", answers, ...(minimal ? ["--untracked-standard"] : [])], { cwd: project, encoding: "utf8", env: { ...env, FACTORY_SKIP_ORCA: "1" } });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const configFile = path.join(project, "factory.config.json");
  const readConfig = () => JSON.parse(fs.readFileSync(configFile, "utf8"));
  const writeConfig = (c) => fs.writeFileSync(configFile, JSON.stringify(c, null, 2) + "\n");
  const c = readConfig();
  c.hosts.workers = [{ name: "server", kind: "remote", ssh: ALIAS, sshConfig: "", projectDir: project, projectsDir: base, workspacesDir: path.join(base, "ws"), orcaEnvironment: "Env", orcaRepoId: "r1", capacity: { suiteWorkersMax: 4, readOnlyWorkersMax: 4 } }];
  c.hosts.controller = { ...c.hosts.controller, host: "server", controllerDir: ctl };
  writeConfig(c);
  const run = (cmd, extra = {}, ...a) => spawnSync("node", [CLI, cmd, ...a], { cwd: project, encoding: "utf8", env: { ...live, ...extra } });
  const calls = (name) => (fs.existsSync(log(name)) ? fs.readFileSync(log(name), "utf8").trim().split("\n").filter(Boolean) : []);
  const forget = () => { for (const n of ["ssh", "rsync"]) fs.rmSync(log(n), { force: true }); };
  const w = { base, home, project, ctl, bin, env, live, git, run, calls, forget, readConfig, writeConfig, configFile, cron, orcaCalls, fa: path.join(home, "front-agent/demo"), markerFile: path.join(home, ".config/agentic-factory/this-machine.json"),
    stop: () => { stopBackground(base); }, done: () => { stopBackground(base); fs.rmSync(base, { recursive: true, force: true }); } };
  if (marker) { const r = run("this-machine", {}, ALIAS); assert.equal(r.status, 0, r.stdout + r.stderr); forget(); }
  spawnSync("node", [CLI, "install-skills"], { cwd: project, encoding: "utf8", env });
  return w;
}

test("this-machine records an ssh target that does not resolve here, and refuses one that answers, a wrong user or an unknown host", () => {
  const w = world({ marker: false });
  const c = w.readConfig(); c.hosts.workers[0].ssh = "someone-else@alias"; w.writeConfig(c);
  let r = w.run("this-machine", {}, "someone-else@alias");
  assert.equal(r.status, 1); assert.match(r.stdout, /names the user someone-else/); assert.equal(fs.existsSync(w.markerFile), false);
  c.hosts.workers[0].ssh = ALIAS; w.writeConfig(c);
  r = w.run("this-machine", {}, `${USER}@elsewhere`);
  assert.equal(r.status, 1); assert.match(r.stdout, /No remote host in this project's factory\.config\.json has the ssh target/);
  fs.writeFileSync(path.join(w.bin, "ssh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
  r = w.run("this-machine", {}, ALIAS);
  assert.equal(r.status, 0); assert.match(r.stdout, /answers over ssh from here/); assert.equal(fs.existsSync(w.markerFile), false, "a target that answers is another machine or already reachable: nothing is recorded (and that is no failure)");
  fs.writeFileSync(path.join(w.bin, "ssh"), "#!/bin/sh\necho 'Could not resolve hostname' >&2\nexit 255\n", { mode: 0o755 });
  // A machine without an id cannot tell its record from another's: nothing is recorded, and an old record never matches there.
  r = w.run("this-machine", { FACTORY_MACHINE_ID: "" }, ALIAS);
  assert.equal(r.status, 1); assert.match(r.stdout, /no machine id/); assert.equal(fs.existsSync(w.markerFile), false);
  r = w.run("this-machine", {}, ALIAS);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.deepEqual(JSON.parse(fs.readFileSync(w.markerFile, "utf8")), { machines: [{ machineId: "machine-A", hostname: "host-a", ssh: [ALIAS] }] });
  assert.match(w.run("this-machine").stdout, /server \(.*\): this machine, handled locally/);
  assert.match(w.run("this-machine", { FACTORY_MACHINE_ID: "" }).stdout, /server .*: another machine, reached over ssh/, "an empty id never matches");
  // A record that came with a copied home (another machine's id), or with a clone that kept the id but not the host name, counts for nothing.
  assert.match(w.run("this-machine", { FACTORY_MACHINE_ID: "machine-B" }).stdout, /None of it counts for this machine/);
  assert.match(w.run("this-machine", { FACTORY_HOSTNAME: "host-clone" }).stdout, /server .*: another machine, reached over ssh/);
  // A home shared by two machines holds one entry each; --forget takes the one target of this machine, whatever the order of the words.
  r = w.run("this-machine", { FACTORY_MACHINE_ID: "machine-B", FACTORY_HOSTNAME: "host-b" }, ALIAS); assert.equal(r.status, 0, r.stdout);
  assert.equal(JSON.parse(fs.readFileSync(w.markerFile, "utf8")).machines.length, 2);
  assert.match(w.run("this-machine").stdout, /server \(.*\): this machine, handled locally/, "the second machine did not overwrite the first one's entry");
  r = w.run("this-machine", { FACTORY_MACHINE_ID: "machine-B", FACTORY_HOSTNAME: "host-b" }, "--forget", ALIAS); assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(w.markerFile, "utf8")).machines.map((e) => e.hostname), ["host-a"], "only the entry of the machine that said it");
  r = w.run("this-machine", {}, ALIAS, "--forget"); assert.equal(r.status, 0); assert.equal(fs.existsSync(w.markerFile), false);
  w.done();
});

test("update, start and doctor on the Controller's own machine do locally what they would do over ssh, and never call ssh or rsync", () => {
  const w = world({ minimal: true });
  let r = w.run("update");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /server: standard installed, hooks armed \(this machine\)/);
  assert.doesNotMatch(r.stdout, /cannot be reached/);
  r = w.run("start");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Controller bundle: .*controller-demo \(server, this machine\)/);
  for (const f of ["CONTROLLER.md", "gate", "gate.mjs", "factory.config.json", "heartbeat.mjs", "restart.mjs", "inbox.mjs", ".factory-installed.json"]) assert.ok(fs.existsSync(path.join(w.ctl, f)), `${f} copied locally`);
  assert.match(fs.readFileSync(w.cron, "utf8"), new RegExp(`cd "${w.ctl}".*node heartbeat\\.mjs`), "the heartbeat is scheduled in this machine's crontab");
  assert.match(r.stdout, /Heartbeat: cron line added/);
  assert.ok(fs.existsSync(path.join(w.fa, "FRONT_AGENT.md")), "the Front side is here too");
  assert.match(w.calls("orca").find((l) => l.startsWith("terminal create")), new RegExp(`--worktree path:${w.project}`), "the Controller opens in the clone, in the local Orca");
  assert.doesNotMatch(w.calls("orca").find((l) => l.startsWith("terminal create")), /--environment/);
  assert.ok(w.calls("orca").some((l) => l.startsWith("terminal focus --terminal term-1")), "a terminal Orca made in the background is focused");
  assert.match(fs.readFileSync(path.join(w.fa, "front-agent.json"), "utf8"), /projectDir/);
  r = w.run("doctor");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK\s+server is this machine/); assert.match(r.stdout, /OK\s+server: this project's gate/); assert.match(r.stdout, /OK\s+server: user-level skills present/);
  assert.doesNotMatch(r.stdout, /MISSING ssh/);
  assert.deepEqual(w.calls("ssh"), [], "ssh was never called"); assert.deepEqual(w.calls("rsync"), [], "rsync was never called");
  w.done();
});

test("the Front agent scripts read the Controller on this machine directly: no ssh to the alias on a scheduled run", () => {
  const w = world();
  assert.equal(w.run("update").status, 0);
  assert.equal(w.run("start").status, 0);
  fs.writeFileSync(path.join(w.ctl, "status.md"), "## On main\nabc\n\n## Needs Test Human\n- a question\n\n## Problems\n");
  const t = spawnSync("node", [path.join(w.fa, "statuswatch.mjs")], { encoding: "utf8", env: w.live });
  assert.equal(t.status, 0, t.stdout + t.stderr);
  assert.deepEqual(w.calls("ssh"), []);
  w.done();
});

test("a remote host that is not this machine is reported as before: update exits 1, doctor misses ssh, start fails its copy", () => {
  for (const marker of [false, "copied"]) {
    const w = world({ minimal: true, marker: false });
    if (marker === "copied") { fs.mkdirSync(path.dirname(w.markerFile), { recursive: true }); fs.writeFileSync(w.markerFile, JSON.stringify({ machines: [{ machineId: "machine-B", hostname: "host-a", ssh: [ALIAS] }] })); }
    let r = w.run("update");
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /server: no clone at .*, or the host cannot be reached\. Its clone keeps the older standard until this works\./);
    assert.match(r.stdout, /agentic-factory this-machine .*alias/, "it names the one step that tells the CLI this host is this machine");
    r = w.run("doctor");
    assert.equal(r.status, 1); assert.match(r.stdout, /MISSING ssh \S*alias reachable/);
    r = w.run("start");
    assert.equal(r.status, 1); assert.match(r.stdout, /Controller bundle: copy to server failed: .*could not look at/);
    assert.equal(fs.existsSync(path.join(w.ctl, "CONTROLLER.md")), false, "nothing was put in the local directory of the same name");
    assert.ok(w.calls("ssh").length > 0, "ssh was tried");
    w.done();
  }
});

// What an older factory left: the bundle rendered by it (recorded in the manifest), installed by it (no record at the destination).
function olderInstall(w, rel, oldText) {
  const manifestFile = path.join(w.project, ".factory/manifest.json"), manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const key = `.factory/controller/${rel}`;
  fs.writeFileSync(path.join(w.project, key), oldText); manifest.files[key] = sha(oldText);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  return (text = oldText) => { fs.mkdirSync(path.dirname(path.join(w.ctl, rel)), { recursive: true }); fs.writeFileSync(path.join(w.ctl, rel), text); };
}

test("a handbook changed only in the Controller directory is kept by update and start, the new one lies beside it, and the warnings fire for it", () => {
  const w = world();
  assert.equal(w.run("update").status, 0);
  // The state of the real case: an older factory rendered and installed the files; the project edited CONTROLLER.md in the Controller directory.
  const oldHandbook = "# Controller\nrun `node cleanup.mjs --all --prune-remote` every cycle\n";
  const install = olderInstall(w, "CONTROLLER.md", oldHandbook), installScript = olderInstall(w, "heartbeat.mjs", "// the older heartbeat\n");
  install(`${oldHandbook}Our own rule: never touch the billing module.\n`); installScript("// the project's own heartbeat\n");
  fs.rmSync(path.join(w.ctl, ".factory-installed.json"), { force: true });
  let r = w.run("update");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // No record of what was installed: nobody can say whether the project edited the handbook, so it is not kept silently (and not replaced silently either).
  assert.match(r.stdout, /WARNING: \S*controller-demo: CONTROLLER\.md will be replaced by the new version, because nothing says whether the project changed it/);
  assert.match(r.stdout, /CONTROLLER\.md\.backup-\d{4}-\d\d-\d\d/);
  assert.match(r.stdout, /NOTE: \S*controller-demo: 1 script\/code file\(s\) will be replaced.*heartbeat\.mjs → heartbeat\.mjs\.backup-/s);
  assert.match(fs.readFileSync(path.join(w.ctl, "CONTROLLER.md"), "utf8"), /billing module/, "update changes nothing in the Controller directory");
  r = w.run("start");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /WARNING: \S*controller-demo: CONTROLLER\.md was replaced by the new version/);
  assert.match(r.stdout, /all \d+ script\/code files are the new version/);
  assert.doesNotMatch(r.stdout, /keep\s+\S*controller-demo/, "nothing is kept when no baseline exists");
  const backups = fs.readdirSync(w.ctl).filter((f) => /^CONTROLLER\.md\.backup-/.test(f));
  assert.equal(backups.length, 1); assert.match(fs.readFileSync(path.join(w.ctl, backups[0]), "utf8"), /billing module/, "the project's text is not lost");
  assert.equal(fs.readFileSync(path.join(w.ctl, "CONTROLLER.md"), "utf8"), fs.readFileSync(path.join(w.project, ".factory/controller/CONTROLLER.md"), "utf8"));
  assert.equal(fs.readFileSync(path.join(w.ctl, "heartbeat.mjs"), "utf8"), fs.readFileSync(path.join(w.project, ".factory/controller/heartbeat.mjs"), "utf8"), "the older script is replaced");
  assert.match(fs.readFileSync(path.join(w.ctl, ".factory-installed.json"), "utf8"), /CONTROLLER\.md/, "from now on there is a baseline");
  // With a baseline, a change by the project is known for what it is: kept, the new version beside it, the warnings fire for the file in use.
  const own = fs.readFileSync(path.join(w.ctl, "CONTROLLER.md"), "utf8").replace(/inbox\.mjs --done/g, "inbox.mjs").replace(/restart\.md/g, "restart notes") + "\nOur own rule.\n";
  fs.writeFileSync(path.join(w.ctl, "CONTROLLER.md"), own);
  r = w.run("update");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /keep\s+\S*controller-demo\/CONTROLLER\.md \(changed there since the template installed it\)/);
  assert.match(r.stdout, /WARNING: \S*controller-demo\/CONTROLLER\.md does not mention .*inbox\.mjs/, "the warning is about the file in use");
  assert.match(fs.readFileSync(path.join(w.project, ".factory/new/.factory/controller/CONTROLLER.md"), "utf8"), /Controller/, "the new version is offered in .factory/new");
  assert.match(r.stdout, /[1-9]\d* kept/);
  r = w.run("start");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /keep\s+\S*controller-demo\/CONTROLLER\.md .*→ new version beside it: \S*CONTROLLER\.md\.new/);
  assert.equal(fs.readFileSync(path.join(w.ctl, "CONTROLLER.md"), "utf8"), own, "the project's handbook is still there");
  assert.equal(fs.readFileSync(path.join(w.ctl, "CONTROLLER.md.new"), "utf8"), fs.readFileSync(path.join(w.project, ".factory/controller/CONTROLLER.md"), "utf8"));
  r = w.run("doctor");
  assert.equal(r.status, 1); assert.match(r.stdout, /MISSING handbook: the Controller's CONTROLLER\.md does not mention/);
  assert.match(r.stdout, /OK\s+Controller directory: every script\/code file is the bundle's/, "the scripts are one version even though the handbook is the project's");
  // The human merges: after taking the new version, the next start says nothing.
  fs.copyFileSync(path.join(w.ctl, "CONTROLLER.md.new"), path.join(w.ctl, "CONTROLLER.md")); fs.rmSync(path.join(w.ctl, "CONTROLLER.md.new"));
  r = w.run("start");
  assert.doesNotMatch(r.stdout, /keep\s+\S*controller-demo/); assert.doesNotMatch(r.stdout, /WARNING: .*CONTROLLER\.md/);
  w.done();
});

test("a file the template installed and the project did not change is replaced by the next version, one the project changed in the Front agent directory is kept", () => {
  const w = world();
  assert.equal(w.run("update").status, 0);
  assert.equal(w.run("start").status, 0);
  const rec = () => JSON.parse(fs.readFileSync(path.join(w.ctl, ".factory-installed.json"), "utf8")).files;
  assert.equal(rec()["CONTROLLER.md"], sha(fs.readFileSync(path.join(w.ctl, "CONTROLLER.md"), "utf8")), "the record holds what start installed");
  // The project's next template: the bundle's handbook changes, nobody touched the installed one.
  const bundle = path.join(w.project, ".factory/controller/CONTROLLER.md");
  fs.appendFileSync(bundle, "\nA new rule.\n");
  fs.appendFileSync(path.join(w.fa, "FRONT_AGENT.md"), "\nOur own note.\n");
  fs.appendFileSync(path.join(w.project, ".factory/front-agent/FRONT_AGENT.md"), "\nA new front rule.\n");
  const r = w.run("start");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(fs.readFileSync(path.join(w.ctl, "CONTROLLER.md"), "utf8"), /A new rule\./, "untouched: replaced");
  assert.doesNotMatch(r.stdout, /keep\s+\S*controller-demo\/CONTROLLER\.md/);
  assert.match(r.stdout, /keep\s+\S*front-agent\/demo\/FRONT_AGENT\.md .*beside it/);
  assert.match(fs.readFileSync(path.join(w.fa, "FRONT_AGENT.md"), "utf8"), /Our own note\./);
  assert.match(fs.readFileSync(path.join(w.fa, "FRONT_AGENT.md.new"), "utf8"), /A new front rule\./);
  assert.match(fs.readFileSync(path.join(w.project, ".factory/new/.factory/front-agent/FRONT_AGENT.md"), "utf8"), /A new front rule\./, "start offers it in .factory/new too, as it says");
  w.done();
});

test("an installation with no record, whose files an older update recorded only in the committed manifest, is not taken for changed", () => {
  const w = world();
  // The adoption commit holds the first render of the Controller's config; an older start installed it; an older update moved the
  // manifest on to a render that was never installed; now the config changes and update runs.
  const key = ".factory/controller/factory.config.json";
  fs.mkdirSync(w.ctl, { recursive: true }); fs.copyFileSync(path.join(w.project, key), path.join(w.ctl, "factory.config.json"));
  olderInstall(w, "factory.config.json", '{"a render nobody installed": true}\n');
  const c = w.readConfig(); c.reviews.maxRounds = 5; w.writeConfig(c);
  let r = w.run("update");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /keep\s+\S*controller-demo\/factory\.config\.json/, "it was installed by the template, nobody changed it");
  r = w.run("start");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.ctl, "factory.config.json"), "utf8")).reviews.maxRounds, 5, "the change reached the Controller");
  assert.equal(fs.existsSync(path.join(w.ctl, "factory.config.json.new")), false);
  w.done();
});

test("a host is only taken for this machine when its clone is this repository here", () => {
  const w = world({ marker: false });
  const c = w.readConfig(); c.hosts.workers[0].projectDir = path.join(w.base, "somewhere-else"); w.writeConfig(c);
  const r = w.run("this-machine", {}, ALIAS);
  assert.equal(r.status, 1); assert.match(r.stdout, /is not this repository on this machine, so this cannot be that host/);
  assert.equal(fs.existsSync(w.markerFile), false);
  w.done();
});

test("a remote host's Controller directory is looked at over ssh with the real probe and rsync: a changed file is kept, the new one lands beside it, the rest is replaced", { skip: spawnSync("rsync", ["--version"]).status !== 0 }, () => {
  const w = world({ marker: false });
  // An ssh that runs the command on this machine, real rsync through it (as untracked-standard.test.mjs does): the host is reachable, and not this machine.
  // (The one command it does not run is start's skills-and-load-log line: a logger started through it keeps this fake's pipe open.)
  fs.writeFileSync(path.join(w.bin, "ssh"), '#!/bin/bash\nwhile [ "$1" = "-o" ] || [ "$1" = "-F" ]; do shift 2; done\nshift\ncase "$*" in *loadlog.sh*) echo ok; exit 0;; esac\nexec bash -c "$*"\n', { mode: 0o755 });
  fs.rmSync(path.join(w.bin, "rsync"));
  assert.equal(w.run("update").status, 0);
  let r = w.run("start");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Controller bundle: server:\S*controller-demo/);
  assert.ok(fs.existsSync(path.join(w.ctl, ".factory-installed.json")), "the record was written over rsync");
  fs.appendFileSync(path.join(w.ctl, "CONTROLLER.md"), "\nOur own rule.\n");
  fs.appendFileSync(path.join(w.project, ".factory/controller/heartbeat.mjs"), "\n// a newer heartbeat\n");
  fs.appendFileSync(path.join(w.ctl, "lib.mjs"), "\n// ours, on the server\n");
  fs.appendFileSync(path.join(w.ctl, "lib.mjs"), "\n// ours, on the server\n");
  r = w.run("update");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /keep\s+server:\S*controller-demo\/CONTROLLER\.md \(changed there since the template installed it\)/);
  r = w.run("start");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /keep\s+server:\S*controller-demo\/CONTROLLER\.md .*→ new version beside it/);
  assert.match(fs.readFileSync(path.join(w.ctl, "CONTROLLER.md"), "utf8"), /Our own rule\./);
  assert.equal(fs.readFileSync(path.join(w.ctl, "CONTROLLER.md.new"), "utf8"), fs.readFileSync(path.join(w.project, ".factory/controller/CONTROLLER.md"), "utf8"));
  assert.match(fs.readFileSync(path.join(w.ctl, "heartbeat.mjs"), "utf8"), /a newer heartbeat/, "a file nobody changed there is replaced");
  assert.equal(fs.readFileSync(path.join(w.ctl, "lib.mjs"), "utf8"), fs.readFileSync(path.join(w.project, ".factory/controller/lib.mjs"), "utf8"), "code is replaced on a remote host too");
  assert.ok(fs.readdirSync(w.ctl).some((n) => /^lib\.mjs\.backup-/.test(n) && /ours, on the server/.test(fs.readFileSync(path.join(w.ctl, n), "utf8"))), "and the project's copy is saved there");
  w.done();
});

test("a Controller config tuned in the Controller directory survives start: kept whole, the differing keys listed, the project's copy beside it", () => {
  const w = world();
  assert.equal(w.run("update").status, 0);
  assert.equal(w.run("start").status, 0);
  const own = path.join(w.ctl, "factory.config.json");
  // Untuned: a change of the tracked config reaches the Controller.
  let c = w.readConfig(); c.reviews.maxRounds = 5; w.writeConfig(c);
  assert.equal(w.run("update").status, 0);
  let r = w.run("start");
  assert.equal(JSON.parse(fs.readFileSync(own, "utf8")).reviews.maxRounds, 5, "nobody tuned it there: the tracked change is installed");
  assert.doesNotMatch(r.stdout, /keep\s+\S*factory\.config\.json/);
  // Tuned there: models, caps and calibration.
  const tuned = JSON.parse(fs.readFileSync(own, "utf8"));
  tuned.agents.models.default = "tuned-model"; tuned.hosts.workers[0].capacity.suiteWorkersMax = 10; tuned.hosts.workers[0].capacity.calibration = { foreignOnlyFloor: 8 };
  fs.writeFileSync(own, JSON.stringify(tuned, null, 2) + "\n");
  c = w.readConfig(); c.reviews.maxRounds = 3; w.writeConfig(c);
  assert.equal(w.run("update").status, 0);
  r = w.run("start");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(own, "utf8")), tuned, "the Controller's own copy is not changed, nothing is merged");
  assert.match(r.stdout, /keep\s+\S*factory\.config\.json \(it differs from the project's copy, so it stays as it is/);
  for (const key of ["agents.models.default", "reviews.maxRounds", "hosts.workers"]) assert.match(r.stdout, new RegExp(key.replace(/\./g, "\\.")), `${key} is listed`);
  assert.match(r.stdout, /agents\.models\.default \(there "tuned-model", project "/);
  for (const key of ["hosts.workers[server].capacity.suiteWorkersMax (there 10", "hosts.workers[server].capacity.calibration (there {\"foreignOnlyFloor\":8}"]) assert.ok(r.stdout.includes(key), `${key}: every differing key is named, an array of named hosts by the host's name`);
  assert.match(r.stdout, /differs from the project's in these \d+ keys:/);
  assert.match(r.stdout, /cp \S*factory\.config\.json\.new \S*factory\.config\.json/, "it says how to take the project's copy");
  assert.equal(JSON.parse(fs.readFileSync(`${own}.new`, "utf8")).reviews.maxRounds, 3);
  assert.equal(w.run("start").status, 0, "a kept config is not a failure");
  assert.match(w.run("doctor").stdout, /info\s+the Controller's factory\.config\.json .* differs from the project's in \d+ keys: .*agents\.models\.default/);
  w.done();
});

test("update leaves the tracked factory.config.json's formatting alone, and does not write it at all when nothing changes", () => {
  const w = world();
  // A file as prettier keeps it: four spaces, a short array on one line, a one-line object, no final newline.
  const c = w.readConfig(); delete c.project.adoptedOn; delete c.hooks;
  const body = JSON.stringify(c, null, 4).replace(/"release": \[\]/, '"release": ["npm run a", "npm run b"]').replace(/"commands": \{/, '"commands": {');
  const text = body.replace(/\n    "steering": \{/, '\n    "tiny": { "a": 1, "b": [1, 2] },\n    "steering": {');
  fs.writeFileSync(w.configFile, text);
  assert.equal(JSON.parse(text).tiny.b.length, 2);
  assert.equal(w.run("update", { FACTORY_TODAY: "2030-01-02" }).status, 0);
  const after = fs.readFileSync(w.configFile, "utf8");
  assert.match(JSON.parse(after).project.adoptedOn, /^\d{4}-\d\d-\d\d$/); assert.ok(JSON.parse(after).hooks.mode);
  assert.ok(after.includes('"tiny": { "a": 1, "b": [1, 2] },'), "a one-line object stays on one line");
  assert.ok(!after.endsWith("\n"), "no final newline was added");
  assert.ok(after.includes('\n    "project": {\n        "name": "demo"'), "four-space indentation stays");
  // Every line of the original is still there, in order; only added keys are new.
  const kept = text.split("\n").filter((l) => after.split("\n").includes(l));
  assert.deepEqual(kept.slice(0, 6), text.split("\n").slice(0, 6));
  // Nothing changes now: the file is not written (its modification time stays where a test put it).
  const past = new Date(Date.now() - 3_600_000); fs.utimesSync(w.configFile, past, past);
  assert.equal(w.run("update", { FACTORY_TODAY: "2030-01-02" }).status, 0);
  assert.equal(fs.statSync(w.configFile).mtimeMs, past.getTime(), "not rewritten");
  assert.equal(fs.readFileSync(w.configFile, "utf8"), after);
  w.done();
});

test("doctor says which factory is installed, and when the config records another", () => {
  const w = world();
  const c = w.readConfig(); c.factoryVersion = "0.1.11"; w.writeConfig(c);
  assert.equal(w.run("update").status, 0);
  assert.equal(w.readConfig().factoryVersion, "0.1.11", "update does not change what the config records");
  assert.equal(w.run("start").status, 0);
  const r = w.run("doctor");
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  assert.match(r.stdout, new RegExp(`OK\\s+factory ${version.replace(/\./g, "\\.")} installed`));
  assert.match(r.stdout, new RegExp(`info\\s+factory\\.config\\.json records factory 0\\.1\\.11 .*this is ${version.replace(/\./g, "\\.")}`));
  assert.doesNotMatch(r.stdout, /OK\s+factory\.config\.json \(project demo, factory 0\.1\.11\)/);
  w.done();
});

const codeFiles = (dir) => { const out = []; const walk = (d, rel = "") => { for (const e of fs.readdirSync(path.join(dir, d), { withFileTypes: true })) { const r = path.join(rel, e.name); if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r); } }; walk("."); return out.filter((r) => !/^[^/]+\.md$/.test(r) && r !== "factory.config.json"); };
const same = (a, b) => fs.readFileSync(a).equals(fs.readFileSync(b));

test("an untouched installation by an older version, whose baseline nobody can establish, is upgraded as one set: every script is new, nothing is kept, everything replaced is listed and saved", () => {
  const w = world();
  assert.equal(w.run("update").status, 0);
  // What a v0.1.13-style installation looks like to this CLI: every file of both directories is an older version, no record, no matching manifest hash.
  for (const [dir, bundle] of [[w.ctl, ".factory/controller"], [w.fa, ".factory/front-agent"]]) for (const rel of fs.readdirSync(path.join(w.project, bundle), { recursive: true }).filter((r) => fs.statSync(path.join(w.project, bundle, r)).isFile())) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    const text = fs.readFileSync(path.join(w.project, bundle, rel), "utf8");
    fs.writeFileSync(path.join(dir, rel), rel === "factory.config.json" ? JSON.stringify({ ...JSON.parse(text), olderKey: true }, null, 2) : `// an older version of ${rel}\n${text}`, { mode: 0o644 });
  }
  let r = w.run("update");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const keptLines = (out) => out.split("\n").filter((l) => /^\s+keep\s+\S*(controller-demo|front-agent)/.test(l) && !/factory\.config\.json/.test(l));
  assert.deepEqual(keptLines(r.stdout), [], "nothing is kept but the configs");
  r = w.run("start");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(keptLines(r.stdout), [], "nothing is kept but the configs");
  assert.match(r.stdout, /WARNING: \S*controller-demo: CONTROLLER\.md was replaced by the new version/, "the handbook and the config are named, with their copies");
  assert.match(r.stdout, /NOTE: \S*controller-demo: \d+ script\/code file\(s\) were replaced by the new version[\s\S]*lib\.mjs → lib\.mjs\.backup-\d{4}-\d\d-\d\d/, "every replaced script is listed");
  for (const [dir, bundle] of [[w.ctl, ".factory/controller"], [w.fa, ".factory/front-agent"]]) {
    for (const rel of codeFiles(path.join(w.project, bundle))) assert.ok(same(path.join(dir, rel), path.join(w.project, bundle, rel)), `${rel} is the new version`);
    assert.ok(fs.readdirSync(dir).some((f) => /^lib\.mjs\.backup-|^hosts\.mjs\.backup-/.test(f)), "the old copies are saved beside");
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".new") && f !== "factory.config.json.new").length, 0, "no .new but the config's: the config is never replaced");
  }
  assert.match(fs.readFileSync(path.join(w.ctl, "lib.mjs.backup-" + new Date().toISOString().slice(0, 10)), "utf8"), /^\/\/ an older version of lib\.mjs/);
  assert.ok(fs.statSync(path.join(w.ctl, "gate")).mode & 0o100, "the gate is executable");
  assert.equal(w.run("doctor").stdout.match(/MISSING .*version/g), null);
  assert.match(w.run("doctor").stdout, /OK\s+Controller directory: every script\/code file is the bundle's \(one version\)/);
  w.done();
});

test("a script the project changed after a start is code: replaced with the rest, the project's copy saved, so no two versions run side by side; a stale gate cannot stay", () => {
  const w = world();
  assert.equal(w.run("update").status, 0);
  assert.equal(w.run("start").status, 0);
  fs.appendFileSync(path.join(w.ctl, "lib.mjs"), "\n// the project's own change\n");
  fs.appendFileSync(path.join(w.ctl, "gate.mjs"), "\n// the project's own gate change\n");
  fs.appendFileSync(path.join(w.project, ".factory/controller/front-notice.mjs"), "\nexport const newerThing = 1;\n");   // the new version needs more of the whole set
  let r = w.run("doctor");
  assert.equal(r.status, 1); assert.match(r.stdout, /MISSING Controller directory \(\S*controller-demo\): 3 script\/code file\(s\) are not the version of this project's bundle \(.*gate\.mjs/);
  r = w.run("start");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const f of ["lib.mjs", "gate.mjs", "front-notice.mjs"]) assert.ok(same(path.join(w.ctl, f), path.join(w.project, ".factory/controller", f)), `${f} is the new version`);
  const day = new Date().toISOString().slice(0, 10);
  assert.match(fs.readFileSync(path.join(w.ctl, `lib.mjs.backup-${day}`), "utf8"), /the project's own change/, "nothing the project wrote is lost");
  assert.match(fs.readFileSync(path.join(w.ctl, `gate.mjs.backup-${day}`), "utf8"), /own gate change/);
  assert.match(r.stdout, /lib\.mjs → lib\.mjs\.backup-/); assert.match(r.stdout, /gate\.mjs → gate\.mjs\.backup-/);
  assert.equal(fs.existsSync(path.join(w.ctl, "front-notice.mjs.backup-" + day)), false, "a file the template installed itself is no one's change");
  assert.equal(w.run("doctor").status, 0);
  // A second change on the same day does not overwrite the first backup.
  fs.appendFileSync(path.join(w.ctl, "lib.mjs"), "\n// a second change\n");
  assert.equal(w.run("start").status, 0);
  assert.match(fs.readFileSync(path.join(w.ctl, `lib.mjs.backup-${day}-2`), "utf8"), /a second change/); assert.match(fs.readFileSync(path.join(w.ctl, `lib.mjs.backup-${day}`), "utf8"), /the project's own change/);
  w.done();
});

test("start restores a lost executable bit, and doctor says the installation is not one version while it is lost", () => {
  const w = world();
  assert.equal(w.run("update").status, 0);
  assert.equal(w.run("start").status, 0);
  fs.chmodSync(path.join(w.ctl, "gate"), 0o644);
  const r = w.run("doctor");
  assert.equal(r.status, 1); assert.match(r.stdout, /not the version of this project's bundle \(gate\)/);
  assert.equal(w.run("start").status, 0);
  assert.ok(fs.statSync(path.join(w.ctl, "gate")).mode & 0o100, "executable again");
  assert.equal(w.run("doctor").status, 0);
  w.done();
});

test("the evidence's case: an installation without any record keeps a Controller config that differs in controllerArgs, role models and caps, byte for byte, and lists every difference", () => {
  const w = world();
  assert.equal(w.run("update").status, 0);
  const own = path.join(w.ctl, "factory.config.json");
  const tuned = w.readConfig();
  tuned.agents.controllerArgs = "--model some-model --thinking high";
  tuned.agents.piRoleModels = { architect: "model-a", reviewer: "model-b" };
  tuned.agents.apiToken = "sk-should-never-be-printed";
  tuned.hosts.workers[0].capacity = { suiteWorkersMax: 10, readOnlyWorkersMax: 10, calibration: { foreignOnlyFloor: 8 } };
  tuned.hosts.workers[0].sshPassword = "hunter2-should-never-be-printed";
  fs.mkdirSync(w.ctl, { recursive: true });
  fs.writeFileSync(own, JSON.stringify(tuned, null, 4) + "\n");   // its own formatting: byte-identical afterwards
  const before = fs.readFileSync(own);
  assert.equal(fs.existsSync(path.join(w.ctl, ".factory-installed.json")), false, "no record: the case of every installation made by 0.1.13 or older");
  for (const cmd of ["update", "start"]) {
    const r = w.run(cmd);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /keep\s+\S*controller-demo\/factory\.config\.json \(it differs from the project's copy, so it stays as it is/);
    for (const key of ["agents.controllerArgs (there \"--model some-model --thinking high\"", "agents.piRoleModels.architect (there \"model-a\"", "agents.piRoleModels.reviewer (there \"model-b\"", "hosts.workers[server].capacity.suiteWorkersMax (there 10", "hosts.workers[server].capacity.calibration (there {\"foreignOnlyFloor\":8}"]) assert.ok(r.stdout.includes(key), `${cmd}: ${key}`);
    assert.match(r.stdout, /agents\.apiToken \(there \(hidden\), project \(absent\)\)/, "a value that can hold a secret is masked");
    assert.match(r.stdout, /hosts\.workers\[server\]\.sshPassword \(there \(hidden\)/);
    assert.doesNotMatch(r.stdout, /should-never-be-printed/);
    assert.ok(fs.readFileSync(own).equals(before), `${cmd}: the Controller's copy is byte-identical`);
  }
  assert.equal(JSON.parse(fs.readFileSync(`${own}.new`, "utf8")).project.name, "demo", "the project's copy lies beside it");
  assert.equal(fs.readdirSync(w.ctl).filter((f) => /^factory\.config\.json\.backup-/.test(f)).length, 0, "nothing replaced, so nothing to back up");
  assert.ok(fs.existsSync(path.join(w.ctl, ".factory-installed.json")), "start wrote the record of the rest");
  assert.ok(fs.readFileSync(own).equals(before), "also with a record now");
  w.done();
});

test("a Controller config without a key the scripts cannot run without stops start before anything is installed or started, and is not replaced", () => {
  const w = world();
  assert.equal(w.run("update").status, 0);
  fs.mkdirSync(w.ctl, { recursive: true });
  const broken = JSON.stringify({ agents: { default: "claude" } });
  fs.writeFileSync(path.join(w.ctl, "factory.config.json"), broken);
  const r = w.run("start");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /STOPPED: \S*controller-demo\/factory\.config\.json has no project\.name, hosts, which the scripts cannot run without/);
  assert.equal(fs.readFileSync(path.join(w.ctl, "factory.config.json"), "utf8"), broken);
  assert.equal(fs.existsSync(path.join(w.ctl, "heartbeat.mjs")), false, "nothing was installed");
  assert.equal(w.calls("orca").some((l) => l.startsWith("terminal create")), false, "no Controller was started");
  w.done();
});
