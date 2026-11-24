// Wakes this directory's Controller from outside, so noticing finished work does not depend on the Controller itself
// (docs/learnings.md). `agentic-factory start` runs it from cron or launchd every minute. A worker message, a finished wave
// and a new inbox line wake it at once; the full work check runs at each tenth minute; an idle project is woken at most every
// hosts.controller.wake.idleMinutes. It marks progress in Orca's sidebar without a model.
// It sends text into the Controller's terminal. Whether the Controller is idle is Orca's answer, or the Controller's own word: the
// marker `cycle.mjs end` writes when it ends a cycle (see trustedWaiting below). A Controller that Orca reads as busy gets a pointer
// for every reason that would wake an idle one, again after wake.repeatMinutes if it was not answered. A Controller that is busy without any sign of work (status.md and the journal
// unchanged) for hosts.controller.hung.minutes is reported to the Front agent. Only where a project set hosts.controller.hung.restart
// to true, and after a second confirmation, it is restarted once through restart.mjs (the same session `start` makes); a second
// hang is escalated and never restarted automatically. Each Controller directory has its own
// copy and state, so projects on one host stay independent. Usage: node heartbeat.mjs
import "./cli.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { controllerPlaces, locateController } from "./controller-terminal.mjs";
import { HOSTS, HUMAN, HUNG, MAIN, ORCA, PROJECT, PROJECT_DIR, STEERING, WAKE, config, dispatchStates, file, hostNamed, journalQuiet, orcaCall, orcaEnvArgsOn, workerStatus, worktreeRefOn, workspacesOn } from "./lib.mjs";
import { alertLines, clearAlert, ensureAlert, raiseAlert, tellFront, writeHealth } from "./front-notice.mjs";
import { newLines } from "./inbox.mjs";
import { restartController } from "./restart.mjs";

const IDLE_WAIT_MS = 15_000;
const LOG_LIMIT = 1 << 20;
const MESSAGE = "Heartbeat: run the next cycle of \"The loop\" in CONTROLLER.md now, then stop and wait for the next heartbeat.";
// Nothing a worker or a message wrote is ever typed into the Controller's terminal: the lines above and the one below are
// fixed text plus a count this script made. The Controller reads the mail itself (step 1 of its loop). What a terminal's
// title says goes only into the sidebar comment, on one line.
const oneLine = (text, n) => String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, n);
const POINTER = "Heartbeat: inbox.md has a new instruction. Read it after your current step.";
// Typed once when a hang is first reported: a Controller that sits at its prompt (Orca may misread it as busy) runs a cycle and writes
// status.md, which ends the hang; one that really hangs does not.
const POINTER_HUNG = "Heartbeat: you have shown no sign of work for a while. Run step 1 of \"The loop\" in CONTROLLER.md after your current step, and write status.md.";
const POINTER_WORK = "Heartbeat: ready tickets or running workers are waiting. Run the next cycle of \"The loop\" in CONTROLLER.md after your current step.";
const POINTER_MAIL ="Heartbeat: something new is waiting (inbox.md, worker mail or a finished wave). Run step 1 of \"The loop\" in CONTROLLER.md after your current step.";
const title = `${PROJECT} · Controller`;

const LOCK = file("heartbeat.lock.d");
const LOCK_STALE_MS = 5 * 60_000;
const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
const orca = (...args) => JSON.parse(run(ORCA, [...args, "--json"]));
// Unreadable, or the wrong kind of value (null, an array for an object): the fallback.
const readJson = (name, fallback) => {
  try { const v = JSON.parse(fs.readFileSync(file(name), "utf8")); if (fallback === null || (Array.isArray(fallback) ? Array.isArray(v) : v !== null && typeof v === "object" && !Array.isArray(v))) return v; } catch { /* fallback */ }
  return fallback;
};
const readText = (name) => { try { return fs.readFileSync(file(name), "utf8"); } catch { return ""; } };
const mtime = (name) => { try { return fs.statSync(file(name)).mtimeMs; } catch { return 0; } };
const short = (error) => String(error.message).slice(0, 160);

// cron starts this every minute, and a slow Orca can take longer than that. mkdir is atomic and needs no flock, which macOS lacks.
try { if (Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS) fs.rmdirSync(LOCK); } catch { /* no lock */ }
try { fs.mkdirSync(LOCK); } catch { process.exit(0); }
process.on("exit", () => { try { fs.rmdirSync(LOCK); } catch { /* already gone */ } });
try { if (fs.statSync(file("heartbeat.log")).size > LOG_LIMIT) fs.renameSync(file("heartbeat.log"), file("heartbeat.log.1")); } catch { /* no log yet */ }
// Proof for `doctor` and `status` (a quiet beat writes no log line): heartbeat.alive says a run started, heartbeat.ok that one
// got through, so a job that never ran, or crashes after it started, is told from one that works. A run that could not reach
// Orca's terminal list is no success.
let reached = true;
try { fs.writeFileSync(file("heartbeat.alive"), ""); } catch { /* read-only directory: the beat still works */ }
process.on("exit", (code) => { if (code === 0 && reached) try { fs.writeFileSync(file("heartbeat.ok"), ""); } catch { /* as above */ } });

const steering = (...args) => JSON.parse(run("node", [file(`steering/${STEERING === "github-issues" ? "issues" : "tasks"}.mjs`), ...args]));
const readyTickets = () => (STEERING === "github-issues" ? steering("ready") : steering("list", "ready"));
const startedTickets = () => (STEERING === "github-issues"
  ? JSON.parse(run("gh", ["issue", "list", "--label", config.steering?.inProgressLabel ?? "in-progress", "--state", "open", "--json", "number"], PROJECT_DIR)).map((i) => `#${i.number}`)
  : steering("list", "building").map((t) => t.id));

// An unreadable source counts as work: a false wake costs one cycle, a missed one stalls the project.
let newlySettled = [];
// An inbox line counts when the Controller has not handled it (inbox.mjs): a line it already handled, and left in inbox.md, wakes nobody.
const inboxHasNew = () => newLines() > 0;
const pendingWork = () => {
  const reasons = [];
  if (inboxHasNew()) reasons.push("inbox");
  // Running workers are work. A finished worker's record waits for cleanup: a worker that settled without a worker_done
  // message wakes the Controller once, when it is first seen settled, and not again at every tenth minute.
  try {
    const { running, unknown, settled } = workerCounts(JSON.parse(fs.readFileSync(file("workers.json"), "utf8")));
    if (running) reasons.push("workers");
    else if (unknown) reasons.push("workers unreadable");
    const told = new Set(readJson("heartbeat.settled.json", []));
    // A worker that sent worker_done already woke the Controller with it; only a silent settle needs this wake.
    const reported = new Set(messages.filter((m) => m.type === "worker_done").map((m) => m.from));
    newlySettled = settled.filter((s) => s?.dispatch && !told.has(s.dispatch) && !reported.has(s.dispatch) && !reported.has(s.terminal)).map((s) => s.dispatch);
    if (newlySettled.length) reasons.push(`${newlySettled.length} workers settled`);
  } catch (error) { if (error.code !== "ENOENT") reasons.push("workers unreadable"); }
  try {
    const ready = readyTickets();
    if (ready.length) reasons.push(`${ready.length} ready`);
  } catch { reasons.push("tickets unreadable"); }
  return reasons;
};

