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
// Tuning of the heartbeat's wakes, of hang detection and of restarts (hosts.controller.wake, .hung, .restart). A missing or
// unusable value is the default; the defaults are documented in docs/orca.md.
const positive = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
// Text patterns (regular expressions, case-insensitive) of a confirmation question: a pointer is never typed where one is visible.
// They look at the last 8 lines only and are anchored to how a prompt really ends or lists its options, so a sentence that merely
// contains these words does not count: "(y/n)" or "[y/N]" at the end of a line, a menu option "1. Yes" at the start of one, and "press
// enter" (optionally "to <something>") ending a line.
const DIALOGS = ["\\((?:y/n|yes/no)\\)\\s*:?\\s*$", "\\[(?:y/n|yes/no)\\]\\s*:?\\s*$", "^\\W*1[.)]\\s+yes\\b", "\\bpress enter(?: to [a-z ]+)?\\s*$"];
const patternList = (v, fallback) => (Array.isArray(v) ? v.filter((p) => typeof p === "string" && p) : fallback);
export const WAKE = { idleMinutes: positive(ctl.wake?.idleMinutes, 30), busyPointerMinutes: positive(ctl.wake?.busyPointerMinutes, 2), dialogPatterns: patternList(ctl.wake?.dialogPatterns, DIALOGS), dialogHoldMinutes: positive(ctl.wake?.dialogHoldMinutes, 15) };
export const HUNG = {
  minutes: positive(ctl.hung?.minutes, 25), restartAfterMinutes: positive(ctl.hung?.restartAfterMinutes, 15), 
  // Off unless a project sets exactly true: nothing else (false, "false", a typo of the value) turns a kill of a session on.
  restart: ctl.hung?.restart === true, restartInvalid: ctl.hung?.restart !== undefined && typeof ctl.hung.restart !== "boolean",
  patterns: patternList(ctl.hung?.patterns, []), patternMinutes: positive(ctl.hung?.patternMinutes, 10), resetAfterDays: positive(ctl.hung?.resetAfterDays, 7),
};
export const RESTART = { minGapMinutes: positive(ctl.restart?.minGapMinutes, 30), contextGapMinutes: positive(ctl.restart?.contextGapMinutes, 120), afterGateMinutes: positive(ctl.restart?.afterGateMinutes, 15), contextPercent: positive(ctl.restart?.contextPercent, 50) };

// --- orca --------------------------------------------------------------------------------------
export function hasBin(name) { return spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" }).status === 0; }
export const ORCA = process.env.ORCA_CLI_COMMAND ?? (process.platform === "linux" && !process.env.ORCA_TERMINAL && hasBin("orca-ide") ? "orca-ide" : "orca");
export const orcaJson = (args, h) => {
  const raw = sh(ORCA, [...args, ...(h ? orcaEnvArgsOn(h) : []), "--json"]);
  return JSON.parse(raw.split("\n").filter((l) => !l.includes('"_keepalive"')).join("\n"));
};

// --- finished workers --------------------------------------------------------------------------
// A worker is finished when Orca reports its dispatch settled, not when its terminal is gone: after worker_done the agent
// can sit at its prompt for hours. Orca's terminal list cannot tell (it has no status field, and a structured chat worker
// is not in it at all), so cleanup, capacity and the heartbeat all ask the dispatch through these functions.
// Cleanup deletes, so the rule leans to "busy": only a state Orca positively reports as settled is finished. "abandoned"
// is not: Orca fences such a worker "without claiming its process stopped", so it may still run.
export const SETTLED_STATES = new Set(["succeeded", "failed", "stopped"]);
/**
 * "finished", "running" or "unknown" for one workers.json record. `dispatches` comes from dispatchStates(): id →
 * { state, keptOpen, owned }, where state "gone" means Orca no longer knows the dispatch (then the terminal decides, as for
 * records without a dispatch); an id missing from it is unknown.
 * `terminals` is a Set of listed terminal handles or null when the list failed. Unknown never counts as finished.
 */
export function workerStatus(w, { dispatches = {}, terminals = null, pidAlive = () => false } = {}) {
  if (w.dispatch) {
    const state = dispatches[w.dispatch]?.state;
    if (!state) return "unknown";
    // A follow-up dispatch took over the worker's terminal (worker-start --terminal): it is in use, whatever this one says.
    if (dispatches[w.dispatch].owner && dispatches[w.dispatch].owner !== w.dispatch) return "running";
    if (state !== "gone") return SETTLED_STATES.has(state) ? "finished" : "running";
    // Orca no longer knows the dispatch (a reset, another server): a terminal still listed may still be working.
    if (!w.terminal) return "finished";
  }
  if (w.terminal) return terminals ? (terminals.has(w.terminal) ? "running" : "finished") : "unknown";   // records without a dispatch
  if (w.pid) return pidAlive(w.pid) ? "running" : "finished";
  return "unknown";   // nothing to check it by: never treated as finished
}
// Bounds on Orca calls per dispatchStates() run. Anything not answered within them is unknown (busy), never finished.
export const ORCA_CALL_TIMEOUT_MS = 20_000, LIST_PAGES_MAX = 3, SHOW_CALLS_MAX = 10, DISPATCH_DEADLINE_MS = 60_000;
/** Orca's answer to a call, parsed even when it exits non-zero (an error answer carries its code); null without JSON or on timeout. */
export const orcaCall = (args, h) => {
  const r = spawnSync(ORCA, [...args, ...(h ? orcaEnvArgsOn(h) : []), "--json"], { encoding: "utf8", maxBuffer: 1 << 26, timeout: ORCA_CALL_TIMEOUT_MS });
  if (r.error) return null;
  try { return JSON.parse(String(r.stdout ?? "").split("\n").filter((l) => l.trim() && !l.includes('"_keepalive"')).join("\n")); } catch { return null; }
};
const dispatchInfo = (state, resource) => ({ state, keptOpen: resource?.retainedReason === "user_requested", owned: resource?.ownershipState === "owned", owner: resource?.ownerDispatchId ?? undefined });
/** Settled states never change back, so they are kept in dispatch-settled.json and never asked again: "<host> <id>" → state. */
export const knownSettled = (h) => { const all = readState("dispatch-settled.json", {}), p = `${h?.name ?? "local"} `; return Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith(p)).map(([k, v]) => [k.slice(p.length), v])); };
/**
 * Dispatch state for the given ids on host h: at most LIST_PAGES_MAX pages of worker-list (newest first, stops once every
 * id is seen), then worker-show for at most SHOW_CALLS_MAX of the rest, least recently asked first (dispatch-asked.json),
 * so ids that never leave cannot starve the others. All calls together stop after DISPATCH_DEADLINE_MS, and a failed or
 * slow call stops that path; ids left unanswered are absent from the result, which workerStatus reads as unknown. keptOpen: Orca retains the worker's
 * terminal with retainedReason "user_requested" (worker-keep-open, and Orca's default for workers in a new worktree);
 * owned: Orca owns the worker's terminal and may close it; owner: the dispatch that owns the terminal now.
 * A settled state, once seen, comes from dispatch-settled.json without a call (cached: true, no terminal details), so
 * records that stay for a while cannot starve the bounded calls. Only ids of current records are kept there.
 */
