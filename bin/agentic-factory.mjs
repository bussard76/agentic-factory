#!/usr/bin/env node
// agentic-factory CLI: init (onboarding), update, doctor, selfcheck. Node 22+, no dependencies.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { heartbeatCronScript, statusWatchCronScript, statusWatchLabel, statusWatchPlist } from "./heartbeat-cron.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const cwd = process.cwd();
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const yes = flag("--yes");
// The Front agent runs the onboarding as a conversation: `init --print-questions` lists the questions (with the
// answers given so far) as JSON and changes nothing; `init --answers <file>` runs init with the human's answers.
const printQuestions = cmd === "init" && flag("--print-questions");
const answersFile = opt("--answers");
const presetAnswers = answersFile ? JSON.parse(fs.readFileSync(answersFile, "utf8")) : {};
const batch = yes || printQuestions || Boolean(answersFile);
const sh = (c, a, o = {}) => { try { return execFileSync(c, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...o }).trim(); } catch { return ""; } };
const has = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
// In --print-questions mode stdout carries only the JSON; printed lines become the context of the next question.
let sayBuffer = [];
const say = (s = "") => (printQuestions ? sayBuffer.push(String(s).trim()) : console.log(s));

// Only the interactive init reads the keyboard; any other command would otherwise wait for stdin to close.
const rl = batch || cmd !== "init" ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
// Every question asked, in order, for --print-questions (and to validate --answers).
const asked = [];
const validAnswerIds = ["project.name", "project.repo", "project.humanName", "project.language", "rhythm.mode", "steering.mode", "agents.default", "architecture.mode", ...["small", "default", "large"].map((t) => `agents.models.${t}`), "hosts.where", "hosts.remote.name", "hosts.remote.ssh", "hosts.remote.sshConfig", "hosts.remote.orcaEnvironment", "hosts.controller", "capacity.calibration", "agents.calibration", ...["install", "typecheck", "lint", "unit", "verify", "e2e"].map((k) => `commands.${k}`), "preview.enabled", "preview.port", "preview.command", "reviews.maxRounds", "design.tool", "rules.confirm", "skills.installNow"];
function validateAnswers() {
  if (!answersFile) return;
  if (!presetAnswers || typeof presetAnswers !== "object" || Array.isArray(presetAnswers)) { console.error("--answers: expected an object keyed by question id"); process.exit(1); }
  for (const [id, value] of Object.entries(presetAnswers)) {
    if (!validAnswerIds.includes(id)) { console.error(`--answers: unknown id "${id}"; valid ids: ${validAnswerIds.join(", ")}`); process.exit(1); }
    if (["preview.port", "reviews.maxRounds"].includes(id) && !/^\d+$/.test(String(value ?? "").trim())) { console.error(`--answers: "${id}" must be a number`); process.exit(1); }
    if (["project.name", "hosts.remote.name", "hosts.remote.ssh"].includes(id) && (value == null || !String(value).trim())) { console.error(`--answers: "${id}" must not be empty`); process.exit(1); }
    const choices = { "project.language": ["en", "de"], "rhythm.mode": ["day-plan-night-build", "continuous", "custom"], "steering.mode": ["github-issues", "orca-tasks"], "agents.default": ["codex", "claude", "pi"], "hosts.where": ["local", "both", "remote"], "capacity.calibration": ["auto", "manual"], "agents.calibration": ["auto", "manual"], "preview.enabled": ["yes", "no"], "design.tool": ["figma", "pencil", "none"], "rules.confirm": ["yes", "no"], "skills.installNow": ["yes", "no"] }[id];
    const normalized = typeof value === "boolean" ? (value ? "yes" : "no") : String(value ?? "");
    if (choices && !choices.includes(normalized)) { console.error(`--answers: "${id}" must be one of ${choices.join(", ")} (got "${normalized}")`); process.exit(1); }
  }
  if (!printQuestions && presetAnswers["rules.confirm"] !== "yes") { console.error('--answers: "rules.confirm" must be present and yes'); process.exit(1); }
}
const takeContext = () => { const c = sayBuffer.filter(Boolean).join("\n"); sayBuffer = []; return c; };
function preset(id, options) {
  if (!(id in presetAnswers)) return undefined;
  let v = presetAnswers[id];
  if (options && typeof v === "boolean") v = v ? "yes" : "no";
  v = v === null ? "" : String(v);
  if (options && !options.some((o) => o.value === v)) { console.error(`--answers: "${id}" must be one of ${options.map((o) => o.value).join(", ")} (got "${v}")`); process.exit(1); }
  return v;
}
// The Orca executable: ORCA_CLI_COMMAND if set; on Linux outside an Orca terminal `orca-ide` (bare `orca` is the GNOME screen reader there).
const ORCA_BIN = process.env.ORCA_CLI_COMMAND ?? (process.platform === "linux" && !process.env.ORCA_TERMINAL && has("orca-ide") ? "orca-ide" : "orca");
async function ask(id, question, options, def) {
  // One question at a time, recommended option first. With --yes, the default is taken; with --answers, the given one.
  const given = preset(id, options);
  asked.push({ id, type: "choice", question: question.trim(), context: takeContext() || undefined, options: options.map(({ label, value, hint }) => ({ value, label, ...(hint ? { hint } : {}) })), recommended: def, answer: given ?? null });
  if (given !== undefined) return given;
  if (batch) return def;
  say(`\n${question}`);
  options.forEach((o, i) => say(`  ${i + 1}) ${o.label}${o.value === def ? "  (recommended)" : ""}${o.hint ? `\n     ${o.hint}` : ""}`));
  const a = (await rl.question(`> [${options.findIndex((o) => o.value === def) + 1}] `)).trim();
  if (!a) return def;
  const n = Number(a);
  return n >= 1 && n <= options.length ? options[n - 1].value : a;
}
// Enter keeps the default; a single "-" clears the value (for optional commands).
async function askText(id, question, def) {
  const given = preset(id);
  asked.push({ id, type: "text", question: question.trim(), context: takeContext() || undefined, recommended: def ?? "", answer: given ?? null });
  if (given !== undefined) return given;
  if (batch) return def;
  const a = (await rl.question(`\n${question} [${def || "none"}] (Enter = keep, - = none) `)).trim(); return a === "-" ? "" : a || def; }

