// The Controller's own word about where it is in its loop, so the heartbeat does not have to read it off Orca or the screen.
//   node cycle.mjs start  first act of a cycle: removes controller.waiting.json (the marker) and prints every worker message it has
//                         not recorded as handled, in full; exactly what it printed is kept in mail.read.json, with the time and
//                         the terminal of the session that read it
//   node cycle.mjs end    last act of a cycle, after status.md is written and wait.mjs is armed: records what `start` printed as
//                         handled (mail.handled.json: the heartbeat stops counting it, as inbox.mjs --done does for inbox.md) and
//                         writes the marker, which says "my cycle is over, I sit at my prompt, type to me when there is something"
// Both commands act only from the Controller's own terminal: ORCA_TERMINAL_HANDLE must be set and equal the handle `start` recorded in
// controller-terminal.txt. Run by anything else (a worker, a person in another terminal, a shell without the variable) or with no
// record to compare with, they say so and change nothing: a marker written by a session that is not the Controller would stand
// in front of the heartbeat's wake.
// What counts as handled is exactly what a `start` printed in this session since the last restart: a list left by a session that
// died, by a restart, or by another terminal is thrown away at `end` and its mail stays new; mail that was not printed (more than 200
// messages in Orca's list, or mail that arrived later) stays new too. Nothing is cut: a message is printed whole or not recorded.
// The marker is only trusted while nothing contradicts it (heartbeat.mjs): status.md newer than it, output in the terminal a moment ago,
// a confirmation question on the screen, or a restart since all mean the Controller is working after all. A Controller whose handbook
// does not know this script never writes a marker, and the heartbeat then acts as it always did.
// Usage: node cycle.mjs start|end
import "./cli.mjs";
import fs from "node:fs";
import { RUNNER, file, orcaJson, writeJson } from "./lib.mjs";

const MARKER = "controller.waiting.json", READ = "mail.read.json", HANDLED = "mail.handled.json", KEEP = 500;
const [mode] = process.argv.slice(2);
if (mode !== "start" && mode !== "end") { console.error("usage: node cycle.mjs start|end"); process.exit(1); }
const json = (name) => { try { return JSON.parse(fs.readFileSync(file(name), "utf8")); } catch { return null; } };
const ids = (name) => { const v = json(name); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; };
const handle = process.env.ORCA_TERMINAL_HANDLE ?? null;
// The session is the terminal and the agent session Orca started in it (ORCA_AGENT_SESSION_ID, new for every launch of an agent): a
// list read by an agent that was relaunched in the same terminal is not the new agent's.
const session = `${handle}|${process.env.ORCA_AGENT_SESSION_ID ?? ""}`;
let recorded = "";
try { recorded = fs.readFileSync(file("controller-terminal.txt"), "utf8").split("\n")[0].trim(); } catch { /* no record */ }
const refuse = !handle ? "ORCA_TERMINAL_HANDLE is not set, so this cannot be shown to be the Controller's terminal" : !recorded ? "there is no controller-terminal.txt, so there is no recorded Controller terminal to compare with" : recorded !== handle ? `this is terminal ${handle}, not the Controller's (${recorded})` : "";
if (refuse) { console.log(`cycle.mjs ${mode}: ${refuse}: nothing was changed`); process.exit(0); }

if (mode === "end") {
  const read = json(READ);
  fs.rmSync(file(READ), { force: true });
  let recorded = 0, dropped = "";
  if (read && Array.isArray(read.ids) && read.ids.length) {
    const restartedAt = Number(json("heartbeat.restarted.json")?.at ?? 0);
    if (!Number.isFinite(Number(read.at)) || Number(read.at) <= restartedAt) dropped = "it was read before the last restart";
    else if ((read.session ?? null) !== session) dropped = "it was read by another session";
    else { writeJson(HANDLED, [...new Set([...ids(HANDLED), ...read.ids.filter((x) => typeof x === "string")])].slice(-KEEP)); recorded = read.ids.length; }
  }
  writeJson(MARKER, { at: Date.now(), startedAt: read?.at ?? null });
  console.log(`marked as waiting${recorded ? `; ${recorded} message(s) recorded as handled` : ""}${dropped ? `; the mail list of an earlier session was not recorded (${dropped}): that mail stays new` : ""}: the heartbeat may type a wake line into this terminal when there is work`);
  process.exit(0);
}

// start: clear the marker first, whatever happens next. A list that a dead session left is replaced below or dropped.
fs.rmSync(file(MARKER), { force: true });
if (RUNNER !== "orca") { fs.rmSync(file(READ), { force: true }); console.log("no worker mail (runner is not orca)"); process.exit(0); }
let messages;
try {
  const j = orcaJson(["orchestration", "inbox", "--limit", "200", "--full"]);
  if (!Array.isArray(j?.result?.messages)) throw new Error("no message list");
  messages = j.result.messages.filter((m) => m && typeof m.id === "string" && m.type !== "status" && m.type !== "heartbeat");
} catch (error) {
  fs.rmSync(file(READ), { force: true });
  console.log(`worker mail not read (${String(error.message).split("\n")[0].slice(0, 120)}): run \`orca orchestration inbox --limit 200 --full --json\` yourself; nothing was recorded`);
  process.exit(0);
}
const handled = new Set(ids(HANDLED));
const open = messages.filter((m) => !handled.has(m.id));
for (const m of open) console.log(["#", m.id, m.type, m.from ?? "", m.subject ?? "", "|", String(m.body ?? "")].map(String).join(" "));
if (!open.length) console.log(`(no worker mail that was not handled before${messages.length ? `; ${messages.length} older message(s) already handled` : ""})`);
writeJson(READ, { at: Date.now(), session, ids: open.map((m) => m.id) });
