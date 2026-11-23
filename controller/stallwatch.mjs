// Watches every worker on every worker host and prints one line per state change: WORKING | IDLE | CAPACITY | GONE |
// EARLY-STOP. Orca: reads each "· Worker" terminal screen. Terminal runner: log mtime and process liveness.
// Idle counts only after the screen stopped changing for 90 s. Nudge idle workers with a message into their terminal.
// Only this project's own workers are read, never another project's on a shared host.
// Runs until killed. Usage: node stallwatch.mjs
import fs from "node:fs";
import { HOSTS, ORCA, RUNNER, file, isHelperTerminal, journal, onHost, orcaEnvArgsOn, readJson, trySh, workspacesOn } from "./lib.mjs";
// A shared host lists every project's terminals, and a title does not tell them apart. A terminal is this project's when workers.json
// names its handle (start.mjs records it for every worker), or when its worktree lies in this project's workspace directory on that
// host. A remote host's configured path can start with ~, so there the last two segments (<workspaces dir>/<project>) decide.
// When worker terminals exist but none can be told to be this project's (a layout neither rule knows), all of them are watched, with a
// notice: watching too much is better than a stall that nobody sees.
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
  if (!workers.length || mine.length === workers.length) { notices.delete(host.name); return mine; }
  if (!mine.length) { notice(host.name, `${workers.length} worker terminal(s) on ${host.name} and none can be told to be this project's (not in workers.json, worktree not under ${workspacesOn(host)}): watching all of them`); return workers; }
  notice(host.name, `${workers.length - mine.length} worker terminal(s) on ${host.name} ignored: not this project's`);
  return mine;
}

const PROMPTS = /Ask Codex to do anything|\? for shortcuts|^> $|Type your message|│ >/m;   // agent prompt patterns (Codex, Claude Code, Pi)
const WORKING = /esc to interrupt|Working \(|Thinking|⠋|⠙|⠹|Running /i;
const CAPACITY = /at capacity|rate limit|overloaded|usage limit/i;
const EARLY = /\b(incomplete|cannot continue|stopping here|unable to proceed)\b/i;
const last = new Map(), idleSince = new Map(), prevScreen = new Map();
const report = (key, state, title) => {
  if (last.get(key) !== state) {
    if (last.has(key) || state !== "WORKING") { console.log(`${new Date().toTimeString().slice(0, 5)} ${state} ${title} ${key}`); if (state !== "WORKING") journal("stall", String(title).split(" · ")[0], { note: state }); }
    last.set(key, state);
  }
};
for (;;) {
  const seen = new Set();
  for (const host of HOSTS) {
    if (RUNNER === "orca") {
      let terms = [];
      try { terms = JSON.parse(trySh(ORCA, ["terminal", "list", ...orcaEnvArgsOn(host), "--json"]) || "{}").result?.terminals ?? []; } catch {}
      for (const t of ownWorkers(host, terms.filter((t) => / · Worker /.test(t.title ?? "") && !isHelperTerminal(t.title) && t.status !== "exited"))) {
        const key = `${host.name}|${t.handle}`; seen.add(key);
        let tail = "";
        try { tail = (JSON.parse(trySh(ORCA, ["terminal", "read", "--terminal", t.handle, "--screen", ...orcaEnvArgsOn(host), "--json"]) || "{}").result?.terminal?.tail ?? []).join("\n"); } catch {}
        const bottom = tail.split("\n").slice(-8).join("\n");
        let state = "WORKING";
        if (CAPACITY.test(bottom)) state = "CAPACITY";
        else if (WORKING.test(tail)) state = "WORKING";
        else if (EARLY.test(bottom) && PROMPTS.test(bottom)) state = "EARLY-STOP";
        else if (PROMPTS.test(bottom)) state = "IDLE";
        if (state === "IDLE" && prevScreen.get(key) !== tail) state = "WORKING";
        prevScreen.set(key, tail);
        if (state === "IDLE") { if (!idleSince.has(key)) idleSince.set(key, Date.now()); if (Date.now() - idleSince.get(key) < 90_000) state = "WORKING"; } else idleSince.delete(key);
        report(key, state, t.title);
      }
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
  for (const key of [...last.keys()]) if (!seen.has(key) && last.get(key) !== "GONE") report(key, "GONE", "worker");
  await new Promise((r) => setTimeout(r, 120_000));
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
