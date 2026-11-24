// --help, -h and unknown arguments for every script a human or the Controller runs, and every agentic-factory command
// (issues #24, #38). Each runs in a sandbox where a real run would reach a fake orca/ssh/git/gh that records the call,
// so "did nothing" means: exit 0 (help) or 2 (unknown argument), no recorded call, no file created or changed.
import "./support/safe-env.mjs";
import { tempDir } from "./support/cleanup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { grammar, leadingComment, parse } from "../controller/cli.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLI = path.join(ROOT, "bin/agentic-factory.mjs");
// Modules other scripts import; nobody runs them.
const LIBRARIES = ["controller/lib.mjs", "controller/reviewrecord.mjs", "controller/cli.mjs", "controller/controller-terminal.mjs", "controller/front-notice.mjs", "front-agent/hosts.mjs", "front-agent/cli.mjs"];
// Installed as single files, so they handle --help themselves. gate's arguments are the command it runs, and the
// guardrails take a hook's subcommand, so only arm.mjs also rejects unknown arguments.
const STANDALONE = ["controller/gate.mjs", "templates/tools/factory-guardrails.mjs", "standard/arm.mjs"];
const list = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".mjs")).map((f) => `${dir}/${f}`);
const SCRIPTS = ["controller", "controller/steering", "controller/templates", "front-agent", "templates/tools", "standard"].flatMap(list).filter((f) => !LIBRARIES.includes(f));
const WITH_CLI = SCRIPTS.filter((f) => !STANDALONE.includes(f));

function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const s = fs.statSync(p); out[path.relative(dir, p)] = `${s.size}:${s.mtimeMs}`; } } };
  walk(dir);
  return out;
}

/** A sandbox with the bundles copied, a config (unless withConfig is false; "broken" writes one that is not JSON, also
 *  in the working directory), and fakes for every outside tool. */
