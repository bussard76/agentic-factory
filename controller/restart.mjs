// Restarts the Controller with a fresh context: saves what a new one needs, opens a new Controller terminal the way `agentic-factory
// start` does (the same command, exactly the configured agents.controllerArgs), records it, and closes the old terminal last.
// The Controller runs it itself when its context use is above hosts.controller.restart.contextPercent (CONTROLLER.md, "Starting fresh"),
// and the heartbeat runs the same code for a Controller that hangs, only where a project turned hosts.controller.hung.restart on.
// It touches no worker, wave, worktree or branch, and refuses (exit 3, nothing changed) while a wave runs, within
// hosts.controller.restart.afterGateMinutes of a gate or wave in the journal or of the project's remote branch moving, and, for a
// restart the Controller asks for, within restart.contextGapMinutes of the last one. Run by the Controller it needs its own terminal
// handle (ORCA_TERMINAL_HANDLE) and must be that terminal. --force is for a person: it skips the gap, the gate guard and the handle
// check, never the wave guard. Exit 0 restarted, 1 failed (the old Controller was left alone, or is named in the message), 3 refused.
// The new terminal is made with --keep-open where the installed Orca has it (read from `terminal create --help`) and without where
// it has not (1.4.266); the old terminal is closed only after the new one is confirmed in Orca's list.
// Usage: node restart.mjs --reason "<why>" [--dry] [--force]
import "./cli.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KEEP_OPEN_FROM, controllerPlaces, controllerSession, createArgs, createdHandle, locateController, orcaCreateSupport, refusedKeepOpen } from "./controller-terminal.mjs";
import { CONTROLLER_HOME, MAIN, ORCA, PROJECT, PROJECT_DIR, RESTART, config, file, journalQuiet, orcaCall, writeJson, writeText } from "./lib.mjs";
import { clearAlert, oneLine, raiseAlert, tellFront } from "./front-notice.mjs";

const LOCK = file("heartbeat.lock.d");
const LOCK_STALE_MS = 5 * 60_000;
const KEEP_RESTARTS = 10;
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

// A new terminal counts as live when Orca lists it, not orphaned; the list is polled because it can lag a moment behind a create.
const LIST_WAIT_MS = Number(process.env.FACTORY_RESTART_LIST_WAIT_MS) || 10_000;   // the variable is for tests
const terminalsNow = () => orcaCall(["terminal", "list"])?.result?.terminals;
function waitListed(handle) {
  for (const until = Date.now() + LIST_WAIT_MS; ; sleep(500)) {
    if (terminalsNow()?.some((t) => t.handle === handle && !t.orphaned)) return true;
    if (Date.now() > until) return false;
  }
}
// Closes a terminal this restart made and could not confirm, ONLY by a handle: the one Orca's answer to this run's own create named,
// or one restart.pending.json recorded from such an answer (needListed: and it is still listed). Never by title, and never a
// terminal that is the old or recorded Controller or the caller's own session (`protect`). Nothing is believed that cannot be
// shown: the close has to answer ok and the listing must not show the handle afterwards, else the result is "unconfirmed" (a hidden
// background terminal is not in the list, so only Orca's own "ok" counts for it).
// Returns { ok, closed, unconfirmed, skipped }: ok means closed and shown; anything else needs a person.
function discardStray({ handle, protect = [], needListed = false }) {
  const out = { ok: false, closed: [], unconfirmed: [], skipped: "" };
  if (typeof handle !== "string" || !handle) return { ...out, skipped: "no handle is known" };
  if (protect.includes(handle)) return { ...out, skipped: `${handle} is the Controller or the session that runs this` };
  const now = terminalsNow();
  const listedBefore = Array.isArray(now) && now.some((t) => t.handle === handle && !t.orphaned);
  if (needListed && !listedBefore) return { ...out, skipped: `${handle} is not listed` };
  const r = spawnSync(ORCA, ["terminal", "close", "--terminal", handle, "--json"], { encoding: "utf8", timeout: 30_000 });
  const answered = r.status === 0 && /"ok":\s*true/.test(r.stdout ?? "");
  const after = terminalsNow();
  const stillThere = !Array.isArray(after) || after.some((t) => t.handle === handle && !t.orphaned);
  if (answered && !stillThere) return { ...out, ok: true, closed: [handle] };
  return { ...out, unconfirmed: [handle] };
}

