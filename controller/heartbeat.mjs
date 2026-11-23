// Wakes this directory's Controller from outside, so noticing finished work does not depend on the Controller itself
// (docs/learnings.md). `agentic-factory start` runs it from cron every minute. Worker messages and a finished wave wake it
// at once; the full work check runs at each tenth minute. It marks progress in Orca's sidebar without a model.
// It only sends text into the Controller's terminal: it never starts or restarts a Controller. Each Controller directory
// has its own copy and state, so projects on one host stay independent.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { controllerPlaces, locateController } from "./controller-terminal.mjs";
import { HOSTS, HUMAN, MAIN, ORCA, PROJECT, PROJECT_DIR, STEERING, config, dispatchStates, file, hostNamed, orcaEnvArgsOn, workerStatus, worktreeRefOn } from "./lib.mjs";

const IDLE_WAIT_MS = 15_000;
const IDLE_WAKE_MS = 55 * 60_000; // Nothing to do: wake about hourly, a little under so a 60-minute tick is not missed.
const INBOX_POINTER_MS = 5 * 60_000; // A busy Controller gets a pointer to the inbox after this long.
const LOG_LIMIT = 1 << 20;
const MESSAGE = "Heartbeat: run the next cycle of \"The loop\" in CONTROLLER.md now, then stop and wait for the next heartbeat.";
// Nothing a worker or a message wrote is ever typed into the Controller's terminal: the lines above and the one below are
// fixed text plus a count this script made. The Controller reads the mail itself (step 1 of its loop). What a terminal's
// title says goes only into the sidebar comment, on one line.
const oneLine = (text, n) => String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, n);
const POINTER = "Heartbeat: inbox.md has a new instruction. Read it after your current step.";
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
const pendingWork = () => {
  const reasons = [];
  if (readText("inbox.md").trim()) reasons.push("inbox");
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
const fullCheck = new Date().getMinutes() % 10 === 0;
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
  const open = needsHuman();
  if (readText("inbox.md").trim()) return showNotice(say("Working: instruction from the inbox", "Arbeitet: Auftrag aus der Inbox"), "in-progress", false);
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
const mark = (args) => { try { run(ORCA, ["worktree", "set", ...args, "--unread", "--json"]); } catch (error) { log(`marking failed: ${short(error)}`); } };
const announce = (id, line, worker) => {
  announced.add(id);
  fs.writeFileSync(file("heartbeat.announced.json"), JSON.stringify([...announced].slice(-500)));
  log(line);
  if (worker?.dir && worker.host) {
    try { const host = hostNamed(worker.host); mark(["--worktree", worktreeRefOn(host, worker.dir), "--workspace-status", "completed", ...orcaEnvArgsOn(host)]); }
    catch (error) { log(`marking failed: ${short(error)}`); }
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
const fresh = events.filter((id) => !seen.has(id));
const remember = () => fs.writeFileSync(file("heartbeat.seen.json"), JSON.stringify([...seen, ...fresh].slice(-500)));
if (!seenExisted) { remember(); log("baseline of worker messages recorded"); process.exit(0); } // Old messages wake nobody.

const inboxWaiting = readText("inbox.md").trim() !== "";

const reasons = fullCheck ? pendingWork() : inboxWaiting ? ["inbox"] : [];
if (fresh.length) reasons.unshift(`${fresh.length} worker message`);
if (wave.state === "finished") reasons.unshift("wave finished");
// A Controller that only waits for the human is not woken: it would achieve nothing and cost model time.
if (!reasons.length && needsHuman().length) process.exit(0);
const lastWake = fs.existsSync(file("heartbeat.last")) ? fs.statSync(file("heartbeat.last")).mtimeMs : 0;
if (!reasons.length && Date.now() - lastWake < IDLE_WAKE_MS) process.exit(0);


// A Controller that has not written its first status.md has not started its first cycle: it may still sit at its agent CLI's
// first-start dialog (trust this folder), and a line typed there is Enter on a default. Whatever the reason, nothing is typed yet.
if (!fs.existsSync(file("status.md"))) { log(`no status.md yet, so the Controller has not started: nothing typed (${reasons.join(", ") || "hourly check"})`); process.exit(0); }

// Output timestamps are no idle signal: an idle session still redraws. A timeout counts as busy.
let idle = false;
try {
  idle = orca("terminal", "wait", "--terminal", terminal.handle, "--for", "tui-idle", "--timeout-ms", String(IDLE_WAIT_MS)).result.wait.satisfied === true;
} catch { idle = false; }
if (!idle) {
  log(`busy, not woken (${reasons.join(", ") || "hourly check"})`);
  // A long cycle must not starve the inbox. Point the running session to it, once per inbox state.
  const inboxAt = inboxWaiting ? fs.statSync(file("inbox.md")).mtimeMs : 0;
  if (inboxWaiting && Date.now() - inboxAt > INBOX_POINTER_MS && readText("heartbeat.pointer") !== String(inboxAt)) {
    orca("terminal", "send", "--terminal", terminal.handle, "--text", POINTER, "--enter");
    fs.writeFileSync(file("heartbeat.pointer"), String(inboxAt));
    log("pointed the busy Controller to the inbox");
  }
  process.exit(0);
}

// A count tells the Controller there is mail; what it says it reads itself, in step 1 of the loop.
const text = fresh.length ? `Heartbeat: ${fresh.length} new worker message${fresh.length > 1 ? "s" : ""}. Run the next cycle of "The loop" in CONTROLLER.md now (step 1 reads the mail), then stop and wait for the next heartbeat.` : MESSAGE;
orca("terminal", "send", "--terminal", terminal.handle, "--text", text, "--enter");
fs.writeFileSync(file("heartbeat.last"), "");
remember();
if (newlySettled.length) fs.writeFileSync(file("heartbeat.settled.json"), JSON.stringify([...readJson("heartbeat.settled.json", []), ...newlySettled].slice(-500)));
if (wave.state === "finished") fs.writeFileSync(file("heartbeat.wave"), wave.handle);
log(`woke ${terminal.handle} (${reasons.join(", ") || "hourly check"})`);