const terminalsByHost = {};
for (const host of HOSTS) {
  try { terminalsByHost[host.name] = orca("terminal", "list", ...orcaEnvArgsOn(host)).result.terminals; }
  catch (error) { terminalsByHost[host.name] = null; reached = false; log(`terminal list failed on ${host.name}: ${short(error)}`); }
}
// Running and unknown workers in a workers.json object, and the dispatches of settled ones not kept open, from Orca's
// dispatch state (lib.mjs workerStatus). Orca is asked at most once per run, and for the sidebar at most every 10 minutes:
// the counts are cached in heartbeat.workers.json. `fresh` (the full check) always asks.
const COUNT_CACHE_MS = 10 * 60_000;
// FACTORY_MINUTE (0-59) replaces the wall clock's minute, but only inside the test support environment (test/support/safe-env.mjs sets
// AF_TEST_SAFE_BIN): a stray FACTORY_MINUTE in a cron or launchd environment is ignored, so no test depends on the minute it runs in
// and production always reads the clock.
const minuteNow = process.env.AF_TEST_SAFE_BIN && /^\d{1,2}$/.test(process.env.FACTORY_MINUTE ?? "") ? Number(process.env.FACTORY_MINUTE) : new Date().getMinutes();
const fullCheck = minuteNow % 10 === 0;
let counted;
const workerCounts = (records, fresh = fullCheck) => {
  if (counted) return counted;
  if (!fresh) {
    // The cache is valid for 10 minutes, and only while workers.json has not changed since it was written.
    try {
      const at = fs.statSync(file("heartbeat.workers.json")).mtimeMs, changed = fs.statSync(file("workers.json")).mtimeMs;
      const cached = Date.now() - at < COUNT_CACHE_MS && changed <= at ? readJson("heartbeat.workers.json", null) : null;
      if (cached && typeof cached === "object" && Number.isFinite(cached.running) && Number.isFinite(cached.unknown) && Array.isArray(cached.settled)) return (counted = cached);
    } catch { /* no cache or no workers.json */ }
  }
  counted = { running: 0, unknown: 0, settled: [] };
  const byHost = Object.groupBy(Object.values(records), (w) => w.host ?? "local");
  for (const [hostName, list] of Object.entries(byHost)) {
    let host;
    try { host = hostNamed(hostName); } catch { counted.unknown += list.length; continue; }
    const listed = terminalsByHost[host.name] ? new Set(terminalsByHost[host.name].map((t) => t.handle)) : null;
    const dispatches = list.some((w) => w.dispatch) ? dispatchStates(list.map((w) => w.dispatch), host) : {};
    for (const w of list) {
      const status = workerStatus(w, { dispatches, terminals: listed, pidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } } });
      if (status !== "finished") counted[status]++;
      else if (w.dispatch) counted.settled.push({ dispatch: w.dispatch, terminal: w.terminal });
    }
  }
  fs.writeFileSync(file("heartbeat.workers.json"), JSON.stringify(counted));
  return counted;
};
// Who is the Controller is settled by how it was made (controller-terminal.mjs): the handle `start` recorded from its own
// `terminal create`, else a terminal that carries the Controller's name. An unnamed agent session, even the only one in the
// project's checkout, is never taken (it may be a person's, or the Front agent's), and a record is never made here. A record
// that is gone, orphaned or in another worktree is dropped. Unknown, unconfirmed or ambiguous means no wake.
const controllerTerminals = terminalsByHost[config.hosts?.controller?.host ?? "local"];
const [recorded = "", recordedWorktree = ""] = readText("controller-terminal.txt").split("\n").map((l) => l.trim());
const located = locateController(controllerTerminals, { title, controllerDir: file("."), handle: recorded, dirs: controllerPlaces({ projectDir: PROJECT_DIR, controllerDir: file("."), recordedWorktree }) });
const terminal = located.terminal;
if (controllerTerminals !== null && recorded && located.record === "invalid") { try { fs.rmSync(file("controller-terminal.txt"), { force: true }); log(`dropped the recorded terminal ${recorded}: it is gone, orphaned, or not in this project`); } catch { /* retried next beat */ } }

// A wave runs in its own terminal, is no worker and sends no message, so its end has to be read from the terminal.
const readWave = () => {
  const [hostName, handle] = readText("wave-handle.txt").trim().split(" ");
  if (!handle?.startsWith("term_") || readText("heartbeat.wave") === handle) return { state: "none" };
  let host;
  try { host = hostNamed(hostName); } catch { return { state: "none" }; }
  if (terminalsByHost[host.name] === null) return { state: "running", handle };
  if (!terminalsByHost[host.name].some((t) => t.handle === handle)) return { state: "finished", handle, result: "terminal gone" };
  try {
    const read = orca("terminal", "read", "--terminal", handle, ...orcaEnvArgsOn(host)).result ?? {};
    const tail = read.terminal?.tail ?? read.tail ?? read.lines ?? read.text ?? "";
    const lines = Array.isArray(tail) ? tail : String(tail).split("\n");
    if (!lines.some((line) => line.includes("WAVE-END") && !/echo WAVE-END/.test(line))) return { state: "running", handle };
    return { state: "finished", handle, result: lines.some((line) => line.includes(`PUSHED ${MAIN}`)) ? `pushed to ${MAIN}` : "not pushed" };
  } catch { return { state: "running", handle }; }
};
const wave = readWave();

