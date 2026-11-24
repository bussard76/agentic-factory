// Tells the Front agent that something is wrong with the Controller itself (hung, restarted, hung again): the heartbeat and
// restart.mjs use it, because a Controller that cannot act cannot tell anybody. A library; its callers are the scripts.
// Three ways, the same ones the Controller's own front events use (CONTROLLER.md, "Noticing that work has finished"):
//  1. heartbeat-health.md in the Controller directory, one line per open problem. statuswatch.mjs (terminal Front agent) and
//     botwatch.mjs (bot) read it in the same probe as status.md, locally or over ssh, so it reaches either kind within one
//     watch interval wherever the Controller runs. It is a file of its own: the heartbeat never writes status.md, whose age
//     is the sign that the Controller works.
//  2. A FRONT-EVENT line in front-events.log, the record a Front agent on the server or a bot follows.
//  3. At once, where the Front agent is on this machine: the bot gets `orca orchestration send --to bot:<name>`, a terminal
//     Front agent gets a run of its own statuswatch.mjs (it delivers into an idle terminal, else the sidebar shows it), unless
//     hosts.frontAgent.statusWatch is false. A Front agent on another machine cannot be reached from here and waits for its next watch (1).
// Usage: none; a module, imported by the scripts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ORCA, PROJECT, config, file, writeText } from "./lib.mjs";

export const HEALTH_FILE = "heartbeat-health.md";
// Everything that reaches a file, an agent's input or a sidebar is one line without control characters.
export const oneLine = (text, n = 300) => String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/** The open problems, one line each. An empty list removes the file. Returns true when the file changed. */
export function writeHealth(lines) {
  const text = lines.map((l) => `- ${oneLine(l)}`).join("\n");
  let current = "";
  try { current = fs.readFileSync(file(HEALTH_FILE), "utf8").trim(); } catch { /* none yet */ }
  if (current === text) return false;
  if (!text) fs.rmSync(file(HEALTH_FILE), { force: true });
  else writeText(HEALTH_FILE, `${text}\n`);
  return true;
}

// Alerts that outlive one heartbeat run (heartbeat.alerts.json: key → line). The heartbeat adds them to every health file it
// writes, so a hang check does not erase them; whoever raised one clears it when the problem is gone.
const ALERTS_FILE = "heartbeat.alerts.json";
const readAlerts = () => { try { const v = JSON.parse(fs.readFileSync(file(ALERTS_FILE), "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };
export const alertLines = () => Object.values(readAlerts()).map(String);
export const hasAlert = (key) => key in readAlerts();
export function clearAlert(key) {
  const all = readAlerts();
  if (!(key in all)) return;
  const gone = all[key];
  delete all[key];
  try { writeHealth(fs.readFileSync(file(HEALTH_FILE), "utf8").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2)).filter((l) => l !== gone)); } catch { /* no health file */ }
  try { if (Object.keys(all).length) fs.writeFileSync(file(ALERTS_FILE), JSON.stringify(all)); else fs.rmSync(file(ALERTS_FILE), { force: true }); } catch { /* retried */ }
}
/**
 * Makes the alert true now, from what the caller sees on disk: raised (and told) when it is missing, and, when it is already
 * known, only put back into the health file if that lost it. A corrupt alerts file reads as empty and is rebuilt here.
 */
export function ensureAlert(key, text, opts) {
  if (key in readAlerts()) {
    let current = [];
    try { current = fs.readFileSync(file(HEALTH_FILE), "utf8").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2)); } catch { /* none yet */ }
    const line = oneLine(readAlerts()[key]);
    if (!current.includes(line)) writeHealth([...current, line]);
    return [];
  }
  return raiseAlert(key, text, opts);
}
/** Raises an alert on all three channels: the health file (also for a Front agent on another machine), front-events.log, and at once where reachable. */
export function raiseAlert(key, text, { type = "question", kind = key } = {}) {
  const all = readAlerts();
  all[key] = oneLine(text);
  try { fs.writeFileSync(file(ALERTS_FILE), JSON.stringify(all)); } catch { /* read-only directory */ }
  let current = [];
  try { current = fs.readFileSync(file(HEALTH_FILE), "utf8").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2)); } catch { /* none yet */ }
  writeHealth([...current.filter((l) => l !== all[key]), all[key]]);
  return tellFront(kind, text, { type });
}

// The Controller is on another machine than the Front agent when its host is a remote one in the configuration.
const controllerRemote = () => (config.hosts?.workers ?? []).some((h) => h.name === (config.hosts?.controller?.host ?? "local") && h.kind === "remote");

/**
 * Appends the event to front-events.log and delivers it where it can be reached from here. `type` is "question" for something
 * the human must decide and "status" for the rest. `push: false` only records it (3 is skipped). Returns what was done, for the log;
 * never throws.
 */
export function tellFront(kind, text, { type = "status", from, push = true } = {}) {
  const done = [], line = oneLine(text);
  try { fs.appendFileSync(file("front-events.log"), `${new Date().toISOString()} FRONT-EVENT ${kind}: ${line}\n`); done.push("front-events.log"); } catch { /* read-only directory */ }
  if (!push || controllerRemote()) return done;
  const front = config.hosts?.frontAgent ?? {};
  try {
    if (front.kind === "orca-bot" && front.bot) {
      execFileSync(ORCA, ["orchestration", "send", "--to", `bot:${front.bot}`, "--type", type, "--subject", kind, "--body", `${kind}: ${line}`, ...(from ? ["--from", from] : []), "--json"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
      done.push(`bot ${front.bot}`);
    } else if ((!front.kind || front.kind === "terminal") && front.statusWatch !== false) {
      const watch = path.join(os.homedir(), "front-agent", PROJECT, "statuswatch.mjs");
      if (fs.existsSync(watch)) { execFileSync("node", [watch], { encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] }); done.push("statuswatch"); }
    }
  } catch (error) { done.push(`not delivered at once (${oneLine(error.message, 100)})`); }
  return done;
}