// A wave runs in its own terminal (wave-handle.txt: "<host> <handle>") and says WAVE-END when it is over: the same reading as the
// heartbeat's. A wave whose terminal cannot be read counts as running.
function waveRunning(listed) {
  const [, handle] = readText("wave-handle.txt").trim().split(" ");
  if (!handle?.startsWith("term_") || readText("heartbeat.wave") === handle) return false;
  if (!listed.some((t) => t.handle === handle)) return false;
  const read = orcaCall(["terminal", "read", "--terminal", handle])?.result ?? null;
  if (!read) return true;
  const tail = read.terminal?.tail ?? read.tail ?? read.lines ?? read.text ?? "";
  return !(Array.isArray(tail) ? tail : String(tail).split("\n")).some((line) => line.includes("WAVE-END") && !/echo WAVE-END/.test(line));
}
// Something the Controller started that a restart would cut off: a gate or a wave it journaled, or a push (the remote branch moved).
function recentGate() {
  const since = Date.now() - RESTART.afterGateMinutes * 60_000;
  for (const l of readText("journal.ndjson").split("\n").slice(-200)) {
    try { const e = JSON.parse(l); if ((e.type === "gate" || e.type === "wave") && Date.parse(e.ts) > since) return `a ${e.type} was journaled at ${e.ts}`; } catch { /* not a line */ }
  }
  const r = spawnSync("git", ["-C", PROJECT_DIR, "reflog", "-1", "--format=%ct", `refs/remotes/origin/${MAIN}`], { encoding: "utf8", timeout: 10_000 });
  if (r.status === 0 && Number(r.stdout.trim()) * 1000 > since) return `origin/${MAIN} moved at ${new Date(Number(r.stdout.trim()) * 1000).toISOString()}`;
  return "";
}

// What the fresh Controller reads first. The old session's own files stay where they are; a copy of the ones that move on goes
// to restart/<stamp>/, so a restart never loses the state it started from.
function saveHandover({ stamp, kind, reason, oldHandle }) {
  const dir = file(`restart/${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["status.md", "handover.md", "inbox.md", "workers.json", "wave-handle.txt", "front-events.log"]) { try { fs.copyFileSync(file(name), path.join(dir, name)); } catch { /* not there */ } }
  try { fs.writeFileSync(path.join(dir, "journal-tail.ndjson"), readText("journal.ndjson").split("\n").slice(-100).join("\n")); } catch { /* none */ }
  const workers = Object.entries(readJson("workers.json", {})).filter(([, w]) => w && typeof w === "object").map(([key, w]) => `- \`${key}\`: ${w.name ?? "worker"}, host ${w.host ?? "local"}, terminal ${w.terminal ?? "?"}, dispatch ${w.dispatch ?? "?"}`);
  const mtime = (n) => { try { return fs.statSync(file(n)).mtimeMs; } catch { return 0; } };
  const handoverAge = mtime("handover.md") ? `written ${new Date(mtime("handover.md")).toISOString()}${mtime("handover.md") < mtime("status.md") ? ", OLDER than status.md: treat it as stale and trust status.md, the journal and workers.json over it" : ""}` : "none";
  writeText("restart.md", [
    `# Restart ${new Date().toISOString()}`, "",
    `You are a fresh Controller. The session before you was ended on purpose (${kind}): ${oneLine(reason, 300)}.`,
    `Its terminal was ${oldHandle ?? "not found"}; it is closed. Nothing else was touched: workers, a running wave, worktrees and branches carry on.`, "",
    "## What to read, in this order",
    `1. \`handover.md\` (${handoverAge}): what was in flight and queued (a Controller that restarts itself rewrites it first; after a hang nobody did).`,
    `2. \`status.md\` as it was, and the last journal lines: copies are in \`restart/${stamp}/\` (\`status.md\`, \`journal-tail.ndjson\`, \`inbox.md\`, \`workers.json\`).`,
    "3. The worker mail: `orca orchestration inbox --limit 200 --json` (without `--terminal` it lists messages across recipients, so mail addressed to the previous session is in it; `--terminal " + (oldHandle ?? "<old handle>") + "` reads just that session's). A worker that finished while no Controller ran has a `worker_done` there: take every message whose `from` is a terminal or dispatch in `workers.json` as an event of this cycle.", "",
    "## Workers recorded when the previous session ended", ...(workers.length ? workers : ["- none"]), "",
    "## Then",
    "- Check each worker above with `orca orchestration worker-show --dispatch <id>`; do not start a duplicate of a task that is running.",
    "- A wave that was running has its terminal in `wave-handle.txt`; `wavewait.mjs` tells its end. Do not start a second one.",
    "- Start `node wait.mjs` in the background again; the previous session's watcher died with it.",
    "- Run the cycle of \"The loop\" and write `status.md` in it (nothing is typed into you before that), then move this file to `restart/" + stamp + "/restart-read.md`.", "",
  ].join("\n"));
  // Old copies are not kept forever.
  try { for (const old of fs.readdirSync(file("restart")).sort().slice(0, -KEEP_RESTARTS)) fs.rmSync(file(`restart/${old}`), { recursive: true, force: true }); } catch { /* none */ }
  return dir;
}

