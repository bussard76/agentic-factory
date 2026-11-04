// Start a worker from a spec file on a worker host. Reads the runner and hosts from factory.config.json.
// Usage: node start.mjs "<Task> · Worker <Role>" <spec-file> <key> [--on <host>] [--agent codex|claude|pi]
//        [--tier small|default|large] [--model <m>] [--worktree <dir>|new] [--readonly] [--effort high] [--force]
// Records the host and terminal handle (orca) or pid (terminal runner) under <key> in workers.json.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BRANCH_PREFIX, FALLBACK, MAIN, ORCA, RUNNER, argHost, config, file, journal, modelFor, onHost, orcaEnvArgsOn, projectDirOn, readJson, sh, slug, workspacesOn, worktreeRefOn, writeJson } from "./lib.mjs";

const [name, specFile, key, ...rest] = process.argv.slice(2);
if (!name || !specFile || !key || !/ · Worker /.test(name)) throw new Error('usage: node start.mjs "<Task> · Worker <Role>" <spec-file> <key> [options]');
const opt = (flag, def) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : def; };
const has = (flag) => rest.includes(flag);
const host = argHost(process.argv);
const spec = fs.readFileSync(specFile, "utf8").trim();
const agent = opt("--agent", quotaFallback() ? FALLBACK.agent : config.agents?.default ?? "codex");
const role = name.split(" · Worker ")[1] ?? "Developer";
const tier = opt("--tier", readJson("model-tiers.json", {})[role] ?? "default");   // calibrated per role, see calibrate-models.mjs
const model = opt("--model", modelFor(tier, agent));
const effort = opt("--effort", "high");
const worktree = opt("--worktree", "new");
const dir = worktree === "new" ? slug(key) : worktree;
const readonly = has("--readonly");

// Capacity verdict first (docs/capacity.md). --force skips it for rework of an already running task.
if (!has("--force")) {
  const verdict = JSON.parse(sh("node", [file("capacity.mjs"), "--on", host.name]));
  const kind = readonly ? "readonly" : "suite";
  if (verdict[kind] !== "start") { console.log(JSON.stringify({ started: false, host: host.name, waiting: kind, reason: verdict.reason })); process.exit(2); }
}

const workers = readJson("workers.json", {});
let record;
if (RUNNER === "orca") {
  const args = ["orchestration", "worker-start", "--task-title", name, "--spec", spec, "--agent", agent, "--model", model, "--repo", `id:${host.orcaRepoId}`, "--setup", "run", ...orcaEnvArgsOn(host), "--json"];
  if (agent === "codex") args.push("--effort", effort);
  // A worker on the Controller's own host becomes a child of the Controller's workspace. Orca refuses new-child across
  // hosts, and it needs a Controller inside an Orca terminal. A child starts from origin/<main>, not the parent's branch.
  const placement = !host.orcaEnvironment && process.env.ORCA_TERMINAL_HANDLE ? "new-child" : "new-top-level";
  args.push(...(worktree === "new" ? ["--worktree", placement, "--name", dir, "--base-branch", `origin/${MAIN}`] : ["--worktree", worktreeRefOn(host, dir)]));
  const limits = host.capacity.worker ?? {};
  const env = { ...process.env, ...(limits.memoryMax ? { ORCA_TERMINAL_MEMORY_MAX: limits.memoryMax } : {}), ...(limits.processCeiling ? { ORCA_TERMINAL_PROCESS_CEILING: String(limits.processCeiling) } : {}) };
  const receipt = JSON.parse(sh(ORCA, args, { env }));
  if (!receipt.ok) throw new Error(JSON.stringify(receipt.error));
  const dispatch = receipt.result?.dispatchId ?? receipt.result?.dispatch?.id;
  const handle = receipt.result?.terminal ?? receipt.result?.worker?.agentTerminalHandle ?? (dispatch ? JSON.parse(sh(ORCA, ["orchestration", "worker-show", "--dispatch", dispatch, ...orcaEnvArgsOn(host), "--json"])).result?.worker?.agentTerminalHandle : undefined);  // Name the terminal and pane by task and role so the sidebar never shows an automatic session name.
  record = { name, host: host.name, agent, model, tier, dispatch, terminal: handle, worktree: `${workspacesOn(host)}${dir}`, readonly, started: new Date().toISOString() };
  // The worker runs now: record it first, because a failed title must not lose it or invite a second start.
  workers[key] = record;
  writeJson("workers.json", workers);
  // Name the terminal and pane by task and role so the sidebar never shows an automatic session name.
  if (handle) for (const sub of ["rename", "set-pane-title"]) {
    try { sh(ORCA, ["terminal", sub, "--terminal", handle, "--title", name, ...orcaEnvArgsOn(host), "--json"]); }
    catch (e) { console.error(`Worker started, but ${sub} failed: ${e.message}`); }
  }
} else {
  // Plain terminal runner: a git worktree plus an agent process whose first prompt is the spec. Local or over ssh.
  const wt = `${workspacesOn(host)}${dir}`;
  const projectDir = projectDirOn(host);
  const eventsDir = host.kind === "local" ? file("events") : `${host.projectsDir}/../controller-events`;
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  onHost(host, `mkdir -p ${q(workspacesOn(host))} ${q(eventsDir)} && cd ${q(projectDir)} && git fetch -q origin && ([ -d ${q(wt)} ] || git worktree add -q -b ${q(BRANCH_PREFIX + dir)} ${q(wt)} origin/${MAIN})`);
  const preamble = `You are a factory worker named "${name}". When you are completely done, append one line "DONE <branch> <sha> <one-line result>" to ${eventsDir}/${key}.md. If you are blocked, append "ESCALATE <one concrete blocker>" there and stop. Never push to ${MAIN}.\n\n`;
  const cmd = { codex: ["codex", "exec", "--full-auto", "-m", model, preamble + spec], claude: ["claude", "--dangerously-skip-permissions", "--model", model, "-p", preamble + spec], pi: ["pi", "-p", preamble + spec] }[agent];
  fs.mkdirSync(file("logs"), { recursive: true });
  const log = fs.openSync(file(`logs/${key}.log`), "a");
  let child;
  if (host.kind === "local") child = spawn(cmd[0], cmd.slice(1), { cwd: wt, detached: true, stdio: ["ignore", log, log] });
  else child = spawn("ssh", [...(host.sshConfig ? ["-F", host.sshConfig] : []), host.ssh, `cd ${q(wt)} && setsid ${cmd.map(q).join(" ")} > ${q(`${eventsDir}/${key}.log`)} 2>&1 < /dev/null & echo $!`], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  record = { name, host: host.name, agent, model, tier, pid: host.kind === "local" ? child.pid : undefined, remoteLog: host.kind === "remote" ? `${eventsDir}/${key}.log` : undefined, worktree: wt, readonly, started: new Date().toISOString() };
}
workers[key] = record;
writeJson("workers.json", workers);
journal("start", key, { role: name.split(" · Worker ")[1], model, agent, host: host.name, note: readonly ? "readonly" : "suite" });
console.log(JSON.stringify({ started: true, key, ...record }));

function quotaFallback() {
  const q = readJson("quota.json", {});
  const t = FALLBACK.quotaThresholdPercent ?? 10;
  return typeof q.defaultAgentPercentLeft === "number" && q.defaultAgentPercentLeft < t && FALLBACK.agent;
}
