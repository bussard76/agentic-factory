// doctor and status warn about pi workers under the Orca runner (the human's own pi extensions can open a question dialog nobody
// answers), and name an installed question extension where pi's settings can be read. A temporary HOME with a fake pi settings
// file stands in for pi's real configuration; no real Orca, no real pi, no ssh to a real host.
import "./support/safe-env.mjs";
import { tempDir } from "./support/cleanup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin/agentic-factory.mjs");

function rig(agents = {}) {
  const base = fs.realpathSync(tempDir("af-pinote-"));
  const home = path.join(base, "home"), bin = path.join(base, "bin"), dir = path.join(base, "p");
  for (const d of [home, bin, dir]) fs.mkdirSync(d);
  for (const n of ["claude", "pi"]) fs.writeFileSync(path.join(bin, n), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: "1", FACTORY_SCHEDULER: "cron", FACTORY_SKIP_ORCA: "1" };
  for (const k of Object.keys(env)) if (k.startsWith("ORCA_") || k === "PI_CODING_AGENT_DIR") delete env[k];
  const run = (cmd, args, extra = {}) => spawnSync(cmd, args, { cwd: dir, encoding: "utf8", env: { ...env, ...extra } });
  const git = (...a) => assert.equal(run("git", a).status, 0);
  git("init", "-q", "-b", "main"); git("config", "user.name", "T"); git("config", "user.email", "t@example.invalid");
  fs.writeFileSync(path.join(dir, "README.md"), "x\n"); git("add", "."); git("commit", "-qm", "initial");
  const answers = path.join(base, "a.json");
  fs.writeFileSync(answers, JSON.stringify({ "project.name": "demo", "project.humanName": "Hu", "agents.default": "claude", "skills.installNow": "no", "rules.confirm": "yes" }));
  assert.equal(run("node", [CLI, "init", "--answers", answers, "--experimental-terminal-runner"]).status, 0);
  const file = path.join(dir, "factory.config.json"), c = JSON.parse(fs.readFileSync(file, "utf8"));
  c.agents = { ...c.agents, runner: "orca", ...agents };
  fs.writeFileSync(file, JSON.stringify(c, null, 2));
  const piDir = path.join(home, ".pi/agent");
  return {
    base, home, run, piDir,
    doctor: (extra) => run("node", [CLI, "doctor"], extra),
    status: (extra) => JSON.parse(run("node", [CLI, "status", "--json"], extra).stdout),
    setSettings: (obj, d = piDir) => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify(obj)); },
    done: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}
const WARN = /^warn    pi workers under the Orca runner may run with the human's own pi extensions and with Orca's default arguments for pi: the factory can pass the agent nothing\. A question tool from an extension can hang such a worker at a dialog nobody answers\. What to do: remove the extension on the worker host, or try setting default arguments for pi in Orca \(`--exclude-tools ask_user_question,question,questionnaire`, plus the name of any other question tool; the flag needs pi 0\.77\.0 or later, an older pi may refuse to start with it\) and check on one real worker that they apply \(ask it to list its tools\)\./m;

test("pi as default, fallback or in piRoleModels under the Orca runner shows the warning; claude only, or the terminal runner, does not", () => {
  for (const agents of [{ default: "pi" }, { fallback: { agent: "pi", models: {} } }, { piRoleModels: { Developer: "prov/model" } }]) {
    const r = rig(agents);
    try {
      assert.match(r.doctor().stdout, WARN, JSON.stringify(agents));
      assert.match(r.status().setup.piOrca.text, /^pi workers under the Orca runner/);
    } finally { r.done(); }
  }
  for (const agents of [{}, { default: "pi", runner: "terminal" }]) {
    const r = rig(agents);
    try {
      assert.doesNotMatch(r.doctor().stdout, /pi workers under the Orca runner/, JSON.stringify(agents));
      assert.equal(r.status().setup.piOrca, undefined);
    } finally { r.done(); }
  }
});

