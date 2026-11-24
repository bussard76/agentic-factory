// Restarts the Controller with a fresh context: saves what a new one needs, opens a new Controller terminal the way `agentic-factory
// start` does (the same command, exactly the configured agents.controllerArgs), records it, and closes the old terminal last.
// The Controller runs it itself when its context use is above hosts.controller.restart.contextPercent (CONTROLLER.md, "Starting fresh"),
// and the heartbeat runs the same code for a Controller that hangs (hosts.controller.hung). It touches no worker, wave, worktree or branch.
// Refuses within hosts.controller.restart.minGapMinutes of the last restart (a fresh Controller may already be above the threshold),
// unless --force. Exit 0 restarted, 1 failed (the old Controller was left alone, or is named in the message), 3 refused.
// Usage: node restart.mjs --reason "<why>" [--dry] [--force]
import "./cli.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { controllerPlaces, controllerSession, createArgs, createdHandle, locateController } from "./controller-terminal.mjs";
import { CONTROLLER_HOME, ORCA, PROJECT, PROJECT_DIR, RESTART, config, file, journal, orcaCall, writeJson, writeText } from "./lib.mjs";
import { oneLine, tellFront } from "./front-notice.mjs";

const LOCK = file("heartbeat.lock.d");
const LOCK_STALE_MS = 5 * 60_000;
const title = `${PROJECT} · Controller`;
const readText = (name) => { try { return fs.readFileSync(file(name), "utf8"); } catch { return ""; } };
const readJson = (name, fallback) => { try { const v = JSON.parse(readText(name)); return v && typeof v === "object" ? v : fallback; } catch { return fallback; } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The heartbeat's own lock: while it is held no heartbeat run types into a Controller that is being exchanged, and two
// restarts (the Controller's own and the heartbeat's) cannot overlap. A run that holds it is a few seconds long.
function takeLock(waitMs = Number(process.env.FACTORY_RESTART_LOCK_WAIT_MS) || 45_000) {   // the variable is for tests
  for (const until = Date.now() + waitMs; ; sleep(1000)) {
    try { if (Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS) fs.rmdirSync(LOCK); } catch { /* none */ }
    try { fs.mkdirSync(LOCK); return () => { try { fs.rmdirSync(LOCK); } catch { /* gone */ } }; } catch { /* held */ }
    if (Date.now() > until) return null;
  }
}

// What the fresh Controller reads first. The old session's own files stay where they are; a copy of the ones that move on goes
// to restart/<stamp>/, so a restart never loses the state it started from.
function saveHandover({ stamp, kind, reason, oldHandle }) {
  const dir = file(`restart/${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["status.md", "handover.md", "inbox.md", "workers.json", "wave-handle.txt", "front-events.log"]) { try { fs.copyFileSync(file(name), path.join(dir, name)); } catch { /* not there */ } }
  try { fs.writeFileSync(path.join(dir, "journal-tail.ndjson"), readText("journal.ndjson").split("\n").slice(-100).join("\n")); } catch { /* none */ }
  const workers = Object.entries(readJson("workers.json", {})).map(([key, w]) => `- \`${key}\`: ${w.name ?? "worker"}, host ${w.host ?? "local"}, terminal ${w.terminal ?? "?"}, dispatch ${w.dispatch ?? "?"}`);
  writeText("restart.md", [
    `# Restart ${new Date().toISOString()}`, "",
    `You are a fresh Controller. The session before you was ended on purpose (${kind}): ${oneLine(reason, 300)}.`,
    `Its terminal was ${oldHandle ?? "not found"}; it is closed. Nothing else was touched: workers, a running wave, worktrees and branches carry on.`, "",
    "## What to read, in this order",
    "1. `handover.md`: what was in flight and queued (the previous Controller rewrites it before a restart it starts itself; after a hang nobody did).",
    `2. \`status.md\` as it was, and the last journal lines: copies are in \`restart/${stamp}/\` (\`status.md\`, \`journal-tail.ndjson\`, \`inbox.md\`, \`workers.json\`).`,
    "3. The worker mail: `orca orchestration inbox --limit 200 --json`. A worker that finished while no Controller ran has a `worker_done` there. Workers the previous session started may report to its mailbox: take every message whose `from` is a terminal or dispatch in `workers.json`, as an event of this cycle.", "",
    "## Workers recorded when the previous session ended", ...(workers.length ? workers : ["- none"]), "",
    "## Then",
    "- Check each worker above with `orca orchestration worker-show --dispatch <id>`; do not start a duplicate of a task that is running.",
    "- A wave that was running has its terminal in `wave-handle.txt`; `wavewait.mjs` tells its end. Do not start a second one.",
    "- Start `node wait.mjs` in the background again; the previous session's watcher died with it.",
    "- Run the cycle of \"The loop\", then move this file to `restart/" + stamp + "/restart-read.md`.", "",
  ].join("\n"));
  return dir;
}

/**
 * Restarts the Controller. kind: "context" (it asked for it), "hang" (the heartbeat), "manual". `lockHeld`: the caller is the
 * heartbeat, which holds the lock. Returns { ok, code, message, handle }. The old terminal is closed last, and only after the new
 * one exists and is recorded: a failure before that leaves the old Controller as it was.
 */
export function restartController({ reason, kind = "context", lockHeld = false, force = false, dry = false, tell = true } = {}) {
  const fail = (code, message) => ({ ok: false, code, message });
  const last = readJson("heartbeat.restarted.json", {});
  if (kind !== "hang" && !force && last.at && Date.now() - last.at < RESTART.minGapMinutes * 60_000)
    return fail(3, `refused: the Controller was restarted ${Math.round((Date.now() - last.at) / 60_000)} minutes ago (hosts.controller.restart.minGapMinutes is ${RESTART.minGapMinutes}). Carry on with this context and note it in status.md under "Problems".`);
  const release = lockHeld ? () => {} : takeLock();
  if (!release) return fail(1, "the heartbeat is running and did not finish within 45 seconds; run this again in a minute");
  let released = false;
  const unlock = () => { if (!released) { released = true; release(); } };
  try {
    const [recorded = "", recordedWorktree = ""] = readText("controller-terminal.txt").split("\n").map((l) => l.trim());
    const listed = orcaCall(["terminal", "list"])?.result?.terminals;
    if (!Array.isArray(listed)) return fail(1, "Orca's terminal list could not be read, so the Controller's terminal is not known; nothing was changed");
    const located = locateController(listed, { title, controllerDir: file("."), handle: recorded, dirs: controllerPlaces({ projectDir: PROJECT_DIR, controllerDir: file("."), recordedWorktree }) });
    const old = located.terminal;
    if (!old) return fail(1, "no terminal is recorded or named as the Controller (see `agentic-factory status`); nothing was changed. Run `agentic-factory start`.");
    if (process.env.ORCA_TERMINAL_HANDLE && kind === "context" && process.env.ORCA_TERMINAL_HANDLE !== old.handle) return fail(1, `this session (${process.env.ORCA_TERMINAL_HANDLE}) is not the recorded Controller terminal (${old.handle}); nothing was changed`);
    const worktree = [recordedWorktree, ...controllerPlaces({ projectDir: PROJECT_DIR, controllerDir: file(".") })].find((p) => p && fs.existsSync(p));
    if (!worktree) return fail(1, "the worktree the Controller was started in is gone; run `agentic-factory start`");
    const session = controllerSession({ dir: CONTROLLER_HOME, project: PROJECT, agent: config.agents?.default ?? "codex", args: config.agents?.controllerArgs });
    if (dry) return { ok: true, code: 0, message: `dry run: would save the handover, run \`orca ${createArgs({ where: ["--worktree", `path:${worktree}`], title, session }).join(" ")}\`, record the new handle and close ${old.handle}` };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    saveHandover({ stamp, kind, reason, oldHandle: old.handle });
    const created = spawnSync(ORCA, createArgs({ where: ["--worktree", `path:${worktree}`], title, session }), { encoding: "utf8", timeout: 60_000 });
    if (created.status !== 0 || !/"ok":\s*true/.test(created.stdout ?? "")) {
      journal("restart", "controller", { kind, reason, from: old.handle, failed: oneLine(created.stderr || created.stdout, 160) });
      return fail(1, `Orca could not create the new terminal (${oneLine(created.stderr || created.stdout, 160)}); the old Controller is still there`);
    }
    const handle = createdHandle(created.stdout);
    // The record is the Controller's identity (controller-terminal.mjs): the new handle from the create receipt, with its worktree.
    if (handle) writeText("controller-terminal.txt", `${handle}\n${worktree}\n`); else fs.rmSync(file("controller-terminal.txt"), { force: true });
    writeJson("heartbeat.restarted.json", { at: Date.now(), kind, reason: oneLine(reason, 200), from: old.handle, to: handle ?? null });
    for (const name of ["heartbeat.busy.json", "heartbeat.pointer"]) fs.rmSync(file(name), { force: true });
    journal("restart", "controller", { kind, reason: oneLine(reason, 200), from: old.handle, to: handle ?? null });
    // The heartbeat (tell: false) tells the Front agent itself, once its health file says so. A routine fresh start is only recorded.
    const event = `the Controller was restarted fresh (${kind}: ${oneLine(reason, 200)}); new terminal ${handle ?? "unknown"}, old ${old.handle} closed`;
    const told = tell ? tellFront("RESTARTED", event, { push: kind === "hang" }) : [];
    unlock();   // before the close: when the Controller runs this itself, closing its terminal ends this process
    const closed = spawnSync(ORCA, ["terminal", "close", "--terminal", old.handle, "--json"], { encoding: "utf8", timeout: 30_000 });
    if (closed.status !== 0) {
      journal("restart", "controller", { kind, note: "the old terminal could not be closed", terminal: old.handle });
      return { ok: true, code: 0, handle, event, message: `restarted; new terminal ${handle ?? "unknown"}, but the old one ${old.handle} could not be closed: close it by hand, two Controllers must not run`, closeFailed: old.handle };
    }
    return { ok: true, code: 0, handle, event, message: `restarted; new terminal ${handle ?? "unknown"}, ${old.handle} closed` };
  } finally { unlock(); }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--reason");
  const reason = at >= 0 ? process.argv[at + 1] : "";
  if (!reason || reason.startsWith("--")) { console.error('restart.mjs: say why: --reason "<why>"'); process.exit(2); }
  const result = restartController({ reason, kind: "context", force: process.argv.includes("--force"), dry: process.argv.includes("--dry") });
  console.log(result.message);
  process.exit(result.code);
}
