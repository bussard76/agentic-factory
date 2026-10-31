#!/usr/bin/env node
// agentic-factory CLI: init (onboarding), update, doctor, selfcheck. Node 22+, no dependencies.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const cwd = process.cwd();
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const yes = flag("--yes");
const sh = (c, a, o = {}) => { try { return execFileSync(c, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...o }).trim(); } catch { return ""; } };
const has = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const say = (s = "") => console.log(s);

const rl = yes ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
// The Orca executable: ORCA_CLI_COMMAND if set; on Linux outside an Orca terminal `orca-ide` (bare `orca` is the GNOME screen reader there).
const ORCA_BIN = process.env.ORCA_CLI_COMMAND ?? (process.platform === "linux" && !process.env.ORCA_TERMINAL && has("orca-ide") ? "orca-ide" : "orca");
async function ask(question, options, def) {
  // One question at a time, recommended option first. With --yes, the default is taken.
  if (yes) return def;
  say(`\n${question}`);
  options.forEach((o, i) => say(`  ${i + 1}) ${o.label}${o.value === def ? "  (recommended)" : ""}${o.hint ? `\n     ${o.hint}` : ""}`));
  const a = (await rl.question(`> [${options.findIndex((o) => o.value === def) + 1}] `)).trim();
  if (!a) return def;
  const n = Number(a);
  return n >= 1 && n <= options.length ? options[n - 1].value : a;
}
// Enter keeps the default; a single "-" clears the value (for optional commands).
async function askText(question, def) { if (yes) return def; const a = (await rl.question(`\n${question} [${def || "none"}] (Enter = keep, - = none) `)).trim(); return a === "-" ? "" : a || def; }

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
  say(`agentic-factory ${PKG.version}: onboarding for ${cwd}`);
  if (spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" }).status !== 0) { say("Not a git repository. Run `git init` first."); process.exit(1); }
  const d = detect();
  // A re-run on an initialised project is an update: keep the project's recorded answers, refresh the files, commit nothing.
  if (fs.existsSync(".factory/manifest.json") && fs.existsSync("factory.config.json")) {
    say("Already initialised (factory.config.json and .factory/manifest.json exist). Refreshing from the recorded answers; change answers by editing factory.config.json. Nothing is committed.");
    await initNonInteractiveRefresh();
    rl?.close();
    return;
  }
  // Every script fetches origin and merges origin/<main>. A repo without a remote gets a local bare one, so the
  // first wave works on a single machine; replace it with a real remote any time (git remote set-url origin …).
  if (!sh("git", ["remote"])) {
    // Keyed by name plus a hash of the absolute path, so two projects with the same directory name never share a remote.
    const bare = path.join(os.homedir(), ".factory-remotes", `${d.name}-${hash(cwd).slice(0, 6)}.git`);
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    const existed = fs.existsSync(bare);
    if (!existed) spawnSync("git", ["init", "-q", "--bare", bare]);
    spawnSync("git", ["remote", "add", "origin", bare]);
    const branch = sh("git", ["branch", "--show-current"]) || "main";
    // An empty repository (git init, no commit yet) has nothing to push; the adoption commit pushes with -u later. An
    // existing bare must then be empty too, or it is a leftover of another attempt with a different history.
    const foreign = () => { spawnSync("git", ["remote", "remove", "origin"]); say(`The existing local bare remote ${bare} holds a different history. Remove it (rm -rf "${bare}") or add your own remote (git remote add origin <url>), then run init again. origin was not kept.`); process.exit(1); };
    if (sh("git", ["rev-parse", "--verify", "-q", "HEAD"])) {
      const p = spawnSync("git", ["push", "-q", "-u", "origin", branch], { encoding: "utf8" });
      if (p.status !== 0) foreign();
    } else if (existed && sh("git", ["-C", bare, "rev-parse", "--verify", "-q", "HEAD"])) foreign();
    say(`No remote found: ${existed ? "using the existing" : "created a"} local bare remote at ${bare} as origin (replace it later with git remote set-url origin <url>).`);
    d.repo = `local:${bare}`;
  }
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, "factory.config.example.json"), "utf8"));
  delete c.$comment;
  c.factoryVersion = PKG.version;
  c.project.adoptedOn = process.env.FACTORY_TODAY ?? new Date().toISOString().slice(0, 10);
  c.project.name = await askText("1. Project name (used for branches, worktrees, locks, the preview)?", d.name);
  c.project.repo = await askText("   Repository?", d.repo || `github.com/<owner>/${c.project.name}`);
  c.project.mainBranch = sh("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace("origin/", "") || sh("git", ["branch", "--show-current"]) || "main";
  c.project.humanName = await askText("2. Who is the human the agents work for (name as the handbooks should address them)?", os.userInfo().username);
  const langDefault = /^de/i.test(process.env.LANG ?? process.env.LC_ALL ?? "") ? "de" : "en";
  c.project.language = await ask("   In which language should the human-facing workflow guide be written?", [{ label: "English", value: "en" }, { label: "Deutsch", value: "de" }], langDefault);
  c.rhythm.mode = await ask("3. Working rhythm?", [
    { label: "Day: plan, test, decide. Night: the Controller builds unattended. Morning handover.", value: "day-plan-night-build" },
    { label: "Continuous: build whenever signed-off work exists; questions as they arise", value: "continuous" },
    { label: "Custom quiet hours (edit rhythm.quietHours afterwards)", value: "custom" }], "day-plan-night-build");
  c.steering.mode = await ask("4. Where do tickets live?", [
    { label: "GitHub issues (labels, native blocking; wayfinder maps visible in the tracker)", value: "github-issues" },
    { label: "Task files docs/tasks/T<n>-*.md (everything in git, no tracker)", value: "orca-tasks" }], d.github && d.tools.gh ? "github-issues" : "orca-tasks");
  // Orca is a prerequisite: workers, worktrees, terminals, messages and remote hosts all run through it.
  // The plain-terminal runner exists for experiments only (--experimental-terminal-runner).
  const skipOrca = process.env.FACTORY_SKIP_ORCA === "1";   // tests only: never touch the local Orca
  c.agents.runner = flag("--experimental-terminal-runner") ? "terminal" : "orca";
  let orcaRunning = false;
  if (c.agents.runner === "orca" && !skipOrca) {
    if (!d.tools.orca) {
      say(`\nOrca is required and its CLI (orca / orca-ide) is not on this machine. Install Orca (https://orca.earendil.works), start it, then run init again.\n(For experiments without Orca: --experimental-terminal-runner. Unsupported.)`);
      process.exit(1);
    }
    orcaRunning = /"ok":\s*true/.test(sh(ORCA_BIN, ["status", "--json"]));
    say(orcaRunning ? `5. Orca: installed and running (${ORCA_BIN}).` : `5. Orca: installed but not running. Start it with \`${ORCA_BIN} open --json\`; the repo is registered with Orca when it runs.`);
  } else if (c.agents.runner === "terminal") say("5. Runner: plain terminals (experimental, unsupported).");
  c.agents.default = await ask("6. Default agent CLI for workers?", [{ label: "Codex", value: "codex" }, { label: "Claude Code", value: "claude" }, { label: "Pi", value: "pi" }], d.tools.codex ? "codex" : d.tools.claude ? "claude" : "pi");
  if (c.agents.default === "claude") { c.agents.models = { small: "haiku", default: "sonnet", large: "opus" }; c.agents.fallback = { agent: "codex", models: { small: "gpt-6-luna", default: "gpt-6.1-terra", large: "gpt-6.1-sol" }, quotaThresholdPercent: 10 }; }
  for (const t of ["small", "default", "large"]) c.agents.models[t] = await askText(`   Model for the "${t}" tier (as the ${c.agents.default} CLI names it; a starting value, calibrated later)?`, c.agents.models[t]);
  const where = await ask("7. Where do workers run? (a remote server is an option, not a must; you can add more hosts later)", [
    { label: "Only on this machine", value: "local" },
    { label: "On this machine and on one remote server (ssh alias)", value: "both" },
    { label: "Only on a remote server", value: "remote" }], "local");
  // projectDir is the explicit checkout path, so the project name may differ from the directory name.
  const localHost = { name: "local", kind: "local", projectDir: cwd.replace(os.homedir(), "~"), projectsDir: path.dirname(cwd).replace(os.homedir(), "~"), workspacesDir: "~/orca/workspaces", orcaEnvironment: "", orcaRepoId: "", capacity: { suiteWorkersMax: 2, readOnlyWorkersMax: 2 } };
  const remoteHost = { name: "build-server", kind: "remote", ssh: "build-server", sshConfig: "", projectsDir: "~/projects", workspacesDir: "~/orca/workspaces", orcaEnvironment: "", orcaRepoId: "", capacity: { suiteWorkersMax: 8, readOnlyWorkersMax: 6, gate: { unitSlots: 3, e2eSlots: 2 } } };
  if (where !== "local") {
    remoteHost.name = await askText("   Name of the remote host (also its Orca environment name)?", "build-server");
    remoteHost.ssh = await askText("   SSH alias for it (from your ssh config)?", remoteHost.name);
    remoteHost.sshConfig = await askText("   Path to an ssh config file, or empty for ~/.ssh/config?", "");
    remoteHost.orcaEnvironment = c.agents.runner === "orca" ? remoteHost.name : "";
  }
  c.hosts.workers = where === "local" ? [localHost] : where === "both" ? [localHost, remoteHost] : [remoteHost];
  // Register this repo with the local Orca so the local host has its repo id (remote hosts register on the server).
  if (c.agents.runner === "orca" && orcaRunning && !skipOrca && where !== "remote") {
    const list = sh(ORCA_BIN, ["repo", "list", "--json"]);
    let id = (list.match(new RegExp(`"id":\\s*"([0-9a-f-]{36})"[^{}]*"path":\\s*"${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`)) ?? [])[1];
    if (!id) { const added = sh(ORCA_BIN, ["repo", "add", "--path", cwd, "--json"]); id = (added.match(/"id":\s*"([0-9a-f-]{36})"/g) ?? []).map((m) => m.match(/[0-9a-f-]{36}/)[0]).at(-1); }
    if (id) { localHost.orcaRepoId = id; say(`   Registered with Orca: repo id ${id}.`); } else say("   Could not register the repo with Orca; set hosts.workers[].orcaRepoId by hand (orca repo add --path <repo> --json).");
  }
  c.hosts.controller = { host: await ask("8. Where does the Controller run?", c.hosts.workers.map((h) => ({ label: h.kind === "local" ? "On this machine (a second agent session next to the Front agent)" : `On ${h.name} (unattended, survives this machine sleeping)`, value: h.name })), c.hosts.workers.at(-1).name), controllerDir: "~/controller" };
  c.capacity.calibration.mode = await ask("9. Capacity: the limits per host are starting values. Calibrate them automatically?", [{ label: "Auto: start low, raise step by step while the host stays quiet, lower on pressure; the audit verifies", value: "auto" }, { label: "Manual: use the configured limits as they are", value: "manual" }], "auto");
  c.agents.calibration = await ask("   Models: calibrate the tier per role from measured pass rates and rounds?", [{ label: "Auto", value: "auto" }, { label: "Manual: only recommend", value: "manual" }], "auto");
  say(`\n10. Commands the hooks, Testers and waves will run (package manager: ${d.pm}, from ${d.hasLock ? "the lockfile" : "package.json or PATH"}; edit factory.config.json to change):`);
  for (const k of ["install", "typecheck", "lint", "unit", "verify", "e2e"]) c.commands[k] = await askText(`    ${k}?`, d.commands[k] ?? c.commands[k] ?? "");
  if (yes) for (const k of ["install", "typecheck", "lint", "unit", "verify", "e2e"]) say(`    ${k}: ${c.commands[k] || "(none)"}`);
  c.commands.release = d.commands.release.length ? d.commands.release : c.commands.release;
  c.hosts.frontAgent.preview.enabled = (await ask("11. Local preview that follows main on this machine (the human accepts there)?", [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], "yes")) === "yes";
  if (c.hosts.frontAgent.preview.enabled) { c.hosts.frontAgent.preview.port = Number(await askText("   Port?", "8180")); c.hosts.frontAgent.preview.command = await askText("   Start command?", d.scripts.dev ? `${d.pm} dev` : c.hosts.frontAgent.preview.command); c.hosts.frontAgent.preview.envFile = `~/.config/${c.project.name}/preview.env`; }
  c.reviews.maxRounds = Number(await askText("12. Review rounds before a working feature is integrated and the rest becomes debt?", "2"));
  c.design = { tool: await ask("13. Design tool for stage 1 of outside-in?", [{ label: "Figma via its local MCP server", value: "figma" }, { label: "Pencil", value: "pencil" }, { label: "None for now", value: "none" }], d.tools.figma ? "figma" : "none"), exportDir: "design" };
  say("\n14. Hard rules (they go into AGENTS.md and docs/coordinator.md):\n  - no real data or secrets in the repo, .env never committed\n  - the factory has no outward effects: nothing changes outside the repo and the demo environment\n  - workers never push to main; --no-verify is forbidden\n  - tests run on demo data or a private copy, never on the original\n  - no real model calls in tests");
  if ((await ask("   Confirm all of them?", [{ label: "Yes", value: "yes" }, { label: "No, stop here", value: "no" }], "yes")) !== "yes") { say("Stopped. Nothing written."); process.exit(1); }
  const installNow = (await ask("15. Install the user-level skills on this machine now (needed by the Front agent here, and by the Controller if it runs here)?", [{ label: "Yes", value: "yes" }, { label: "Later (agentic-factory install-skills)", value: "no" }], "yes")) === "yes";

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
  c.hooks = { mode, dir: setup.dir, hooksPath: setup.hooksPath, layout: setup.layout };
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
  if (mode === "merge") {
    say(`  HOOKS: this repo has its own hooks in ${setup.dir} (${ownHookFiles(setup).join(", ")}${setup.layout === "husky" ? "; husky layout, core.hooksPath stays " + setup.hooksPath : ""}); each becomes <hook>.own and runs first inside the factory hook of the same name (hooks.mode = "merge").`);
    for (const own of keepOwnHooks(setup)) { manifest.files[own] = hash(fs.readFileSync(own, "utf8")); say(`  keep   ${own} (the project's own hook)`); }
  }
  write("factory.config.json", JSON.stringify(c, null, 2) + "\n");
  for (const rel of walk(path.join(ROOT, "templates"))) if (!skipTemplate(rel, mode)) write(templateTarget(rel, setup.dir), render(fs.readFileSync(path.join(ROOT, "templates", rel), "utf8"), vars), /\.githooks\/|tools\//.test(rel) ? 0o755 : undefined);
  write("docs/dev-workflow.md", absolutizeDocLinks(render(fs.readFileSync(path.join(ROOT, "docs", c.project.language === "de" ? "de/workflow.md" : "workflow.md"), "utf8"), vars), c.project.language));
  for (const rel of walk(path.join(ROOT, "skills"))) write(path.join(".agents/skills", rel), fs.readFileSync(path.join(ROOT, "skills", rel), "utf8"));
  if (!fs.existsSync(".claude")) fs.mkdirSync(".claude");
  if (!fs.existsSync(".claude/skills")) fs.symlinkSync("../.agents/skills", ".claude/skills");
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
  appendGitignore(IGNORES(fs.existsSync("package.json")));
  // The adoption commit: only the files init wrote, committed with the ADR reference and pushed BEFORE the hooks are
  // armed, so origin/<main> carries AGENTS.md, the handbooks and the hooks for the first workers and the first wave.
  // A re-run on an initialised project is an update: no adoption commit (the hooks are armed; it could not be pushed).
  // package.json still untracked (a fresh repository): it goes in with the adoption, because the lockfile and
  // commands.install derive from it and a worktree without it cannot install.
  const untrackedPkg = fs.existsSync("package.json") && spawnSync("git", ["ls-files", "--error-unmatch", "package.json"], { stdio: "ignore" }).status !== 0;
  if (!hadManifest && untrackedPkg) say("  add    package.json (untracked; the install command and the lockfile depend on it)");
  const adopted = hadManifest ? "" : commitAdoption([...Object.keys(manifest.files), ...(lockfile ? [lockfile] : []), ...(untrackedPkg ? ["package.json"] : [])], c.project.mainBranch, vars.ADOPTION_ADR);
  if (hadManifest) say("  already initialised: files refreshed, nothing committed (commit the changes yourself, or use `agentic-factory update`)");
  const untracked = sh("git", ["status", "--porcelain", "--untracked-files=all"]).split("\n").filter((l) => l.startsWith("??")).map((l) => l.slice(3));
  if (!hadManifest && untracked.length) say(`  NOTE: still untracked, not on origin: ${untracked.slice(0, 8).join(", ")}${untracked.length > 8 ? ` (+${untracked.length - 8})` : ""}. Commit your project files before the first task.`);
  // Arm the hooks where they live: .githooks for the factory layout, the project's own directory (e.g. husky) in merge
  // mode, nothing in own mode.
  if (mode !== "own") sh("git", ["config", "core.hooksPath", c.hooks.hooksPath]);
  if (installNow) { say("\nUser-level skills:"); installSkills(); }

  // --- the human's checklist -----------------------------------------------------------------
  const remote = c.hosts.workers.find((h) => h.kind === "remote");
  const ctl = c.hosts.workers.find((h) => h.name === c.hosts.controller.host);
  const steps = [
    adopted ? `Read docs/dev-workflow.md (the process) and AGENTS.md (the agents' rules). The adoption commit "Adopt agentic-factory (${vars.ADOPTION_ADR})" is on ${adopted}.${mode === "own" ? " Your own hooks stay in force; the factory hooks were not installed." : ` From now on protected files need an ADR reference in the commit message; try a commit without one to see the hook speak. A new or proposed ADR is committed by citing ${vars.ADOPTION_ADR} in the message; once accepted, cite the ADR itself.`}` : `Read docs/dev-workflow.md (the process) and AGENTS.md (the agents' rules). Commit the new files with a message that references the adoption ADR, e.g. \`git commit -m "Adopt agentic-factory (${vars.ADOPTION_ADR})"\`, and push to origin so workers and waves see them.`,
    remote && `Set up ${remote.name}: copy .factory/server/ there and follow docs/server-setup.md in the factory repo. Logins (gh, ${c.agents.default}, tailscale${c.agents.runner === "orca" ? ", Orca pairing" : ""}) are yours. Then put its Orca repo id into factory.config.json → hosts.workers[].orcaRepoId and run \`agentic-factory update\` to refresh the bundles.`,
    `Skills at user level, on EVERY host that runs a Controller or Front agent: ${installNow ? "done here" : "`agentic-factory install-skills` here"}${remote ? `; on ${remote.name}: \`mkdir -p ~/.claude/skills ~/.agents/skills && cp -R ~/controller/skills/* ~/.claude/skills/ && cp -R ~/controller/skills/* ~/.agents/skills/\`` : ""}. Without the Orca skills (orchestration, orca-cli) the agents cannot start, watch or release workers.`,
    c.agents.runner === "orca" && !orcaRunning && `Orca: ${d.tools.orca ? `start it (\`${ORCA_BIN} open --json\`) and register the repo (\`${ORCA_BIN} repo add --path <repo> --json\`, id into hosts.workers[].orcaRepoId)` : "install it (https://orca.earendil.works), then register the repo and put its id into hosts.workers[].orcaRepoId"}; the Orca skills load their guide from the binary (\`${ORCA_BIN} skills get orchestration\`).`,
    `Controller: copy .factory/controller/ to ${ctl.kind === "local" ? "~/controller on this machine" : `${ctl.name}:~/controller`}, install the gate (\`mkdir -p ~/.local/bin && install -m 755 ~/controller/gate ~/.local/bin/gate\`; it needs only node), start \`bash ~/controller/loadlog.sh &\`, then start an agent session there with: "Read ~/controller/CONTROLLER.md and act as the Controller."`,
    `Front agent: copy .factory/front-agent/ to ~/front-agent/${c.project.name} on this machine and start your agent session with: "Read ~/front-agent/${c.project.name}/FRONT_AGENT.md and act as the Front agent."`,
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
    PROJECT: c.project.name, HUMAN: c.project.humanName, MAIN: c.project.mainBranch, BRANCH_PREFIX: c.project.branchPrefix ?? "agents/", DATE: c.project.adoptedOn ?? (process.env.FACTORY_TODAY ?? new Date().toISOString().slice(0, 10)),
    ADOPTION_ADR: `ADR-${adoptionAdrNumber()}`,
    HOOKS_DIR: c.hooks?.dir ?? ".githooks",
    HOOKS_PATH: c.hooks?.hooksPath ?? ".githooks",
    HOOK_ENFORCEMENT: (c.hooks?.mode ?? "factory") === "own"
      ? `**hooks.mode = own:** this project keeps its own hooks in \`${c.hooks?.dir ?? c.hooks?.ownDir ?? ".githooks"}\`; they, not the factory's, must enforce the commit checks and the review gate on \`${c.project.mainBranch}\`. The factory does not verify them. The project's own \`pre-push\` must implement the rule below for every update of \`${c.project.mainBranch}\`.`
      : `Enforced by the factory hooks in \`${c.hooks?.dir ?? ".githooks"}/\` (\`tools/factory-guardrails.mjs\`)${(c.hooks?.mode ?? "factory") === "merge" ? "; the project's own hooks run first as `<hook>.own` next to them" : ""}. With the hooks armed (\`core.hooksPath=${c.hooks?.hooksPath ?? ".githooks"}\`), \`pre-push\` checks every update of \`${c.project.mainBranch}\`.`,
    VERIFY: c.commands.verify || "the verify command", E2E: c.commands.e2e || "the browser suite", RELEASE: (c.commands.release ?? []).join(" and ") || "the release gates",
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
    CONTROLLER_LOCATION: ctl.kind === "local" ? "on this machine (`~/controller`)" : `on the server \`${ctl.name}\` (ssh alias \`${ctl.ssh}\`, \`~/controller\`)`,
    INBOX_CMD: ctl.kind === "local" ? "`cat >> ~/controller/inbox.md`" : `\`ssh ${ctl.ssh} 'cat >> ~/controller/inbox.md'\``,
    PREVIEW_PLIST: `de.${c.project.name}.preview`, PREVIEW_LABEL: `de.${c.project.name}.preview`, PREVIEW_SCRIPT: `${os.homedir()}/front-agent/${c.project.name}/preview-update.sh`, HOME: os.homedir(),
    COMMIT_PATTERN: `mv .env ../.${c.project.name}.env; git add …; git commit …; mv ../.${c.project.name}.env .env`,
    // Project-specific Controller rules live in the project (docs/controller-rules.md) and are rendered into CONTROLLER.md.
    PROJECT_RULES: fs.existsSync("docs/controller-rules.md") ? fs.readFileSync("docs/controller-rules.md", "utf8").trim() : "_None yet. Put project-specific hard rules, data boundaries, known flakes and decision pointers into `docs/controller-rules.md`; `agentic-factory update` renders them here._",
  };
}
const render = (text, vars) => text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
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
function commitAdoption(files, branch, adr = "ADR-0001") {
  const r = spawnSync("git", ["add", "--", ".gitignore", ".factory/manifest.json", ".claude", "docs/reviews/.gitkeep", "docs/reports/.gitkeep", "docs/handoffs/.gitkeep", ...files.filter((f) => !f.startsWith(".factory/") && fs.existsSync(f))], { encoding: "utf8" });
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
  if (mode === "merge") {
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
  for (const rel of walk(path.join(ROOT, "templates"))) if (!skipTemplate(rel, mode)) write(templateTarget(rel, hdir), render(fs.readFileSync(path.join(ROOT, "templates", rel), "utf8"), vars), /\.githooks\/|tools\//.test(rel) ? 0o755 : undefined);
  write("docs/dev-workflow.md", absolutizeDocLinks(render(fs.readFileSync(path.join(ROOT, "docs", c.project.language === "de" ? "de/workflow.md" : "workflow.md"), "utf8"), vars), c.project.language));
  for (const rel of walk(path.join(ROOT, "skills"))) write(path.join(".agents/skills", rel), fs.readFileSync(path.join(ROOT, "skills", rel), "utf8"));
  for (const rel of walk(path.join(ROOT, "controller"))) write(path.join(".factory/controller", rel), render(fs.readFileSync(path.join(ROOT, "controller", rel), "utf8"), vars), /gate$|\.sh$/.test(rel) ? 0o755 : undefined);
  write(".factory/controller/factory.config.json", JSON.stringify(c, null, 2) + "\n");
  for (const s of USER_SKILLS) for (const rel of walk(path.join(ROOT, "skills", s))) write(path.join(".factory/controller/skills", s, rel), fs.readFileSync(path.join(ROOT, "skills", s, rel), "utf8"));
  for (const rel of walk(path.join(ROOT, "front-agent"))) write(path.join(".factory/front-agent", rel), render(fs.readFileSync(path.join(ROOT, "front-agent", rel), "utf8"), vars), /\.sh$/.test(rel) ? 0o755 : undefined);
  write(".factory/front-agent/factory.config.json", JSON.stringify(c, null, 2) + "\n");
  for (const rel of walk(path.join(ROOT, "server"))) write(path.join(".factory/server", rel), fs.readFileSync(path.join(ROOT, "server", rel), "utf8"), /\.sh$/.test(rel) ? 0o755 : undefined);
  manifest.factoryVersion = PKG.version;
  fs.writeFileSync(".factory/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  appendGitignore(IGNORES(fs.existsSync("package.json")));   // projects initialised by an older factory get the current ignore list
  // Every checkout of an adopted project (a fresh clone, the server checkout the waves push from) must arm the hooks:
  // core.hooksPath is per clone, not committed. own mode keeps its own setting.
  if (mode !== "own" && fs.existsSync(path.join(hdir, "pre-commit"))) sh("git", ["config", "core.hooksPath", c.hooks.hooksPath]);
  say(`${written} updated, ${kept} kept (locally changed). Review .factory/new/ and merge what you want.`);
}

// --- doctor ----------------------------------------------------------------------------------------
function doctor() {
  let fail = 0;
  const ok = (m) => say(`OK      ${m}`), bad = (m) => { say(`MISSING ${m}`); fail++; }, info = (m) => say(`info    ${m}`);
  const major = Number(process.versions.node.split(".")[0]); major >= 22 ? ok(`node ${process.versions.node}`) : bad(`node >= 22 (have ${process.versions.node})`);
  if (!fs.existsSync("factory.config.json")) { bad("factory.config.json (run init)"); process.exit(1); }
  const c = JSON.parse(fs.readFileSync("factory.config.json", "utf8")); ok(`factory.config.json (project ${c.project.name}, factory ${c.factoryVersion})`);
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
      sk ? bad(`${h.name}: user-level skills missing: ${sk.split("\n").join(", ")} (copy ~/controller/skills/* into ~/.claude/skills and ~/.agents/skills there)`) : ok(`${h.name}: user-level skills present`);
    }
    if (c.agents.runner === "orca" && !h.orcaRepoId) info(`${h.name}: orcaRepoId not set yet`);
  }
  const ctl = c.hosts.workers.find((h) => h.name === c.hosts.controller.host);
  if (ctl) {
    const statusAge = ctl.kind === "local" ? (fs.existsSync(path.join(os.homedir(), "controller/status.md")) ? (Date.now() - fs.statSync(path.join(os.homedir(), "controller/status.md")).mtimeMs) / 60000 : null) : Number(sh("ssh", [...(ctl.sshConfig ? ["-F", ctl.sshConfig.replace(/^~/, os.homedir())] : []), ctl.ssh, "stat -c %Y ~/controller/status.md 2>/dev/null"]) ? (Date.now() / 1000 - Number(sh("ssh", [...(ctl.sshConfig ? ["-F", ctl.sshConfig.replace(/^~/, os.homedir())] : []), ctl.ssh, "stat -c %Y ~/controller/status.md"]))) / 60 : null);
    statusAge === null ? info(`controller status.md not found on ${ctl.name} (controller not started yet)`) : statusAge > 25 ? bad(`controller status.md is ${Math.round(statusAge)} min old`) : ok(`controller status.md ${Math.round(statusAge)} min old`);
  }
  if (c.hosts.frontAgent.preview.enabled) { const r = spawnSync("curl", ["-s", "-m", "2", "-o", "/dev/null", "-w", "%{http_code}", `http://localhost:${c.hosts.frontAgent.preview.port}/`], { encoding: "utf8" }); /^[23]/.test(r.stdout) ? ok(`preview answers on ${c.hosts.frontAgent.preview.port}`) : info(`preview not running on ${c.hosts.frontAgent.preview.port}`); }
  process.exit(fail ? 1 : 0);
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
  for (const root of ["controller", "front-agent", "templates", "bin", "server"]) for (const rel of walk(path.join(ROOT, root))) {
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

const commands = { init, update, doctor, selfcheck, "install-skills": installSkills };
if (!commands[cmd]) { say(`agentic-factory ${PKG.version}\n  init            onboarding: ask the project's questions, write factory.config.json, copy handbooks, hooks, skills and bundles (--keep-own-hooks: leave the project's hooks untouched, hooks.mode own)\n  update          re-render from a newer factory; locally changed files are kept, new versions land in .factory/new/\n  install-skills  install the Orca and coordination skills at user level (~/.claude/skills, ~/.agents/skills) on this host; required wherever a Controller or Front agent runs. --all for every vendored skill, --force to replace\n  doctor          check config, hooks, tools, user-level skills, hosts and the controller's status\n  selfcheck       (factory repo) syntax and placeholder check\nFlags: --yes (take defaults)`); process.exit(cmd ? 1 : 0); }
await commands[cmd]();
