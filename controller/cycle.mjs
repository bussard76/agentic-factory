// The Controller's own word about where it is in its loop, so the heartbeat does not have to read it off Orca or the screen.
//   node cycle.mjs start  first act of a cycle: removes controller.waiting.json (the marker) and prints the worker mail it has not
//                         printed as handled before; what it printed is kept in mail.read.json
//   node cycle.mjs end    last act of a cycle, after status.md is written and wait.mjs is armed: records the mail printed by `start`
//                         as handled (mail.handled.json: the heartbeat stops counting it, as inbox.mjs --done does for inbox.md) and
//                         writes the marker, which says "my cycle is over, I sit at my prompt, type to me when there is something"
// The marker is only trusted while nothing contradicts it (heartbeat.mjs): status.md newer than it, output in the terminal a moment ago,
// a confirmation question on the screen, or a restart since all mean the Controller is working after all. A cycle that crashes before
// `end` handled nothing. A Controller whose handbook does not know this script never writes a marker, and the heartbeat then acts as
// it always did.
// Usage: node cycle.mjs start|end
import "./cli.mjs";
import fs from "node:fs";
import { RUNNER, file, orcaJson, writeJson } from "./lib.mjs";

const MARKER = "controller.waiting.json", READ = "mail.read.json", HANDLED = "mail.handled.json", KEEP = 500, SHOW = 30;
const [mode] = process.argv.slice(2);
if (mode !== "start" && mode !== "end") { console.error("usage: node cycle.mjs start|end"); process.exit(1); }
const ids = (name) => { try { const v = JSON.parse(fs.readFileSync(file(name), "utf8")); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } };

if (mode === "end") {
  // Mail this cycle read becomes handled only now: a Controller that died mid-cycle acted on none of it.
  const read = ids(READ);
  if (read.length) { writeJson(HANDLED, [...new Set([...ids(HANDLED), ...read])].slice(-KEEP)); fs.rmSync(file(READ), { force: true }); }
  writeJson(MARKER, { at: Date.now() });
  console.log(`marked as waiting${read.length ? `; ${read.length} message(s) recorded as handled` : ""}: the heartbeat may type a wake line into this terminal when there is work`);
  process.exit(0);
}

// start: clear the marker first, whatever happens next.
fs.rmSync(file(MARKER), { force: true });
if (RUNNER !== "orca") { console.log("no worker mail (runner is not orca)"); process.exit(0); }
let messages;
try {
  const j = orcaJson(["orchestration", "inbox", "--limit", "200"]);
  if (!Array.isArray(j?.result?.messages)) throw new Error("no message list");
  messages = j.result.messages.filter((m) => m && typeof m.id === "string" && m.type !== "status" && m.type !== "heartbeat");
} catch (error) {
  console.log(`worker mail not read (${String(error.message).split("\n")[0].slice(0, 120)}): run \`orca orchestration inbox --limit 200 --json\` yourself; nothing was recorded`);
  process.exit(0);
}
const handled = new Set(ids(HANDLED));
const open = messages.filter((m) => !handled.has(m.id));
// The newest ones in full; older ones by count (the Controller's context is not a log). All of them count as read.
for (const m of open.slice(-SHOW)) console.log(["#", m.id, m.type, m.from ?? "", m.subject ?? "", "|", String(m.body ?? "").slice(0, 2000)].map(String).join(" "));
if (open.length > SHOW) console.log(`(${open.length - SHOW} older message(s) not shown: \`orca orchestration inbox --limit 200 --json\` lists them)`);
if (!open.length) console.log(`(no worker mail that was not handled before${messages.length ? `; ${messages.length} older message(s) already handled` : ""})`);
writeJson(READ, open.map((m) => m.id));
