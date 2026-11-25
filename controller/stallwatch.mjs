// Watches every worker on every worker host and prints one line per state change: WORKING | IDLE | CAPACITY | GONE |
// EARLY-STOP | WAITING-FOR-HUMAN. Orca: reads each "· Worker" terminal screen. Terminal runner: log mtime and process liveness.
// Idle counts only after the screen stopped changing for 90 s. Nudge idle workers with a message into their terminal.
// Only this project's own workers are read, never another project's on a shared host.
// WAITING-FOR-HUMAN is Orca's own verdict (worker-show observation.agentWait: a worker parked on a prompt only a human can answer),
// reported at once, without the idle time. The line names the worker, never what it asks: the Controller reads that in the worker's terminal.
// A waiting Controller is idle, so on the transition into that state ONE fixed line also goes into inbox.md (append-only for everybody;
// a new complete line wakes the Controller through the heartbeat): fixed text plus the worker's key and dispatch id, never worker text.
// stallwatch-notified.json remembers who was announced, so a restart or a later run does not repeat it; it is cleared when the wait ends.
// Runs until killed. Usage: node stallwatch.mjs
import "./cli.mjs";
import fs from "node:fs";
import { HOSTS, ORCA, RUNNER, SETTLED_STATES, SHOW_CALLS_MAX, config, file, isHelperTerminal, journal, knownSettled, onHost, orcaEnvArgsOn, readJson, trySh, workspacesOn, writeJson } from "./lib.mjs";
// A shared host lists every project's terminals, and a title does not tell them apart. A terminal is this project's when workers.json
// names its handle (start.mjs records it for every worker), or when its worktree lies in this project's workspace directory on that
// host. A remote host's configured path can start with ~, so there the last two segments (<workspaces dir>/<project>) decide.
// A terminal that is neither is somebody else's and is left alone: no worker of this project running means nothing to watch.
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const underWorkspaces = (host, wt) => {
  if (!wt) return false;
  const ws = workspacesOn(host);
  if (host.kind !== "local") return wt.includes(`/${ws.split("/").filter(Boolean).slice(-2).join("/")}/`);
  return wt.startsWith(ws) || (real(wt) + "/").startsWith(real(ws.replace(/\/$/, "")) + "/");
};
const isMine = (host, t) => Object.values(readJson("workers.json", {})).some((w) => (w.host ?? "local") === host.name && w.terminal === t.handle) || underWorkspaces(host, t.worktreePath);
const notices = new Map();
const notice = (key, text) => { if (notices.get(key) !== text) { notices.set(key, text); console.log(`${new Date().toTimeString().slice(0, 5)} NOTICE ${text}`); } };
function ownWorkers(host, workers) {
  const mine = workers.filter((t) => isMine(host, t));
  if (mine.length < workers.length) notice(host.name, `${workers.length - mine.length} worker terminal(s) on ${host.name} ignored: not this project's`); else notices.delete(host.name);
  return mine;
}