// --- detection -----------------------------------------------------------------------------------
function detect() {
  const remote = sh("git", ["config", "--get", "remote.origin.url"]);
  // A filesystem remote (the local bare remote, any path) says nothing about the project: the directory name does.
  const isFsRemote = /^(\.\.?\/|\/|~|file:)/.test(remote);
  const repo = isFsRemote ? `local:${path.resolve(cwd, remote.replace(/^file:\/\//, "").replace(/^~/, os.homedir()))}` : remote.replace(/^git@github\.com:/, "github.com/").replace(/^https?:\/\//, "").replace(/\.git$/, "");
  const name = path.basename(remote && !isFsRemote ? repo : cwd);
  const pkg = fs.existsSync("package.json") ? JSON.parse(fs.readFileSync("package.json", "utf8")) : {};
  const scripts = pkg.scripts ?? {};
  // Package manager: the lockfile decides; else package.json → packageManager (corepack) or engines; else the first of
  // pnpm/npm/yarn on PATH, else npm. init runs this manager once and commits its lockfile, so never guess wrong.
  const declared = /^(pnpm|npm|yarn)\b/.exec(pkg.packageManager ?? "")?.[1] ?? ["pnpm", "yarn", "npm"].find((m) => pkg.engines?.[m]);
  const pm = fs.existsSync("pnpm-lock.yaml") ? "pnpm" : fs.existsSync("yarn.lock") ? "yarn" : fs.existsSync("package-lock.json") ? "npm" : declared ?? ["pnpm", "npm", "yarn"].find(has) ?? "npm";
  const run = (s) => (scripts[s] ? `${pm} ${pm === "npm" ? "run " : ""}${s}` : "");
  const figma = (() => { try { const r = spawnSync("curl", ["-s", "-m", "1", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:3845/mcp"], { encoding: "utf8" }); return /^(2|4)/.test(r.stdout); } catch { return false; } })();
  return {
    repo, name, github: /github\.com/.test(repo), pm, scripts,
    // Frozen installs need a lockfile; without one, a plain install (the first wave would otherwise fail on `npm ci`).
    hasLock: fs.existsSync("pnpm-lock.yaml") || fs.existsSync("yarn.lock") || fs.existsSync("package-lock.json"),
    commands: { install: !(fs.existsSync("pnpm-lock.yaml") || fs.existsSync("yarn.lock") || fs.existsSync("package-lock.json")) ? `${pm} install` : pm === "pnpm" ? "pnpm install --frozen-lockfile" : pm === "npm" ? "npm ci" : "yarn install --frozen-lockfile", typecheck: run("typecheck") || run("check-types"), lint: run("lint"), unit: run("test:unit") || run("test"), verify: run("verify") || run("test"), e2e: run("test:e2e") || run("e2e"), release: [run("e2e:compose"), run("test:images")].filter(Boolean) },
    tools: { orca: has("orca") || has("orca-ide"), codex: has("codex"), claude: has("claude"), pi: has("pi"), gh: has("gh"), figma },
  };
}

// --- init ------------------------------------------------------------------------------------------
async function init() {
  if (flag("--untracked-standard")) {
    if (flag("--keep-own-hooks")) { say("--untracked-standard cannot be combined with --keep-own-hooks yet: new worktrees get the standard through a factory hook. Without --keep-own-hooks your hooks stay where they are and run first."); process.exit(1); }
    // husky's prepare script sets core.hooksPath on every install, which would switch the review gate off for the whole clone.
    const prepare = fs.existsSync("package.json") ? JSON.parse(fs.readFileSync("package.json", "utf8")).scripts?.prepare ?? "" : "";
    const foreign = sh("git", ["config", "--show-origin", "--get-all", "core.hooksPath"]).split("\n").filter((l) => l && !/^file:\.git\/config(\t|$)/.test(l));
    const hooksDir = path.join(sh("git", ["rev-parse", "--git-common-dir"]) || ".git", "hooks");
    if (fs.lstatSync(hooksDir, { throwIfNoEntry: false })?.isSymbolicLink()) { say(`--untracked-standard: ${hooksDir} is a link, so the factory's hooks would be written into whatever it points at, possibly tracked files. Nothing was changed.`); process.exit(1); }
    // Excluded and not tracked, such a file would vanish from git status, and a later merge would overwrite it without a word.
    const tracked = sh("git", ["ls-files"]).split("\n");
    const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
    if (lstat("docs") && !(fs.existsSync("docs") && fs.statSync("docs").isDirectory())) { say("--untracked-standard: `docs` is not a directory here, and the factory needs a directory of that name for ADRs and reviews. Nothing was changed."); process.exit(1); }
    // A parent that is a link (a tracked .claude/skills) or a file (a tracked file named docs) leaves nothing to hide.
    const inTheWay = standardPaths().filter((p) => { const stat = lstat(p); return stat && !stat.isSymbolicLink() && !lstat(path.dirname(p))?.isSymbolicLink() && !tracked.some((t) => t === p || t.startsWith(`${p}/`)); });
    if (inTheWay.length) { say(`--untracked-standard: these untracked files sit where the factory's standard goes: ${inTheWay.join(", ")}. Commit them, then they count as this project's deviation, or move them. Nothing was changed.`); process.exit(1); }
    if (foreign.length) { say(`--untracked-standard: a core.hooksPath is set outside this clone's config (${foreign[0].split("\t")[0]}), so git would not run the factory's hooks and there would be no review gate. Remove it first. Nothing was changed.`); process.exit(1); }
    if (fs.existsSync(".husky") || /husky/.test(prepare) || hooksSetup().layout === "husky") { say("--untracked-standard does not support husky yet: every install would switch the factory's hooks off for this clone (F44 in the factory's debt.md). Nothing was changed."); process.exit(1); }
    if (isAdopted() && !minimal(readConfig())) { say("--untracked-standard: this project already tracks the standard, and switching an existing project is not built yet. Nothing was changed."); process.exit(1); }
  }
  validateAnswers();
  say(`agentic-factory ${PKG.version}: onboarding for ${cwd}`);
  const emit = (o) => { console.log(JSON.stringify(o, null, 2)); process.exit(0); };
  if (spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" }).status !== 0) { if (printQuestions) emit({ blocker: "not a git repository: run `git init` first", questions: [] }); say("Not a git repository. Run `git init` first."); process.exit(1); }
  const d = detect();
  // A re-run on an initialised project is an update: keep the project's recorded answers, refresh the files, commit nothing.
  if (printQuestions && isAdopted()) emit({ initialised: true, questions: [], next: "already initialised: run `status`, and `start` if the Controller is not running" });
  if (isAdopted()) {
    say("Already initialised (factory.config.json and .factory/manifest.json exist). Refreshing from the recorded answers; change answers by editing factory.config.json. Nothing is committed.");
    await initNonInteractiveRefresh();
    rl?.close();
    return;
  }
  // Every script fetches origin and merges origin/<main>. A repo without a remote gets a local bare one, so the
  // first wave works on a single machine; replace it with a real remote any time (git remote set-url origin …).
  const needsRemote = !sh("git", ["remote"]);
  const bare = path.join(os.homedir(), ".factory-remotes", `${d.name}-${hash(cwd).slice(0, 6)}.git`);
  if (needsRemote) d.repo = `local:${bare}`;
  const createRemote = () => {
    // Keyed by name plus a hash of the absolute path, so two projects with the same directory name never share a remote.
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    const existed = fs.existsSync(bare);
    const branch = sh("git", ["branch", "--show-current"]) || "main";
    if (!existed) spawnSync("git", ["init", "-q", "--bare", "-b", branch, bare]);
    spawnSync("git", ["remote", "add", "origin", bare]);
    // An empty repository (git init, no commit yet) has nothing to push; the adoption commit pushes with -u later. An
    // existing bare must then be empty too, or it is a leftover of another attempt with a different history.
    const foreign = () => { spawnSync("git", ["remote", "remove", "origin"]); say(`The existing local bare remote ${bare} holds a different history. Remove it (rm -rf "${bare}") or add your own remote (git remote add origin <url>), then run init again. origin was not kept.`); process.exit(1); };
    if (sh("git", ["rev-parse", "--verify", "-q", "HEAD"])) {
      const p = spawnSync("git", ["push", "-q", "-u", "origin", branch], { encoding: "utf8" });
      if (p.status !== 0) foreign();
    } else if (existed && sh("git", ["-C", bare, "rev-parse", "--verify", "-q", "HEAD"])) foreign();
    say(`No remote found: ${existed ? "using the existing" : "created a"} local bare remote at ${bare} as origin (replace it later with git remote set-url origin <url>).`);
  };
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, "factory.config.example.json"), "utf8"));
  delete c.$comment;
  c.factoryVersion = PKG.version;
  if (flag("--untracked-standard")) c.footprint = "minimal";
  c.project.adoptedOn = process.env.FACTORY_TODAY ?? new Date().toISOString().slice(0, 10);
  c.project.name = await askText("project.name", "1. Project name (used for branches, worktrees, locks, the preview)?", d.name);
  c.project.repo = await askText("project.repo", "   Repository?", d.repo || `github.com/<owner>/${c.project.name}`);
  c.project.mainBranch = sh("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace("origin/", "") || sh("git", ["branch", "--show-current"]) || "main";
  c.project.humanName = await askText("project.humanName", "2. Who is the human the agents work for (name as the handbooks should address them)?", os.userInfo().username);
  const langDefault = /^de/i.test(process.env.LANG ?? process.env.LC_ALL ?? "") ? "de" : "en";
  c.project.language = await ask("project.language", "   In which language should the human-facing workflow guide be written?", [{ label: "English", value: "en" }, { label: "Deutsch", value: "de" }], langDefault);
  c.rhythm.mode = await ask("rhythm.mode", "3. Working rhythm?", [
    { label: "Day: plan, test, decide. Night: the Controller builds unattended. Morning handover.", value: "day-plan-night-build" },
    { label: "Continuous: build whenever signed-off work exists; questions as they arise", value: "continuous" },
    { label: "Custom quiet hours (edit rhythm.quietHours afterwards)", value: "custom" }], "day-plan-night-build");
  c.steering.mode = await ask("steering.mode", "4. Where do tickets live?", [
    { label: "GitHub issues (labels, native blocking; wayfinder maps visible in the tracker)", value: "github-issues" },
    { label: "Task files docs/tasks/T<n>-*.md (everything in git, no tracker)", value: "orca-tasks" }], d.github && d.tools.gh ? "github-issues" : "orca-tasks");
  // Orca is a prerequisite: workers, worktrees, terminals, messages and remote hosts all run through it.
  // The plain-terminal runner exists for experiments only (--experimental-terminal-runner).
  const skipOrca = process.env.FACTORY_SKIP_ORCA === "1";   // tests only: never touch the local Orca
  c.agents.runner = flag("--experimental-terminal-runner") ? "terminal" : "orca";
  let orcaRunning = false;
  if (c.agents.runner === "orca" && !skipOrca) {
    if (!d.tools.orca) {
      if (printQuestions) emit({ blocker: "Orca is required and its CLI (orca / orca-ide) is not on this machine: install it (https://github.com/stablyai/orca) and start it", questions: [] });
      say(`\nOrca is required and its CLI (orca / orca-ide) is not on this machine. Install Orca (https://github.com/stablyai/orca), start it, then run init again.\n(For experiments without Orca: --experimental-terminal-runner. Unsupported.)`);
      process.exit(1);
    }
    orcaRunning = /"ok":\s*true/.test(sh(ORCA_BIN, ["status", "--json"]));
    say(orcaRunning ? `5. Orca: installed and running (${ORCA_BIN}).` : `5. Orca: installed but not running. Start it with \`${ORCA_BIN} open --json\`; the repo is registered with Orca when it runs.`);
  } else if (c.agents.runner === "terminal") say("5. Runner: plain terminals (experimental, unsupported).");
  c.agents.default = await ask("agents.default", "6. Default agent CLI for workers?", [{ label: "Codex", value: "codex" }, { label: "Claude Code", value: "claude" }, { label: "Pi", value: "pi" }], d.tools.codex ? "codex" : d.tools.claude ? "claude" : "pi");
  if (c.agents.default === "claude") { c.agents.models = { small: "haiku", default: "sonnet", large: "opus" }; c.agents.fallback = { agent: "codex", models: { small: "gpt-6-luna", default: "gpt-6.1-terra", large: "gpt-6.1-sol" }, quotaThresholdPercent: 10 }; }
  for (const t of ["small", "default", "large"]) c.agents.models[t] = await askText(`agents.models.${t}`, `   Model for the "${t}" tier (as the ${c.agents.default} CLI names it; a starting value, calibrated later)?`, c.agents.models[t]);
  const where = await ask("hosts.where", "7. Where do workers run? (a remote server is an option, not a must; you can add more hosts later)", [
    { label: "Only on this machine", value: "local" },
    { label: "On this machine and on one remote server (ssh alias)", value: "both" },
    { label: "Only on a remote server", value: "remote" }], "local");
  // projectDir is the explicit checkout path, so the project name may differ from the directory name.
  const localHost = { name: "local", kind: "local", projectDir: cwd.replace(os.homedir(), "~"), projectsDir: path.dirname(cwd).replace(os.homedir(), "~"), workspacesDir: "~/orca/workspaces", orcaEnvironment: "", orcaRepoId: "", capacity: { suiteWorkersMax: 2, readOnlyWorkersMax: 2 } };
  const remoteHost = { name: "build-server", kind: "remote", ssh: "build-server", sshConfig: "", projectsDir: "~/projects", workspacesDir: "~/orca/workspaces", orcaEnvironment: "", orcaRepoId: "", capacity: { suiteWorkersMax: 8, readOnlyWorkersMax: 6, gate: { unitSlots: 3, e2eSlots: 2 } } };
  if (where !== "local") {
    remoteHost.name = await askText("hosts.remote.name", "   Name of the remote host?", "build-server");
    remoteHost.ssh = await askText("hosts.remote.ssh", "   SSH alias for it (from your ssh config)?", remoteHost.name);
    remoteHost.sshConfig = await askText("hosts.remote.sshConfig", "   Path to an ssh config file, or empty for ~/.ssh/config?", "");
    if (c.agents.runner === "orca") remoteHost.orcaEnvironment = await askText("hosts.remote.orcaEnvironment", "   Saved Orca environment name (set later in hosts.workers[].orcaEnvironment if unknown)?", "");
  }
  c.hosts.workers = where === "local" ? [localHost] : where === "both" ? [localHost, remoteHost] : [remoteHost];
  // Register this repo with the local Orca so the local host has its repo id (remote hosts register on the server).
  c.hosts.controller = { host: await ask("hosts.controller", "8. Where does the Controller run?", c.hosts.workers.map((h) => ({ label: h.kind === "local" ? "On this machine (a second agent session next to the Front agent)" : `On ${h.name} (unattended, survives this machine sleeping)`, value: h.name })), c.hosts.workers.at(-1).name), controllerDir: "~/controller" };
  c.capacity.calibration.mode = await ask("capacity.calibration", "9. Capacity: the limits per host are starting values. Calibrate them automatically?", [{ label: "Auto: start low, raise step by step while the host stays quiet, lower on pressure; the audit verifies", value: "auto" }, { label: "Manual: use the configured limits as they are", value: "manual" }], "auto");
  c.agents.calibration = await ask("agents.calibration", "   Models: calibrate the tier per role from measured pass rates and rounds?", [{ label: "Auto", value: "auto" }, { label: "Manual: only recommend", value: "manual" }], "auto");
  say(`\n10. Commands the hooks, Testers and waves will run (package manager: ${d.pm}, from ${d.hasLock ? "the lockfile" : "package.json or PATH"}; edit factory.config.json to change):`);
  for (const k of ["install", "typecheck", "lint", "unit", "verify", "e2e"]) c.commands[k] = await askText(`commands.${k}`, `    ${k}?`, d.commands[k] ?? c.commands[k] ?? "");
  if (yes) for (const k of ["install", "typecheck", "lint", "unit", "verify", "e2e"]) say(`    ${k}: ${c.commands[k] || "(none)"}`);
  c.commands.release = d.commands.release.length ? d.commands.release : c.commands.release;
  c.hosts.frontAgent.preview.enabled = (await ask("preview.enabled", "11. Local preview that follows main on this machine (the human accepts there)?", [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], "yes")) === "yes";
  if (c.hosts.frontAgent.preview.enabled) { c.hosts.frontAgent.preview.port = Number(await askText("preview.port", "   Port?", "8180")); c.hosts.frontAgent.preview.command = await askText("preview.command", "   Start command?", d.scripts.dev ? `${d.pm} dev` : c.hosts.frontAgent.preview.command); c.hosts.frontAgent.preview.envFile = `~/.config/${c.project.name}/preview.env`; }
  c.reviews.maxRounds = Number(await askText("reviews.maxRounds", "12. Review rounds before a working feature is integrated and the rest becomes debt?", "2"));
  c.design = { tool: await ask("design.tool", "13. Design tool for stage 1 of outside-in?", [{ label: "Figma via its local MCP server", value: "figma" }, { label: "Pencil", value: "pencil" }, { label: "None for now", value: "none" }], d.tools.figma ? "figma" : "none"), exportDir: "design" };
  c.architecture = { mode: await ask("architecture.mode", "   Architecture document: should a Worker Architect create ARCHITECTURE.md and keep it current?", [{ label: "Yes", value: "architect", hint: "existing code: described as the first task; a new repo: after the first merged wave. An existing ARCHITECTURE.md is kept and checked. Reviews compare against it, and one Architect worker runs after each wave." }, { label: "No", value: "off", hint: "spec and conformance reviews still run, without a document to compare against" }], "architect") };
  say("\n14. Hard rules (they go into AGENTS.md and docs/coordinator.md):\n  - no real data or secrets in the repo, .env never committed\n  - the factory has no outward effects: nothing changes outside the repo and the demo environment\n  - workers never push to main; --no-verify is forbidden\n  - tests run on demo data or a private copy, never on the original\n  - no real model calls in tests");
  if ((await ask("rules.confirm", "   Confirm all of them?", [{ label: "Yes", value: "yes" }, { label: "No, stop here", value: "no" }], "yes")) !== "yes") { say("Stopped. Nothing written."); process.exit(1); }
  const installNow = (await ask("skills.installNow", "15. Install the user-level skills on this machine now (needed by the Front agent here, and by the Controller if it runs here)?", [{ label: "Yes", value: "yes" }, { label: "Later (agentic-factory install-skills)", value: "no" }], "yes")) === "yes";
  // --print-questions: hand the questions to the Front agent and stop before anything is written. Follow-up questions
  // (remote host details, preview port) appear once the answer that opens them is in the answers file.
  if (printQuestions) {
    const open = asked.filter((q) => q.answer === null).map((q) => q.id);
    emit({ factory: PKG.version, project: cwd, detected: { name: d.name, repo: d.repo, packageManager: d.pm, tools: d.tools }, questions: asked, open,
      next: open.length ? "ask the open questions one at a time (recommended option first, say why it matters: docs/onboarding.md), write all answers as {id: value} to a file outside the repo, run --print-questions --answers <file> again until `open` is empty and no new question appears, then run init --answers <file>" : "all answered: run init --answers <file>" });
  }

  if (c.agents.runner === "orca" && orcaRunning && !skipOrca && where !== "remote") {
    const list = sh(ORCA_BIN, ["repo", "list", "--json"]);
    let id = (list.match(new RegExp(`"id":\\s*"([0-9a-f-]{36})"[^{}]*"path":\\s*"${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`)) ?? [])[1];
    if (!id) { const added = sh(ORCA_BIN, ["repo", "add", "--path", cwd, "--json"]); id = (added.match(/"id":\s*"([0-9a-f-]{36})"/g) ?? []).map((m) => m.match(/[0-9a-f-]{36}/)[0]).at(-1); }
    if (id) { localHost.orcaRepoId = id; say(`   Registered with Orca: repo id ${id}.`); } else say("   Could not register the repo with Orca; set hosts.workers[].orcaRepoId by hand (orca repo add --path <repo> --json).");
  }
  if (needsRemote) createRemote();

  // --- write -----------------------------------------------------------------------------------
  const hadManifest = fs.existsSync(".factory/manifest.json");
  const manifest = { factoryVersion: PKG.version, files: {} };
  // A Node project without a lockfile gets one now, committed with the adoption: the hooks' lint would otherwise
  // install on first use and leave an untracked lockfile in every worktree, and waves could not install frozen.
  let lockfile = "";
  if (fs.existsSync("package.json") && !d.hasLock && !has(d.pm)) say(`\nNo lockfile and \`${d.pm}\` (the manager package.json names) is not installed: no install run; commands.install stays a plain install. Later: install ${d.pm}, run \`${d.pm} install\`, commit the lockfile, and set commands.install in factory.config.json to the frozen form (\`${d.pm === "pnpm" ? "pnpm install --frozen-lockfile" : d.pm === "npm" ? "npm ci" : "yarn install --frozen-lockfile"}\`).`);
  if (fs.existsSync("package.json") && !d.hasLock && has(d.pm)) {
    say(`\nNo lockfile: running \`${d.pm} install\` once (manager: ${d.pm}) so the lockfile can be committed with the adoption.`);
    const r = spawnSync(d.pm, ["install"], { stdio: "ignore" });
    lockfile = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"].find(fs.existsSync) ?? "";
    if (r.status === 0 && lockfile) c.commands.install = d.pm === "pnpm" ? "pnpm install --frozen-lockfile" : d.pm === "npm" ? "npm ci" : "yarn install --frozen-lockfile";
    else say("  install did not produce a lockfile; keeping the plain install command");
  }
  // The hook mode is decided before rendering: the documents say which hooks enforce the gate.
  const setup = hooksSetup(), mode = hookMode(setup);
  c.hooks = { mode, dir: setup.dir, hooksPath: minimal(c) ? STANDARD_HOOKS : setup.hooksPath, layout: setup.layout };
  const vars = templateVars(c);
  const write = (rel, content, mode) => {
    const target = path.join(cwd, rel);
    if (fs.existsSync(target) && fs.readFileSync(target, "utf8") !== content) {
      const existing = JSON.parse(fs.existsSync(".factory/manifest.json") ? fs.readFileSync(".factory/manifest.json", "utf8") : "{}").files?.[rel];
      // A file we did not generate, or one changed since we generated it, is user-owned: keep it and never adopt
      // its hash as our baseline, so later runs keep it too. The new version lands in .factory/new/.
      if (!existing || existing !== hash(fs.readFileSync(target, "utf8"))) { say(`  keep   ${rel} (user-owned; new version at .factory/new/${rel})`); fs.mkdirSync(path.dirname(path.join(cwd, ".factory/new", rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, ".factory/new", rel), content); manifest.files[rel] = existing ?? "user"; return; }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content); if (mode) fs.chmodSync(target, mode);
    manifest.files[rel] = hash(content); say(`  write  ${rel}`);
  };
  say("\nWriting:");
  if (mode === "own") say(`  HOOKS: --keep-own-hooks: the project's hooks in ${setup.dir} stay as they are; the factory hooks are NOT installed. They must enforce the commit checks and the review gate on main themselves (hooks.mode = "own"). core.hooksPath is ${sh("git", ["config", "--local", "core.hooksPath"]) || "NOT set in this repository: the own hooks are not armed"}.`);
  if (mode === "merge" && minimal(c)) say(`  HOOKS: this repo has its own hooks in ${setup.dir}; they stay there unchanged and run first, called by the factory hook of the same name.`);
  if (mode === "merge" && !minimal(c)) {
    say(`  HOOKS: this repo has its own hooks in ${setup.dir} (${ownHookFiles(setup).join(", ")}${setup.layout === "husky" ? "; husky layout, core.hooksPath stays " + setup.hooksPath : ""}); each becomes <hook>.own and runs first inside the factory hook of the same name (hooks.mode = "merge").`);
    for (const own of keepOwnHooks(setup)) { manifest.files[own] = hash(fs.readFileSync(own, "utf8")); say(`  keep   ${own} (the project's own hook)`); }
  }
  write("factory.config.json", JSON.stringify(c, null, 2) + "\n");
  if (minimal(c)) {
    for (const rel of walk(path.join(ROOT, "templates"))) if (trackedInMinimal(rel)) write(templateTarget(rel, setup.dir), render(fs.readFileSync(path.join(ROOT, "templates", rel), "utf8"), vars));
    renderStandard(c, vars);
  } else {
    for (const rel of walk(path.join(ROOT, "templates"))) if (!skipTemplate(rel, mode)) write(templateTarget(rel, setup.dir), render(fs.readFileSync(path.join(ROOT, "templates", rel), "utf8"), vars), /\.githooks\/|tools\//.test(rel) ? 0o755 : undefined);
    write("docs/dev-workflow.md", absolutizeDocLinks(render(fs.readFileSync(path.join(ROOT, "docs", c.project.language === "de" ? "de/workflow.md" : "workflow.md"), "utf8"), vars), c.project.language));
    for (const rel of walk(path.join(ROOT, "skills"))) write(path.join(".agents/skills", rel), fs.readFileSync(path.join(ROOT, "skills", rel), "utf8"));
    if (!fs.existsSync(".claude")) fs.mkdirSync(".claude");
    if (!fs.existsSync(".claude/skills")) fs.symlinkSync("../.agents/skills", ".claude/skills");
  }
  // Bundles for the Controller host and the Front agent (copied by the human or by `doctor --install`).
  for (const rel of walk(path.join(ROOT, "controller"))) write(path.join(".factory/controller", rel), render(fs.readFileSync(path.join(ROOT, "controller", rel), "utf8"), vars), /gate$|\.sh$/.test(rel) ? 0o755 : undefined);
  write(".factory/controller/factory.config.json", JSON.stringify(c, null, 2) + "\n");
  // The user-level skills the Controller and Front agent need on their host travel with the bundles.
  for (const s of USER_SKILLS) for (const rel of walk(path.join(ROOT, "skills", s))) write(path.join(".factory/controller/skills", s, rel), fs.readFileSync(path.join(ROOT, "skills", s, rel), "utf8"));
  for (const rel of walk(path.join(ROOT, "front-agent"))) write(path.join(".factory/front-agent", rel), render(fs.readFileSync(path.join(ROOT, "front-agent", rel), "utf8"), vars), /\.sh$/.test(rel) ? 0o755 : undefined);
  write(".factory/front-agent/factory.config.json", JSON.stringify(c, null, 2) + "\n");
  for (const rel of walk(path.join(ROOT, "server"))) write(path.join(".factory/server", rel), fs.readFileSync(path.join(ROOT, "server", rel), "utf8"), /\.sh$/.test(rel) ? 0o755 : undefined);
  fs.mkdirSync(".factory", { recursive: true });
  fs.writeFileSync(".factory/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  for (const dir of ["docs/reviews", "docs/reports", "docs/handoffs"]) { fs.mkdirSync(dir, { recursive: true }); if (!fs.existsSync(path.join(dir, ".gitkeep"))) fs.writeFileSync(path.join(dir, ".gitkeep"), ""); }
  if (!minimal(c)) appendGitignore(IGNORES(fs.existsSync("package.json")));
  // The adoption commit: only the files init wrote, committed with the ADR reference and pushed BEFORE the hooks are
  // armed, so origin/<main> carries AGENTS.md, the handbooks and the hooks for the first workers and the first wave.
  // A re-run on an initialised project is an update: no adoption commit (the hooks are armed; it could not be pushed).
  // package.json still untracked (a fresh repository): it goes in with the adoption, because the lockfile and
  // commands.install derive from it and a worktree without it cannot install.
  const untrackedPkg = fs.existsSync("package.json") && spawnSync("git", ["ls-files", "--error-unmatch", "package.json"], { stdio: "ignore" }).status !== 0;
  if (!hadManifest && untrackedPkg) say("  add    package.json (untracked; the install command and the lockfile depend on it)");
  const adopted = hadManifest ? "" : commitAdoption([...Object.keys(manifest.files), ...(lockfile ? [lockfile] : []), ...(untrackedPkg ? ["package.json"] : [])], c.project.mainBranch, vars.ADOPTION_ADR, minimal(c));
  // After the commit: from here on the standard is excluded, and the hooks are armed.
  if (minimal(c)) installStandard();
  if (hadManifest) say("  already initialised: files refreshed, nothing committed (commit the changes yourself, or use `agentic-factory update`)");
  const untracked = sh("git", ["status", "--porcelain", "--untracked-files=all"]).split("\n").filter((l) => l.startsWith("??")).map((l) => l.slice(3));
  if (!hadManifest && untracked.length) say(`  NOTE: still untracked, not on origin: ${untracked.slice(0, 8).join(", ")}${untracked.length > 8 ? ` (+${untracked.length - 8})` : ""}. Commit your project files before the first task.`);
  // Arm the hooks where they live: .githooks for the factory layout, the project's own directory (e.g. husky) in merge
  // mode, nothing in own mode.
  if (mode !== "own" && !minimal(c)) sh("git", ["config", "core.hooksPath", c.hooks.hooksPath]);
  if (installNow) { say("\nUser-level skills:"); installSkills(); }

  // --- the human's checklist -----------------------------------------------------------------
  const remote = c.hosts.workers.find((h) => h.kind === "remote");
  const ctl = c.hosts.workers.find((h) => h.name === c.hosts.controller.host);
  const steps = [
    adopted ? `Read docs/dev-workflow.md (the process) and ${minimal(c) ? "AGENTS.factory.md" : "AGENTS.md"} (the agents' rules). The adoption commit "Adopt agentic-factory (${vars.ADOPTION_ADR})" is on ${adopted}.${mode === "own" ? " Your own hooks stay in force; the factory hooks were not installed." : ` From now on protected files need an ADR reference in the commit message; try a commit without one to see the hook speak. A new or proposed ADR is committed by citing ${vars.ADOPTION_ADR} in the message; once accepted, cite the ADR itself.`}` : `Read docs/dev-workflow.md (the process) and ${minimal(c) ? "AGENTS.factory.md" : "AGENTS.md"} (the agents' rules). Commit the new files with a message that references the adoption ADR, e.g. \`git commit -m "Adopt agentic-factory (${vars.ADOPTION_ADR})"\`, and push to origin so workers and waves see them.`,
    remote && `Set up ${remote.name}: copy .factory/server/ there and follow docs/server-setup.md in the factory repo. Logins (gh, ${c.agents.default}, tailscale${c.agents.runner === "orca" ? ", Orca pairing" : ""}) are yours. Then put its Orca repo id into factory.config.json → hosts.workers[].orcaRepoId and run \`agentic-factory update\` to refresh the bundles.`,
    c.agents.runner === "orca" && !orcaRunning && `Orca: ${d.tools.orca ? `start it (\`${ORCA_BIN} open --json\`) and register the repo (\`${ORCA_BIN} repo add --path <repo> --json\`, id into hosts.workers[].orcaRepoId)` : "install it (https://github.com/stablyai/orca), then register the repo and put its id into hosts.workers[].orcaRepoId"}; the Orca skills load their guide from the binary (\`${ORCA_BIN} skills get orchestration\`).`,
    `Start the machine: \`agentic-factory start\` installs the user-level skills${remote ? ` (here and on ${ctl.kind === "remote" ? ctl.name : "the Controller's host"})` : ""}, copies the Front agent bundle to ~/front-agent/${c.project.name} and the Controller bundle to ${ctl.kind === "local" ? "" : `${ctl.name}:`}${c.hosts.controller.controllerDir ?? "~/controller"}, installs the gate, starts the load log and the Controller's session in an Orca terminal. The Front agent runs it for you; \`agentic-factory status\` shows the phase.`,
    c.hosts.frontAgent.preview.enabled && `Preview: clone the repo to ~/Development/${c.project.name}-preview, fill ${c.hosts.frontAgent.preview.envFile}, then load the launchd agent from .factory/front-agent/preview.plist.template (fill the paths) with \`launchctl bootstrap gui/$(id -u) <plist>\`.`,
    c.steering.mode === "github-issues" ? "Create the labels: ready-for-agent, in-progress, needs-human, debt:tests, debt:edge-case, debt:security, debt:load, debt:style (gh label create …)." : "Create your first ticket from docs/tasks/T00-template.md.",
    "Run `agentic-factory doctor` any time to check the setup.",
  ].filter(Boolean);
  say(`\nDone. Your checklist:\n${steps.map((s, i) => ` ${i + 1}. ${s}`).join("\n")}`);
  rl?.close();
}

function templateVars(c) {
  const ctl = c.hosts.workers.find((h) => h.name === c.hosts.controller.host) ?? c.hosts.workers[0];
  const remote = c.hosts.workers.find((h) => h.kind === "remote");
  const projectDir = ctl.projectDir ?? (ctl.kind === "local" ? path.join(ctl.projectsDir, c.project.name) : `${ctl.projectsDir}/${c.project.name}`);
  const orca = c.agents.runner === "orca";
  return {
    // DATE is the adoption day, recorded once in factory.config.json: a later update must not rewrite recorded decisions.
    CONTROLLER_DIR: c.hosts?.controller?.controllerDir ?? "~/controller", PROJECT: c.project.name, HUMAN: c.project.humanName, MAIN: c.project.mainBranch, BRANCH_PREFIX: c.project.branchPrefix ?? "agents/", DATE: c.project.adoptedOn ?? (process.env.FACTORY_TODAY ?? new Date().toISOString().slice(0, 10)),
    ADOPTION_ADR: `ADR-${adoptionAdrNumber()}`,
    ...architectureVars(c),
    HOOKS_DIR: c.hooks?.dir ?? ".githooks",
    HOOKS_PATH: c.hooks?.hooksPath ?? ".githooks",
    PROCESS_DOCS: minimal(c) ? "`docs/process-decisions.md` (the project's own record; create it with the first decision, the handbooks are generated)" : "`docs/coordinator.md` and `docs/dev-workflow.md`",
    PROCESS_READ: minimal(c) ? " Also `docs/process-decisions.md` if it exists: this project's own decisions, which win over the generated handbooks." : "",
    READ_FIRST_EXTRA: minimal(c) ? " The project's own decisions are in `docs/process-decisions.md`, its own rules in `AGENTS.md`, if they exist. They win over this file." : "",
    RETRO_DOCS: minimal(c) ? "`docs/process-decisions.md`, a tracked deviation from a generated file (`agentic-factory deviate <path>`), `CODING_STANDARDS.md` once it deviates, or the project's `AGENTS.md` through an accepted ADR" : "`docs/coordinator.md`, `docs/review-protocol.md`, `CODING_STANDARDS.md`, or `AGENTS.md` through an accepted ADR",
    AGENTS_READ: minimal(c) ? "AGENTS.factory.md, the project's AGENTS.md if it has one" : "AGENTS.md",
    COORDINATOR_UPDATES: minimal(c) ? "`docs/process-decisions.md`" : "this handbook and `docs/dev-workflow.md`",
    WORKFLOW_SYNC: minimal(c) ? "The handbooks are generated: a decision for this project goes into `docs/process-decisions.md`, a changed rule into a deviation (`agentic-factory deviate <path>`)." : "Whenever a rule here, in `AGENTS.md`, `docs/review-protocol.md` or `docs/architect-protocol.md` changes, update it in the same change.",
    RULES_FILE: minimal(c) ? "`AGENTS.factory.md`" : "`AGENTS.md`",
    AGENTS_FACTORY_PROTECTED: minimal(c) ? ", `AGENTS.factory.md`" : "",
    SPEC_STANDARD_NOTE: minimal(c) ? " Binding: AGENTS.factory.md (the factory's rules) and the project's AGENTS.md if it has one. Files generated by the factory are read-only links outside the project's history: read them, never edit them, never force-add them." : "",
    HOOK_ENFORCEMENT: minimal(c) ? `Enforced by the factory hooks installed in this clone (\`.git/hooks\`, by \`agentic-factory start\`)${(c.hooks?.mode ?? "factory") === "merge" ? `; the project's own hooks in \`${c.hooks.dir}\` run first` : ""}. \`pre-push\` checks every update of \`${c.project.mainBranch}\`.` : (c.hooks?.mode ?? "factory") === "own"
      ? `**hooks.mode = own:** this project keeps its own hooks in \`${c.hooks?.dir ?? c.hooks?.ownDir ?? ".githooks"}\`; they, not the factory's, must enforce the commit checks and the review gate on \`${c.project.mainBranch}\`. The factory does not verify them. The project's own \`pre-push\` must implement the rule below for every update of \`${c.project.mainBranch}\`.`
      : `Enforced by the factory hooks in \`${c.hooks?.dir ?? ".githooks"}/\` (\`tools/factory-guardrails.mjs\`)${(c.hooks?.mode ?? "factory") === "merge" ? "; the project's own hooks run first as `<hook>.own` next to them" : ""}. With the hooks armed (\`core.hooksPath=${c.hooks?.hooksPath ?? ".githooks"}\`), \`pre-push\` checks every update of \`${c.project.mainBranch}\`.`,
    VERIFY: c.commands.verify || "the verify command", E2E: c.commands.e2e || "the browser suite", RELEASE: (c.commands.release ?? []).join(" && ") || "the release gates",
    UI_LANGUAGE: c.project.language === "de" ? "German" : "English", LANGUAGE_NAME: c.project.language === "de" ? "German" : "English",
    MAX_ROUNDS: String(c.reviews.maxRounds), SUITE_MAX: String(ctl.capacity?.suiteWorkersMax ?? c.capacity.suiteWorkersMax), READONLY_MAX: String(ctl.capacity?.readOnlyWorkersMax ?? c.capacity.readOnlyWorkersMax),
    UNIT_SLOTS: String(ctl.capacity?.gate?.unitSlots ?? c.capacity.gate.unitSlots), E2E_SLOTS: String(ctl.capacity?.gate?.e2eSlots ?? c.capacity.gate.e2eSlots),
    MODEL_SMALL: c.agents.models.small, MODEL_DEFAULT: c.agents.models.default, MODEL_LARGE: c.agents.models.large,
    AGENT_DEFAULT: c.agents.default, AGENT_FALLBACK: c.agents.fallback.agent, FB_SMALL: c.agents.fallback.models.small, FB_DEFAULT: c.agents.fallback.models.default, FB_LARGE: c.agents.fallback.models.large, QUOTA_THRESHOLD: String(c.agents.fallback.quotaThresholdPercent),
    WAVE_PASSED: String(c.reviews.waveTriggers.passedTasks), WAVE_MINUTES: String(c.reviews.waveTriggers.waitMinutes), FAST_LANE_MAX: String(c.improvement.fastLaneMaxParallel),
    PROJECT_DIR: projectDir, WORKSPACES: `${ctl.workspacesDir}/${c.project.name}/`,
    ORCA_LINE: orca ? ` through Orca (repo id \`${ctl.orcaRepoId || "<set hosts.workers[].orcaRepoId>"}\`${ctl.orcaEnvironment ? `, environment \`${ctl.orcaEnvironment}\`` : ""})` : " with plain terminal workers (runner: terminal)",
    TICKETS_LINE: c.steering.mode === "github-issues" ? `GitHub issues labelled \`${c.steering.readyLabel}\` (\`node steering/issues.mjs ready\`)` : `\`${projectDir}/${c.steering.tasksDir}/*.md\` with a Status line (\`node steering/tasks.mjs list ready\`)`,
    ACK_LINE: orca ? "; ack every delivery with `orca orchestration check --ack <delivery> --json`" : "; terminal workers append DONE/ESCALATE lines under events/",
    NUDGE_LINE: orca ? "An answer to an escalation does not wake an idle worker. Always also send the text into its terminal with `orca terminal send --terminal <handle> --text \"…\" --enter`." : "Terminal workers cannot be nudged; restart a stalled one in its worktree with a resume spec.",
    STEERING_SCRIPT: c.steering.mode === "github-issues" ? "issues.mjs" : "tasks.mjs",
    PREVIEW_URL: c.hosts.frontAgent.preview.enabled ? `http://localhost:${c.hosts.frontAgent.preview.port}` : "n/a", PREVIEW_PORT: String(c.hosts.frontAgent.preview.port), PREVIEW_CMD: c.hosts.frontAgent.preview.command, PREVIEW_ENV_FILE: c.hosts.frontAgent.preview.envFile ?? "", INSTALL_CMD: c.commands.install ?? "",
    SSH_ALIAS: remote?.ssh ?? "local",
    CONTROLLER_LOCATION: ctl.kind === "local" ? `on this machine (\`${c.hosts.controller.controllerDir ?? "~/controller"}\`)` : `on the server \`${ctl.name}\` (ssh alias \`${ctl.ssh}\`, \`${c.hosts.controller.controllerDir ?? "~/controller"}\`)`,
    INBOX_CMD: ctl.kind === "local" ? `\`cat >> ${c.hosts.controller.controllerDir ?? "~/controller"}/inbox.md\`` : `\`ssh ${ctl.ssh} 'cat >> ${c.hosts.controller.controllerDir ?? "~/controller"}/inbox.md'\``,
    PREVIEW_PLIST: `de.${c.project.name}.preview`, PREVIEW_LABEL: `de.${c.project.name}.preview`, PREVIEW_SCRIPT: `${os.homedir()}/front-agent/${c.project.name}/preview-update.sh`, HOME: os.homedir(),
    FACTORY_CLI: `node ${path.join(ROOT, "bin/agentic-factory.mjs").replace(os.homedir(), "~")}`,
    COMMIT_PATTERN: `mv .env ../.${c.project.name}.env; git add …; git commit …; mv ../.${c.project.name}.env .env`,
    // Project-specific Controller rules live in the project (docs/controller-rules.md) and are rendered into CONTROLLER.md.
    PROJECT_RULES: fs.existsSync("docs/controller-rules.md") ? fs.readFileSync("docs/controller-rules.md", "utf8").trim() : "_None yet. Put project-specific hard rules, data boundaries, known flakes and decision pointers into `docs/controller-rules.md`; `agentic-factory update` renders them here._",
  };
}
// The untracked standard: footprint "minimal" in factory.config.json. Everything a project has not changed lives in the
// clone's .git/factory, never in its history, and reaches each worktree as a link (standard/arm.mjs). A file the project
// tracks at the same path is its deviation and wins, so what is checked in is exactly what is individual.
const minimal = (c) => c?.footprint === "minimal";
const STANDARD_HOOKS = ".git/hooks";
// A project's own record of the work. Tickets, reviews and debt move out with the companion repo, not here.
const trackedInMinimal = (rel) => rel === "docs/debt.md" || /^docs\/adr\/0001-/.test(rel);
const HANDBOOK = /^(docs\/(coordinator|review-protocol|architect-protocol|dev-workflow)\.md|AGENTS\.factory\.md|CODING_STANDARDS\.md)$/;
const PASSED_THROUGH_HOOKS = ["applypatch-msg", "pre-applypatch", "post-applypatch", "prepare-commit-msg", "post-commit", "pre-rebase", "post-merge", "post-rewrite", "pre-auto-gc", "post-index-change", "reference-transaction", "sendemail-validate"];
const GENERATED_HEADER = /^> Generated by agentic-factory[^\n]*\n\n/;
// Every path the standard links into a worktree.
const standardPaths = () => [
  ...walk(path.join(ROOT, "templates")).filter((rel) => !trackedInMinimal(rel) && !/^\.githooks\//.test(rel) && rel !== "tools/factory-guardrails.mjs").map((rel) => (rel === "AGENTS.md" ? "AGENTS.factory.md" : rel)),
  "docs/dev-workflow.md",
  ...walkDirs(path.join(ROOT, "skills")).flatMap((s) => [`.agents/skills/${s}`, `.claude/skills/${s}`]),
];
function renderStandard(c, vars) {
  const out = path.join(cwd, ".factory/standard");
  fs.rmSync(out, { recursive: true, force: true });
  const put = (rel, content, mode) => { const p = path.join(out, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); fs.chmodSync(p, mode); };
  const links = [];
  const generated = (target, content) => { put(`files/${target}`, (HANDBOOK.test(target) ? `> Generated by agentic-factory ${PKG.version}. Read-only, not in this project's history. Project decisions go into \`docs/process-decisions.md\`. To change this file for this project only: \`agentic-factory deviate ${target}\`.\n\n` : "") + (target === "AGENTS.factory.md" ? content : content.replaceAll("`AGENTS.md`", "`AGENTS.factory.md` and the project's `AGENTS.md`, if it has one")), 0o444); links.push({ path: target, target: `files/${target}` }); };
  // A hooks directory that is git's own would make each hook call itself. /dev/null/<hook> never exists.
  const own = /^\.git(\/|$)/.test(c.hooks.dir) || path.resolve(cwd, c.hooks.dir) === path.join(gitCommonDir(), "hooks") ? "/dev/null" : c.hooks.dir;
  // The factory's hook also calls the project's tracked one where it is, and finds the guardrails next to itself.
  const hook = (text) => text.replace(/^if \[ -x "\$d\/([a-z-]+)\.own" \]; then "\$d\/[a-z-]+\.own"(.*)$/gm, (line, h, rest) => `${line}\nif [ -x "${own}/${h}" ]; then "${own}/${h}"${rest}`).replaceAll("node tools/factory-guardrails.mjs", 'node "$d/factory-guardrails.mjs"');
  // Git only runs what is in the hooks directory, so every other hook a project may have needs a way through.
  for (const h of [...PASSED_THROUGH_HOOKS, ...(fs.existsSync(path.join(own, "push-to-checkout")) ? ["push-to-checkout"] : [])]) put(`hooks/${h}`, `#!/bin/sh
${HOOK_MARKER} (${h}): runs the project's own, if any. Both get the same stdin.
d=$(dirname "$0")
a="$d/${h}.own"; b="${own}/${h}"
if [ -x "$a" ] && [ -x "$b" ]; then in=$(mktemp); trap 'rm -f "$in"' EXIT; cat > "$in"; "$a" "$@" < "$in" || exit $?; "$b" "$@" < "$in" || exit $?; exit 0; fi
if [ -x "$a" ]; then exec "$a" "$@"; fi
if [ -x "$b" ]; then exec "$b" "$@"; fi
exit 0
`, 0o755);
  for (const rel of walk(path.join(ROOT, "templates"))) {
    if (trackedInMinimal(rel)) continue;
    const text = render(fs.readFileSync(path.join(ROOT, "templates", rel), "utf8"), vars);
    if (/^\.githooks\//.test(rel)) put(`hooks/${path.basename(rel)}`, hook(text), 0o755);
    else if (rel === "tools/factory-guardrails.mjs") put("hooks/factory-guardrails.mjs", text, 0o644);
    else generated(rel === "AGENTS.md" ? "AGENTS.factory.md" : rel, text);
  }
  generated("docs/dev-workflow.md", absolutizeDocLinks(render(fs.readFileSync(path.join(ROOT, "docs", c.project.language === "de" ? "de/workflow.md" : "workflow.md"), "utf8"), vars), c.project.language));
  put("hooks/post-checkout", fs.readFileSync(path.join(ROOT, "standard/post-checkout"), "utf8").replaceAll("{{OWN_HOOKS_DIR}}", own), 0o755);
  put("arm.mjs", fs.readFileSync(path.join(ROOT, "standard/arm.mjs"), "utf8"), 0o644);
  for (const s of walkDirs(path.join(ROOT, "skills"))) {
    fs.cpSync(path.join(ROOT, "skills", s), path.join(out, "skills", s), { recursive: true });
    links.push({ path: `.agents/skills/${s}`, target: `skills/${s}` }, { path: `.claude/skills/${s}`, target: `../../.agents/skills/${s}`, relative: true });
  }
  put("standard.json", JSON.stringify({ factoryVersion: PKG.version, ignores: ["/.factory/", "/.build/", "/.scratch/", ".env", ".env.*", "!.env.example", ...(fs.existsSync("package.json") ? ["node_modules/"] : [])], links }, null, 2) + "\n", 0o644);
}
function installStandardOnRemotes(c) {
  let failed = 0;
  for (const h of c.hosts.workers.filter((h) => h.kind === "remote")) { const problem = installStandardOn(h, c); if (problem) { failed++; say(`  ${h.name}: ${problem}. Its clone keeps the older standard until this works.`); } else say(`  ${h.name}: standard installed, hooks armed`); }
  return failed;
}
// What git would really run, checked by the same code the wave relies on.
const checkHooks = () => { const arm = path.join(gitCommonDir(), "factory/arm.mjs"); if (!fs.existsSync(arm)) return "the factory's standard is not installed in this clone"; const r = spawnSync("node", [arm, "--check"], { encoding: "utf8" }); return r.status === 0 ? "" : (r.stderr || "the check failed").trim().split("\n").pop(); };
const gitCommonDir = () => fs.realpathSync(sh("git", ["rev-parse", "--git-common-dir"]));
function installStandard() {
  const dest = path.join(gitCommonDir(), "factory"), next = `${dest}.new.${process.pid}`, old = `${dest}.old.${process.pid}`;
  try {
    fs.cpSync(path.join(cwd, ".factory/standard"), next, { recursive: true });
    if (fs.existsSync(dest)) fs.renameSync(dest, old);
    fs.renameSync(next, dest);
    fs.rmSync(old, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(next, { recursive: true, force: true });
    if (!fs.existsSync(dest) && fs.existsSync(old)) fs.renameSync(old, dest);
    say(`Standard: could not replace it (${error.code ?? error.message}). Is another update or start running here? Run this again.`);
    process.exitCode = 1;
    return false;
  }
  const r = spawnSync("node", [path.join(dest, "arm.mjs"), "--all"], { encoding: "utf8" });
  if (r.status !== 0) { say(`Standard: ${(r.stderr || "arming failed").trim().split("\n").pop()}`); process.exitCode = 1; return false; }
  if (r.stderr.trim()) say(r.stderr.trim());
  say("  standard installed in .git/factory, hooks armed, linked into every worktree of this clone");
  return true;
}
// Another host's clone: same files, armed there. Git hooks there run under the same login shell the workers use.
function installStandardOn(h, c) {
  const dir = h.projectDir ?? `${h.projectsDir}/${c.project.name}`;
  const clone = spawnSync("ssh", [...sshArgsFor(h), `test -d ${dir}/.git`], { encoding: "utf8", timeout: 60000 });
  if (clone.status !== 0) return `no clone at ${dir}, or the host cannot be reached`;
  const copy = spawnSync("rsync", ["-a", "--delete", "-e", `ssh ${sshArgsFor(h).slice(0, -1).map((a) => JSON.stringify(a)).join(" ")}`, ".factory/standard/", `${h.ssh}:${dir}/.git/factory/`], { encoding: "utf8" });
  if (copy.status !== 0) return `copy failed: ${(copy.stderr || "").trim().slice(0, 200)}`;
  const arm = spawnSync("ssh", [...sshArgsFor(h), `bash -lc 'cd ${dir} && node .git/factory/arm.mjs --all'`], { encoding: "utf8" });
  return arm.status === 0 ? "" : `${(arm.stderr || "arming failed").trim().split("\n").pop().slice(0, 200)}`;
}
// Makes a generated file the project's own: a real file at the same path, staged. From then on it wins over the standard.
function deviate() {
  const top = sh("git", ["rev-parse", "--show-toplevel"]);
  if (top) process.chdir(top);
  const c = readConfig(), rel = args[1];
  if (!minimal(c)) { say("deviate needs footprint \"minimal\" in factory.config.json: in this project the standard is tracked, so just edit the file."); process.exit(1); }
  const manifest = path.join(gitCommonDir(), "factory/standard.json");
  if (!fs.existsSync(manifest)) { say("The factory's standard is not installed in this clone. Run `agentic-factory start` first."); process.exit(1); }
  const standard = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (!standard.links.some((l) => l.path === rel)) { say(`${rel ?? "(no path)"} is not part of the standard. Usage: agentic-factory deviate <path>, for example docs/review-protocol.md`); process.exit(1); }
  const p = path.join(sh("git", ["rev-parse", "--show-toplevel"]), rel);
  if (!fs.existsSync(p)) { say(`${rel} is missing in this worktree. Run \`agentic-factory start\` first.`); process.exit(1); }
  if (!fs.lstatSync(p).isSymbolicLink()) {
    if (sh("git", ["ls-files", "--", rel])) { say(`${rel} already deviates.`); return; }
    // A real file that git does not track: excluded, so nothing shows it, and a merge could overwrite it.
    const forced = spawnSync("git", ["add", "-f", "--", p], { encoding: "utf8" });
    if (forced.status !== 0) { say(`git add failed: ${(forced.stderr || "").trim().slice(0, 200)}`); process.exit(1); }
    say(`${rel} was untracked and is now staged as this project's own. Commit it.`);
    return;
  }
  const real = fs.realpathSync(p);
  fs.unlinkSync(p);
  fs.cpSync(real, p, { recursive: true });
  if (fs.statSync(p).isFile()) { fs.chmodSync(p, 0o644); fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(GENERATED_HEADER, "")); }
  const added = spawnSync("git", ["add", "-f", "--", p], { encoding: "utf8" });
  if (added.status !== 0) { say(`git add failed: ${(added.stderr || "").trim().slice(0, 200)}`); process.exit(1); }
  say(`${rel} is now this project's own and staged. Change it and commit. Later factory versions no longer update it; \`doctor\` lists it.`);
}
const render = (text, vars) => text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
// Templates that an existing project may already have in its own form: the adoption ADR is skipped when the project
// already has an ADR 0001 (its numbering is its own); the ADR template is skipped when docs/adr/ already exists.
// Hooks in a project that already has some. Three modes, decided once and recorded in factory.config.json → hooks:
//   factory  no own hooks: the factory hooks are written into .githooks/
//   merge    own hooks exist (pre-commit, commit-msg, pre-push, pre-merge-commit; in .githooks/ or in the directory
//            core.hooksPath points to, incl. husky v9's .husky/_ layout): each own hook is kept as <hook>.own in the
//            hooks directory and the factory hook runs it first under set -e; the factory hooks are written INTO that
//            directory and core.hooksPath stays where the project put it (a husky `prepare` script cannot disarm them)
//   own      only on request (init --keep-own-hooks): nothing is written, the project's hooks must enforce the gate
const HOOK_NAMES = ["pre-commit", "commit-msg", "pre-push", "pre-merge-commit"];
// Only the repository's own (--local) core.hooksPath counts, and only when it points inside the worktree: a user-level
// value (dotfiles, a global secret scanner) is never touched or taken over; the local .githooks overrides it.
function hooksSetup() {
  const local = sh("git", ["config", "--local", "core.hooksPath"]);
  const effective = sh("git", ["config", "core.hooksPath"]);
  if (!local && effective) say(`  NOTE: a global core.hooksPath (${effective}) is in effect; init sets the repository's own hooks path and leaves the global hooks untouched.`);
  // Absolute paths inside the worktree are fine and recorded relative to it; paths outside the worktree are not used.
  const real = (f) => { try { return fs.realpathSync(f); } catch { return f; } };
  const abs = local ? real(path.resolve(cwd, local)) : "", realCwd = real(cwd);
  const inside = Boolean(local) && abs.startsWith(realCwd + path.sep);
  if (local && !inside) { say(`  NOTE: core.hooksPath=${local} points outside this repository; it is not used as the hooks directory (the factory uses .githooks) and the hooks there will not run in this repository.`); return { dir: ".githooks", hooksPath: ".githooks", layout: "githooks" }; }
  const p = local ? path.relative(realCwd, abs) : "";
  if (p && /\/_\/?$/.test(p) && fs.existsSync(path.dirname(p))) return { dir: path.dirname(p), hooksPath: p, layout: "husky" };   // husky v9: .husky/_ runs .husky/<hook>
  if (p && p !== ".githooks" && fs.existsSync(p)) return { dir: p, hooksPath: p, layout: "custom" };
  return { dir: ".githooks", hooksPath: ".githooks", layout: "githooks" };
}
// Factory hooks carry a marker line; everything else in the hooks directory is the project's own.
const HOOK_MARKER = "# agentic-factory hook";
const isFactoryHook = (file) => { const t = fs.readFileSync(file, "utf8"); return t.includes(HOOK_MARKER) || t.includes("factory-guardrails"); };
const ownHookFiles = (setup) => HOOK_NAMES.filter((h) => fs.existsSync(path.join(setup.dir, h)) && !isFactoryHook(path.join(setup.dir, h)));
const hookMode = (setup = hooksSetup()) => (flag("--keep-own-hooks") ? "own" : ownHookFiles(setup).length ? "merge" : "factory");
const ownHooksDir = () => hooksSetup().dir;
const ownAdr = () => fs.existsSync("docs/adr") && fs.readdirSync("docs/adr").some((f) => /^(ADR-)?0001[-.]/.test(f) && !f.includes("adopt-agentic-factory"));
// The adoption ADR takes the next free number when the project already numbers its ADRs.
// architecture.mode is the human's choice. A config from before this choice counts as off until the human decides.
function architectureVars(c) {
  if (c.architecture?.mode !== "architect") return {
    ARCHITECTURE_LOOP: "   - **Architecture document:** this project has not chosen one (`architecture.mode` is not `architect`), so there is no baseline and no stewardship. Spec and conformance reviews still run.",
    ARCHITECTURE_PROTOCOL: "## Architecture document\n\nThis project has not chosen a maintained `ARCHITECTURE.md` (`architecture.mode` in `factory.config.json`), so there is no baseline and no stewardship. Spec and conformance reviews still run. To turn it on, set the mode to `architect` and run `agentic-factory update`.",
  };
  return {
    ARCHITECTURE_LOOP: `   - **Architecture baseline:** if \`ARCHITECTURE.md\` is missing on \`origin/${c.project.mainBranch}\`, start one (\`mkspec baseline\`) as the first task when the repo holds code beyond the adoption files, otherwise after the first merged wave. It blocks no feature work. An existing file is checked, never replaced.
   - **Wave merged:** start the stewardship review in the same cycle (\`mkspec steward "<wave title>"\`, \`--readonly\`). Its branch joins the next wave without a Tester, because it changes only documents.
   - **Open points:** when \`ARCHITECTURE.md\` lists points under "Open", name their number in \`status.md\` under "Problems". They are questions for ${c.project.humanName}, not blockers.`,
    ARCHITECTURE_PROTOCOL: `## Keeping ARCHITECTURE.md current

\`ARCHITECTURE.md\` describes the architecture as it is, and every review compares against it. ${c.project.humanName} chose this (\`architecture.mode\`).

- Every level 3 change, and every accepted ADR that changes modules, responsibilities, data flows or interfaces, updates \`ARCHITECTURE.md\` in the same change, citing that ADR. A process ADR does not.
- Conformance fails if a level 3 change does not update it. A level 2 change that makes it wrong is noted as a finding, and stewardship follows it up.
- Stewardship after each wave reports any drift between the document and the code, with file evidence, and records it in \`docs/debt.md\`.
- The document states what the code does. A point without an approved requirement or ADR is marked \`open\`. Code never proves a decision.

## Baseline: creating ARCHITECTURE.md

A Worker Architect creates it from the code: as the first task when the repo already holds code, otherwise after the first merged wave. Every statement carries file evidence.

- Nothing is decided here. What the code does but no requirement or ADR approves goes under "Open". Those points are questions for ${c.project.humanName} and block no feature work.
- An existing \`ARCHITECTURE.md\` is never replaced. The Architect reports where it differs from the code, as a stewardship review does.
- The file is protected, so the commit cites ${`ADR-${adoptionAdrNumber()}`}. It changes only documents, so it joins the next wave without a Tester.
- The first line names the commit last checked. Stewardship moves it when it finds no drift, citing the same ADR.`,
  };
}

const adoptionAdrNumber = () => { if (!fs.existsSync("docs/adr")) return "0001"; const nums = fs.readdirSync("docs/adr").map((f) => /^(?:ADR-)?(\d{4})[-.]/.exec(f)?.[1]).filter(Boolean).map(Number); const existing = fs.readdirSync("docs/adr").find((f) => f.includes("adopt-agentic-factory")); if (existing) return /(\d{4})/.exec(existing)[1]; return String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, "0"); };
const skipTemplate = (rel, mode = hookMode()) => (/^\.githooks\//.test(rel) || rel === "tools/factory-guardrails.mjs") && mode === "own";
// The adoption ADR template is written under the project's next free number; hook templates go into the hooks directory.
const templateTarget = (rel, hooksDir = ".githooks") => (/^docs\/adr\/0001-adopt-agentic-factory\.md$/.test(rel) ? `docs/adr/${adoptionAdrNumber()}-adopt-agentic-factory.md` : /^\.githooks\//.test(rel) ? `${hooksDir}/${rel.slice(".githooks/".length)}` : rel);
// merge mode: every own hook becomes <dir>/<hook>.own; the factory hook of the same name runs it first under set -e.
// Returns the .own files created (relative paths) so they join the manifest and the adoption commit.
function keepOwnHooks(setup) {
  const kept = [];
  for (const h of ownHookFiles(setup)) {
    const own = path.join(setup.dir, `${h}.own`);
    if (fs.existsSync(own)) continue;
    fs.renameSync(path.join(setup.dir, h), own); fs.chmodSync(own, 0o755); kept.push(own);
  }
  return kept;
}
// The workflow guide copied into a project links to sibling docs that are not copied; point those links at the factory repo.
const FACTORY_DOCS_URL = "https://github.com/bussard76/agentic-factory/blob/main/docs";
const absolutizeDocLinks = (text, lang) => text.replace(/\]\((\.\.\/)?([a-z-]+\.md)(#[^)]*)?\)/g, (m, up, f, hash) => `](${FACTORY_DOCS_URL}/${up || lang === "en" ? "" : "de/"}${f}${hash ?? ""})`);
function commitAdoption(files, branch, adr = "ADR-0001", untrackedStandard = false) {
  const r = spawnSync("git", ["add", "--", ...(untrackedStandard ? [] : [".gitignore", ".factory/manifest.json", ".claude"]), "docs/reviews/.gitkeep", "docs/reports/.gitkeep", "docs/handoffs/.gitkeep", ...files.filter((f) => !f.startsWith(".factory/") && fs.existsSync(f))], { encoding: "utf8" });
  if (r.status !== 0) { say(`  adoption commit not made: git add failed: ${(r.stderr || "").trim().slice(0, 200)}`); return ""; }
  if (spawnSync("git", ["diff", "--cached", "--quiet"]).status === 0) return "";
  // Hooks may already be armed (a repo with its own hooks, or core.hooksPath set earlier): this one commit and push
  // run without them, because the review gate they install would reject the very commit that installs it.
  const c = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", `Adopt agentic-factory (${adr})`], { encoding: "utf8" });
  if (c.status !== 0) { say(`  adoption commit failed: ${(c.stderr || c.stdout).trim().slice(0, 200)}`); return ""; }
  const p = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "push", "-q", "-u", "origin", branch], { encoding: "utf8" });
  if (p.status !== 0) { say(`  adoption commit created locally; push failed: ${(p.stderr || "").trim().slice(0, 200)}`); process.exitCode = 1; return "this branch (not pushed)"; }
  say(`  commit Adopt agentic-factory (${adr}), pushed to origin/${branch}`);
  return `origin/${branch}`;
}
function walk(dir, base = dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))])); }
// The bundles are regenerated by `update` and copied to their hosts by hand; they do not belong in the project's history.
// node_modules/ is ignored for Node projects because the hooks' lint/typecheck may install on first use.
const IGNORES = (node) => [".factory/new/", ".factory/controller/", ".factory/front-agent/", ".factory/server/", ".build/", ".env", ".env.*", "!.env.example", ".scratch/", ...(node ? ["node_modules/"] : [])];
function appendGitignore(lines) { const p = ".gitignore"; const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; const add = lines.filter((l) => !cur.split("\n").includes(l)); if (add.length) fs.writeFileSync(p, cur + (cur.endsWith("\n") || !cur ? "" : "\n") + add.join("\n") + "\n"); }

// --- update ----------------------------------------------------------------------------------------
async function update() {
  if (!fs.existsSync("factory.config.json")) { say("No factory.config.json here. Run init first."); process.exit(1); }
  say(`Re-rendering templates and bundles from factory ${PKG.version}; files you changed locally are kept and the new version lands in .factory/new/.`);
  process.argv.push("--yes"); args.push("--yes");
  await initNonInteractiveRefresh();
}
async function initNonInteractiveRefresh() {
  const c = JSON.parse(fs.readFileSync("factory.config.json", "utf8"));
  // Projects adopted before adoptedOn existed: derive the adoption day once (first commit of the manifest, else the
  // adoption ADR's Date line, else today) and persist it, so the recorded decision dates stop following the clock.
  if (!c.project.adoptedOn) {
    const fromGit = sh("git", ["log", "--diff-filter=A", "--format=%as", "-1", "--", ".factory/manifest.json"]);
    const adrFile = fs.existsSync("docs/adr") ? fs.readdirSync("docs/adr").find((f) => f.includes("adopt-agentic-factory")) : null;
    const fromAdr = adrFile ? /^Date:\s*(\d{4}-\d{2}-\d{2})/m.exec(fs.readFileSync(path.join("docs/adr", adrFile), "utf8"))?.[1] : null;
    c.project.adoptedOn = fromGit || fromAdr || process.env.FACTORY_TODAY || new Date().toISOString().slice(0, 10);
    say(`  recorded project.adoptedOn = ${c.project.adoptedOn} in factory.config.json (decision dates stay fixed)`);
  }
  // hooks: keep a recorded mode; fill in the directory and hooksPath for configs written by an older factory.
  const setup = hooksSetup();
  c.hooks = { mode: c.hooks?.mode ?? hookMode(setup), dir: c.hooks?.dir ?? c.hooks?.ownDir ?? setup.dir, hooksPath: c.hooks?.hooksPath ?? (c.hooks?.mode === "own" ? setup.hooksPath : c.hooks?.ownDir ?? setup.hooksPath), layout: c.hooks?.layout ?? setup.layout };
  fs.writeFileSync("factory.config.json", JSON.stringify(c, null, 2) + "\n");
  const vars = templateVars(c);
  const manifest = JSON.parse(fs.existsSync(".factory/manifest.json") ? fs.readFileSync(".factory/manifest.json", "utf8") : '{"files":{}}');
  let written = 0, kept = 0;
  const write = (rel, content, mode) => {
    const target = path.join(cwd, rel);
    if (fs.existsSync(target)) {
      const current = fs.readFileSync(target, "utf8");
      if (current === content) return;
      // Unknown to the manifest, or changed since we generated it: user-owned, keep it.
      if (!manifest.files[rel] || manifest.files[rel] !== hash(current)) { kept++; fs.mkdirSync(path.dirname(path.join(cwd, ".factory/new", rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, ".factory/new", rel), content); say(`  keep   ${rel} (user-owned) → new version in .factory/new/${rel}`); return; }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); if (mode) fs.chmodSync(target, mode); manifest.files[rel] = hash(content); written++; say(`  update ${rel}`);
  };
  const mode = c.hooks.mode, hdir = c.hooks.dir;
  if (mode === "merge" && !minimal(c)) {
    // A project merged by an older factory still has the appended lines in pre-commit: split the own part out and let
    // the template replace the file (the appended file was a factory product, so it joins the manifest).
    const pc = path.join(hdir, "pre-commit");
    if (fs.existsSync(pc) && fs.readFileSync(pc, "utf8").includes("# agentic-factory guardrails") && !fs.existsSync(`${pc}.own`)) {
      const cur = fs.readFileSync(pc, "utf8"); const own = cur.split("\n# agentic-factory guardrails")[0].replace(/\s*$/, "\n");
      fs.writeFileSync(`${pc}.own`, own); fs.chmodSync(`${pc}.own`, 0o755); manifest.files[pc] = hash(cur); manifest.files[`${pc}.own`] = hash(own); say(`  keep   ${pc}.own (the project's own pre-commit, split out)`);
    }
    // Own hooks that appeared since (or were never merged): keep them as .own so the templates can take their place.
    for (const own of keepOwnHooks({ dir: hdir })) { manifest.files[own] = hash(fs.readFileSync(own, "utf8")); say(`  keep   ${own} (the project's own hook)`); }
  }
  if (minimal(c)) renderStandard(c, vars);
  else {
    for (const rel of walk(path.join(ROOT, "templates"))) if (!skipTemplate(rel, mode)) write(templateTarget(rel, hdir), render(fs.readFileSync(path.join(ROOT, "templates", rel), "utf8"), vars), /\.githooks\/|tools\//.test(rel) ? 0o755 : undefined);
    write("docs/dev-workflow.md", absolutizeDocLinks(render(fs.readFileSync(path.join(ROOT, "docs", c.project.language === "de" ? "de/workflow.md" : "workflow.md"), "utf8"), vars), c.project.language));
    for (const rel of walk(path.join(ROOT, "skills"))) write(path.join(".agents/skills", rel), fs.readFileSync(path.join(ROOT, "skills", rel), "utf8"));
  }
  for (const rel of walk(path.join(ROOT, "controller"))) write(path.join(".factory/controller", rel), render(fs.readFileSync(path.join(ROOT, "controller", rel), "utf8"), vars), /gate$|\.sh$/.test(rel) ? 0o755 : undefined);
  write(".factory/controller/factory.config.json", JSON.stringify(c, null, 2) + "\n");
  for (const s of USER_SKILLS) for (const rel of walk(path.join(ROOT, "skills", s))) write(path.join(".factory/controller/skills", s, rel), fs.readFileSync(path.join(ROOT, "skills", s, rel), "utf8"));
  for (const rel of walk(path.join(ROOT, "front-agent"))) write(path.join(".factory/front-agent", rel), render(fs.readFileSync(path.join(ROOT, "front-agent", rel), "utf8"), vars), /\.sh$/.test(rel) ? 0o755 : undefined);
  write(".factory/front-agent/factory.config.json", JSON.stringify(c, null, 2) + "\n");
  for (const rel of walk(path.join(ROOT, "server"))) write(path.join(".factory/server", rel), fs.readFileSync(path.join(ROOT, "server", rel), "utf8"), /\.sh$/.test(rel) ? 0o755 : undefined);
  manifest.factoryVersion = PKG.version;
  fs.writeFileSync(".factory/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  if (minimal(c)) { installStandard(); if (installStandardOnRemotes(c)) process.exitCode = 1; }
  else appendGitignore(IGNORES(fs.existsSync("package.json")));   // projects initialised by an older factory get the current ignore list
  // Every checkout of an adopted project (a fresh clone, the server checkout the waves push from) must arm the hooks:
  // core.hooksPath is per clone, not committed. own mode keeps its own setting.
  if (!minimal(c) && mode !== "own" && fs.existsSync(path.join(hdir, "pre-commit"))) sh("git", ["config", "core.hooksPath", c.hooks.hooksPath]);
  say(`${written} updated, ${kept} kept (locally changed). Review .factory/new/ and merge what you want.`);
}

// --- doctor ----------------------------------------------------------------------------------------
function doctor() {
  let fail = 0;
  const ok = (m) => say(`OK      ${m}`), bad = (m) => { say(`MISSING ${m}`); fail++; }, info = (m) => say(`info    ${m}`);
  const major = Number(process.versions.node.split(".")[0]); major >= 22 ? ok(`node ${process.versions.node}`) : bad(`node >= 22 (have ${process.versions.node})`);
  if (!fs.existsSync("factory.config.json")) { bad("factory.config.json (run init)"); process.exit(1); }
  const c = JSON.parse(fs.readFileSync("factory.config.json", "utf8")); ok(`factory.config.json (project ${c.project.name}, factory ${c.factoryVersion})`);
  if (minimal(c)) doctorStandard(ok, bad, info);
  else doctorTracked(c, ok, bad, info);
  if (watchRequired(c) && readWatchProblem(c)) info(`status watch cannot reach the terminal: ${readWatchProblem(c)}`);
  // Under WSL the cron service does not always run, and then the schedule is there but nothing happens.
  if (watchRequired(c)) statusWatchRuns(c) ? ok("status watch running") : info(`status watch not running: without it, finished work and open questions do not reach the Front agent. Run start${/microsoft/i.test(os.release()) ? "; under WSL also check the cron service (sudo service cron start)" : ""}`);
  for (const t of [c.agents.default, c.agents.fallback?.agent].filter(Boolean)) has(t) ? ok(`${t} CLI`) : info(`${t} CLI not on this machine`);
  if (c.agents.runner === "orca") has("orca") || has("orca-ide") ? ok("orca CLI") : bad("orca CLI (runner is orca)");
  // User-level skills: the Controller and Front agent sessions run outside the repo and need these on their host.
  const userSkillDirs = [path.join(os.homedir(), ".claude/skills"), path.join(os.homedir(), ".agents/skills")];
  for (const s of c.agents.runner === "orca" ? ["orchestration", "orca-cli", "writing-for-agents", "retro"] : ["writing-for-agents", "retro"]) userSkillDirs.some((d) => fs.existsSync(path.join(d, s, "SKILL.md"))) ? ok(`user-level skill ${s}`) : bad(`user-level skill ${s} (run: agentic-factory install-skills)`);
  if (c.steering.mode === "github-issues") has("gh") ? ok("gh CLI") : bad("gh CLI (steering is github-issues)");
  for (const h of c.hosts.workers.filter((h) => h.kind === "remote")) {
    const sshArgs = [...(h.sshConfig ? ["-F", h.sshConfig.replace(/^~/, os.homedir())] : []), "-o", "ConnectTimeout=5", h.ssh];
    const r = spawnSync("ssh", [...sshArgs, "echo ok"], { encoding: "utf8" });
    r.stdout?.trim() === "ok" ? ok(`ssh ${h.ssh}`) : bad(`ssh ${h.ssh} reachable`);
    if (r.stdout?.trim() === "ok" && h.name === c.hosts.controller.host) {
      const sk = spawnSync("ssh", [...sshArgs, "for s in orchestration orca-cli writing-for-agents retro; do [ -f ~/.claude/skills/$s/SKILL.md ] || [ -f ~/.agents/skills/$s/SKILL.md ] || echo $s; done"], { encoding: "utf8" }).stdout.trim();
      sk ? bad(`${h.name}: user-level skills missing: ${sk.split("\n").join(", ")} (copy ${c.hosts.controller.controllerDir ?? "~/controller"}/skills/* into ~/.claude/skills and ~/.agents/skills there)`) : ok(`${h.name}: user-level skills present`);
    }
    if (c.agents.runner === "orca" && !h.orcaRepoId) info(`${h.name}: orcaRepoId not set yet`);
  }
  const ctl = c.hosts.workers.find((h) => h.name === c.hosts.controller.host);
  if (ctl) {
    const statusAge = ctl.kind === "local" ? (fs.existsSync(expandHome(`${c.hosts.controller.controllerDir ?? "~/controller"}/status.md`)) ? (Date.now() - fs.statSync(expandHome(`${c.hosts.controller.controllerDir ?? "~/controller"}/status.md`)).mtimeMs) / 60000 : null) : Number(sh("ssh", [...(ctl.sshConfig ? ["-F", ctl.sshConfig.replace(/^~/, os.homedir())] : []), ctl.ssh, `stat -c %Y ${c.hosts.controller.controllerDir ?? "~/controller"}/status.md 2>/dev/null`]) ? (Date.now() / 1000 - Number(sh("ssh", [...(ctl.sshConfig ? ["-F", ctl.sshConfig.replace(/^~/, os.homedir())] : []), ctl.ssh, "stat -c %Y ~/controller/status.md"]))) / 60 : null);
    statusAge === null ? info(`controller status.md not found on ${ctl.name} (controller not started yet)`) : statusAge > 25 ? bad(`controller status.md is ${Math.round(statusAge)} min old`) : ok(`controller status.md ${Math.round(statusAge)} min old`);
  }
  if (c.hosts.frontAgent.preview.enabled) { const r = spawnSync("curl", ["-s", "-m", "2", "-o", "/dev/null", "-w", "%{http_code}", `http://localhost:${c.hosts.frontAgent.preview.port}/`], { encoding: "utf8" }); /^[23]/.test(r.stdout) ? ok(`preview answers on ${c.hosts.frontAgent.preview.port}`) : info(`preview not running on ${c.hosts.frontAgent.preview.port}`); }
  process.exit(fail ? 1 : 0);
}

function doctorTracked(c, ok, bad, info) {
  const hmode = c.hooks?.mode ?? "factory", hdir = c.hooks?.dir ?? c.hooks?.ownDir ?? ".githooks", wantPath = c.hooks?.hooksPath ?? (hmode === "own" ? sh("git", ["config", "core.hooksPath"]) : ".githooks");
  const exe = (f) => fs.existsSync(f) && (fs.statSync(f).mode & 0o111);
  if (hmode === "own") {
    const cur = sh("git", ["config", "core.hooksPath"]);
    cur && cur === (c.hooks?.hooksPath || cur) ? ok(`core.hooksPath=${cur} (own hooks armed)`) : bad(`core.hooksPath=${c.hooks?.hooksPath || hdir}: the own hooks are NOT armed (git config core.hooksPath ${c.hooks?.hooksPath || hdir})`);
    for (const h of ["pre-commit", "pre-push"]) exe(`${hdir}/${h}`) ? ok(`own hook ${hdir}/${h}`) : bad(`own hook ${hdir}/${h} executable`);
    info("hooks.mode = own: the project's own hooks must enforce the review gate; the factory guardrails are not installed and not verified");
  } else {
    sh("git", ["config", "core.hooksPath"]) === wantPath ? ok(`core.hooksPath=${wantPath}`) : bad(`core.hooksPath=${wantPath} (git config core.hooksPath ${wantPath})`);
    fs.existsSync("tools/factory-guardrails.mjs") ? ok("tools/factory-guardrails.mjs") : bad("tools/factory-guardrails.mjs");
    // Every gate must be present AND wired: pre-commit (checks), commit-msg (protected files), pre-push (review gate).
    for (const h of ["pre-commit", "commit-msg", "pre-push"]) exe(`${hdir}/${h}`) && fs.readFileSync(`${hdir}/${h}`, "utf8").includes("factory-guardrails") ? ok(`hook ${hdir}/${h} wired (${hmode})`) : bad(`hook ${hdir}/${h} executable and calling tools/factory-guardrails.mjs`);
    for (const h of HOOK_NAMES) if (fs.existsSync(`${hdir}/${h}.own`)) !exe(`${hdir}/${h}.own`) ? bad(`${hdir}/${h}.own executable`) : isFactoryHook(`${hdir}/${h}.own`) ? bad(`${hdir}/${h}.own is a factory hook mistaken for an own one; delete it`) : ok(`own hook kept as ${hdir}/${h}.own`);
    // The directory core.hooksPath points to must exist: husky's .husky/_ is generated by the install and is absent in a fresh clone or worktree.
    if (!fs.existsSync(wantPath)) bad(`hooks directory ${wantPath} missing${c.hooks?.layout === "husky" ? ` (husky generates it: run \`${c.commands?.install ?? "the install command"}\`)` : ""}: no hook runs here`);
  }
  for (const f of ["AGENTS.md", "docs/coordinator.md", "docs/dev-workflow.md", "docs/review-protocol.md", "docs/architect-protocol.md", "docs/debt.md"]) fs.existsSync(f) ? ok(f) : bad(f);
  fs.existsSync(".agents/skills/ponytail/SKILL.md") ? ok(".agents/skills") : bad(".agents/skills");
}
// The standard in this clone: armed, linked here, and which files deviate from it.
function doctorStandard(ok, bad, info) {
  const dir = path.join(gitCommonDir(), "factory");
  if (!fs.existsSync(path.join(dir, "standard.json"))) { bad("the factory's standard in this clone (a fresh clone: run `agentic-factory start`)"); return; }
  const hooksProblem = checkHooks();
  hooksProblem ? bad(`hooks NOT armed, so no review gate here: ${hooksProblem}`) : ok("hooks armed");
  const standard = JSON.parse(fs.readFileSync(path.join(dir, "standard.json"), "utf8"));
  standard.factoryVersion === PKG.version ? ok(`standard of factory ${standard.factoryVersion} in .git/factory`) : info(`standard of factory ${standard.factoryVersion} in .git/factory, this factory is ${PKG.version}: run update`);
  const root = sh("git", ["rev-parse", "--show-toplevel"]);
  const missing = standard.links.filter((l) => !fs.existsSync(path.join(root, l.path)));
  missing.length ? bad(`${missing.length} links missing in this worktree, first ${missing[0].path}: node ${path.join(dir, "arm.mjs")}`) : ok("standard linked in this worktree");
  const tracked = new Set(sh("git", ["ls-files"]).split("\n"));
  for (const l of standard.links) {
    if (tracked.has(l.path) || [...tracked].some((t) => t.startsWith(`${l.path}/`))) info(`deviates from the standard: ${l.path}`);
    else if (fs.existsSync(path.join(root, l.path)) && !fs.lstatSync(path.join(root, l.path)).isSymbolicLink()) info(`${l.path} is a file of its own but not tracked: git status hides it and a wave's clean deletes it. Commit it with git add -f, or remove it`);
  }
  // A new file in a deviating skill stays excluded: it would never be committed, and a wave's clean deletes it.
  for (const f of sh("git", ["ls-files", "-oi", "--exclude-standard", "--", ".agents/skills", ".claude/skills"]).split("\n").filter(Boolean)) if (!fs.lstatSync(f).isSymbolicLink() && !f.includes("/.git/")) info(`${f} is new in a deviating skill and not tracked: git add -f it`);
  for (const f of ["docs/debt.md"]) fs.existsSync(f) ? ok(f) : bad(f);
}

// --- install-skills ---------------------------------------------------------------------------------
// The Controller and the Front agent run OUTSIDE the project repo (~/controller, ~/front-agent/<project>), so the
// project's .agents/skills are invisible to them. The Orca skills (orchestration, orca-cli) and the writing/retro
// skills they rely on must be installed at user level on every host that runs a Controller or Front agent.
const USER_SKILLS = ["orchestration", "orca-cli", "writing-for-agents", "retro", "handoff", "grilling", "grill-with-docs", "domain-modeling", "wayfinder", "to-spec", "to-tickets", "prototype", "setup-matt-pocock-skills"];
function installSkills() {
  const all = flag("--all");
  const names = all ? walkDirs(path.join(ROOT, "skills")) : USER_SKILLS;
  const targets = [path.join(os.homedir(), ".claude/skills"), path.join(os.homedir(), ".agents/skills")];
  let n = 0;
  for (const t of targets) {
    fs.mkdirSync(t, { recursive: true });
    for (const s of names) {
      const src = path.join(ROOT, "skills", s), dst = path.join(t, s);
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dst) && !flag("--force")) { say(`  keep   ${dst} (exists; --force to replace)`); continue; }
      fs.rmSync(dst, { recursive: true, force: true }); fs.cpSync(src, dst, { recursive: true }); n++; say(`  install ${dst}`);
    }
  }
  say(`${n} skills installed. Orca's own guide loads from the binary: \`orca skills get orchestration\`.`);
}
const walkDirs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

// --- selfcheck (for the factory repo itself) ------------------------------------------------------
function selfcheck() {
  let fail = 0;
  for (const root of ["controller", "front-agent", "templates", "bin", "server", "standard"]) for (const rel of walk(path.join(ROOT, root))) {
    const full = path.join(ROOT, root, rel);
    if (/\.mjs$/.test(full)) { const r = spawnSync("node", ["--check", full]); if (r.status !== 0) { say(`SYNTAX ${full}`); fail++; } }
    if (/\.sh$|\/gate$|\.githooks\//.test(full)) { const r = spawnSync("bash", ["-n", full]); if (r.status !== 0) { say(`SYNTAX ${full}`); fail++; } }
  }
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, "factory.config.example.json"), "utf8"));
  const vars = templateVars(c);
  for (const dir of ["templates", "controller", "front-agent"]) for (const rel of walk(path.join(ROOT, dir))) { const out = render(fs.readFileSync(path.join(ROOT, dir, rel), "utf8"), vars); const left = out.match(/\{\{[A-Z_]+\}\}/g); if (left) { say(`UNRESOLVED ${dir}/${rel}: ${[...new Set(left)].join(" ")}`); fail++; } }
  // Runtime state must never ship in the bundles.
  for (const rel of walk(path.join(ROOT, "controller"))) if (/^(journal\.ndjson|workers\.json|quota\.json|model-tiers\.json|gate-slots.*\.json|capacity-state.*\.json|wave-handle\.txt|specs\/|logs\/|events\/)/.test(rel)) { say(`RUNTIME STATE in controller/: ${rel}`); fail++; }
  say(fail ? `${fail} problems` : "selfcheck ok");
  process.exit(fail ? 1 : 0);
}

// --- status and start: the Front agent's view and its one-command setup ----------------------------
const readConfig = () => (fs.existsSync("factory.config.json") ? JSON.parse(fs.readFileSync("factory.config.json", "utf8")) : null);
const isAdopted = () => fs.existsSync("factory.config.json") && (fs.existsSync(".factory/manifest.json") || minimal(readConfig()));
const expandHome = (p) => String(p ?? "").replace(/^~(?=\/|$)/, os.homedir());
const sshArgsFor = (h) => [...(h.sshConfig ? ["-F", expandHome(h.sshConfig)] : []), "-o", "ConnectTimeout=5", h.ssh];
const controllerTitle = (c) => `${c.project.name} · Controller`;
const hasControllerTerminal = (c) => {
  const title = controllerTitle(c);
  const host = c.hosts.workers.find((h) => h.name === c.hosts.controller.host);
  const where = host?.kind === "remote" && host.orcaEnvironment ? ["--environment", host.orcaEnvironment] : [];
  if (process.env.FACTORY_SKIP_ORCA === "1") return false;
  try { const terminals = JSON.parse(sh(ORCA_BIN, ["terminal", "list", ...where, "--json"])).result?.terminals; return Array.isArray(terminals) && terminals.some((t) => t.title === title); } catch { return false; }
};
const agentCommand = (agent, prompt, args) => `${agent}${args ? ` ${args}` : ""} ${JSON.stringify(prompt)}`;

// Reads the Controller's status.md (local file or over ssh): age in minutes and the open "Needs <human>" items.
function controllerStatus(c) {
  const ctl = c.hosts.workers.find((h) => h.name === c.hosts.controller.host);
  const file = `${c.hosts.controller.controllerDir ?? "~/controller"}/status.md`;
  let text = "", ageMin = null;
  if (!ctl || ctl.kind === "local") {
    const f = expandHome(file);
    if (fs.existsSync(f)) { text = fs.readFileSync(f, "utf8"); ageMin = Math.round((Date.now() - fs.statSync(f).mtimeMs) / 60000); }
  } else {
    const out = sh("ssh", [...sshArgsFor(ctl), `f=${file}; [ -f "$f" ] && { stat -c %Y "$f" 2>/dev/null || stat -f %m "$f"; cat "$f"; }`]);
    if (out) { const [ts, ...rest] = out.split("\n"); ageMin = Math.round((Date.now() / 1000 - Number(ts)) / 60); text = rest.join("\n"); }
  }
  const lines = (text.split(/^## /m).find((s) => /^Needs\b/.test(s)) ?? "").split("\n").slice(1);
  const separator = (l = "") => /^\s*\|?\s*:?-{3}/.test(l);
  const needs = lines.filter((l, i) => /^\s*([-*]|\d+\.|\|)/.test(l) && !separator(l) && !(l.trim().startsWith("|") && separator(lines[i + 1])) && !/^(none|nothing|keine)$/i.test(l.replace(/^\s*(?:[-*]|\d+\.|\|)\s*/, "").replace(/\|\s*$/, "").trim()));
  return { host: ctl?.name ?? "local", kind: ctl?.kind ?? "local", ageMin, needs: needs.map((l) => l.trim()) };
}

function collectStatus() {
  const c = readConfig();
  const major = Number(process.versions.node.split(".")[0]);
  const runner = c?.agents?.runner ?? "orca";
  const orcaInstalled = has("orca") || has("orca-ide");
  const orcaRunning = orcaInstalled && process.env.FACTORY_SKIP_ORCA !== "1" ? /"ok":\s*true/.test(sh(ORCA_BIN, ["status", "--json"])) : false;
  const agents = ["codex", "claude", "pi"].filter(has);
  const prerequisites = [
    { item: "node >= 22", ok: major >= 22, fix: "install Node 22 or newer" },
    { item: "git repository", ok: spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" }).status === 0, fix: "git init" },
    { item: "git identity", ok: Boolean(sh("git", ["config", "user.name"]) && sh("git", ["config", "user.email"])), fix: "git config --global user.name … and user.email …" },
    ...(runner === "orca" ? [{ item: "Orca installed", ok: orcaInstalled, fix: "install Orca: https://github.com/stablyai/orca" }, { item: "Orca running", ok: orcaRunning || process.env.FACTORY_SKIP_ORCA === "1", fix: `${ORCA_BIN} open --json` }] : []),
    { item: "agent CLI", ok: c ? has(c.agents.default) : agents.length > 0, fix: c ? `install and log in to ${c.agents.default}` : "install and log in to codex, claude or pi" },
    ...(c?.steering?.mode === "github-issues" ? [{ item: "gh CLI", ok: has("gh"), fix: "install gh and run gh auth login" }] : []),
  ];
  const s = { factory: PKG.version, project: cwd, prerequisites, initialised: Boolean(c && isAdopted()) };
  if (!s.initialised) { s.phase = prerequisites.every((p) => p.ok) ? "onboarding" : "prerequisites"; s.next = s.phase === "onboarding" ? "run the onboarding as a conversation: init --print-questions, then init --answers <file>" : "fix the missing prerequisites (they need the human)"; return s; }
  const userSkill = (n) => [".claude/skills", ".agents/skills"].some((d) => fs.existsSync(path.join(os.homedir(), d, n, "SKILL.md")));
  const ctl = controllerStatus(c);
  const ctlTerminal = hasControllerTerminal(c);
  s.setup = {
    hooksArmed: minimal(c) ? !checkHooks() : (c.hooks?.mode ?? "factory") === "own" || sh("git", ["config", "core.hooksPath"]) === (c.hooks?.hooksPath ?? ".githooks"),
    userSkills: ["orchestration", "orca-cli"].every(userSkill),
    frontAgentBundle: fs.existsSync(path.join(os.homedir(), "front-agent", c.project.name, "FRONT_AGENT.md")),
    statusWatch: statusWatchRuns(c),
    controller: { host: ctl.host, statusAgeMin: ctl.ageMin, terminal: ctlTerminal, running: ctlTerminal || (ctl.ageMin !== null && ctl.ageMin <= 25) },
  };
  // The work: design exports, tickets by status, domain and architecture documents, open debt, open questions.
  const features = fs.existsSync("design") ? fs.readdirSync("design", { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  const tickets = { total: 0, byStatus: {} };
  if (c.steering.mode === "github-issues") {
    const out = has("gh") ? sh("gh", ["issue", "list", "--state", "open", "--limit", "200", "--json", "number,title,labels"], { timeout: 15000 }) : "";
    if (out) for (const i of JSON.parse(out)) { tickets.total++; const labels = i.labels.map((l) => l.name); const st = labels.includes("needs-human") ? "needs-human" : labels.find((n) => [c.steering.readyLabel ?? "ready-for-agent", "needs-triage", "needs-info", "ready-for-human", "in-progress", "blocked"].includes(n)) ?? "open"; tickets.byStatus[st] = (tickets.byStatus[st] ?? 0) + 1; if (labels.includes("needs-human")) ctl.needs.push(`Issue #${i.number}: ${i.title}`); }
    else tickets.unavailable = "gh not available or not logged in";
  } else if (fs.existsSync("docs/tasks")) {
    for (const f of fs.readdirSync("docs/tasks").filter((f) => /^T\d+.*\.md$/.test(f) && !/^T00-/.test(f))) {
      const st = (/^Status:\s*([a-z-]+)/m.exec(fs.readFileSync(path.join("docs/tasks", f), "utf8")) ?? [])[1] ?? "unknown";
      tickets.total++; tickets.byStatus[st] = (tickets.byStatus[st] ?? 0) + 1;
    }
  }
  const n = (k) => tickets.byStatus[k] ?? 0;
  const active = n("ready") + n("building") + n("review") + n("passed") + n(c.steering.readyLabel ?? "ready-for-agent") + n("in-progress");
  const drafts = n("draft") + n("needs-triage") + n("needs-info");
  const adrs = fs.existsSync("docs/adr") ? fs.readdirSync("docs/adr").filter((f) => /\.md$/.test(f) && !/0000-template/.test(f)).length : 0;
  // The template's example row (placeholders in angle brackets) is not debt.
  const debtOpen = fs.existsSync("docs/debt.md") ? fs.readFileSync("docs/debt.md", "utf8").split("\n").filter((l) => /\|\s*open\s*\|/.test(l) && !/<[a-z][^>]*>/.test(l)).length : 0;
  s.work = { designedFeatures: features, tickets, adrs, architecture: fs.existsSync("ARCHITECTURE.md"), glossary: ["GLOSSARY.md", "CONTEXT.md", "docs/glossary.md"].some((f) => fs.existsSync(f)), debtOpen, needsHuman: ctl.needs };
  // The phase is a hint for the Front agent's next question, derived from what is in the repo; the human decides.
  const setupMissing = !s.setup.hooksArmed || !s.setup.userSkills || !s.setup.frontAgentBundle || !s.setup.controller.running;
  if (!prerequisites.every((p) => p.ok)) [s.phase, s.next] = ["prerequisites", "fix the missing prerequisites (they need the human)"];
  else if (setupMissing) [s.phase, s.next] = ["start", `run \`start\`: user-level skills, the Front agent bundle and the Controller`];
  else if (ctl.needs.length) [s.phase, s.next] = ["decisions", "the Controller waits for the human: ask the open questions one at a time"];
  else if (!features.length && !tickets.total) [s.phase, s.next] = ["outside-in: surface", "sketch the surface of the first feature with the human (design tool or a clickable fake with the prototype skill), export it to design/<feature>/"];
  else if (drafts || (features.length > tickets.total && !active)) [s.phase, s.next] = ["outside-in: data and logic", "for the designed features: list data in and out on the fake, agree the logic in words and a diagram (grilling), then write the tickets as ready"];
  else if (active) [s.phase, s.next] = ["building", "the Controller works on the ready tickets: show the status table; accept what reaches main on the preview"];
  else [s.phase, s.next] = ["accept and next", "accept what was integrated on the preview, then choose the next feature"];
  // A hint, not a phase: a laptop that slept or a machine without cron must not hide open questions behind `start`.
  if (s.setup.frontAgentBundle && watchRequired(c) && !s.setup.statusWatch) s.next = `The status watch is not running, so finished work and open questions do not reach you: run \`start\`, and if that does not help, \`doctor\`. Then: ${s.next}`;
  else if (watchRequired(c) && readWatchProblem(c)) s.next = `The status watch runs but cannot reach your terminal (${readWatchProblem(c)}). Then: ${s.next}`;
  s.hints = [
    ...(!s.work.glossary ? ["the business terms are not written down yet (no GLOSSARY.md): capture them with domain-modeling while specifying"] : []),
    ...(c.architecture?.mode === undefined ? ["no decision on ARCHITECTURE.md yet: ask the human, then set architecture.mode to architect or off in factory.config.json and run update"] : []),
    ...(c.architecture?.mode === "architect" && !s.work.architecture ? ["no ARCHITECTURE.md yet: the Controller starts the baseline (mkspec baseline)"] : []),
    ...(debtOpen ? [`${debtOpen} open debt items: they must be closed or accepted before a release`] : []),
  ];
  return s;
}

function status() {
  const s = collectStatus();
  if (flag("--json")) { console.log(JSON.stringify(s, null, 2)); return; }
  say(`agentic-factory ${s.factory}: ${s.project}`);
  for (const p of s.prerequisites) say(`${p.ok ? "OK     " : "MISSING"} ${p.item}${p.ok ? "" : `  (${p.fix})`}`);
  if (s.setup) {
    const st = s.setup;
    say(`${st.hooksArmed ? "OK     " : "MISSING"} hooks armed`);
    say(`${st.userSkills ? "OK     " : "MISSING"} user-level skills (orchestration, orca-cli)`);
    say(`${st.frontAgentBundle ? "OK     " : "MISSING"} Front agent bundle`);
    say(`${st.controller.running ? "OK     " : "MISSING"} Controller on ${st.controller.host}${st.controller.statusAgeMin !== null ? ` (status.md ${st.controller.statusAgeMin} min old)` : ""}`);
    const w = s.work;
    say(`\nDesigned features: ${w.designedFeatures.length ? w.designedFeatures.join(", ") : "none"}`);
    say(`Tickets: ${w.tickets.total ? Object.entries(w.tickets.byStatus).map(([k, v]) => `${v} ${k}`).join(", ") : w.tickets.unavailable ?? "none"}`);
    say(`ADRs: ${w.adrs} · ARCHITECTURE.md: ${w.architecture ? "yes" : "no"} · glossary: ${w.glossary ? "yes" : "no"} · open debt: ${w.debtOpen}`);
    if (w.needsHuman.length) say(`Needs the human:\n  ${w.needsHuman.join("\n  ")}`);
  }
  say(`\nPhase: ${s.phase}\nNext:  ${s.next}`);
  for (const h of s.hints ?? []) say(`Hint:  ${h}`);
}

// The heartbeat wakes the Controller from outside (controller/heartbeat.mjs). hosts.controller.heartbeat = false opts out.
function armHeartbeat(c, ctl, dir) {
  if (process.env.FACTORY_SKIP_ORCA === "1" || c.agents.runner !== "orca" || c.hosts.controller.heartbeat === false) return;
  const script = heartbeatCronScript(dir, c.project.name);
  const r = ctl.kind === "local" ? spawnSync("sh", ["-c", script], { encoding: "utf8" }) : spawnSync("ssh", [...sshArgsFor(ctl), script], { encoding: "utf8" });
  const out = (r.stdout ?? "").trim();
  if (out === "added" || out === "exists") say(`Heartbeat: ${out === "added" ? "cron line added" : "already in cron"}${ctl.kind === "local" ? "" : ` on ${ctl.name}`}`);
  else say(`Heartbeat: could not add the cron line (${(r.stderr || "").trim().slice(0, 200)}). Without it nothing wakes the Controller from outside. Run this on the Controller's host:\n${script}`);
}

// Names the Front agent's own terminal and, if its name is still automatic, its sidebar entry (docs/orca.md, "Naming").
function nameFrontAgent(c) {
  const handle = process.env.ORCA_TERMINAL_HANDLE;
  if (!handle || process.env.FACTORY_SKIP_ORCA === "1" || c.agents.runner !== "orca") return;
  const name = `${c.project.name} · Front Agent`;
  for (const sub of ["rename", "set-pane-title"]) spawnSync(ORCA_BIN, ["terminal", sub, "--terminal", handle, "--title", name, "--json"], { encoding: "utf8" });
  const shown = spawnSync(ORCA_BIN, ["worktree", "show", "--worktree", `path:${cwd}`, "--json"], { encoding: "utf8" });
  if (/"displayNameMode":\s*"automatic"/.test(shown.stdout ?? "")) spawnSync(ORCA_BIN, ["worktree", "set", "--worktree", `path:${cwd}`, "--display-name", name, "--json"], { encoding: "utf8" });
}

// Sets everything up that the Front agent needs to hand over to the Controller: user-level skills, the bundles,
// the gate, the load log and the Controller's own agent session in an Orca terminal. Idempotent.
// The status watch runs on a schedule, outside any session: it needs no agent to start it and works with whichever agent is
// in front. launchd on macOS, cron elsewhere. Like the heartbeat, a schedule that fails is reported and stops nothing.
function scheduleStatusWatch(c, frontAgentDir) {
  if ((process.env.FACTORY_SCHEDULER ?? (process.platform === "darwin" ? "launchd" : "cron")) !== "launchd") return spawnSync("sh", ["-c", statusWatchCronScript(frontAgentDir, c.project.name, path.dirname(process.execPath))], { encoding: "utf8" });
  const label = statusWatchLabel(c.project.name), domain = `gui/${process.getuid()}`;
  const plist = path.join(os.homedir(), "Library/LaunchAgents", `${label}.plist`);
  try {
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, statusWatchPlist(frontAgentDir, c.project.name, process.execPath, os.homedir()));
  } catch (error) { return { status: 1, stderr: error.message }; }
  spawnSync("launchctl", ["bootout", `${domain}/${label}`], { encoding: "utf8" });
  // A run that is still ending can make the first attempt fail.
  let r;
  for (let attempt = 0; attempt < 5; attempt++) {
    r = spawnSync("launchctl", ["bootstrap", domain, plist], { encoding: "utf8" });
    if (r.status === 0) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  return r;
}
const watchRequired = (c) => c.agents.runner === "orca" && process.env.FACTORY_SKIP_ORCA !== "1" && c.hosts.frontAgent?.statusWatch !== false;
const readWatchProblem = (c) => { try { return fs.readFileSync(path.join(os.homedir(), "front-agent", c.project.name, "statuswatch.problem"), "utf8").trim(); } catch { return ""; } };
const statusWatchRuns = (c) => { try { return Date.now() - fs.statSync(path.join(os.homedir(), "front-agent", c.project.name, "statuswatch.alive")).mtimeMs < 11 * 60_000; } catch { return false; } };
function armStatusWatch(c, frontAgentDir) {
  // Cron has none of this session's environment. Under WSL, Orca's command comes from ORCA_CLI_COMMAND, so it is recorded here.
  // Inside an Orca terminal, its command is found through a PATH that cron does not have, so the full path is recorded.
  const orcaFound = spawnSync("sh", ["-c", `command -v ${JSON.stringify(ORCA_BIN)}`], { encoding: "utf8" }).stdout?.trim();
  const orcaCommand = orcaFound?.startsWith("/") ? orcaFound : process.env.ORCA_CLI_BIN_DIR ? path.join(process.env.ORCA_CLI_BIN_DIR, ORCA_BIN) : ORCA_BIN;
  fs.writeFileSync(path.join(frontAgentDir, "front-agent.json"), JSON.stringify({ projectDir: cwd, handle: process.env.ORCA_TERMINAL_HANDLE ?? null, orcaCommand }, null, 2) + "\n");
  // Opted out: a job from before must not go on alerting without any hint.
  const oldPlist = path.join(os.homedir(), "Library/LaunchAgents", `${statusWatchLabel(c.project.name)}.plist`);
  if (c.hosts.frontAgent?.statusWatch === false && process.env.FACTORY_SKIP_ORCA !== "1" && fs.existsSync(oldPlist)) { spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${statusWatchLabel(c.project.name)}`], { encoding: "utf8" }); fs.rmSync(oldPlist, { force: true }); }
  if (!watchRequired(c)) return;
  const r = scheduleStatusWatch(c, frontAgentDir);
  if (r.status !== 0) { say(`Status watch: could not schedule it (${(r.stderr || r.error?.message || "").trim().slice(0, 200)}). Without it, finished work and open questions do not reach the Front agent. Fix the scheduler, or set hosts.frontAgent.statusWatch to false in factory.config.json if nobody works in front here, and run start again.`); return; }
  // At once, not in up to 5 minutes. Detached, because it can wait for the Controller and for an idle terminal.
  const log = fs.openSync(path.join(frontAgentDir, "statuswatch.log"), "a");
  spawn("node", ["statuswatch.mjs"], { cwd: frontAgentDir, detached: true, stdio: ["ignore", log, log] }).unref();
  say("Status watch: scheduled, every 5 minutes");
}

async function start() {
  const c = readConfig();
  if (!c || !isAdopted()) { say("Not initialised: run init first (the Front agent does this as a conversation)."); process.exit(1); }
  if (!fs.existsSync(".factory/controller/CONTROLLER.md") || !fs.existsSync(".factory/front-agent/FRONT_AGENT.md") || (minimal(c) && !fs.existsSync(".factory/standard/standard.json"))) { say("Bundles missing (a fresh clone): regenerating them from factory.config.json."); await initNonInteractiveRefresh(); }
  say("\nUser-level skills:"); installSkills();
  const fa = path.join(os.homedir(), "front-agent", c.project.name);
  fs.mkdirSync(fa, { recursive: true }); fs.cpSync(".factory/front-agent", fa, { recursive: true, force: true }); say(`\nFront agent bundle: ${fa.replace(os.homedir(), "~")}`);
  armStatusWatch(c, fa);
  const ctl = c.hosts.workers.find((h) => h.name === c.hosts.controller.host) ?? { kind: "local", name: "local" };
  const dir = c.hosts.controller.controllerDir ?? "~/controller";
  const prompt = `Read ${dir}/CONTROLLER.md and act as the Controller for the project ${c.project.name}.`;
  const session = `cd ${dir} && ${agentCommand(c.agents.default, prompt, c.agents.controllerArgs)}`;
  const title = controllerTitle(c);
  let failed = 0;
  if (minimal(c)) {
    say("\nStandard:"); if (!installStandard()) failed++;
    failed += installStandardOnRemotes(c);
  }
  // A host can run one Controller per project, each in its own controllerDir. Never overwrite another project's.
  const present = ctl.kind === "local" ? (fs.existsSync(path.join(expandHome(dir), "factory.config.json")) ? fs.readFileSync(path.join(expandHome(dir), "factory.config.json"), "utf8") : "") : sh("ssh", [...sshArgsFor(ctl), `cat ${dir}/factory.config.json 2>/dev/null`]);
  const owner = (() => { try { return JSON.parse(present).project?.name; } catch { return undefined; } })();
  if (owner && owner !== c.project.name) { say(`Controller directory ${dir}${ctl.kind === "local" ? "" : ` on ${ctl.name}`} belongs to the project ${owner}. Set hosts.controller.controllerDir in factory.config.json to a directory of its own (for example ~/controller-${c.project.name}), run \`agentic-factory update\`, then start again. Nothing was copied.`); process.exit(1); }
  if (ctl.kind === "local") {
    const d = expandHome(dir);
    fs.mkdirSync(d, { recursive: true }); fs.cpSync(".factory/controller", d, { recursive: true, force: true }); say(`Controller bundle: ${dir}`);
    const bin = path.join(os.homedir(), ".local/bin"); fs.mkdirSync(bin, { recursive: true }); fs.copyFileSync(path.join(d, "gate"), path.join(bin, "gate")); fs.chmodSync(path.join(bin, "gate"), 0o755); fs.copyFileSync(path.join(d, "gate.mjs"), path.join(bin, "gate.mjs")); say("Gate: ~/.local/bin/gate");
    const loadlog = path.join(d, "loadlog.sh");
    if (sh("ps", ["-ax", "-o", "command"]).split("\n").some((l) => l.includes(loadlog))) say("Load log: already running");
    else { spawn("bash", [loadlog], { cwd: d, detached: true, stdio: "ignore" }).unref(); say("Load log: started (~/load.log)"); }
  } else {
    const remoteDir = dir;
    const r = spawnSync("rsync", ["-a", "-e", `ssh ${sshArgsFor(ctl).slice(0, -1).map((a) => JSON.stringify(a)).join(" ")}`, ".factory/controller/", `${ctl.ssh}:${remoteDir}/`], { encoding: "utf8" });
    if (r.status !== 0) { failed++; say(`Controller bundle: copy to ${ctl.name} failed: ${(r.stderr || "").trim().slice(0, 200)}`); }
    else {
      say(`Controller bundle: ${ctl.name}:${remoteDir}`);
      const s = spawnSync("ssh", [...sshArgsFor(ctl), `mkdir -p ~/.local/bin && install -m 755 ${remoteDir}/gate ~/.local/bin/gate && install -m 644 ${remoteDir}/gate.mjs ~/.local/bin/gate.mjs && for s in ${remoteDir}/skills/*; do n=$(basename "$s"); for t in ~/.claude/skills ~/.agents/skills; do mkdir -p "$t"; [ -e "$t/$n" ] || cp -R "$s" "$t/"; done; done; pgrep -f "[b]ash loadlog.sh" >/dev/null || (cd ${remoteDir} && nohup bash loadlog.sh >/dev/null 2>&1 &); echo ok`], { encoding: "utf8" });
      s.stdout?.trim().endsWith("ok") ? say(`Gate, user-level skills and load log on ${ctl.name}: ok`) : (failed++, say(`Gate, skills or load log on ${ctl.name} failed: ${(s.stderr || "").trim().slice(0, 200)}`));
    }
  }
  armHeartbeat(c, ctl, dir);
  // The Controller's own agent session, in an Orca terminal so the Front agent can read it and send it text.
  if (hasControllerTerminal(c)) say(`Controller session: already running (Orca terminal "${title}")`);
  else if (process.env.FACTORY_SKIP_ORCA === "1" || c.agents.runner !== "orca") say(`Controller session: start it in a terminal${ctl.kind === "local" ? "" : ` on ${ctl.name}`}:\n  ${session}`);
  else {
    const remoteHome = ctl.kind === "remote" ? sh("ssh", [...sshArgsFor(ctl), 'printf "%s\\n" "$HOME"']) : "";
    const remotePath = ctl.projectDir ?? `${ctl.projectsDir}/${c.project.name}`;
    if (ctl.kind === "remote" && (!ctl.orcaEnvironment || !remoteHome.startsWith("/") || (!remotePath.startsWith("/") && !/^~(?:\/|$)/.test(remotePath)))) { failed++; say(`Controller session: set hosts.workers[].orcaEnvironment to the saved Orca environment name and configure an absolute or ~/ remote project path; ensure ssh can resolve the remote home. Start it by hand:\n  ${session}`); }
    else {
    const where = ctl.kind === "local" ? ["--worktree", `path:${cwd}`] : ["--environment", ctl.orcaEnvironment, "--worktree", `path:${path.posix.resolve(remotePath.replace(/^~(?=\/|$)/, remoteHome))}`];
    const r = spawnSync(ORCA_BIN, ["terminal", "create", ...where, "--title", title, "--command", session, "--json"], { encoding: "utf8" });
    if (r.status === 0 && /"ok":\s*true/.test(r.stdout)) say(`Controller session: started (Orca terminal "${title}"). It may ask once for permissions there.`);
    else { failed++; say(`Controller session: Orca could not create the terminal (${(r.stderr || r.stdout || "").trim().slice(0, 200)}). Start it by hand:\n  ${session}`); }
    }
  }
  nameFrontAgent(c);
  say(failed ? `\n${failed} step(s) failed; fix them and run start again.` : "\nStarted. `status` shows the phase and the next step.");
  process.exit(failed ? 1 : 0);
}

const commands = { init, update, doctor, selfcheck, status, start, deviate, "install-skills": installSkills };
if (!commands[cmd]) { say(`agentic-factory ${PKG.version}\n  init            onboarding: ask the project's questions, write factory.config.json, copy handbooks, hooks, skills and bundles (--keep-own-hooks: leave the project's hooks untouched, hooks.mode own; --untracked-standard: keep the standard out of the project's history)\n  deviate <path>  make a generated file of the untracked standard the project's own: a tracked file that wins over the standard\n  update          re-render from a newer factory; locally changed files are kept, new versions land in .factory/new/\n  install-skills  install the Orca and coordination skills at user level (~/.claude/skills, ~/.agents/skills) on this host; required wherever a Controller or Front agent runs. --all for every vendored skill, --force to replace\n  doctor          check config, hooks, tools, user-level skills, hosts and the controller's status\n  selfcheck       (factory repo) syntax and placeholder check\n  status          prerequisites, setup, the work in the repo and the phase with the next step (--json for the Front agent)\n  start           user-level skills, Front agent and Controller bundles, gate, load log and the Controller's session in Orca\nFlags: --yes (take defaults), --print-questions (init: the questions as JSON, nothing written), --answers <file> (init: answers as {id: value})\n\nUsually you run none of this yourself: start an agent in your project with\n  claude "Read ${path.join(ROOT, "START.md").replace(os.homedir(), "~")} and set up this project."`); process.exit(cmd ? 1 : 0); }
await commands[cmd]();