function sandbox({ withConfig = true } = {}) {
  const dir = fs.realpathSync(tempDir("af-cli-"));
  for (const d of ["controller", "front-agent"]) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  for (const f of STANDALONE) { const to = path.join(dir, "alone", path.basename(f, ".mjs"), path.basename(f)); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(ROOT, f), to); }
  const project = path.join(dir, "project");
  for (const d of ["home", "work", "fake", path.join("project", "docs/tasks")]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  if (withConfig) {
    const config = { project: { name: "demo", mainBranch: "main" }, agents: { runner: "orca" }, commands: { verify: "true" }, steering: { mode: "orca-tasks" }, hosts: { controller: { host: "local" }, frontAgent: {}, workers: [{ name: "local", kind: "local", projectDir: project, orcaRepoId: "r" }] } };
    for (const d of ["controller", "front-agent"]) fs.writeFileSync(path.join(dir, d, "factory.config.json"), withConfig === "broken" ? "{ not json" : JSON.stringify(config));
    if (withConfig === "broken") fs.writeFileSync(path.join(dir, "work", "factory.config.json"), "{ not json");
  }
  const calls = path.join(dir, "calls.log");
  for (const tool of ["orca", "orca-ide", "ssh", "git", "gh", "crontab", "launchctl", "tmux"]) fs.writeFileSync(path.join(dir, "fake", tool), `#!/bin/sh\necho "${tool} $*" >> "${calls}"\nexit 1\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: path.join(dir, "home"), PATH: `${path.join(dir, "fake")}:${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: path.join(dir, "home") };
  for (const k of ["FACTORY_CONFIG", "ORCA_CLI_COMMAND", "ORCA_TERMINAL", "ORCA_TERMINAL_HANDLE", "GIT_DIR"]) delete env[k];
  const before = snapshot(dir);
  const run = (file, args) => spawnSync(process.execPath, [file, ...args], { cwd: path.join(dir, "work"), env, encoding: "utf8", timeout: 20_000 });
  const script = (rel, args) => run(STANDALONE.includes(rel) ? path.join(dir, "alone", path.basename(rel, ".mjs"), path.basename(rel)) : path.join(dir, rel), args);
  const untouched = (what) => {
    assert.equal(fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "", "", `${what} called an outside tool`);
    assert.deepEqual(snapshot(dir), before, `${what} created or changed a file`);
  };
  return { dir, run, script, untouched };
}

test("every script prints its leading comment for --help and -h, exits 0 and does nothing else", () => {
  const box = sandbox();
  for (const rel of SCRIPTS) for (const h of ["--help", "-h"]) {
    const r = box.script(rel, [h]);
    assert.equal(r.status, 0, `${rel} ${h}: ${r.stderr}`);
    assert.match(r.stdout, /Usage:/, `${rel} ${h} prints no usage`);
    assert.equal(r.stdout.trim(), leadingComment(fs.readFileSync(path.join(ROOT, rel), "utf8")).trim(), `${rel}: the help is the leading comment`);
    box.untouched(`${rel} ${h}`);
  }
});

test("--help works without a config, before the script loads one", () => {
  const box = sandbox({ withConfig: false });
  for (const rel of SCRIPTS) {
    const r = box.script(rel, ["--help"]);
    assert.equal(r.status, 0, `${rel}: ${r.stderr}`);
    box.untouched(`${rel} --help`);
  }
});

test("--help reads no config: a broken one next to the scripts or in the working directory does not matter", () => {
  const box = sandbox({ withConfig: "broken" });
  for (const rel of SCRIPTS) {
    const r = box.script(rel, ["--help"]);
    assert.equal(r.status, 0, `${rel}: ${r.stderr}`);
    box.untouched(`${rel} --help`);
  }
});

test("an unknown option is a usage error (exit 2) before anything runs", () => {
  const box = sandbox();
  for (const rel of [...WITH_CLI, "standard/arm.mjs"]) {
    const r = box.script(rel, ["--no-such-option"]);
    assert.equal(r.status, 2, `${rel}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /unknown argument "--no-such-option"[\s\S]*Usage:/);
    box.untouched(`${rel} --no-such-option`);
  }
  // A value-taking option's value is skipped, and the unknown one behind it is still found.
  for (const args of [["--on", "local", "--dyr"], ["--dry", "--on=local"]]) {
    const r = box.script("controller/cleanup.mjs", args);
    assert.equal(r.status, 2, `cleanup ${args.join(" ")}: ${r.stderr}`);
  }
  box.untouched("cleanup with a misspelt option");
});

test("a positional argument is a usage error where the usage names none", () => {
  const box = sandbox();
  const none = WITH_CLI.filter((rel) => !grammar(leadingComment(fs.readFileSync(path.join(ROOT, rel), "utf8")), path.basename(rel)).positional);
  for (const rel of ["controller/cleanup.mjs", "controller/capacity.mjs", "controller/names.mjs", "controller/heartbeat.mjs"]) assert.ok(none.includes(rel), `${rel} should take no positional argument`);
  for (const rel of none) {
    const r = box.script(rel, ["stray"]);
    assert.equal(r.status, 2, `${rel}: ${r.stderr}`);
    box.untouched(`${rel} stray`);
  }
});

// Options these scripts pass to other programs (orca, git, gh, ssh, an agent CLI); they are not the script's own.
// A new one goes here; an option the script itself reads goes into its Usage: line instead.
const FOREIGN = {
  "controller/capacity.mjs": ["--json"],
  "controller/cycle.mjs": ["--limit"],
  "controller/cleanup.mjs": ["--json", "--full", "-q", "--prune", "--porcelain", "--terminal", "--verify", "--worktree", "-r", "--merged", "--delete", "--dispatch"],
  "controller/docsonly.mjs": ["-C", "-q", "--verify", "--path-format", "--git-common-dir", "--json", "--ticket", "--issue", "--ticket-text", "--jq"],
  "controller/reviewed.mjs": ["-C", "-q", "-e", "-z", "--raw", "--no-renames", "--no-tags", "--verify", "--is-ancestor"],
  "controller/heartbeat.mjs": ["--json", "--label", "--state", "--terminal", "--worktree", "--comment", "--workspace-status", "--unread", "--limit", "--for", "--timeout-ms", "--text", "--enter", "--screen"],
  "controller/restart.mjs": ["--json", "--terminal", "--worktree", "-C", "--format"],
  "controller/names.mjs": ["--repo", "--limit", "--json", "--worktree", "--display-name", "--terminal", "--title"],
  "controller/runscript.mjs": ["--worktree", "--title", "--command", "--json", "-c"],
  "controller/stallwatch.mjs": ["--json", "--terminal", "--screen"],
  "controller/start.mjs": ["--task-title", "--spec", "--json", "--repo", "--name", "--base-branch", "--setup", "--dispatch", "--terminal", "--title", "--full-auto", "-m", "--dangerously-skip-permissions", "-p", "-F"],
  "controller/wait.mjs": ["--full", "--wait", "--types", "--timeout-ms", "--ack"],
  "controller/wave.mjs": ["--worktree", "--title", "--command", "--json", "-c"],
  "controller/wavewait.mjs": ["--terminal", "--json"],
  "controller/templates/mkspec.mjs": ["-C", "-q"],
  "controller/steering/issues.mjs": ["-F", "-f", "--add-assignee", "--remove-label", "--add-label", "--body-file", "--body", "--comment", "--json"],
  "front-agent/botwatch.mjs": ["-F", "-o"],
  "front-agent/relay.mjs": ["-F", "--wait", "--types", "--timeout-ms", "--json", "--ack"],
  "front-agent/statuswatch.mjs": ["-F", "--json", "--terminal", "--for", "--timeout-ms", "--text", "--enter", "--worktree", "--comment", "--unread"],
};

/** Why a script's argument reading and its usage disagree; empty when every argument it can read is in its usage.
 *  A script reads process.argv only in forms this check understands; any other form is reported, so a new way of
 *  reading an argument cannot slip past the usage. */
function argumentProblems(rel, source) {
  const problems = [];
  const g = grammar(leadingComment(source), path.basename(rel));
  if (!g) return [`${rel} has no Usage: line in its leading comment`];
  if (!/^import "\.\.?\/cli\.mjs";$/m.test(source)) problems.push(`${rel} does not import cli.mjs`);
  // cli.mjs must run before any module of the bundle (lib.mjs reads the config); built-ins have no side effects.
  else if (source.indexOf('/cli.mjs";') > source.search(/^import .*from "\.\.?\//m) && source.search(/^import .*from "\.\.?\//m) >= 0) problems.push(`${rel}: cli.mjs must be imported before the bundle's other modules`);
  const code = source.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const known = (o) => g.options.has(o) || (FOREIGN[rel] ?? []).includes(o);
  for (const [, o] of code.matchAll(/["'`](--?[A-Za-z][\w-]*)/g)) if (!known(o)) problems.push(`${rel} uses ${o}: name it in the Usage: line if the script reads it, or in FOREIGN if it is passed to another program`);
  for (const [, o] of code.matchAll(/(?:includes|indexOf|opt|has)\(\s*"(--?[\w-]+)"/g)) if (!g.options.has(o)) problems.push(`${rel} reads ${o} but its usage does not name it`);
  if (/\bargHost\(/.test(code) && !g.options.has("--on")) problems.push(`${rel} reads --on (argHost) but its usage does not name it`);
  // A one-line helper such as `const argValue = (name) => { const i = process.argv.indexOf(name); … }`: every call of it
  // must name an option of the usage literally, so the helper reads nothing the usage does not name.
  const helpers = [...code.matchAll(/const (\w+) = \((\w+)\) => [^\n]*?process\.argv\.indexOf\(\2\)/g)].map((m) => ({ name: m[1], param: m[2] }));
  for (const { name } of helpers) for (const [, a] of code.matchAll(new RegExp(`\\b${name}\\(([^)]*)\\)`, "g"))) {
    const o = /^"(--?[\w-]+)"$/.exec(a.trim())?.[1];
    if (!o) { if (!helpers.some((h) => h.param === a.trim())) problems.push(`${rel} calls ${name}(${a}): pass the option literally`); }
    else if (!g.options.has(o)) problems.push(`${rel} reads ${o} through ${name}() but its usage does not name it`);
  }
  for (const m of code.matchAll(/process\.argv\b(.{0,40})/g)) {
    const rest = m[1], before = code.slice(Math.max(0, m.index - 8), m.index);
    if (/^\.(includes|indexOf)\("--?[\w-]+"\)/.test(rest) || /^\[\w+ \+ 1\]/.test(rest) || /^\[1\]/.test(rest) || (/^\)/.test(rest) && /argHost\($/.test(before))) continue;
    if (helpers.some((h) => rest.startsWith(`.indexOf(${h.param})`))) continue;
    if (/^\.slice\(2\)/.test(rest)) { if (!g.positional) problems.push(`${rel} reads positional arguments but its usage names none`); continue; }
    problems.push(`${rel} reads process.argv${rest.split("\n")[0]} in a form this check cannot see; read options with process.argv.includes/indexOf("--x") or positionals from process.argv.slice(2)`);
  }
  return problems;
}

test("every argument a script reads is named in its usage, so a valid call is never rejected", () => {
  for (const rel of WITH_CLI) assert.deepEqual(argumentProblems(rel, fs.readFileSync(path.join(ROOT, rel), "utf8")), [], rel);
  // agentic-factory reads its arguments only through flag(), opt() and args[0]/args[1] (deviate's path).
  const cli = fs.readFileSync(CLI, "utf8");
  const usage = cli.slice(cli.indexOf("const USAGE = {"), cli.indexOf("const commandHelp"));
  for (const [, o] of cli.matchAll(/(?:flag|opt)\("(--[\w-]+)"/g)) assert.ok(o === "--yes" || usage.includes(o), `agentic-factory reads ${o} but USAGE does not name it`);
  const reads = [...cli.matchAll(/\bargs(\.[A-Za-z]+|\[[^\]]*\])|process\.argv[.[]\w*/g)].map((m) => m[0]).sort();
  assert.deepEqual(reads, ["args.includes", "args.indexOf", "args.push", "args.slice", "args[0]", "args[1]", "args[i + 1]", "process.argv.push", "process.argv.slice"],
    "agentic-factory reads its arguments in a new place: name the option in USAGE and extend this list");
});

test("the usage check sees an argument read through .some(), a helper, an index or a positional", () => {
  const wait = fs.readFileSync(path.join(ROOT, "controller/wait.mjs"), "utf8");
  const capacity = fs.readFileSync(path.join(ROOT, "controller/capacity.mjs"), "utf8");
  const cleanup = fs.readFileSync(path.join(ROOT, "controller/cleanup.mjs"), "utf8");
  const mutants = {
    some: ["controller/wait.mjs", `${wait}\nconst quiet = process.argv.some((a) => a === "--quiet");\n`],
    helper: ["controller/capacity.mjs", `${capacity}\nconst n = argValue("--set-cap");\n`],
    index: ["controller/capacity.mjs", `${capacity}\nconst mode = process.argv[2];\n`],
    positional: ["controller/cleanup.mjs", `${cleanup}\nconst [what] = process.argv.slice(2);\n`],
    late: ["controller/cleanup.mjs", cleanup.replace('import "./cli.mjs";\n', "").replace(/^(import .*lib\.mjs";)$/m, '$1\nimport "./cli.mjs";')],
  };
  for (const [name, [rel, source]] of Object.entries(mutants)) assert.notDeepEqual(argumentProblems(rel, source), [], `${name} was not noticed`);
});

test("parse: --help counts only where an option may stand, values are skipped", () => {
  const g = grammar('Usage: node mkspec.mjs dev <T> [--extra "…"] [--level <1|2>]', "mkspec.mjs");
  assert.deepEqual(parse(["dev", "T1", "--extra", "--help"], g), []);
  assert.equal(parse(["dev", "--help"], g), "help");
  assert.deepEqual(parse(["dev", "--level", "2", "--x"], g), ["--x"]);
  const none = grammar("Usage: node cleanup.mjs [--on <host>|--all] [--dry]", "cleanup.mjs");
  assert.equal(none.positional, false);
  assert.deepEqual(parse(["--on", "a", "--all", "--dry"], none), []);
  assert.deepEqual(parse(["--on", "a", "b"], none), ["b"]);
  // Free text that starts with a dash is a positional, not an option.
  const wave = grammar('Usage: node wave.mjs "<title>" "<summary>" origin/<branch>... [--on <host>]', "wave.mjs");
  assert.deepEqual(parse(["T", "- fixes x\n- adds y", "origin/a"], wave), []);
  assert.deepEqual(parse(["T", "s", "origin/a", "--on=local"], wave), ["--on=local"]);
  // Values are written <…> in the real usage lines, so a value starting with "-" is still a value; prose is not grammar.
  const real = (rel) => grammar(leadingComment(fs.readFileSync(path.join(ROOT, rel), "utf8")), path.basename(rel));
  for (const o of ["--on", "--agent", "--tier", "--model", "--worktree", "--effort"]) assert.equal(real("controller/start.mjs").options.get(o), true, `start ${o} takes a value`);
  for (const o of ["--level", "--round", "--review", "--extra"]) assert.equal(real("controller/templates/mkspec.mjs").options.get(o), true, `mkspec ${o} takes a value`);
  assert.equal(real("controller/calibrate-models.mjs").options.has("--tier"), false);
});

test("front-agent/cli.mjs is the same file as controller/cli.mjs", () => {
  assert.equal(fs.readFileSync(path.join(ROOT, "front-agent/cli.mjs"), "utf8"), fs.readFileSync(path.join(ROOT, "controller/cli.mjs"), "utf8"));
});

test("agentic-factory: every command takes --help and -h, rejects unknown arguments, and does nothing", () => {
  const box = sandbox();
  const commands = ["init", "update", "start", "status", "doctor", "selfcheck", "deviate", "install-skills"];
  for (const c of commands) for (const h of ["--help", "-h"]) {
    const r = box.run(CLI, [c, h]);
    assert.equal(r.status, 0, `${c} ${h}: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`^Usage: agentic-factory ${c}\\b`));
    box.untouched(`${c} ${h}`);
  }
  for (const c of commands) {
    const r = box.run(CLI, [c, "--no-such-option"]);
    assert.equal(r.status, 2, `${c}: ${r.stdout}${r.stderr}`);
    box.untouched(`${c} --no-such-option`);
  }
  for (const args of [["start", "extra"], ["update", "now"], ["init", "--answers", "a.json", "--yess"], ["nope"]]) {
    const r = box.run(CLI, args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    box.untouched(args.join(" "));
  }
  for (const h of [[], ["--help"], ["-h"]]) {
    const r = box.run(CLI, h);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--help` shows a command's arguments/);
  }
  box.untouched("agentic-factory --help");
});