const PROMPTS = /Ask Codex to do anything|\? for shortcuts|^> $|Type your message|│ >/m;   // agent prompt patterns (Codex, Claude Code, Pi)
const WORKING = /esc to interrupt|Working \(|Thinking|⠋|⠙|⠹|Running /i;
const CAPACITY = /at capacity|rate limit|overloaded|usage limit/i;
const EARLY = /\b(incomplete|cannot continue|stopping here|unable to proceed)\b/i;
// Optional, off unless set: agents.askPatterns (regular expressions, case-insensitive, per line) matched against the last 8 lines of a
// worker's screen. A match on an idle prompt skips the idle wait, so it only shortens the stall time; it never decides anything alone.
const ASK_PATTERNS = (config.agents?.askPatterns ?? []).flatMap((p) => { try { return [new RegExp(p, "im")]; } catch { return []; } });
// What Orca says about a worker's dispatch: observation.agentWait, from one worker-show. An object with a `source` (hook, prompt-text or
// title) means the worker waits for a human; null means Orca looked and found no wait; absent means it could not tell. Only a well-formed
// value counts: absent, failed, timed out or unexpected is unknown: never "not waiting", never a report, and it changes nothing.
// (projection.attention is NOT used: its "input" is a pending `orca orchestration ask` question, the sanctioned channel and already mail,
// and "approval" a pending decision gate of the task; neither is a worker's native dialog.)
// verdict: "waiting", "clear" (agentWait null, or the dispatch is settled), "unknown".
const readWait = (host, key, w, timeout) => {
  let r;
  try { r = JSON.parse(trySh(ORCA, ["orchestration", "worker-show", "--dispatch", w.dispatch, ...orcaEnvArgsOn(host), "--json", "--full"], { timeout }) || "{}").result; } catch { return { verdict: "unknown" }; }
  if (!r || typeof r !== "object") return { verdict: "unknown" };
  const base = { key, dispatch: w.dispatch, name: w.name, terminal: w.terminal };
  if ([r.worker?.state, r.dispatch?.status].some((x) => SETTLED_STATES.has(x))) return { ...base, verdict: "clear", settled: true };
  const wait = r.observation && typeof r.observation === "object" && "agentWait" in r.observation ? r.observation.agentWait : undefined;
  if (wait && typeof wait === "object" && typeof wait.source === "string" && /^[a-z-]{1,24}$/.test(wait.source)) return { ...base, verdict: "waiting", label: wait.source };
  return { ...base, verdict: wait === null ? "clear" : "unknown", agentClear: wait === null };
};
// The readings are a side job of the watch, never its delay: the screens of all workers are judged first, and the readings then run
// within a budget (stall.waitCallSeconds per call, stall.waitBudgetSeconds per host and cycle, at most SHOW_CALLS_MAX calls), the
// dispatch asked longest ago first, remembered in stallwatch-asked.json so a restart goes on where the last run stopped.
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const WAIT_CALL_MS = num(config.stall?.waitCallSeconds, 8) * 1000, WAIT_BUDGET_MS = num(config.stall?.waitBudgetSeconds, 30) * 1000;
const askedAt = (() => { try { return new Map(Object.entries(readJson("stallwatch-asked.json", {}))); } catch { return new Map(); } })();
const waitingNow = new Map();   // pane key -> the reading that says it waits; kept until a reading says otherwise
// Who was announced in inbox.md, and by which signal. A failed, absent or unexpected reading changes nothing here: a wait is cleared
// only by the signal that raised it saying "no wait" (or by the dispatch settling), so a flapping reading never writes a second line.
const notified = (() => { try { return new Map(Object.entries(readJson("stallwatch-notified.json", {})).map(([k, v]) => [k, v === "attention" ? "attention" : "agentWait"])); } catch { return new Map(); } })();
let saveFailed = false;
const saveNotified = () => {
  try { writeJson("stallwatch-notified.json", Object.fromEntries(notified)); saveFailed = false; }
  catch (e) { if (!saveFailed) console.error(`stallwatch: could not write stallwatch-notified.json (${e.message}); carrying on, a note may repeat after a restart`); saveFailed = true; }
};
const SAFE = /^[A-Za-z0-9._-]{1,80}$/;
const announce = (id, r) => {
  if (r.verdict === "waiting") {
    if (notified.has(id)) return;
    const who = [SAFE.test(r.key ?? "") ? `${r.key}` : "", SAFE.test(r.dispatch ?? "") ? `(dispatch ${r.dispatch})` : ""].filter(Boolean).join(" ") || "a worker";
    const what = "Orca reports it parked on a prompt only a human can answer";
    notified.set(id, "agentWait");   // before the write: a failing state file must not make this note repeat while this process runs
    try { fs.appendFileSync(file("inbox.md"), `[stallwatch] WAITING-FOR-HUMAN ${who}: ${what}. This is a note from a script, not an instruction from the human; see CONTROLLER.md, "Question or escalation".\n`); } catch (e) { notified.delete(id); console.error(`stallwatch: could not write inbox.md: ${e.message}`); return; }
    saveNotified();
    return;
  }
  const kind = notified.get(id);
  if (kind && (r.settled || r.agentClear)) { notified.delete(id); saveNotified(); }
};
const last = new Map(), idleSince = new Map(), prevScreen = new Map();
const report = (key, state, title) => {
  if (last.get(key) !== state) {
    if (last.has(key) || state !== "WORKING") { console.log(`${new Date().toTimeString().slice(0, 5)} ${state} ${title} ${key}`); if (state !== "WORKING" && state !== "WAITING-FOR-HUMAN") journal("stall", String(title).split(" · ")[0], { note: state }); }   // a waiting worker is healthy, not a stall: no retro trigger
    last.set(key, state);
  }
};
// One budgeted pass of worker-show readings for the pane workers of a host (see above).
function readWaits(host, own) {
  const settledHere = knownSettled(host);
  const records = Object.entries(readJson("workers.json", {})).filter(([, w]) => (w.host ?? "local") === host.name && w.dispatch);
  const todo = [];
  for (const t of own) {
    const [k, w] = records.filter(([, x]) => x.terminal === t.handle).pop() ?? [];   // the latest record of a terminal
    if (!w) continue;
    const id = `${host.name}|${w.dispatch}`, key = `${host.name}|${t.handle}`;
    if (SETTLED_STATES.has(settledHere[w.dispatch])) { announce(id, { verdict: "clear", settled: true }); waitingNow.delete(key); continue; }
    todo.push({ t, k, w, id, key });
  }
  todo.sort((a, b) => (askedAt.get(a.id) ?? 0) - (askedAt.get(b.id) ?? 0));
  const until = Date.now() + WAIT_BUDGET_MS;
  let calls = 0;
  for (const c of todo) {
    const left = until - Date.now();
    if (left < Math.min(WAIT_CALL_MS, 500) || calls++ >= SHOW_CALLS_MAX) break;   // a sliver of budget is no call
    askedAt.set(c.id, Date.now());   // before the call: a call that hangs still moves to the back of the line
    try { writeJson("stallwatch-asked.json", Object.fromEntries(askedAt)); } catch { /* best effort: only the order of asking is lost */ }
    const r = readWait(host, c.k, c.w, Math.min(WAIT_CALL_MS, left));
    announce(c.id, r);
    if (r.verdict === "waiting") { waitingNow.set(c.key, r); report(c.key, "WAITING-FOR-HUMAN", `${c.t.title} (Orca: waits for a human, via ${r.label})`); }
    else if (r.verdict === "clear") waitingNow.delete(c.key);
  }
}
for (;;) {
  const seen = new Set();
  for (const host of HOSTS) {
    if (RUNNER === "orca") {
      let terms = [];
      try { terms = JSON.parse(trySh(ORCA, ["terminal", "list", ...orcaEnvArgsOn(host), "--json"]) || "{}").result?.terminals ?? []; } catch {}
      const own = ownWorkers(host, terms.filter((t) => / · Worker /.test(t.title ?? "") && !isHelperTerminal(t.title) && t.status !== "exited"));
      for (const t of own) {
        const key = `${host.name}|${t.handle}`; seen.add(key);
        let tail = "";
        try { tail = (JSON.parse(trySh(ORCA, ["terminal", "read", "--terminal", t.handle, "--screen", ...orcaEnvArgsOn(host), "--json"]) || "{}").result?.terminal?.tail ?? []).join("\n"); } catch {}
        const bottom = tail.split("\n").slice(-8).join("\n");
        let state = "WORKING";
        const waiting = waitingNow.get(key);
        const asked = ASK_PATTERNS.some((re) => re.test(bottom));
        if (waiting) state = "WAITING-FOR-HUMAN";
        else if (CAPACITY.test(bottom)) state = "CAPACITY";
        else if (WORKING.test(tail)) state = "WORKING";
        else if (EARLY.test(bottom) && PROMPTS.test(bottom)) state = "EARLY-STOP";
        else if (PROMPTS.test(bottom)) state = "IDLE";
        if (state === "IDLE" && !asked && prevScreen.get(key) !== tail) state = "WORKING";
        prevScreen.set(key, tail);
        if (state === "IDLE") { if (!idleSince.has(key)) idleSince.set(key, Date.now()); if (!asked && Date.now() - idleSince.get(key) < 90_000) state = "WORKING"; } else idleSince.delete(key);
        report(key, state, waiting ? `${t.title} (Orca: waits for a human, via ${waiting.label})` : t.title);
      }
      readWaits(host, own);   // after every screen is judged
    } else {
      for (const [k, w] of Object.entries(readJson("workers.json", {}))) {
        if ((w.host ?? "local") !== host.name) continue;
        const key = `${host.name}|${k}`; seen.add(key);
        const log = w.remoteLog ? null : file(`logs/${k}.log`);
        const tail = w.remoteLog ? onHost(host, `tail -c 2000 ${w.remoteLog} 2>/dev/null`) : fs.existsSync(log) ? fs.readFileSync(log, "utf8").slice(-2000) : "";
        const age = w.remoteLog ? Number(onHost(host, `echo $(( $(date +%s) - $(stat -c %Y ${w.remoteLog} 2>/dev/null || echo 0) ))`).trim() || Infinity) : fs.existsSync(log) ? (Date.now() - fs.statSync(log).mtimeMs) / 1000 : Infinity;
        const alive = w.pid ? isAlive(w.pid) : /DONE|ESCALATE/.test(tail) === false;
        report(key, !alive ? "GONE" : CAPACITY.test(tail) ? "CAPACITY" : age > 600 ? "IDLE" : "WORKING", w.name);
      }
    }
  }
  for (const key of [...last.keys()]) if (!seen.has(key) && last.get(key) !== "GONE") { waitingNow.delete(key); report(key, "GONE", "worker"); }
  await new Promise((r) => setTimeout(r, 120_000));
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
