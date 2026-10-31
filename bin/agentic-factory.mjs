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
async function askText(question, def) { if (yes) return def; const a = (await rl.question(`\n${question} [${def}] `)).trim(); return a || def; }

// --- detection -----------------------------------------------------------------------------------
function detect() {
  const remote = sh("git", ["config", "--get", "remote.origin.url"]);
  const repo = remote.replace(/^git@github\.com:/, "github.com/").replace(/^https?:\/\//, "").replace(/\.git$/, "");
  const name = path.basename(repo || cwd);
  const pkg = fs.existsSync("package.json") ? JSON.parse(fs.readFileSync("package.json", "utf8")) : {};
  const scripts = pkg.scripts ?? {};
  const pm = fs.existsSync("pnpm-lock.yaml") ? "pnpm" : fs.existsSync("yarn.lock") ? "yarn" : fs.existsSync("package-lock.json") ? "npm" : "pnpm";
  const run = (s) => (scripts[s] ? `${pm} ${pm === "npm" ? "run " : ""}${s}` : "");
  const figma = (() => { try { const r = spawnSync("curl", ["-s", "-m", "1", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:3845/mcp"], { encoding: "utf8" }); return /^(2|4)/.test(r.stdout); } catch { return false; } })();
  return {
    repo, name, github: /github\.com/.test(repo), pm, scripts,
    commands: { install: pm === "pnpm" ? "pnpm install --frozen-lockfile" : pm === "npm" ? "npm ci" : "yarn install --frozen-lockfile", typecheck: run("typecheck") || run("check-types"), lint: run("lint"), unit: run("test:unit") || run("test"), verify: run("verify") || run("test"), e2e: run("test:e2e") || run("e2e"), release: [run("e2e:compose"), run("test:images")].filter(Boolean) },
    tools: { orca: has("orca") || has("orca-ide"), codex: has("codex"), claude: has("claude"), pi: has("pi"), gh: has("gh"), figma },
  };
}

// --- init ------------------------------------------------------------------------------------------
async function init() {
  say(`agentic-factory ${PKG.version}: onboarding for ${cwd}`);
  if (!fs.existsSync(".git")) { say("Not a git repository. Run `git init` first."); process.exit(1); }
  const d = detect();
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, "factory.config.example.json"), "utf8"));
  delete c.$comment;
  c.factoryVersion = PKG.version;
  c.project.name = await askText("1. Project name (used for branches, worktrees, locks, the preview)?", d.name);
  c.project.repo = await askText("   Repository?", d.repo || `github.com/<owner>/${c.project.name}`);
  c.project.mainBranch = sh("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace("origin/", "") || "main";
  c.project.humanName = await askText("2. Who is the human the agents work for (name as the handbooks should address them)?", os.userInfo().username);
  c.project.language = await ask("   In which language should the human-facing workflow guide be written?", [{ label: "Deutsch", value: "de" }, { label: "English", value: "en" }], "de");
  c.rhythm.mode = await ask("3. Working rhythm?", [
    { label: "Day: plan, test, decide. Night: the Controller builds unattended. Morning handover.", value: "day-plan-night-build" },
    { label: "Continuous: build whenever signed-off work exists; questions as they arise", value: "continuous" },
    { label: "Custom quiet hours (edit rhythm.quietHours afterwards)", value: "custom" }], "day-plan-night-build");
  c.steering.mode = await ask("4. Where do tickets live?", [
    { label: "GitHub issues (labels, native blocking; wayfinder maps visible in the tracker)", value: "github-issues" },
    { label: "Task files docs/tasks/T<n>-*.md (everything in git, no tracker)", value: "orca-tasks" }], d.github && d.tools.gh ? "github-issues" : "orca-tasks");
  c.agents.runner = await ask("5. How are workers run?", [
    { label: "Orca: own worktree and terminal per worker, structured messages, remote servers via pairing", value: "orca" },
    { label: "Plain terminals: git worktrees plus codex/claude/pi processes, no Orca needed", value: "terminal" }], d.tools.orca ? "orca" : "terminal");
  c.agents.default = await ask("6. Default agent CLI for workers?", [{ label: "Codex", value: "codex" }, { label: "Claude Code", value: "claude" }, { label: "Pi", value: "pi" }], d.tools.codex ? "codex" : d.tools.claude ? "claude" : "pi");
  if (c.agents.default === "claude") { c.agents.models = { small: "haiku", default: "sonnet", large: "opus" }; c.agents.fallback = { agent: "codex", models: { small: "gpt-6-luna", default: "gpt-6.1-terra", large: "gpt-6.1-sol" }, quotaThresholdPercent: 10 }; }
  for (const t of ["small", "default", "large"]) c.agents.models[t] = await askText(`   Model for the "${t}" tier (as the ${c.agents.default} CLI names it; a starting value, calibrated later)?`, c.agents.models[t]);
  const where = await ask("7. Where do workers run? (a remote server is an option, not a must; you can add more hosts later)", [
    { label: "Only on this machine", value: "local" },
    { label: "On this machine and on one remote server (ssh alias)", value: "both" },
    { label: "Only on a remote server", value: "remote" }], "local");
  const localHost = { name: "local", kind: "local", projectsDir: path.dirname(cwd).replace(os.homedir(), "~"), workspacesDir: "~/orca/workspaces", orcaEnvironment: "", orcaRepoId: "", capacity: { suiteWorkersMax: 2, readOnlyWorkersMax: 2 } };
  const remoteHost = { name: "workhorse", kind: "remote", ssh: "workhorse", sshConfig: "", projectsDir: "~/projects", workspacesDir: "~/orca/workspaces", orcaEnvironment: "", orcaRepoId: "", capacity: { suiteWorkersMax: 8, readOnlyWorkersMax: 6, gate: { unitSlots: 3, e2eSlots: 2 } } };
  if (where !== "local") {
    remoteHost.name = await askText("   Name of the remote host (also its Orca environment name)?", "workhorse");
    remoteHost.ssh = await askText("   SSH alias for it (from your ssh config)?", remoteHost.name);
    remoteHost.sshConfig = await askText("   Path to an ssh config file, or empty for ~/.ssh/config?", "");
    remoteHost.orcaEnvironment = c.agents.runner === "orca" ? remoteHost.name : "";
  }
  c.hosts.workers = where === "local" ? [localHost] : where === "both" ? [localHost, remoteHost] : [remoteHost];
  c.hosts.controller = { host: await ask("8. Where does the Controller run?", c.hosts.workers.map((h) => ({ label: h.kind === "local" ? "On this machine (a second agent session next to the Front agent)" : `On ${h.name} (unattended, survives this machine sleeping)`, value: h.name })), c.hosts.workers.at(-1).name), controllerDir: "~/controller" };
  c.capacity.calibration.mode = await ask("9. Capacity: the limits per host are starting values. Calibrate them automatically?", [{ label: "Auto: start low, raise step by step while the host stays quiet, lower on pressure; the audit verifies", value: "auto" }, { label: "Manual: use the configured limits as they are", value: "manual" }], "auto");
  c.agents.calibration = await ask("   Models: calibrate the tier per role from measured pass rates and rounds?", [{ label: "Auto", value: "auto" }, { label: "Manual: only recommend", value: "manual" }], "auto");
  for (const k of ["install", "typecheck", "lint", "unit", "verify", "e2e"]) c.commands[k] = await askText(`10. Command: ${k}? (empty to skip)`, d.commands[k] ?? c.commands[k] ?? "");
  c.commands.release = d.commands.release.length ? d.commands.release : c.commands.release;
  c.hosts.frontAgent.preview.enabled = (await ask("11. Local preview that follows main on this machine (the human accepts there)?", [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], "yes")) === "yes";
  if (c.hosts.frontAgent.preview.enabled) { c.hosts.frontAgent.preview.port = Number(await askText("   Port?", "8180")); c.hosts.frontAgent.preview.command = await askText("   Start command?", d.scripts.dev ? `${d.pm} dev` : c.hosts.frontAgent.preview.command); c.hosts.frontAgent.preview.envFile = `~/.config/${c.project.name}/preview.env`; }
  c.reviews.maxRounds = Number(await askText("12. Review rounds before a working feature is integrated and the rest becomes debt?", "2"));
  c.design = { tool: await ask("13. Design tool for stage 1 of outside-in?", [{ label: "Figma via its local MCP server", value: "figma" }, { label: "Pencil", value: "pencil" }, { label: "None for now", value: "none" }], d.tools.figma ? "figma" : "none"), exportDir: "design" };
  say("\n14. Hard rules (they go into AGENTS.md and docs/coordinator.md):\n  - no real data or secrets in the repo, .env never committed\n  - the factory has no outward effects: nothing changes outside the repo and the demo environment\n  - workers never push to main; --no-verify is forbidden\n  - tests run on demo data or a private copy, never on the original\n  - no real model calls in tests");
  if ((await ask("   Confirm all of them?", [{ label: "Yes", value: "yes" }, { label: "No, stop here", value: "no" }], "yes")) !== "yes") { say("Stopped. Nothing written."); process.exit(1); }

  // --- write -----------------------------------------------------------------------------------
  const manifest = { factoryVersion: PKG.version, files: {} };
  const vars = templateVars(c);
  const write = (rel, content, mode) => {
    const target = path.join(cwd, rel);
    if (fs.existsSync(target) && fs.readFileSync(target, "utf8") !== content) {
      const existing = JSON.parse(fs.existsSync(".factory/manifest.json") ? fs.readFileSync(".factory/manifest.json", "utf8") : "{}").files?.[rel];
      if (!existing || existing !== hash(fs.readFileSync(target, "utf8"))) { say(`  keep   ${rel} (exists and was changed locally; new version at .factory/new/${rel})`); fs.mkdirSync(path.dirname(path.join(cwd, ".factory/new", rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, ".factory/new", rel), content); manifest.files[rel] = hash(fs.readFileSync(target, "utf8")); return; }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content); if (mode) fs.chmodSync(target, mode);
    manifest.files[rel] = hash(content); say(`  write  ${rel}`);
  };
  say("\nWriting:");
  write("factory.config.json", JSON.stringify(c, null, 2) + "\n");
  for (const rel of walk(path.join(ROOT, "templates"))) write(rel, render(fs.readFileSync(path.join(ROOT, "templates", rel), "utf8"), vars), /\.githooks\/|tools\//.test(rel) ? 0o755 : undefined);
  write("docs/dev-workflow.md", render(fs.readFileSync(path.join(ROOT, "docs", c.project.language === "de" ? "de/workflow.md" : "workflow.md"), "utf8"), vars));
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
  sh("git", ["config", "core.hooksPath", ".githooks"]);
  for (const dir of ["docs/reviews", "docs/reports", "docs/handoffs"]) { fs.mkdirSync(dir, { recursive: true }); if (!fs.existsSync(path.join(dir, ".gitkeep"))) fs.writeFileSync(path.join(dir, ".gitkeep"), ""); }
  appendGitignore([".factory/new/", ".build/", ".env", ".env.*", "!.env.example", ".scratch/"]);

  // --- the human's checklist -----------------------------------------------------------------
  const remote = c.hosts.workers.find((h) => h.kind === "remote");
  const ctl = c.hosts.workers.find((h) => h.name === c.hosts.controller.host);
  const steps = [
    `Read docs/dev-workflow.md (the process) and AGENTS.md (the agents' rules). Commit the new files with a message that references the adoption ADR, e.g. \`git commit -m "Adopt agentic-factory (ADR-0001)"\`; protected files need that reference.`,
    remote && `Set up ${remote.name}: copy .factory/server/ there and follow docs/server-setup.md in the factory repo. Logins (gh, ${c.agents.default}, tailscale${c.agents.runner === "orca" ? ", Orca pairing" : ""}) are yours. Then put its Orca repo id into factory.config.json → hosts.workers[].orcaRepoId and run \`agentic-factory update\` to refresh the bundles.`,
    `Skills at user level, on EVERY host that runs a Controller or Front agent: \`agentic-factory install-skills\` here${remote ? `; on ${remote.name}: \`mkdir -p ~/.claude/skills ~/.agents/skills && cp -R ~/controller/skills/* ~/.claude/skills/ && cp -R ~/controller/skills/* ~/.agents/skills/\`` : ""}. Without the Orca skills (orchestration, orca-cli) the agents cannot start, watch or release workers.`,
    `Controller: copy .factory/controller/ to ${ctl.kind === "local" ? "~/controller on this machine" : `${ctl.name}:~/controller`}, install the gate (\`install -m 755 ~/controller/gate ~/.local/bin/gate\`), start \`bash ~/controller/loadlog.sh &\`, then start an agent session there with: "Read ~/controller/CONTROLLER.md and act as the Controller."`,
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
  const projectDir = ctl.kind === "local" ? path.join(ctl.projectsDir, c.project.name) : `${ctl.projectsDir}/${c.project.name}`;
  const orca = c.agents.runner === "orca";
  return {
    PROJECT: c.project.name, HUMAN: c.project.humanName, MAIN: c.project.mainBranch, DATE: new Date().toISOString().slice(0, 10),
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
    SSH_ALIAS: remote?.ssh ?? "local", PREVIEW_PLIST: `de.${c.project.name}.preview`, PREVIEW_LABEL: `de.${c.project.name}.preview`, PREVIEW_SCRIPT: `${os.homedir()}/front-agent/${c.project.name}/preview-update.sh`, HOME: os.homedir(),
    COMMIT_PATTERN: `mv .env ../.${c.project.name}.env; git add …; git commit …; mv ../.${c.project.name}.env .env`,
  };
}
const render = (text, vars) => text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
function walk(dir, base = dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))])); }
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
  const vars = templateVars(c);
  const manifest = JSON.parse(fs.existsSync(".factory/manifest.json") ? fs.readFileSync(".factory/manifest.json", "utf8") : '{"files":{}}');
  let written = 0, kept = 0;
  const write = (rel, content, mode) => {
    const target = path.join(cwd, rel);
    if (fs.existsSync(target)) {
      const current = fs.readFileSync(target, "utf8");
      if (current === content) return;
      if (manifest.files[rel] && manifest.files[rel] !== hash(current)) { kept++; fs.mkdirSync(path.dirname(path.join(cwd, ".factory/new", rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, ".factory/new", rel), content); say(`  keep   ${rel} → new version in .factory/new/${rel}`); return; }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); if (mode) fs.chmodSync(target, mode); manifest.files[rel] = hash(content); written++; say(`  update ${rel}`);
  };
  for (const rel of walk(path.join(ROOT, "templates"))) write(rel, render(fs.readFileSync(path.join(ROOT, "templates", rel), "utf8"), vars), /\.githooks\/|tools\//.test(rel) ? 0o755 : undefined);
  write("docs/dev-workflow.md", render(fs.readFileSync(path.join(ROOT, "docs", c.project.language === "de" ? "de/workflow.md" : "workflow.md"), "utf8"), vars));
  for (const rel of walk(path.join(ROOT, "skills"))) write(path.join(".agents/skills", rel), fs.readFileSync(path.join(ROOT, "skills", rel), "utf8"));
  for (const rel of walk(path.join(ROOT, "controller"))) write(path.join(".factory/controller", rel), render(fs.readFileSync(path.join(ROOT, "controller", rel), "utf8"), vars), /gate$|\.sh$/.test(rel) ? 0o755 : undefined);
  write(".factory/controller/factory.config.json", JSON.stringify(c, null, 2) + "\n");
  for (const s of USER_SKILLS) for (const rel of walk(path.join(ROOT, "skills", s))) write(path.join(".factory/controller/skills", s, rel), fs.readFileSync(path.join(ROOT, "skills", s, rel), "utf8"));
  for (const rel of walk(path.join(ROOT, "front-agent"))) write(path.join(".factory/front-agent", rel), render(fs.readFileSync(path.join(ROOT, "front-agent", rel), "utf8"), vars), /\.sh$/.test(rel) ? 0o755 : undefined);
  write(".factory/front-agent/factory.config.json", JSON.stringify(c, null, 2) + "\n");
  for (const rel of walk(path.join(ROOT, "server"))) write(path.join(".factory/server", rel), fs.readFileSync(path.join(ROOT, "server", rel), "utf8"), /\.sh$/.test(rel) ? 0o755 : undefined);
  manifest.factoryVersion = PKG.version;
  fs.writeFileSync(".factory/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  say(`${written} updated, ${kept} kept (locally changed). Review .factory/new/ and merge what you want.`);
}

// --- doctor ----------------------------------------------------------------------------------------
function doctor() {
  let fail = 0;
  const ok = (m) => say(`OK      ${m}`), bad = (m) => { say(`MISSING ${m}`); fail++; }, info = (m) => say(`info    ${m}`);
  const major = Number(process.versions.node.split(".")[0]); major >= 22 ? ok(`node ${process.versions.node}`) : bad(`node >= 22 (have ${process.versions.node})`);
  if (!fs.existsSync("factory.config.json")) { bad("factory.config.json (run init)"); process.exit(1); }
  const c = JSON.parse(fs.readFileSync("factory.config.json", "utf8")); ok(`factory.config.json (project ${c.project.name}, factory ${c.factoryVersion})`);
  sh("git", ["config", "core.hooksPath"]) === ".githooks" ? ok("core.hooksPath=.githooks") : bad("core.hooksPath=.githooks (git config core.hooksPath .githooks)");
  for (const h of ["pre-commit", "commit-msg", "pre-push"]) fs.existsSync(`.githooks/${h}`) && (fs.statSync(`.githooks/${h}`).mode & 0o111) ? ok(`hook ${h}`) : bad(`hook .githooks/${h} executable`);
  fs.existsSync("tools/factory-guardrails.mjs") ? ok("tools/factory-guardrails.mjs") : bad("tools/factory-guardrails.mjs");
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
  for (const rel of [...walk(path.join(ROOT, "controller")), ...walk(path.join(ROOT, "front-agent")), ...walk(path.join(ROOT, "templates")), ...walk(path.join(ROOT, "bin"))]) {
    const p = path.join(ROOT, /^(controller|front-agent|templates|bin)/.test(rel) ? "" : "", rel);
    const full = fs.existsSync(p) ? p : [path.join(ROOT, "controller", rel), path.join(ROOT, "front-agent", rel), path.join(ROOT, "templates", rel), path.join(ROOT, "bin", rel)].find(fs.existsSync);
    if (!full) continue;
    if (/\.mjs$/.test(full)) { const r = spawnSync("node", ["--check", full]); if (r.status !== 0) { say(`SYNTAX ${full}`); fail++; } }
    if (/\.sh$|\/gate$|\.githooks\//.test(full)) { const r = spawnSync("bash", ["-n", full]); if (r.status !== 0) { say(`SYNTAX ${full}`); fail++; } }
  }
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, "factory.config.example.json"), "utf8"));
  const vars = templateVars(c);
  for (const dir of ["templates", "controller", "front-agent"]) for (const rel of walk(path.join(ROOT, dir))) { const out = render(fs.readFileSync(path.join(ROOT, dir, rel), "utf8"), vars); const left = out.match(/\{\{[A-Z_]+\}\}/g); if (left) { say(`UNRESOLVED ${dir}/${rel}: ${[...new Set(left)].join(" ")}`); fail++; } }
  say(fail ? `${fail} problems` : "selfcheck ok");
  process.exit(fail ? 1 : 0);
}

const commands = { init, update, doctor, selfcheck, "install-skills": installSkills };
if (!commands[cmd]) { say(`agentic-factory ${PKG.version}\n  init            onboarding: ask the project's questions, write factory.config.json, copy handbooks, hooks, skills and bundles\n  update          re-render from a newer factory; locally changed files are kept, new versions land in .factory/new/\n  install-skills  install the Orca and coordination skills at user level (~/.claude/skills, ~/.agents/skills) on this host; required wherever a Controller or Front agent runs. --all for every vendored skill, --force to replace\n  doctor          check config, hooks, tools, user-level skills, hosts and the controller's status\n  selfcheck       (factory repo) syntax and placeholder check\nFlags: --yes (take defaults)`); process.exit(cmd ? 1 : 0); }
await commands[cmd]();
