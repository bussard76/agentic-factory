// The Controller's way to read inbox.md and to say how far it has handled it, so the heartbeat wakes it only for a line that is new.
//   node inbox.mjs         prints the complete lines after the handled part of inbox.md and remembers where it stopped (inbox.read.json)
//   node inbox.mjs --done  records that everything printed is handled (inbox.handled.json) and copies those lines to inbox-done.md
// inbox.md is append-only for everybody, this script included: nothing here ever writes, replaces, renames or truncates it, so a line
// the Front agent appends with `cat >>` at any moment, also while this runs, can never be lost (no lock is needed or possible for
// a writer that only appends). What was handled is a byte offset and the hash of the file's start up to it. The heartbeat counts what
// lies after a matching prefix as new, and a file whose start no longer matches (edited by hand, replaced, archived) or no record at all
// as all new: never silence. A last line without its newline is shown and counted like any other once the file has been unchanged for
// a minute (a writer caught mid-append is not cut in half); until then it is neither printed nor counted. The record also holds the
// file's inode, creation time and size, so a file that was replaced or emptied by hand and refilled with the same text counts as all
// new. Run --done once the printed lines are dealt with.
// Usage: node inbox.mjs [--done]
import "./cli.mjs";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { file, writeJson } from "./lib.mjs";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const readBytes = () => { try { return fs.readFileSync(file("inbox.md")); } catch { return Buffer.alloc(0); } };   // no inbox is an empty inbox
const readJson = (name) => { try { const v = JSON.parse(fs.readFileSync(file(name), "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; } };
const SETTLE_MS = 60_000;
const statInbox = () => { try { return fs.statSync(file("inbox.md")); } catch { return null; } };
const lines = (buf) => buf.toString("utf8").split("\n").filter((l) => l.trim()).length;
/** The offset of the end of the handled part, or 0 when there is no usable record or the file no longer starts with it. */
function handledOffset(buf, record, st = statInbox()) {
  const n = Number(record?.bytes);
  if (!record || !Number.isInteger(n) || n < 0 || n > buf.length || typeof record.hash !== "string" || sha(buf.subarray(0, n)) !== record.hash) return 0;
  // The same file: a record without its identity (an earlier format), a replaced file (inode or creation time), or one that is smaller
  // than when the record was made (emptied, then refilled) is not this file's.
  if (!st || record.ino !== st.ino || record.birth !== Math.round(st.birthtimeMs) || !Number.isInteger(record.size) || buf.length < record.size) return 0;
  return n;
}
const identity = (st, size) => ({ ino: st.ino, birth: Math.round(st.birthtimeMs), size });
/** The end of the lines after `from`: the last newline, or the end of the file once a last line without one has been left alone for a
 *  minute (`settled`): a line still being written is not a line yet. */
const completeEnd = (buf, from, settled) => { const i = buf.subarray(from).lastIndexOf(10); return settled ? buf.length : i < 0 ? from : from + i + 1; };
const isSettled = (st = statInbox()) => !st || Date.now() - st.mtimeMs >= SETTLE_MS;

/** How many lines of inbox.md are new: those after a matching handled prefix, else all of them. The marker format of an earlier
 *  version of this file ({bytes: 0, hash of nothing}) and main's (no record at all) mean the same: everything is new. */
export function newLines(buf = readBytes(), handled = readJson("inbox.handled.json"), st = statInbox()) {
  const from = handledOffset(buf, handled, st);
  return lines(buf.subarray(from, completeEnd(buf, from, isSettled(st))));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const buf = readBytes();
  if (process.argv.includes("--done")) {
    const read = readJson("inbox.read.json");
    if (!read || !Number.isInteger(read.bytes) || !Number.isInteger(read.from)) {
      if (!buf.length) { console.log("inbox.md is empty: nothing to hand over"); process.exit(0); }
      console.error("inbox.mjs: nothing was read yet; run `node inbox.mjs` first"); process.exit(1);
    }
    if (read.bytes > buf.length || sha(buf.subarray(0, read.bytes)) !== read.hash) { console.error("inbox.mjs: inbox.md no longer starts with what you read; nothing was recorded. Run `node inbox.mjs` again."); process.exit(1); }
    const done = buf.subarray(read.from, read.bytes);
    if (done.length) fs.appendFileSync(file("inbox-done.md"), done);   // a copy for the record; inbox.md itself is not touched
    const st = statInbox();
    writeJson("inbox.handled.json", { bytes: read.bytes, hash: read.hash, ...(st ? identity(st, buf.length) : {}) });
    fs.rmSync(file("inbox.read.json"), { force: true });
    console.log(`handled ${lines(done)} line(s); ${newLines(buf)} line(s) arrived since you read it and are still new`);
  } else {
    const st = statInbox(), from = handledOffset(buf, readJson("inbox.handled.json"), st), end = completeEnd(buf, from, isSettled(st));
    writeJson("inbox.read.json", { from, bytes: end, hash: sha(buf.subarray(0, end)) });
    const printed = buf.subarray(from, end);
    process.stdout.write(lines(printed) ? printed : "(no new lines in inbox.md)\n");
  }
}
