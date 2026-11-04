// Shared helpers for the Controller scripts. Everything project-specific comes from factory.config.json,
// which `agentic-factory init` copies next to these scripts (and keeps in the project repo).
//
// Hosts: the Controller runs on one host (local or remote). Workers run on zero or more hosts (hosts.workers[]),
// each with its own paths, Orca environment and capacity. Scripts take --on <host-name>; the default is the
// first worker host. A remote worker host is reached through its Orca environment (orca mode) or ssh (terminal mode).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DIR = path.dirname(new URL(import.meta.url).pathname);
export const expand = (p) => (p ? p.replace(/^~(?=$|\/)/, os.homedir()) : p);

function loadConfig() {
  const candidates = [process.env.FACTORY_CONFIG, path.join(DIR, "factory.config.json")].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, "utf8"));
  throw new Error("factory.config.json not found next to the controller scripts; run `agentic-factory init` or set FACTORY_CONFIG");
}
export const config = loadConfig();
export const PROJECT = config.project.name;
export const MAIN = config.project.mainBranch ?? "main";
export const BRANCH_PREFIX = config.project.branchPrefix ?? "agents/";
export const HUMAN = config.project.humanName ?? "the owner";
export const RUNNER = config.agents?.runner ?? "orca";
export const STEERING = config.steering?.mode ?? "orca-tasks";
export const CMDS = config.commands ?? {};
export const MODELS = config.agents?.models ?? {};
export const FALLBACK = config.agents?.fallback ?? {};

// --- hosts -------------------------------------------------------------------------------------
// A host's kind is relative to where these scripts run: the Controller runs on hosts.controller.host, so that host is
// local for the Controller even when the Front agent (on the human's machine) reaches it over ssh.
const controllerHostName = config.hosts?.controller?.host ?? "local";
// Seen from a Controller on a remote host, a "local" worker in the config is the human's machine, which it cannot reach.
const controllerIsRemote = (config.hosts?.workers ?? []).some((h) => h.name === controllerHostName && h.kind === "remote");
const workerHosts = (config.hosts?.workers?.length ? config.hosts.workers : [{ name: "local", kind: "local" }]).filter((h) => !(controllerIsRemote && h.kind === "local")).map((h) => ({
  name: h.name, kind: h.name === controllerHostName ? "local" : h.kind ?? (h.ssh ? "remote" : "local"), ssh: h.ssh, sshConfig: h.sshConfig,
  projectDir: h.projectDir,   // explicit checkout path on that host; default <projectsDir>/<project name>
  projectsDir: h.projectsDir ?? "~/projects", workspacesDir: h.workspacesDir ?? "~/orca/workspaces",
  orcaEnvironment: h.name === controllerHostName ? "" : h.orcaEnvironment ?? "", orcaRepoId: h.orcaRepoId ?? "",
  capacity: { ...(config.capacity ?? {}), ...(h.capacity ?? {}), gate: { ...(config.capacity?.gate ?? {}), ...(h.capacity?.gate ?? {}) } },
}));
export const HOSTS = workerHosts;
export function hostNamed(name) {
  const h = name ? workerHosts.find((x) => x.name === name) : workerHosts[0];
  if (!h) throw new Error(`unknown host ${name}; configured: ${workerHosts.map((x) => x.name).join(", ")}`);
  return h;
}
export const argHost = (argv = process.argv) => { const i = argv.indexOf("--on"); return hostNamed(i >= 0 ? argv[i + 1] : undefined); };
// Paths on a host. For a remote host these are remote paths (no local expansion); for a local host they are expanded.
export const projectDirOn = (h) => h.projectDir ? (h.kind === "local" ? expand(h.projectDir) : h.projectDir) : (h.kind === "local" ? path.join(expand(h.projectsDir), PROJECT) : `${h.projectsDir}/${PROJECT}`);
export const workspacesOn = (h) => (h.kind === "local" ? path.join(expand(h.workspacesDir), PROJECT) + "/" : `${h.workspacesDir}/${PROJECT}/`);
export const integrationOn = (h) => `${workspacesOn(h)}coordinator-integration`;
export const worktreeRefOn = (h, dir) => `id:${h.orcaRepoId}::${workspacesOn(h)}${dir}`;
export const orcaEnvArgsOn = (h) => (h.orcaEnvironment ? ["--environment", h.orcaEnvironment] : []);
/** Run a shell command on a host: locally, or over ssh for a remote host. Returns stdout or "" on failure. */
export function onHost(h, command, opts = {}) {
  if (h.kind === "local") return trySh("sh", ["-c", command], opts);
  return trySh("ssh", [...(h.sshConfig ? ["-F", expand(h.sshConfig)] : []), h.ssh, command], opts);
}
// The project checkout the Controller itself reads (docs, tasks): on the controller's own host.
const ctl = config.hosts?.controller ?? {};
const ctlHost = workerHosts.find((h) => h.name === controllerHostName) ?? workerHosts[0];
export const PROJECT_DIR = projectDirOn({ ...ctlHost, kind: "local", projectDir: ctl.projectDir ?? ctlHost.projectDir, projectsDir: ctl.projectsDir ?? ctlHost.projectsDir });
export const CONTROLLER_HOME = ctl.controllerDir ?? "~/controller"; // as configured: a leading ~ is expanded by the shell of the host it is used on
export const CONTROLLER_DIR = expand(CONTROLLER_HOME);

// --- orca --------------------------------------------------------------------------------------
export function hasBin(name) { return spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" }).status === 0; }
export const ORCA = process.env.ORCA_CLI_COMMAND ?? (process.platform === "linux" && !process.env.ORCA_TERMINAL && hasBin("orca-ide") ? "orca-ide" : "orca");
export const orcaJson = (args, h) => {
  const raw = sh(ORCA, [...args, ...(h ? orcaEnvArgsOn(h) : []), "--json"]);
  return JSON.parse(raw.split("\n").filter((l) => !l.includes('"_keepalive"')).join("\n"));
};

// --- misc --------------------------------------------------------------------------------------
export const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26, ...opts });
export const trySh = (cmd, args, opts = {}) => { try { return sh(cmd, args, opts); } catch { return ""; } };
export const git = (...a) => trySh("git", ["-C", PROJECT_DIR, ...a]).trim();
export const clean = (s) => String(s).split("\n").filter((l) => !/pair|token|code=/i.test(l)).join("\n");
export const file = (name) => path.join(DIR, name);
export const readJson = (name, fallback) => (fs.existsSync(file(name)) ? JSON.parse(fs.readFileSync(file(name), "utf8")) : fallback);
export const writeJson = (name, value) => fs.writeFileSync(file(name), JSON.stringify(value, null, 2) + "\n");
export const journal = (type, task, extra = {}) => fs.appendFileSync(file("journal.ndjson"), JSON.stringify({ ts: new Date().toISOString(), type, task, ...extra }) + "\n");
export const modelFor = (tier, agent = config.agents?.default ?? "codex") => (agent === FALLBACK.agent ? FALLBACK.models?.[tier] : MODELS[tier]) ?? MODELS.default;
export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