/**
 * Restarts the Controller. kind: "context" (it asked for it), "hang" (the heartbeat), "manual". `lockHeld`: the caller is the
 * heartbeat, which holds the lock. Returns { ok, code, message, handle, event, closeFailed }. The old terminal is closed last, and only
 * after the new one exists and is recorded: a failure before that leaves the old Controller as it was.
 */
export function restartController({ reason, kind = "context", lockHeld = false, force = false, dry = false, tell = true } = {}) {
  const fail = (code, message) => ({ ok: false, code, message });
  const last = readJson("heartbeat.restarted.json", {});
  const gap = (kind === "context" ? RESTART.contextGapMinutes : RESTART.minGapMinutes) * 60_000;
  if (kind !== "hang" && !force && last.at && Date.now() - last.at < gap)
    return fail(3, `refused: the Controller was restarted ${Math.round((Date.now() - last.at) / 60_000)} minutes ago (${kind === "context" ? "hosts.controller.restart.contextGapMinutes" : "hosts.controller.restart.minGapMinutes"} is ${Math.round(gap / 60_000)}). Carry on with this context and note it in status.md under "Problems".`);
  if (kind === "context" && !force && !process.env.ORCA_TERMINAL_HANDLE) return fail(1, "this has to run in the Controller's own terminal (ORCA_TERMINAL_HANDLE is not set); a person who means it can add --force");
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
    if (waveRunning(listed)) return fail(3, "refused: a wave is running (wave-handle.txt). Restart after its WAVE-END; the wave does not need a Controller, but the Controller that waits for it does");
    const gate = force ? "" : recentGate();
    if (gate) return fail(3, `refused: ${gate}, less than ${RESTART.afterGateMinutes} minutes ago (hosts.controller.restart.afterGateMinutes): a push or gate the Controller started would be cut off`);
    const worktree = [recordedWorktree, ...controllerPlaces({ projectDir: PROJECT_DIR, controllerDir: file(".") })].find((p) => p && fs.existsSync(p));
    if (!worktree) return fail(1, "the worktree the Controller was started in is gone; run `agentic-factory start`");
    const agent = config.agents?.default;
    if (!agent) return fail(1, "agents.default is not set in factory.config.json; nothing was changed");
    // --keep-open: a terminal made from a session Orca counts as a worker closes with it, and the old terminal is closed right after.
    // Not every Orca has the option (orcaCreateSupport reads `terminal create --help`, which changes nothing). On 1.4.266 it does
    // not exist; one observation there: a terminal made without it outlived the worker session that made it. So the terminal is made
    // without the option, from the Controller's own session too, unless hosts.controller.restart.withoutKeepOpen is false. That the
    // new terminal survives rests on the Orca version, not on an option: the heartbeat reports a restart that ends with no Controller.
    // Help that cannot be read: nothing is assumed, nothing is done.
    const support = orcaCreateSupport(ORCA);
    const installed = `the installed Orca${support.version ? ` ${support.version}` : ""}`;
    if (support.keepOpen === null) return fail(1, `${installed} did not say what \`orca terminal create\` accepts, so a restart is not safe; nothing was changed`);
    const keepOpen = support.keepOpen;
    if (!keepOpen && process.env.ORCA_TERMINAL_HANDLE && !RESTART.withoutKeepOpen)
      return fail(3, `refused: ${installed} has no \`terminal create --keep-open\` (it has from ${KEEP_OPEN_FROM}) and hosts.controller.restart.withoutKeepOpen is false, so a restart from the Controller's own session is not made. The running Controller was left alone; carry on with this context and note it in status.md under "Problems"`);
    const how = keepOpen ? "with --keep-open" : `without --keep-open (${installed} has no such option, from ${KEEP_OPEN_FROM} on it has; that the new terminal survives the end of this session rests on this Orca version's behaviour, observed once on 1.4.266, not on an option)`;
    // A terminal an earlier restart made and could not confirm or close again is removed before another is made.
    // Only by a handle an earlier create of ours returned, never by title; with no such handle a person decides.
    // A pending file that cannot be read blocks too (nobody can tell what it recorded), as the heartbeat's alert says: it reads as one without a handle.
    const pending = fs.existsSync(file("restart.pending.json")) ? (readJson("restart.pending.json", null) ?? {}) : null;
    if (pending && !dry) {
      const protect = [old.handle, recorded, process.env.ORCA_TERMINAL_HANDLE].filter(Boolean);
      const ph = typeof pending.handle === "string" ? pending.handle : "";
      if (!ph) return fail(1, `an earlier restart may have left a second Controller: Orca named no handle for the terminal it made, or the record cannot be read, so nothing is closed by guessing. Look in Orca for a second \`${title}\` terminal and close it if it is one, then delete ${file("restart.pending.json")}; nothing was changed`);
      // Not listed is no proof that it is gone (a hidden background terminal is not listed): the record stays, and so does the alert,
      // until Orca answers ok to the close of that handle and the list does not show it, or a person removes the file.
      if (protect.includes(ph)) { fs.rmSync(file("restart.pending.json"), { force: true }); clearAlert("RESTART-LEFTOVER"); }   // it became the Controller: nothing is closed
      else {
        const cleaned = discardStray({ handle: ph, protect });
        if (!cleaned.ok) return fail(1, `a terminal that an earlier restart made (${ph}) is not confirmed closed (${cleaned.unconfirmed.length ? "the close is unconfirmed: Orca did not answer ok, or the list still shows it" : cleaned.skipped}); no third one is made. Look in Orca for it and close it by hand, then delete ${file("restart.pending.json")}; nothing was changed`);
        fs.rmSync(file("restart.pending.json"), { force: true });
        clearAlert("RESTART-LEFTOVER");
      }
    }
    const session = controllerSession({ dir: CONTROLLER_HOME, project: PROJECT, agent, args: config.agents?.controllerArgs });
    const create = createArgs({ where: ["--worktree", `path:${worktree}`], title, session, keepOpen });
    if (dry) return { ok: true, code: 0, message: `dry run: would save the handover, run \`orca ${create.join(" ")}\` (${how}), record the new handle and close ${old.handle}` };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    saveHandover({ stamp, kind, reason, oldHandle: old.handle });
    const created = spawnSync(ORCA, create, { encoding: "utf8", timeout: 60_000 });
    if (created.status !== 0 || !/"ok":\s*true/.test(created.stdout ?? "")) {
      fs.rmSync(file("restart.md"), { force: true });   // the old Controller lives on: a stale file would mislead a later fresh start
      journalQuiet("restart", "controller", { kind, reason, from: old.handle, failed: oneLine(created.stderr || created.stdout, 160) });
      if (keepOpen && refusedKeepOpen(`${created.stderr}${created.stdout}`)) return fail(1, `${installed} refused --keep-open although its help names it; nothing was created and the old Controller is still there`);
      return fail(1, `Orca could not create the new terminal (${oneLine(created.stderr || created.stdout, 160)}); the old Controller is still there`);
    }
    const handle = createdHandle(created.stdout);
    // The old terminal is closed only once the new one is confirmed: Orca named its handle and LISTS it as live (polled for a few
    // seconds: a list can lag). An Orca that could not put the terminal on screen (1.4.266: surface "background", "could not make it
    // discoverable") lists it only after `terminal focus`, and a focus that exits 0 proves nothing until the listing shows it.
    // Unconfirmed: the terminal this run made is closed again (never two Controllers), the old one stays recorded, exit 1.
    writeJson("restart.pending.json", { handle: handle ?? null, before: listed.map((t) => t.handle), title, at: Date.now() });
    let live = false;
    if (handle) {
      if (/"surface":\s*"background"|terminal focus/.test(created.stdout)) {
        const f = spawnSync(ORCA, ["terminal", "focus", "--terminal", handle, "--json"], { encoding: "utf8", timeout: 30_000 });
        live = f.status === 0 && /"ok":\s*true/.test(f.stdout ?? "") && waitListed(handle);
      } else live = waitListed(handle);
    }
    if (!live) {
      const gone = discardStray({ handle, protect: [old.handle, recorded, process.env.ORCA_TERMINAL_HANDLE].filter(Boolean) });
      journalQuiet("restart", "controller", { kind, reason: oneLine(reason, 200), from: old.handle, to: handle ?? null, unconfirmed: true, discarded: gone.closed });
      fs.rmSync(file("restart.md"), { force: true });
      const what = handle ? `Orca created ${handle} but did not list it as live` : "Orca's answer carried no handle";
      if (gone.ok) { fs.rmSync(file("restart.pending.json"), { force: true }); clearAlert("RESTART-LEFTOVER"); }
      if (gone.ok) return fail(1, `${what}; the new terminal (${gone.closed.join(", ")}) was closed again (Orca answered ok and the list does not show it) and the old Controller ${old.handle} stays the recorded, running one. Nothing else changed; try again later`);
      const known = gone.unconfirmed.length ? `closing ${gone.unconfirmed.join(", ")} was tried and is UNCONFIRMED (Orca did not answer ok, or the list still shows it)` : `nothing was closed: ${gone.skipped}`;
      const alert = `POSSIBLE SECOND CONTROLLER: a restart created a terminal for the Controller that could not be confirmed${handle ? ` (${handle})` : ""} (${what}); ${known}. The old Controller ${old.handle} is still the recorded one. Look in Orca for a second \`${title}\` terminal and close it if it is one; the next restart makes none until this is settled`;
      raiseAlert("RESTART-LEFTOVER", alert, { kind: "TWO-CONTROLLERS" });
      return fail(1, alert);
    }
    fs.rmSync(file("restart.pending.json"), { force: true });
    clearAlert("RESTART-LEFTOVER");
    // The record is the Controller's identity (controller-terminal.mjs): the new handle from the create receipt, with its worktree.
    if (handle) writeText("controller-terminal.txt", `${handle}\n${worktree}\n`); else fs.rmSync(file("controller-terminal.txt"), { force: true });
    const state = { at: Date.now(), kind, reason: oneLine(reason, 200), from: old.handle, to: handle };
    writeJson("heartbeat.restarted.json", state);
    // The old session's own word is not the new Controller's: its waiting marker and the record of the mail it read are removed now
    // that the new one is confirmed (the heartbeat also distrusts a marker older than controller-terminal.txt).
    for (const name of ["heartbeat.busy.json", "heartbeat.pointer", "controller.waiting.json", "mail.read.json"]) fs.rmSync(file(name), { force: true });
    unlock();   // before the close: when the Controller runs this itself, closing its terminal ends this process
    spawnSync(ORCA, ["terminal", "close", "--terminal", old.handle, "--json"], { encoding: "utf8", timeout: 30_000 });
    // Proof, not the exit status: is the old terminal gone from Orca's list?
    const still = orcaCall(["terminal", "list"])?.result?.terminals;
    const closeFailed = !Array.isArray(still) || still.some((t) => t.handle === old.handle && !t.orphaned);
    const event = closeFailed
      ? `the Controller was restarted fresh (${kind}: ${oneLine(reason, 200)}); new terminal ${handle ?? "unknown"}, but the old terminal ${old.handle} could NOT be closed: two Controllers may be running, close ${old.handle} by hand`
      : `the Controller was restarted fresh (${kind}: ${oneLine(reason, 200)}); new terminal ${handle ?? "unknown"}, old ${old.handle} closed`;
    if (closeFailed) writeJson("heartbeat.restarted.json", { ...state, closeFailed: old.handle });
    journalQuiet("restart", "controller", { kind, reason: oneLine(reason, 200), from: old.handle, to: handle ?? null, keepOpen, ...(closeFailed ? { closeFailed: old.handle } : {}) });
    // The heartbeat (tell: false) tells the Front agent itself, once its health file says so. A routine fresh start is only recorded;
    // two Controllers are always an alert.
    const told = closeFailed ? tellFront("TWO-CONTROLLERS", event, { type: "question" }) : tell ? tellFront("RESTARTED", event, { push: kind === "hang" }) : [];
    return closeFailed
      ? { ok: true, code: 0, handle, event, closeFailed: old.handle, message: `restarted (${how}), but the old terminal ${old.handle} is still open (${told.join(", ")}): close it by hand, two Controllers must not run` }
      : { ok: true, code: 0, handle, event, message: `restarted; new terminal ${handle ?? "unknown"} created ${how}, ${old.handle} closed; the old session's controller.waiting.json and mail.read.json were removed` };
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
