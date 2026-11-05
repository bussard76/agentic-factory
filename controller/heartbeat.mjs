// Wakes this directory's Controller from outside, so noticing finished work does not depend on the Controller itself
// (docs/learnings.md). `agentic-factory start` runs it from cron every minute. Worker messages and a finished wave wake it
// at once; the full work check runs at each tenth minute. It marks progress in Orca's sidebar without a model.
// It only sends text into the Controller's terminal: it never starts or restarts a Controller. Each Controller directory
// has its own copy and state, so projects on one host stay independent.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HOSTS, HUMAN, MAIN, ORCA, PROJECT, PROJECT_DIR, STEERING, config, file, hostNamed, orcaEnvArgsOn, worktreeRefOn } from "./lib.mjs";

const IDLE_WAIT_MS = 15_000;
const IDLE_WAKE_MS = 55 * 60_000; // Nothing to do: wake about hourly, a little under so a 60-minute tick is not missed.
const INBOX_POINTER_MS = 5 * 60_000; // A busy Controller gets a pointer to the inbox after this long.
const LOG_LIMIT = 1 << 20;
const MESSAGE = "Heartbeat: run the next cycle of \"The loop\" in CONTROLLER.md now, then stop and wait for the next heartbeat.";
const POINTER = "Heartbeat: inbox.md has a new instruction. Read it after your current step.";
const title = `${PROJECT} · Controller`;

const LOCK = file("heartbeat.lock.d");
const LOCK_STALE_MS = 5 * 60_000;
const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
const orca = (...args) => JSON.parse(run(ORCA, [...args, "--json"]));
const readJson = (name, fallback) => { try { return JSON.parse(fs.readFileSync(file(name), "utf8")); } catch { return fallback; } };
const readText = (name) => { try { return fs.readFileSync(file(name), "utf8"); } catch { return ""; } };
const short = (error) => String(error.message).slice(0, 160);

// cron starts this every minute, and a slow Orca can take longer than that. mkdir is atomic and needs no flock, which macOS lacks.
try { if (Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS) fs.rmdirSync(LOCK); } catch { /* no lock */ }
try { fs.mkdirSync(LOCK); } catch { process.exit(0); }
process.on("exit", () => { try { fs.rmdirSync(LOCK); } catch { /* already gone */ } });
try { if (fs.statSync(file("heartbeat.log")).size > LOG_LIMIT) fs.renameSync(file("heartbeat.log"), file("heartbeat.log.1")); } catch { /* no log yet */ }

const steering = (...args) => JSON.parse(run("node", [file(`steering/${STEERING === "github-issues" ? "issues" : "tasks"}.mjs`), ...args]));
const readyTickets = () => (STEERING === "github-issues" ? steering("ready") : steering("list", "ready"));
const startedTickets = () => (STEERING === "github-issues"
  ? JSON.parse(run("gh", ["issue", "list", "--label", config.steering?.inProgressLabel ?? "in-progress", "--state", "open", "--json", "number"], PROJECT_DIR)).map((i) => `#${i.number}`)
  : steering("list", "building").map((t) => t.id));

// An unreadable source counts as work: a false wake costs one cycle, a missed one stalls the project.
const pendingWork = () => {
  const reasons = [];
  if (readText("inbox.md").trim()) reasons.push("inbox");
  try {
    if (Object.keys(JSON.parse(fs.readFileSync(file("workers.json"), "utf8"))).length) reasons.push("workers");
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
  catch (error) { terminalsByHost[host.name] = null; log(`terminal list failed on ${host.name}: ${short(error)}`); }
}
const allTerminals = Object.values(terminalsByHost).flatMap((t) => t ?? []);
const terminal = (terminalsByHost[config.hosts?.controller?.host ?? "local"] ?? []).find((t) => t.title === title);

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
  const active = Object.values(readJson("workers.json", {})).filter((w) => allTerminals.some((t) => t.handle === w.terminal)).length;
  const open = needsHuman();
  if (readText("inbox.md").trim()) return showNotice(say("Working: instruction from the inbox", "Arbeitet: Auftrag aus der Inbox"), "in-progress", false);
  if (open.length) return showNotice(`${say("Waiting for you", "Wartet auf dich")}: ${open[0].slice(2, 200)}`, "in-review", true);
  if (wave.state === "running") return showNotice(say(`Working: wave running, ${active} workers`, `Arbeitet: Wave läuft, ${active} Worker`), "in-progress", false);
  if (wave.state === "finished") return showNotice(say(`Working: wave finished (${wave.result}), waking the Controller`, `Arbeitet: Wave fertig (${wave.result}), Controller wird geweckt`), "in-progress", true);
  const ready = readyTickets().length;
  if (active || ready) return showNotice(say(`Working: ${active} workers, ${ready} ready tickets`, `Arbeitet: ${active} Worker, ${ready} freigegebene Tickets`), "in-progress", false);
  const started = startedTickets();
  if (started.length) return showNotice(say(`Stalled, nobody is acting: no workers, but in progress: ${started.join(", ")}`, `Steht still, niemand handelt: keine Worker, aber in Arbeit: ${started.join(", ")}`), "in-review", true);
  showNotice(say("Nothing left to do: no workers, no ready tickets, no open question", "Nichts mehr zu tun: keine Worker, keine freigegebenen Tickets, keine offene Frage"), "completed", true);
};
try {
  if (!terminal) showNotice(say("Controller is not running: run `agentic-factory start`", "Controller läuft nicht: bitte `agentic-factory start` ausführen"), "in-review", true);
  else updateNotice();
} catch (error) { log(`notice failed: ${short(error)}`); } // A display problem must not stop the wake below.
if (!terminal) { log(`no terminal titled "${title}", nothing woken`); process.exit(0); }

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

const fullCheck = new Date().getMinutes() % 10 === 0;
const inboxWaiting = readText("inbox.md").trim() !== "";

const reasons = fullCheck ? pendingWork() : inboxWaiting ? ["inbox"] : [];
if (fresh.length) reasons.unshift(`${fresh.length} worker message`);
if (wave.state === "finished") reasons.unshift("wave finished");
// A Controller that only waits for the human is not woken: it would achieve nothing and cost model time.
if (!reasons.length && needsHuman().length) process.exit(0);
const lastWake = fs.existsSync(file("heartbeat.last")) ? fs.statSync(file("heartbeat.last")).mtimeMs : 0;
if (!reasons.length && Date.now() - lastWake < IDLE_WAKE_MS) process.exit(0);

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

orca("terminal", "send", "--terminal", terminal.handle, "--text", MESSAGE, "--enter");
fs.writeFileSync(file("heartbeat.last"), "");
remember();
if (wave.state === "finished") fs.writeFileSync(file("heartbeat.wave"), wave.handle);
log(`woke ${terminal.handle} (${reasons.join(", ") || "hourly check"})`);