export function dispatchStates(ids, h) {
  const ids0 = [...new Set(ids.filter(Boolean))], out = {}, until = Date.now() + DISPATCH_DEADLINE_MS;
  const settled = knownSettled(h);
  for (const id of ids0) if (SETTLED_STATES.has(settled[id])) out[id] = { state: settled[id], cached: true };
  const want = ids0.filter((id) => !out[id]);
  const missing = () => want.some((id) => !out[id]);
  let cursor;
  for (let page = 0; page < LIST_PAGES_MAX && missing() && Date.now() < until; page++) {
    const r = orcaCall(["orchestration", "worker-list", "--full", "--limit", "100", ...(cursor ? ["--cursor", cursor] : [])], h);
    if (!r?.ok) break;
    for (const x of r.result?.workers ?? []) if (want.includes(x.dispatchId)) out[x.dispatchId] = dispatchInfo(x.workerState ?? x.state, x.resource);
    cursor = r.result?.nextCursor ?? r.result?.page?.nextCursor;
    if (!cursor) break;
  }
  const asked = readState("dispatch-asked.json", {}), key = (id) => `${h?.name ?? "local"} ${id}`;
  const rest = want.filter((id) => !out[id]).sort((a, b) => (asked[key(a)] ?? 0) - (asked[key(b)] ?? 0));
  for (const id of rest.slice(0, SHOW_CALLS_MAX)) {
    if (Date.now() >= until) break;
    asked[key(id)] = Date.now();
    const r = orcaCall(["orchestration", "worker-show", "--dispatch", id, "--full"], h);
    if (r?.ok && (r.result?.worker?.state ?? r.result?.state)) out[id] = dispatchInfo(r.result.worker?.state ?? r.result.state, r.result.terminalResource);
    else if (r?.error?.code === "dispatch_not_found") out[id] = { state: "gone" };
    else if (!r) break;   // slow or broken Orca: the rest stays unknown
  }
  // Remember settled answers; forget entries of this host whose record is gone.
  const p = `${h?.name ?? "local"} `, all = readState("dispatch-settled.json", {});
  const next = Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith(p) || ids0.includes(k.slice(p.length))));
  // Not cached while another dispatch owns the terminal: that worker counts as running until it is asked again.
  for (const [id, d] of Object.entries(out)) if (SETTLED_STATES.has(d.state) && (!d.owner || d.owner === id)) next[p + id] = d.state;
  if (JSON.stringify(next) !== JSON.stringify(all)) { try { writeJson("dispatch-settled.json", next); } catch { /* best effort */ } }
  if (rest.length) { const live = new Set(want.map(key)); try { writeJson("dispatch-asked.json", Object.fromEntries(Object.entries(asked).filter(([k]) => live.has(k) || !k.startsWith(`${h?.name ?? "local"} `)))); } catch { /* best effort */ } }
  return out;
}