test("without a readable pi settings file the note is still shown, and says nothing was checked", () => {
  const r = rig({ default: "pi" });
  try {
    const out = r.doctor().stdout;
    assert.match(out, WARN);
    assert.match(out, /Not checked: local \(pi's settings could not be read\)/);
    assert.doesNotMatch(out, /Found in pi's settings|No question extension found/);
  } finally { r.done(); }
});

test("an installed question extension in pi's settings is named, as a warning that changes no exit code; installed is not active", () => {
  const r = rig({ default: "pi" });
  try {
    r.setSettings({ packages: ["npm:pi-web-access"] });
    const clean = r.doctor();
    assert.match(clean.stdout, /No question extension found by name \(ask-user, question, interview\) in pi's settings on local\./);
    const seen = r.doctor.bind(null);
    r.setSettings({ packages: ["npm:pi-web-access", "npm:@juicesharp/rpiv-ask-user-question", { source: "git:example.invalid/interview-tool", extensions: [] }] });
    const found = seen();
    assert.match(found.stdout, /Found in pi's settings: local: npm:@juicesharp\/rpiv-ask-user-question, git:example\.invalid\/interview-tool \(installed, not necessarily active\)\./);
    assert.equal(found.status, clean.status, "the exit code does not depend on the finding");
    assert.match(r.status().setup.piOrca.detected[0].names.join(), /rpiv-ask-user-question/);
    // a local extension file in the extensions directory counts by its name
    r.setSettings({});
    fs.mkdirSync(path.join(r.piDir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(r.piDir, "extensions", "questionnaire.ts"), "// fake\n");
    assert.match(r.doctor().stdout, /Found in pi's settings: local: questionnaire\.ts/);
    // the fake file was read, nothing was written next to it
    assert.deepEqual(fs.readdirSync(path.join(r.piDir, "extensions")), ["questionnaire.ts"]);
  } finally { r.done(); }
});

test("PI_CODING_AGENT_DIR is respected, and the real home is never read", () => {
  const r = rig({ default: "pi" });
  try {
    const other = path.join(r.base, "elsewhere");
    r.setSettings({ packages: ["npm:somewhere-else-ask-user"] }, other);
    r.setSettings({ packages: [] });   // the default location holds nothing
    assert.match(r.doctor({ PI_CODING_AGENT_DIR: other }).stdout, /Found in pi's settings: local: npm:somewhere-else-ask-user/);
    assert.match(r.doctor().stdout, /No question extension found by name \(ask-user, question, interview\) in pi's settings on local\./);
  } finally { r.done(); }
});

test("status stays on this machine and says a remote worker host was not checked; a broken settings file names nothing", () => {
  const r = rig({ default: "pi" });
  try {
    const file = path.join(r.run("pwd").stdout.trim(), "factory.config.json"), c = JSON.parse(fs.readFileSync(file, "utf8"));
    c.hosts.workers.push({ name: "srv", kind: "remote", ssh: "srv.invalid", projectsDir: "~/projects", workspacesDir: "~/orca/workspaces" });
    fs.writeFileSync(file, JSON.stringify(c, null, 2));
    fs.mkdirSync(r.piDir, { recursive: true });
    fs.writeFileSync(path.join(r.piDir, "settings.json"), "{ not json");
    const note = r.status().setup.piOrca;
    assert.match(note.text, /Not checked: srv \(remote host: only doctor checks it\)/);
    assert.deepEqual(note.detected, []);
  } finally { r.done(); }
});

// --- robustness: whatever the settings file holds, the check never throws and doctor's exit code stays what it was ---------------
test("a settings file holding null, a number, an array, a string or odd members never crashes doctor or status, and changes no exit code", () => {
  const r = rig({ default: "pi" });
  try {
    fs.mkdirSync(r.piDir, { recursive: true });
    const settings = path.join(r.piDir, "settings.json");
    const baseline = r.doctor().status;
    for (const body of ["null", "5", "[]", "\"x\"", "true", "{}", "", "{ not json", '{"packages":null}', '{"packages":"npm:ask-user"}', '{"packages":[null,5,{},[],{"source":7}]}', '{"extensions":{"a":1}}']) {
      fs.writeFileSync(settings, body);
      const d = r.doctor();
      assert.doesNotMatch(d.stderr, /TypeError|at piQuestion/, body);
      assert.match(d.stdout, WARN, body);
      assert.equal(d.status, baseline, `exit code with ${JSON.stringify(body)}`);
      const st = r.run("node", [CLI, "status", "--json"]);
      assert.equal(st.status, 0, body + st.stderr);
      assert.match(JSON.parse(st.stdout).setup.piOrca.text, /^pi workers under the Orca runner/);
    }
    // a directory where the file should be, and a settings file nobody may read
    fs.rmSync(settings); fs.mkdirSync(settings);
    assert.match(r.doctor().stdout, WARN);
  } finally { r.done(); }
});

test("names from pi's files are printed on one line, printable, at most 120 characters, at most 10 of them", () => {
  const r = rig({ default: "pi" });
  try {
    const long = "ask-user-" + "x".repeat(400);
    const many = Array.from({ length: 14 }, (_, n) => `npm:question-${n}`);
    r.setSettings({ packages: ["npm:ask-user-\u001b[2J\u001b]0;pwned\u0007\nINJECTED-LINE", long, ...many] });
    const out = r.doctor().stdout;
    assert.doesNotMatch(out, /\u001b|\u0007/, "no escape or control character reaches the terminal");
    const found = out.split("\n").filter((l) => /Found in pi's settings/.test(l));
    assert.equal(found.length, 1, "one line, however the names were written");
    assert.doesNotMatch(out, /^INJECTED-LINE/m);
    assert.ok(!/x{121}/.test(out), "a name is cut at 120 characters");
    assert.match(found[0], /\(6 more\)/, "ten names, then a count");
    const names = r.status().setup.piOrca.detected[0].names;
    assert.equal(names.length, 11);   // 16 matching names: ten, then the count
    assert.ok(names.every((n) => n.length <= 120 && /^[\x20-\x7e]+$/.test(n)));
  } finally { r.done(); }
});

// --- the ssh path, with a fake ssh on PATH that runs the remote command here, in this test's temp HOME ----------------------------
function sshRig() {
  const r = rig({ default: "pi" });
  const fakeBin = path.join(r.base, "sshbin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "ssh"), '#!/bin/sh\n[ -n "$FAKE_SSH_FAIL" ] && { echo "ssh: connect to host: timed out" >&2; exit 255; }\nfor a in "$@"; do last="$a"; done\nPI_CODING_AGENT_DIR="$FAKE_REMOTE_DIR" exec sh -c "$last"\n', { mode: 0o755 });
  const file = path.join(r.run("pwd").stdout.trim(), "factory.config.json"), c = JSON.parse(fs.readFileSync(file, "utf8"));
  c.hosts.workers = [{ name: "local", kind: "local" }, { name: "srv", kind: "remote", ssh: "srv.invalid", projectsDir: "~/projects", workspacesDir: "~/orca/workspaces" }];
  fs.writeFileSync(file, JSON.stringify(c, null, 2));
  const remoteDir = path.join(r.base, "remote-pi");
  r.setSettings({});   // this machine's own pi settings: present, nothing in them
  const doctor = (extra = {}) => r.run("node", [CLI, "doctor"], { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, FAKE_REMOTE_DIR: remoteDir, ...extra });
  return { ...r, remoteDir, doctor };
}

test("ssh: a remote host with settings but no extensions directory is read, not reported as unreadable", () => {
  const r = sshRig();
  try {
    fs.mkdirSync(r.remoteDir);
    fs.writeFileSync(path.join(r.remoteDir, "settings.json"), JSON.stringify({ packages: ["npm:ask-user-thing"] }));
    const out = r.doctor().stdout;
    assert.match(out, /Found in pi's settings: srv: npm:ask-user-thing \(installed, not necessarily active\)\./);
    assert.doesNotMatch(out, /could not be read/);
    // with an extensions directory its names count too
    fs.mkdirSync(path.join(r.remoteDir, "extensions"));
    fs.writeFileSync(path.join(r.remoteDir, "extensions", "questionnaire.ts"), "");
    assert.match(r.doctor().stdout, /srv: npm:ask-user-thing, questionnaire\.ts/);
    // no settings and no directory at all: the host answered and has no pi configuration, so nothing is found
    fs.rmSync(r.remoteDir, { recursive: true });
    assert.match(r.doctor().stdout, /No question extension found by name \(ask-user, question, interview\) in pi's settings on local, srv\./);
  } finally { r.done(); }
});

test("ssh: an unreachable host is not checked and changes no exit code; file text cannot split the answer or inject names", () => {
  const r = sshRig();
  try {
    fs.mkdirSync(r.remoteDir);
    fs.writeFileSync(path.join(r.remoteDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-web-access"] }));
    const ok = r.doctor();
    const down = r.doctor({ FAKE_SSH_FAIL: "1" });
    assert.match(down.stdout, /Not checked: .*srv \(pi's settings could not be read\)/);
    // the doctor's own reachability line fails for a down host; the note adds nothing to the exit code beyond that
    assert.ok(down.status >= ok.status);
    // a file that imitates the old fixed marker and carries a name after it: only the extensions directory supplies extension names
    fs.writeFileSync(path.join(r.remoteDir, "settings.json"), '{"packages":[]}\n--extensions--\nINJECT-question-from-file\n');
    const out = r.doctor().stdout;
    assert.doesNotMatch(out, /INJECT-question-from-file/);
    assert.match(out, /No question extension found by name \(ask-user, question, interview\) in pi's settings on local, srv\./);
  } finally { r.done(); }
});