// `## Needs <human>` lists what waits for the human. "- none" and an empty section mean nothing does.
const needsHuman = () => {
  const section = readText("status.md").split(/^## /m).find((part) => part.startsWith(`Needs ${HUMAN}`)) ?? "";
  return section.split("\n").slice(1).filter((line) => line.startsWith("- ") && !/^- (none|keine)\b/i.test(line));
};

const de = config.project?.language === "de";
const say = (en, german) => (de ? german : en);

// Tells the human in Orca's sidebar what the Controller is doing. Runs without a model, so it cannot be forgotten.
const showNotice = (text, status, unread) => {
  if (readText("heartbeat.notice") === text) return;
  run(ORCA, ["worktree", "set", "--worktree", `path:${PROJECT_DIR}`, "--comment", text, "--workspace-status", status, ...(unread ? ["--unread"] : []), "--json"]);
  fs.writeFileSync(file("heartbeat.notice"), text);
  log(`notice: ${text}`);
};
const updateNotice = () => {
  const restartedAt = readJson("heartbeat.restarted.json", {}).at ?? 0;
  if (restartedAt && mtime("status.md") <= restartedAt) return showNotice(say("Controller restarted, it has not started a cycle yet", "Controller neu gestartet, hat noch keinen Zyklus begonnen"), "in-review", false);
  const open = needsHuman();
  if (inboxHasNew()) return showNotice(say("Working: instruction from the inbox", "Arbeitet: Auftrag aus der Inbox"), "in-progress", false);
  if (open.length) return showNotice(`${say("Waiting for you", "Wartet auf dich")}: ${open[0].slice(2, 200)}`, "in-review", true);
  const { running, unknown } = workerCounts(readJson("workers.json", {}));
  const active = running + unknown;
  if (wave.state === "running") return showNotice(say(`Working: wave running, ${active} workers`, `Arbeitet: Wave läuft, ${active} Worker`), "in-progress", false);
  if (wave.state === "finished") return showNotice(say(`Working: wave finished (${wave.result}), waking the Controller`, `Arbeitet: Wave fertig (${wave.result}), Controller wird geweckt`), "in-progress", true);
  const ready = readyTickets().length;
  if (active || ready) return showNotice(say(`Working: ${active} workers, ${ready} ready tickets`, `Arbeitet: ${active} Worker, ${ready} freigegebene Tickets`), "in-progress", false);
  const started = startedTickets();
  if (started.length) return showNotice(say(`Stalled, nobody is acting: no workers, but in progress: ${started.join(", ")}`, `Steht still, niemand handelt: keine Worker, aber in Arbeit: ${started.join(", ")}`), "in-review", true);
  showNotice(say("Nothing left to do: no workers, no ready tickets, no open question", "Nichts mehr zu tun: keine Worker, keine freigegebenen Tickets, keine offene Frage"), "completed", true);
};
try {
  // A terminal list that failed says nothing about the Controller: no "not running" comment from that.
  if (!terminal && controllerTerminals === null) log("controller terminal unknown: the terminal list failed");
  else if (!terminal && located.ambiguous.length) showNotice(say(`${located.ambiguous.length} terminals in this project look like the Controller and none is recorded, so nothing is woken: close the extra ones or run \`agentic-factory start\``, `${located.ambiguous.length} Terminals dieses Projekts kommen als Controller in Frage und keiner ist vermerkt, daher wird keiner geweckt: überzählige schließen oder \`agentic-factory start\` ausführen`), "in-review", true);
  else if (!terminal && located.unconfirmed.length) showNotice(say(`A terminal named "${oneLine(located.unconfirmed[0].title ?? located.unconfirmed[0].paneTitle, 60)}" may be the Controller, but Orca does not show an agent running in this project there, so nothing is woken`, `Ein Terminal "${oneLine(located.unconfirmed[0].title ?? located.unconfirmed[0].paneTitle, 60)}" könnte der Controller sein, aber Orca zeigt dort keinen Agenten in diesem Projekt, daher wird nichts geweckt`), "in-review", true);
  else if (!terminal) showNotice(say(`Controller is not running: run \`agentic-factory start\`${located.unnamed.length ? ` (${located.unnamed.length} other agent session${located.unnamed.length > 1 ? "s run" : " runs"} in this project's checkout, but none is named or recorded as the Controller, so none is woken)` : ""}`, `Controller läuft nicht: bitte \`agentic-factory start\` ausführen${located.unnamed.length ? ` (${located.unnamed.length} andere Agent-Sitzung(en) laufen im Checkout des Projekts, aber keine trägt den Namen des Controllers oder ist als solcher vermerkt, daher wird keine geweckt)` : ""}`), "in-review", true);
  else updateNotice();
} catch (error) { log(`notice failed: ${short(error)}`); } // A display problem must not stop the wake below.
// A restart that ended with no live Controller (the new terminal died with the old one, or never was listed) is told to the Front
// agent once: without this nothing but the sidebar comment says so, and nothing is woken.
// It goes to the health file too (kept until a Controller runs again), so a Front agent that reads only that file sees it. The
// template has no way to stop a Controller on purpose (hosts.controller.heartbeat: false only stops this heartbeat from running),
// so the text says what to do if it was stopped by hand.
if (terminal) clearAlert("NO-CONTROLLER");
// RESTART-LEFTOVER follows the file itself, every run, not what was remembered: restart.pending.json present means a terminal a
// restart made is not confirmed closed (a crash, a lost or corrupt alerts file and a hand-made file all end up here too).
if (!fs.existsSync(file("restart.pending.json"))) clearAlert("RESTART-LEFTOVER");
else if (Date.now() - (Number(readJson("restart.pending.json", {}).at) || 0) > 120_000) {   // a younger one may be a restart in progress
  const pend = readJson("restart.pending.json", {});
  const ph = typeof pend.handle === "string" && pend.handle ? pend.handle : "";
  ensureAlert("RESTART-LEFTOVER", `POSSIBLE SECOND CONTROLLER: restart.pending.json is present: a restart made a terminal for the Controller (${ph || "no handle known"}) that is not confirmed closed, and no restart is made until it is settled. Look in Orca for a second \`${title}\` terminal and close it if it is one, then delete ${file("restart.pending.json")}`, { kind: "TWO-CONTROLLERS" });
}
if (!terminal && controllerTerminals !== null) {
  const rs = readJson("heartbeat.restarted.json", {});
  if (rs.to && !rs.noControllerTold && !controllerTerminals.some((t) => t.handle === rs.to && !t.orphaned)) {
    try { fs.writeFileSync(file("heartbeat.restarted.json"), JSON.stringify({ ...rs, noControllerTold: true }, null, 2)); } catch { /* told again next run */ }
    log(`told the Front agent (NO-CONTROLLER): ${raiseAlert("NO-CONTROLLER", `NO CONTROLLER: the Controller restarted at ${new Date(rs.at ?? 0).toTimeString().slice(0, 5)} (${rs.kind ?? "restart"}) is no longer running: its terminal ${rs.to} is gone and no other terminal is the Controller, so nothing is woken. Run \`agentic-factory start\`. If you stopped it on purpose, ignore this: the line goes away when a Controller runs again`, { type: "question" }).join(", ")}`);
  }
}
if (!terminal) { log(located.ambiguous.length ? `${located.ambiguous.length} confirmed terminals (${located.ambiguous.map((t) => t.handle).join(", ")}), none recorded: nothing woken` : located.unconfirmed.length ? `${located.unconfirmed.length} terminal(s) named like the Controller, but not confirmed as an agent running in this project: nothing woken` : `no terminal recorded or named as the Controller, nothing woken; ${located.unnamed.length} other agent session(s) in the checkout are never taken (titled "${title}" or "π - …/${path.basename(file("."))}" preferred), nothing woken`); process.exit(0); }

// Every minute: react to a worker's message at once. A message stays unseen until a wake succeeded.
// Workers are remembered: a Controller cycle may drop a worker from workers.json before its message was counted.
const known = readJson("heartbeat.known.json", {});
for (const w of Object.values(readJson("workers.json", {})))
  for (const id of [w.terminal, w.dispatch].filter(Boolean)) known[id] = { name: w.name, host: w.host, dir: w.worktree ? path.basename(w.worktree) : undefined };
fs.writeFileSync(file("heartbeat.known.json"), JSON.stringify(known));
const messages = orca("orchestration", "inbox", "--limit", "200").result.messages.filter((m) => m.type !== "status" && known[m.from]);
const events = messages.map((m) => m.id);

// Marks a finished worker for the human at once, also while the Controller is busy. Each one is announced only once.
const announced = new Set(readJson("heartbeat.announced.json", []));
// A worker's worktree may be removed by cleanup before this runs: that is not a failure, so it is skipped when the directory is
// gone and, for a host whose directory cannot be looked at from here, a "not found" answer from Orca is not logged.
const GONE = /not.?found|no such|does not exist|unknown worktree|no worktree/i;
const mark = (args, quietWhenGone = false) => {
  try { run(ORCA, ["worktree", "set", ...args, "--unread", "--json"]); }
  catch (error) { if (!(quietWhenGone && GONE.test(`${error.stderr ?? ""} ${error.stdout ?? ""} ${error.message}`))) log(`marking failed: ${short(error)}`); }
};
const announce = (id, line, worker) => {
  announced.add(id);
  fs.writeFileSync(file("heartbeat.announced.json"), JSON.stringify([...announced].slice(-500)));
  log(line);
  if (worker?.dir && worker.host) {
    try {
      const host = hostNamed(worker.host);
      if (host.kind !== "local" || fs.existsSync(path.join(workspacesOn(host), worker.dir))) mark(["--worktree", worktreeRefOn(host, worker.dir), "--workspace-status", "completed", ...orcaEnvArgsOn(host)], true);
    } catch (error) { log(`marking failed: ${short(error)}`); }
  }
  mark(["--worktree", `path:${PROJECT_DIR}`]);
};
const seenExisted = fs.existsSync(file("heartbeat.seen.json"));
const seen = new Set(readJson("heartbeat.seen.json", []));
for (const m of messages) {
  if (m.type !== "worker_done" || announced.has(m.id)) continue;
  if (!seenExisted || seen.has(m.id)) { announced.add(m.id); continue; } // Finished before this run: no new signal.
  announce(m.id, `worker done: ${known[m.from].name}: ${String(m.subject ?? "").slice(0, 120)}`, known[m.from]);
}
if (wave.state === "finished" && !announced.has(wave.handle)) announce(wave.handle, `wave finished: ${wave.result}`);
// Mail the Controller has handled (cycle.mjs start records what it printed and read in step 1) is no reason: the Controller cannot
// consume Orca mail itself, so without this a message it had read stayed "new" until the next wake succeeded.
const handledMail = new Set(readJson("mail.handled.json", []));
const fresh = events.filter((id) => !seen.has(id) && !handledMail.has(id));
const remember = () => fs.writeFileSync(file("heartbeat.seen.json"), JSON.stringify([...seen, ...fresh].slice(-500)));
if (!seenExisted) { remember(); log("baseline of worker messages recorded"); process.exit(0); } // Old messages wake nobody.

const inboxWaiting = inboxHasNew();
const mtimeOf = mtime;
const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);

// Is the Controller idle? Orca's answer to `terminal wait --for tui-idle`, asked at most once per run and only when something needs
// it. Orca exits non-zero when the wait is not satisfied and says why in its answer: orcaCall reads it even then, and it goes to the
// log. Whether a session that sits at its prompt with a background shell running reads as idle is Orca's decision, and in a real
// run it did not (docs/orca.md, "Heartbeat"); the pointer further down is the answer to that, not a guess at the screen.
let idleAnswer;
const probeIdle = () => (idleAnswer ??= (() => {
  const r = orcaCall(["terminal", "wait", "--terminal", terminal.handle, "--for", "tui-idle", "--timeout-ms", String(IDLE_WAIT_MS)]);
  const idle = r?.result?.wait?.satisfied === true;
  return { idle, why: idle ? "" : oneLine(r?.error?.code ?? r?.result?.wait?.status ?? (r ? "not idle" : "no answer"), 60) };
})());
// Since when has the Controller been busy without a break? A reading older than 3 minutes proves nothing about the time before it.
const noteBusy = (idle) => {
  if (idle) { fs.rmSync(file("heartbeat.busy.json"), { force: true }); return Date.now(); }
  const b = readJson("heartbeat.busy.json", {}), now = Date.now();
  const since = b.since && b.last && now - b.last < 3 * 60_000 ? b.since : now;
  fs.writeFileSync(file("heartbeat.busy.json"), JSON.stringify({ since, last: now }));
  return since;
};
const compile = (list, what, flags = "i") => list.flatMap((p) => { try { return [new RegExp(p, flags)]; } catch { log(`ignored a ${what} entry that is no regular expression: ${oneLine(p, 60)}`); return []; } });
const readScreen = () => {
  try {
    const read = orca("terminal", "read", "--terminal", terminal.handle, "--screen").result ?? {};
    const tail = read.terminal?.tail ?? read.tail ?? read.lines ?? read.text ?? "";
    return Array.isArray(tail) ? tail.join("\n") : String(tail);
  } catch { return null; }
};
// A fixed line plus Enter is never typed where a confirmation question is visible (Enter would take its default). The patterns are
// generic and configurable (hosts.controller.wake.dialogPatterns); a question they do not recognise is the residual risk.
// Only the last 8 lines are looked at (where a prompt sits), per line (flag m). A match delays the pointer by at most
// wake.dialogHoldMinutes (see below); it never suppresses it for good.
const dialogRegexes = compile(WAKE.dialogPatterns, "hosts.controller.wake.dialogPatterns", "im");
const dialogVisible = (screen) => screen !== null && dialogRegexes.some((re) => re.test(screen.split("\n").slice(-8).join("\n")));
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---- A Controller that hangs. Hung is: busy, its terminal still changing, and no sign of work (status.md and the journal
// unchanged; the heartbeat's own journal lines do not count) for hosts.controller.hung.minutes; or a text pattern the project
// configured visible for hung.patternMinutes. A terminal that does not change (an idle prompt that Orca reads as busy because of a
// background shell) is not hung. The Front agent is told at once, and one fixed line asks the Controller for a cycle. The report
// stays until a sign of work (status.md or the journal newer than the report), whatever the screen does. Restarting is off unless a
// project sets hung.restart to true, and then needs more (see below); a second hang is only escalated. The heartbeat never writes status.md.
const HUNG_FILE = "heartbeat.hung.json", SCREEN_ACTIVE_MS = 3 * 60_000, YOUNG_MS = 5 * 60_000;
const patternRegexes = compile(HUNG.patterns, "hosts.controller.hung.patterns");
// Only the change of the screen is used, never its words (except the configured patterns). A reading older than 3 minutes says
// nothing about what happened since (a laptop that slept would look like a changing screen).
const screenChanging = (text) => {
  const prev = readJson("heartbeat.screen.json", {}), now = Date.now();
  const hash = createHash("sha1").update(text).digest("hex");
  const fresh = prev.readAt && now - prev.readAt < SCREEN_ACTIVE_MS;
  const next = { hash, readAt: now, changedAt: fresh && prev.hash !== hash ? now : fresh ? prev.changedAt ?? null : null };
  fs.writeFileSync(file("heartbeat.screen.json"), JSON.stringify(next));
  return next.changedAt !== null && now - next.changedAt <= SCREEN_ACTIVE_MS;
};
// The same frame: counters, timers and spinner glyphs do not make a different one.
// Digits (counters, clocks, timers), braille, arrows, box and geometric shapes, dingbats and a lone |/\- (spinner frames) do not count.
const frame = (text) => String(text).replace(/\d+/g, "#").replace(/[⠀-⣿←-⇿▀-◿☀-➿]/g, "*").replace(/(^|[\s*])[|/\\-](?=[\s*]|$)/g, "$1*").replace(/\s+/g, " ").trim();
const hungText = (n) => {
  if (n.escalated) return `HUNG AGAIN since ${hhmm(n.since)} (${n.why}) after the automatic restart at ${hhmm(n.restartedAt)}: it is not restarted again and needs a person: close the Controller's terminal and run agentic-factory start`;
  const what = n.restartFailed ? `the automatic restart failed (${n.restartFailed})`
    : n.hangRestarts >= 1 ? `it was restarted automatically at ${hhmm(n.restartedAt)} already, so it is not restarted again`
      : n.kind === "pattern" ? "a text pattern only reports, it never restarts"
        : !HUNG.restart ? "automatic restart is off (hosts.controller.hung.restart is not true): report only"
          : n.declined ? `automatic restart waits: ${n.declined}`
            : `it is restarted at ${hhmm(n.since + HUNG.restartAfterMinutes * 60_000)} unless it recovers, if its terminal then shows the same frame twice`;
  return `HUNG since ${hhmm(n.since)}: ${n.why}${n.pointerAt ? "" : " (the pointer line was not typed)"}; ${what}`;
};
// A Controller that marked itself waiting, was woken the allowed number of times for a state and did not start a cycle (it ignores
// wakes: a screen that eats typed lines, a usage-limit screen). It is reported once to the Front agent (below, where the cap is hit) and
// stays a line in heartbeat-health.md until it reacts: a new marker (it ended another cycle) or a status.md written after the marker.
const unansweredLine = () => {
  const u = readJson("heartbeat.unanswered.json", {});
  if (!u.markerAt) return null;
  const at = Number(readJson("controller.waiting.json", {}).at);
  if (at !== u.markerAt || mtime("status.md") > at + 2000) { fs.rmSync(file("heartbeat.unanswered.json"), { force: true }); return null; }
  return `UNANSWERED since ${hhmm(u.since)}: the Controller marked itself waiting at ${hhmm(at)}, was woken ${u.n} times for ${u.what} and did not start a cycle; a new reason is still typed, the same one is not repeated: it needs a person`;
};
// Returns true when it restarted the Controller: the terminal this run holds is then the old one.
const hangCheck = () => {
  if (!fs.existsSync(file("status.md"))) return false;   // it has not started its first cycle
  const now = Date.now(), state = readJson(HUNG_FILE, {}), rs = readJson("heartbeat.restarted.json", {}), restartAt = rs.at ?? 0;
  const activity = Math.max(mtime("status.md"), mtime("journal.ndjson"), restartAt);   // a fresh Controller gets its time
  const quietMin = (now - activity) / 60_000;
  const next = { hangRestarts: state.hangRestarts ?? 0, restartedAt: state.restartedAt, notStartedTold: state.notStartedTold };
  // "Once" is once per healthy stretch: a restart a week ago, with no hang since, no longer counts.
  if (next.hangRestarts && next.restartedAt && !state.since && now - next.restartedAt > HUNG.resetAfterDays * 86_400_000) { next.hangRestarts = 0; next.restartedAt = undefined; }
  const open = Boolean(state.since) && activity <= (state.activity ?? 0);   // a report stays until a sign of work
  const screen = quietMin >= 5 || patternRegexes.length || open ? readScreen() : null;
  const changing = screen !== null && screenChanging(screen);
  const patternNow = patternRegexes.length > 0 && screen !== null && patternRegexes.some((re) => re.test(screen));
  if (patternNow) next.patternSince = state.patternSince ?? now;
  let why = "", kind = "";
  if (open && !(state.kind === "pattern" && !patternNow)) { why = state.why; kind = state.kind ?? "quiet"; }
  else if (next.patternSince && now - next.patternSince >= HUNG.patternMinutes * 60_000) { kind = "pattern"; why = `a configured text pattern has been visible in its terminal for ${Math.round((now - next.patternSince) / 60_000)} minutes`; }
  else if (quietMin >= HUNG.minutes && wave.state !== "running" && changing && !probeIdle().idle) { kind = "quiet"; why = `busy, its terminal keeps changing, but status.md and the journal have not changed for ${Math.round(quietMin)} minutes`; }
  let restarted = false;
  const tell = [];   // told after the health file is written: a status watch run for it reads that file
  if (!why) { if (state.since) log(`Controller no longer hung (${state.why})`); }
  else {
    Object.assign(next, { since: state.since ?? now, why: state.why ?? why, kind, activity: state.activity ?? activity, pointerAt: state.pointerAt, acted: state.acted, escalated: state.escalated, escalatedAt: state.escalatedAt, restartFailed: state.restartFailed, declined: state.declined });
    if (HUNG.restartInvalid && !state.since) log("hosts.controller.hung.restart is not true or false: it counts as false (no automatic restart)");
    if (!state.since) {
      // The report is always made. The pointer is typed only into a Controller that has started a cycle since its restart, is
      // not brand new, and is not showing a confirmation question: otherwise it is report only.
      const reasonNot = restartAt && mtime("status.md") <= restartAt ? "it was restarted and has not written status.md since"
        : restartAt && now - restartAt < YOUNG_MS ? "it was restarted a moment ago" : dialogVisible(screen) ? "a confirmation question is visible" : "";
      if (reasonNot) log(`${hungText(next)}; pointer not typed: ${reasonNot}`);
      else {
        try { orca("terminal", "send", "--terminal", terminal.handle, "--text", POINTER_HUNG, "--enter"); next.pointerAt = now; log("typed the pointer for a Controller that may only look busy"); } catch (error) { log(`pointer not typed: ${short(error)}`); }
      }
      log(hungText(next)); tell.push(["HUNG", () => hungText(next)]);
    } else if (!next.acted && now - next.since >= HUNG.restartAfterMinutes * 60_000) {
      if (next.hangRestarts >= 1) {
        next.acted = next.escalated = true; next.escalatedAt = now;
        journalQuiet("escalation", "controller", { note: "hung again after an automatic restart", since: new Date(next.since).toISOString() });
        log(hungText(next)); tell.push(["HUNG-AGAIN", () => hungText(next)]);
      } else if (!HUNG.restart || kind === "pattern") { next.acted = true; log(`still hung; ${kind === "pattern" ? "a pattern only reports" : "automatic restart is off (hosts.controller.hung.restart is not true)"}: reported only`); }
      else if (!next.pointerAt) { next.declined = "the pointer line could not be typed, so there is no proof that the Controller ignored it"; }
      else {
        // The second confirmation: the pointer typed at the report was not answered (a sign of work would have ended this report),
        // and the terminal shows the same frame twice, a few seconds apart: a spinner or a timer is no frozen terminal.
        const a = readScreen(); sleepMs(3000); const b = readScreen();
        if (a === null || b === null || frame(a) !== frame(b)) next.declined = "its terminal still changes, so it is not proven frozen";
        else {
          const result = restartController({ reason: `hung: ${next.why}`, kind: "hang", lockHeld: true, tell: false });
          log(`restart: ${result.message}`);
          if (result.ok) { if (!result.closeFailed) tell.push(["RESTARTED", () => result.event]); next.hangRestarts += 1; next.restartedAt = Date.now(); for (const k of ["since", "why", "kind", "activity", "pointerAt", "acted", "restartFailed", "declined"]) delete next[k]; restarted = true; }
          else if (result.code === 3) next.declined = oneLine(result.message.replace(/^refused: /, ""), 140);
          else { next.acted = true; next.restartFailed = oneLine(result.message, 120); tell.push(["HUNG", () => hungText(next)]); }
        }
      }
    }
  }
  // A restarted Controller that never writes status.md has not started: nothing is typed into it, so say so.
  const notStarted = restartAt && !restarted && mtime("status.md") <= restartAt && now - restartAt >= HUNG.restartAfterMinutes * 60_000;
  if (notStarted && next.notStartedTold !== restartAt) { next.notStartedTold = restartAt; tell.push(["NOT-STARTED", () => `the Controller restarted at ${hhmm(restartAt)} has not written status.md since: it has not started a cycle (a dialog, a usage limit, a crashed session?)`]); }
  // Two Controllers: the old terminal could not be closed. The line stays until the terminal is gone.
  let twoControllers = rs.closeFailed;
  if (twoControllers && controllerTerminals !== null && !controllerTerminals.some((t) => t.handle === twoControllers && !t.orphaned)) { try { const { closeFailed, ...rest } = rs; fs.writeFileSync(file("heartbeat.restarted.json"), JSON.stringify(rest, null, 2)); } catch { /* retried */ } twoControllers = undefined; }
  // Open problems for the Front agent's watch (front-notice.mjs). A restart is mentioned for an hour.
  const lines = [];
  if (next.since) lines.push(hungText(next));
  if (notStarted && !restarted) lines.push(`RESTARTED at ${hhmm(restartAt)}, but the Controller has not written status.md since: it has not started a cycle`);
  const dlgState = readJson("heartbeat.dialog.json", {});
  if (dlgState.reportedShape) lines.push(`WAITING AT A CONFIRMATION DIALOG since ${hhmm(dlgState.since)}: nothing is typed into it, it needs a person`);
  const unanswered = unansweredLine();
  if (unanswered) lines.push(unanswered);
  if (twoControllers && !restarted) lines.push(`TWO CONTROLLERS: the old terminal ${twoControllers} could not be closed after the restart: close it by hand`);
  if (!lines.length && next.restartedAt && now - next.restartedAt < 60 * 60_000) lines.push(`RESTARTED automatically at ${hhmm(next.restartedAt)} after a hang`);
  lines.push(...alertLines());   // alerts that outlive a run (a possible second Controller left by a restart)
  writeHealth(lines);
  fs.writeFileSync(file(HUNG_FILE), JSON.stringify(next));
  for (const [k, text] of tell) log(`told the Front agent (${k}): ${tellFront(k, text(), { type: k === "RESTARTED" ? "status" : "question" }).join(", ")}`);
  return restarted;
};
if (hangCheck()) process.exit(0);

const ERROR_REASONS = new Set(["workers unreadable", "tickets unreadable"]);
const reasons = fullCheck ? pendingWork() : inboxWaiting ? ["inbox"] : [];
if (fresh.length) reasons.unshift(`${fresh.length} worker message`);
if (wave.state === "finished") reasons.unshift("wave finished");
// A Controller that only waits for the human is not woken: it would achieve nothing and cost model time.
// An answer the human gave must not wait for ever: a new inbox line is a reason (above) whether a "Needs" item is open or not.
if (!reasons.length && needsHuman().length) process.exit(0);
const lastWake = fs.existsSync(file("heartbeat.last")) ? fs.statSync(file("heartbeat.last")).mtimeMs : 0;
// Idle (nothing new, nothing ready, no worker running) is woken at most every wake.idleMinutes; a source that cannot be read is no event.
const capped = Date.now() - lastWake < WAKE.idleMinutes * 60_000 && reasons.every((r) => ERROR_REASONS.has(r));

// The Controller's own word: cycle.mjs end wrote controller.waiting.json when it finished its cycle and sat down at its prompt, and
// cycle.mjs start removes it when the next one begins. The claim is what the files say; it is believed (trustedWaiting, below) only while
// nothing contradicts it. A marker is contradicted by status.md written after it (the Controller works and forgot to clear it: only
// the Controller writes status.md, and every cycle does; the journal is no sign, since a wave's gate and wavewait.mjs write it while the
// Controller sits idle), by a restart after it, and by a terminal record newer than it (`start` made a new Controller: the marker is the
// old session's). No marker (a handbook from before, a Controller that never ends a cycle) means main's behaviour exactly: Orca decides,
// and a busy reading gets the pointer once per state.
const claim = (() => {
  const m = readJson("controller.waiting.json", {}), at = Number(m.at);
  if (!Number.isFinite(at) || at <= 0 || at > Date.now() + 60_000) return {};
  if (Math.max(mtimeOf("status.md"), readJson("heartbeat.restarted.json", {}).at ?? 0) > at + 2000) return { present: true, why: "the Controller wrote status.md after it marked itself waiting" };
  if (mtimeOf("controller-terminal.txt") > at + 2000) return { present: true, why: "the marker is older than this Controller's terminal record (a new session)" };
  return { at, present: true };
})();
const markerWake = readJson("heartbeat.markerwake.json", {}), markerSeen = readJson("heartbeat.markerseen.json", {});
const MAX_REPEATS = 3;
// What is waiting, as tokens: an unanswered wake is held back only for tokens it already carried, a new one is never held back by the
// repeat timer of an older one. A signal the wake spent (a message, a wave) is no token any more and so is no "new reason" either.
const sha1 = (text) => createHash("sha1").update(text).digest("hex");
const workKinds = () => reasons.filter((r) => !ERROR_REASONS.has(r) && r !== "unanswered wake" && !/^(inbox|\d+ worker message|wave finished)$/.test(r)).map((r) => r.replace(/^\d+ /, ""));
const tokens = () => [...(inboxWaiting ? [`inbox:${sha1(readText("inbox.md"))}`] : []), ...fresh.map((id) => `msg:${id}`), ...(wave.state === "finished" ? [`wave:${wave.handle}`] : []), ...workKinds().map((k) => `work:${k}`)];
// A marker this run has not looked at yet is a Controller that has just ended a cycle: ready tickets are looked at once, so one it left
// unstarted does not wait for the tenth minute. A wake typed because of the marker and not answered (the marker is still the same) is
// a reason by itself after wake.repeatMinutes, at most MAX_REPEATS times.
const newMarker = Boolean(claim.at) && markerSeen.markerAt !== claim.at;
const unansweredDue = Boolean(claim.at) && markerWake.markerAt === claim.at && markerWake.real === true && (markerWake.n ?? 1) <= MAX_REPEATS && Date.now() - markerWake.at >= WAKE.repeatMinutes * 60_000;
if (capped && !newMarker && !unansweredDue) process.exit(0);

// A Controller that has not written its first status.md has not started its first cycle: it may still sit at its agent CLI's
// first-start dialog (trust this folder), and a line typed there is Enter on a default. A restarted one has the old status.md, so
// there it has to be newer than the restart. Whatever the reason, nothing is typed yet.
if (!fs.existsSync(file("status.md"))) { log(`no status.md yet, so the Controller has not started: nothing typed (${reasons.join(", ") || "idle check"})`); process.exit(0); }
const restartedAt = readJson("heartbeat.restarted.json", {}).at ?? 0;
if (restartedAt && mtimeOf("status.md") <= restartedAt) { log(`the Controller was restarted at ${hhmm(restartedAt)} and has not written status.md since: nothing typed (${reasons.join(", ") || "idle check"})`); process.exit(0); }

// Believed only while the terminal itself agrees. THIS IS THE ONE THING between a stale marker and a line typed into a Controller that
// works: Orca's own answer is not asked. The terminal must have printed nothing within wake.quietSeconds (Orca's `terminal list` says
// when it last printed; a thinking agent's spinner and a running command's output are what keeps it fresh), and Orca must give a usable
// time at all: a missing, null or non-numeric `lastOutputAt` is NOT quiet, it is unknown, and unknown is busy. The screen must be
// readable and show no confirmation question. The marker only ever turns "busy" into "idle", never the other way round.
const trustedWaiting = () => {
  if (!claim.at) return { ok: false, why: claim.why };
  const printed = terminal.lastOutputAt;
  if (typeof printed !== "number" || !Number.isFinite(printed) || printed <= 0 || printed > Date.now() + 60_000) return { ok: false, why: "Orca gives no usable lastOutputAt for its terminal" };
  const quiet = Math.round((Date.now() - printed) / 1000);
  if (quiet < WAKE.quietSeconds) return { ok: false, why: `its terminal printed ${quiet} s ago` };
  const screen = readScreen();
  if (screen === null) return { ok: false, why: "its screen cannot be read" };
  if (dialogVisible(screen)) return { ok: false, dialog: true, why: "a confirmation question is visible" };
  return { ok: true, at: claim.at, quiet };
};
const waiting = trustedWaiting();
// Recorded only when the look has been answered by a wake that was sent (or found nothing to send): a failed ticket read or a failed
// send leaves the marker unseen, and the next beat looks again.
let seenRecord = null;
const recordSeen = () => { if (seenRecord) fs.writeFileSync(file("heartbeat.markerseen.json"), JSON.stringify(seenRecord)); };
if (waiting.ok) {
  if (newMarker) {
    // Once per marker, and only when nothing else is a reason: ready tickets the Controller left unstarted when it ended its cycle.
    // Woken when the set is not the one it was last woken for, or after wake.repeatMinutes (a Controller at capacity that ends every cycle
    // with the same tickets is not woken every minute).
    if (!fullCheck && !reasons.length) {
      let ready = null;
      try { ready = readyTickets().map((t) => (t && typeof t === "object" ? t.id ?? t.number ?? JSON.stringify(t) : t)).map(String).sort(); } catch { ready = null; }
      if (ready === null) log("ready tickets could not be read: looked at again at the next beat");
      else if (ready.length && (JSON.stringify(ready) !== JSON.stringify(markerSeen.ready) || Date.now() - (markerSeen.wokeAt ?? 0) >= WAKE.repeatMinutes * 60_000)) { reasons.push(`${ready.length} ready`); seenRecord = { markerAt: claim.at, ready, wokeAt: Date.now() }; }
      else { seenRecord = { markerAt: claim.at, ready, wokeAt: markerSeen.wokeAt }; recordSeen(); seenRecord = null; }
    } else seenRecord = { markerAt: claim.at, ready: markerSeen.ready, wokeAt: markerSeen.wokeAt };
  }
  if (unansweredDue && !reasons.length) reasons.push("unanswered wake");
}
if (capped && !reasons.length) process.exit(0);
const { idle, why: busyWhy } = waiting.ok ? { idle: true, why: "" } : waiting.dialog ? { idle: false, why: "a confirmation question is visible" } : probeIdle();
const busySince = noteBusy(idle);
if (idle && waiting.ok) {
  // A wake typed into a Controller that said it was waiting is held back while it carries nothing the earlier one did not: for
  // wake.repeatMinutes, and for good once MAX_REPEATS repeats are used up, when the Front agent is told once. A NEW reason (a new inbox
  // line, a new message, a new wave, tickets that were not waiting) is never held back by the timer of an older one.
  const now = tokens(), same = markerWake.markerAt === waiting.at, added = same ? now.filter((t) => !(markerWake.sig ?? []).includes(t)) : now;
  if (same && !added.length && (Date.now() - markerWake.at < WAKE.repeatMinutes * 60_000 || (markerWake.n ?? 1) > MAX_REPEATS)) {
    const spent = (markerWake.n ?? 1) > MAX_REPEATS;
    log(`the Controller marked itself waiting at ${hhmm(waiting.at)}; woken at ${hhmm(markerWake.at)} and has not started a cycle: not typed again${spent ? ` (${MAX_REPEATS} repeats are used up)` : ` before ${WAKE.repeatMinutes} minutes`} (${reasons.join(", ") || "idle check"})`);
    if (spent && readJson("heartbeat.unanswered.json", {}).markerAt !== waiting.at) {
      const what = oneLine((markerWake.sig ?? []).map((t) => t.replace(/:.*$/, "")).filter((t, i, a) => a.indexOf(t) === i).join(", ") || "idle check", 80);
      const state = { markerAt: waiting.at, since: Date.now(), n: markerWake.n ?? 1, what };
      fs.writeFileSync(file("heartbeat.unanswered.json"), JSON.stringify(state));
      writeHealth([unansweredLine()].filter(Boolean));
      log(`told the Front agent (UNANSWERED): ${tellFront("UNANSWERED", unansweredLine() ?? "the Controller does not react to wake lines", { type: "question" }).join(", ")}`);
    }
    process.exit(0);
  }
}
if (!idle) {
  log(`busy, not woken (${reasons.join(", ") || "idle check"}; ${waiting.dialog || waiting.why ? `marker not used: ${waiting.why}; ` : ""}Orca: ${busyWhy})`);
  // A long cycle must not starve what is waiting, and Orca may read an idle session as busy. After a short continuous busy period the
  // running session gets a one-line pointer, once per state of what is waiting (inbox lines, worker mail, a finished wave): exactly as
  // before, for a Controller whose handbook does not know the marker. A Controller that has a marker file (its handbook is new, and the
  // marker is not believed just now) gets the pointer for every reason that would wake an idle one too (ready tickets, running workers at
  // the tenth minute), and an unanswered one again after wake.repeatMinutes, at most MAX_REPEATS times per state.
  const finished = wave.state === "finished", extended = Boolean(claim.present);
  const work = extended ? workKinds() : [];
  if ((inboxWaiting || fresh.length || finished || work.length) && Date.now() - busySince >= WAKE.busyPointerMinutes * 60_000) {
    const inboxHash = inboxWaiting ? sha1(readText("inbox.md")) : null;
    const key = JSON.stringify(extended ? [inboxHash, fresh, finished ? wave.handle : null, work] : [inboxHash, fresh, finished ? wave.handle : null]);
    const typed = readJson("heartbeat.pointer.count", {}), sameKey = readText("heartbeat.pointer") === key;
    // While the last lines of the screen look like a confirmation question nothing is typed, however long it lasts (Enter would take
    // its default). After wake.dialogHoldMinutes the Front agent is told instead, once, and again only when the question changes.
    const pending = !sameKey || (extended && Date.now() - mtime("heartbeat.pointer") >= WAKE.repeatMinutes * 60_000 && (typed.key === key ? typed.n ?? 1 : 1) <= MAX_REPEATS), screenNow = pending ? readScreen() : null;
    const onDialog = pending && dialogVisible(screenNow);
    const dlg = readJson("heartbeat.dialog.json", {}), now = Date.now();
    if (!onDialog) fs.rmSync(file("heartbeat.dialog.json"), { force: true });
    else {
      const shape = frame(screenNow.split("\n").slice(-8).join("\n"));
      const state = { since: dlg.since && dlg.last && now - dlg.last < 3 * 60_000 ? dlg.since : now, last: now, shape, reportedShape: dlg.reportedShape };
      const held = Math.round((now - state.since) / 60_000);
      if (now - state.since >= WAKE.dialogHoldMinutes * 60_000 && state.reportedShape !== shape) {
        state.reportedShape = shape;
        const text = `the Controller appears to be waiting at a confirmation dialog (since ${hhmm(state.since)}, ${held} minutes): nothing is typed into it, it needs a person`;
        log(`${text}; told the Front agent: ${tellFront("DIALOG", text, { type: "question" }).join(", ")}`);
      } else log(`pointer not typed: a confirmation question is visible in the Controller's terminal (${held} minutes; the Front agent is told after ${WAKE.dialogHoldMinutes})`);
      fs.writeFileSync(file("heartbeat.dialog.json"), JSON.stringify(state));
    }
    if (!onDialog && pending) {
      const inboxOnly = inboxWaiting && !fresh.length && !finished && !work.length, workOnly = !inboxWaiting && !fresh.length && !finished;
      orca("terminal", "send", "--terminal", terminal.handle, "--text", inboxOnly ? POINTER : workOnly ? POINTER_WORK : POINTER_MAIL, "--enter");
      fs.writeFileSync(file("heartbeat.pointer.count"), JSON.stringify({ key, n: sameKey && typed.key === key ? (typed.n ?? 1) + 1 : 1 }));
      fs.writeFileSync(file("heartbeat.pointer"), key);   // its age is the time of this pointer
      log(inboxOnly ? "pointed the busy Controller to the inbox" : workOnly ? `pointed the busy Controller to ${work.join(", ")}` : "pointed the busy Controller to new mail or a finished wave");
    }
  }
  process.exit(0);
}

// A count tells the Controller there is mail; what it says it reads itself, in step 1 of the loop.
const text = fresh.length ? `Heartbeat: ${fresh.length} new worker message${fresh.length > 1 ? "s" : ""}. Run the next cycle of "The loop" in CONTROLLER.md now (step 1 reads the mail), then stop and wait for the next heartbeat.` : MESSAGE;
const tokensNow = waiting.ok ? tokens() : [];
orca("terminal", "send", "--terminal", terminal.handle, "--text", text, "--enter");
fs.writeFileSync(file("heartbeat.last"), "");
if (waiting.ok) {
  const same = markerWake.markerAt === waiting.at, added = same ? tokensNow.filter((t) => !(markerWake.sig ?? []).includes(t)) : tokensNow;
  fs.writeFileSync(file("heartbeat.markerwake.json"), JSON.stringify({ markerAt: waiting.at, at: Date.now(), n: same && !added.length ? (markerWake.n ?? 1) + 1 : 1, sig: [...new Set([...(same ? markerWake.sig ?? [] : []), ...tokensNow])], real: reasons.length > 0 }));
  recordSeen();
}
remember();
if (newlySettled.length) fs.writeFileSync(file("heartbeat.settled.json"), JSON.stringify([...readJson("heartbeat.settled.json", []), ...newlySettled].slice(-500)));
if (wave.state === "finished") fs.writeFileSync(file("heartbeat.wave"), wave.handle);
log(`woke ${terminal.handle} (${reasons.join(", ") || "idle check"}${waiting.ok ? `; it marked itself waiting at ${hhmm(waiting.at)}, its terminal had been quiet for ${waiting.quiet} s` : ""})`);