// --- misc --------------------------------------------------------------------------------------
export const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26, ...opts });
export const trySh = (cmd, args, opts = {}) => { try { return sh(cmd, args, opts); } catch { return ""; } };
export const git = (...a) => trySh("git", ["-C", PROJECT_DIR, ...a]).trim();
export const clean = (s) => String(s).split("\n").filter((l) => !/pair|token|code=/i.test(l)).join("\n");
export const file = (name) => path.join(DIR, name);
export const readJson = (name, fallback) => (fs.existsSync(file(name)) ? JSON.parse(fs.readFileSync(file(name), "utf8")) : fallback);
/**
 * A state file the scripts can rebuild (caches, calibration): one that cannot be read, or holds the wrong kind of value
 * (null, an array for an object), counts as missing. One line on stderr says so; the next write replaces it. Not for
 * workers.json: an empty worker list would make capacity count nobody and cleanup forget everyone.
 */
export const readState = (name, fallback) => {
  if (!fs.existsSync(file(name))) return fallback;
  try {
    const v = JSON.parse(fs.readFileSync(file(name), "utf8"));
    if (Array.isArray(fallback) ? Array.isArray(v) : v !== null && typeof v === "object" && !Array.isArray(v)) return v;
  } catch { /* reported below */ }
  console.error(`${name} could not be read; starting from scratch, it is rewritten on the next save`);
  return fallback;
};
/** Writes through a temporary file and a rename, so a reader in another process never sees a half-written file. */
export const writeJson = (name, value) => { const tmp = `${file(name)}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n"); fs.renameSync(tmp, file(name)); };
/** Writes text through a temporary file and a rename (as writeJson), for files the watchers read from outside. */
export const writeText = (name, text) => { const tmp = `${file(name)}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file(name)); };
/** A journal line the heartbeat or restart.mjs writes: the file's age is the Controller's sign of work, so its mtime is put back. */
export const journalQuiet = (type, task, extra = {}) => {
  let before = null; try { before = fs.statSync(file("journal.ndjson")); } catch { /* none yet */ }
  journal(type, task, extra);
  // A journal that did not exist before gets the oldest time: the Controller's next line gives it a real one.
  try { fs.utimesSync(file("journal.ndjson"), before?.atime ?? new Date(0), before?.mtime ?? new Date(0)); } catch { /* best effort */ }
};
export const journal = (type, task, extra = {}) => fs.appendFileSync(file("journal.ndjson"), JSON.stringify({ ts: new Date().toISOString(), type, task, ...extra }) + "\n");
export const modelFor = (tier, agent = config.agents?.default ?? "codex") => (agent === FALLBACK.agent ? FALLBACK.models?.[tier] : MODELS[tier]) ?? MODELS.default;
/** A setup or shell terminal in an entry. Its name contains the entry's role, but it is neither the worker nor a wave. */
export const isHelperTerminal = (title = "") => / · (Setup|Shell)$/.test(title);
/** Whether a terminal keeps its worktree from being cleaned up. */
export const holdsWorktree = (title = "") => /· Worker|Controller|Coordinator|· Integration/.test(title) && !isHelperTerminal(title);
export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// The ticket's own declaration of a documentation ticket (`Level: 1` and `Documentation only: yes`), read the way
// templates/tools/factory-guardrails.mjs reads it (a test keeps the two in step). "" when the text declares it, else why not.
export function declaredProblem(text) {
  // Only the ticket's own prose counts: not an HTML comment (the task template carries the field as one) and not a fenced
  // code block. Then exactly one line starting `Level:` (any case) that reads exactly `Level: 1`, and exactly one starting
  // `Documentation only:` that reads exactly `Documentation only: yes`: the documented spelling, at the start of a line, once.
  const prose = String(text).replace(/<!--[\s\S]*?(-->|$)/g, ""), kept = [];
  let fence = "";
  for (const l of prose.split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (fence) { if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = ""; continue; }
    if (m) { fence = m[1]; continue; }
    kept.push(l);
  }
  const level = kept.filter((l) => /^level:/i.test(l)), decl = kept.filter((l) => /^documentation only:/i.test(l));
  if (level.length !== 1 || !/^Level: 1[ \t]*$/.test(level[0])) return "its Level is not 1";
  if (decl.length !== 1 || !/^Documentation only: yes[ \t]*$/.test(decl[0])) return "it does not say `Documentation only: yes`";
  return "";
}
