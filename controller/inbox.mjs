// The Controller's way to read inbox.md and to say it has handled it, so the heartbeat wakes it only for a line that is new.
//   node inbox.mjs            prints inbox.md and records which lines it printed (inbox.read.json)
//   node inbox.mjs --handled  commits them: what the Controller read and that is still in inbox.md is handled (inbox.handled.json)
// Run --handled after moving the processed lines to inbox-done.md. A line that arrives between the two steps was not printed, so it
// stays new and wakes the Controller; a line moved out is gone from the record, so the same text sent again wakes it again. The
// heartbeat only reads inbox.handled.json and never writes it: a missing file means every line is new, as before this existed.
// Usage: node inbox.mjs [--handled]
import "./cli.mjs";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { file, writeJson } from "./lib.mjs";

/** Line text → how often it occurs. Blank lines do not count. */
export const lineCounts = (text) => {
  const counts = {};
  for (const line of String(text ?? "").split("\n")) if (line.trim()) { const d = createHash("sha256").update(line.trim()).digest("hex").slice(0, 16); counts[d] = (counts[d] ?? 0) + 1; }
  return counts;
};
const readJson = (name) => { try { const v = JSON.parse(fs.readFileSync(file(name), "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; } };
export const inboxText = () => { try { return fs.readFileSync(file("inbox.md"), "utf8"); } catch { return ""; } };

/** How many lines of inbox.md the Controller has not handled: every line without a record, else the surplus over what was handled. */
export function newLines(text = inboxText(), handled = readJson("inbox.handled.json")) {
  const counts = lineCounts(text);
  if (!handled) return Object.values(counts).reduce((a, b) => a + b, 0);
  return Object.entries(counts).reduce((sum, [d, n]) => sum + Math.max(0, n - (Number(handled[d]) || 0)), 0);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--handled")) {
    const read = readJson("inbox.read.json");
    if (!read) { console.error("inbox.mjs: nothing was read yet; run `node inbox.mjs` first"); process.exit(1); }
    const now = lineCounts(inboxText());
    const handled = Object.fromEntries(Object.entries(read).map(([d, n]) => [d, Math.min(Number(n) || 0, now[d] ?? 0)]).filter(([, n]) => n > 0));
    writeJson("inbox.handled.json", handled);
    console.log(`handled; ${newLines(inboxText(), handled)} line(s) in inbox.md arrived since you read it`);
  } else {
    const text = inboxText();
    writeJson("inbox.read.json", lineCounts(text));
    process.stdout.write(text.trim() ? text : "(inbox.md is empty)\n");
  }
}
