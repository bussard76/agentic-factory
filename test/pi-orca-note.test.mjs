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
const WARN = /^warn    pi workers under the Orca runner run with the human's own pi extensions and with Orca's default arguments for pi: the factory can pass the agent nothing\. A question tool from an extension can hang such a worker at a dialog nobody answers\. What to do: remove the extension on the worker host, or set default arguments for pi in Orca \(`--exclude-tools ask_user_question,question,questionnaire`, plus the name of any other question tool\) and check on one real worker that they apply \(ask it to list its tools\)\./m;

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
    assert.match(clean.stdout, /No question extension found in pi's settings on local\./);
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
    assert.match(r.doctor().stdout, /No question extension found in pi's settings on local\./);
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
    assert.match(note.text, /Not checked: srv \(not checked\)/);
    assert.deepEqual(note.detected, []);
  } finally { r.done(); }
});
