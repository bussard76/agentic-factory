// The Controller's way to read inbox.md and to say how far it has handled it, so the heartbeat wakes it only for a line that is new.
//   node inbox.mjs         prints the complete lines after the handled part of inbox.md and remembers where it stopped (inbox.read.json)
//   node inbox.mjs --done  records that everything printed is handled (inbox.handled.json) and copies those lines to inbox-done.md
// inbox.md is append-only for everybody, this script included: nothing here ever writes, replaces, renames or truncates it, so a line
// the Front agent appends with `cat >>` at any moment, also while this runs, can never be lost (no lock is needed or possible for
// a writer that only appends). What was handled is a byte offset and the hash of the file's start up to it. The heartbeat counts what
// lies after a matching prefix as new, and a file whose start no longer matches (edited by hand, replaced, archived) or no record at all
// as all new: never silence. A half-written last line is neither printed nor counted. Run --done once the printed lines are dealt with.
// Usage: node inbox.mjs [--done]
import "./cli.mjs";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { file, writeJson } from "./lib.mjs";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const readBytes = () => { try { return fs.readFileSync(file("inbox.md")); } catch { return Buffer.alloc(0); } };   // no inbox is an empty inbox
const readJson = (name) => { try { const v = JSON.parse(fs.readFileSync(file(name), "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; } };
const lines = (buf) => buf.toString("utf8").split("\n").filter((l) => l.trim()).length;
/** The offset of the end of the handled part, or 0 when there is no usable record or the file no longer starts with it. */
function handledOffset(buf, record) {
  const n = Number(record?.bytes);
  return record && Number.isInteger(n) && n >= 0 && n <= buf.length && typeof record.hash === "string" && sha(buf.subarray(0, n)) === record.hash ? n : 0;
}
/** The bytes up to and including the last newline after `from`: a line still being written is not a line yet. */
const completeEnd = (buf, from) => { const i = buf.subarray(from).lastIndexOf(10); return i < 0 ? from : from + i + 1; };

/** How many lines of inbox.md are new: those after a matching handled prefix, else all of them. The marker format of an earlier
 *  version of this file ({bytes: 0, hash of nothing}) and main's (no record at all) mean the same: everything is new. */
export function newLines(buf = readBytes(), handled = readJson("inbox.handled.json")) {
  return lines(buf.subarray(handledOffset(buf, handled)));
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
    writeJson("inbox.handled.json", { bytes: read.bytes, hash: read.hash });
    fs.rmSync(file("inbox.read.json"), { force: true });
    console.log(`handled ${lines(done)} line(s); ${newLines(buf)} line(s) arrived since you read it and are still new`);
  } else {
    const from = handledOffset(buf, readJson("inbox.handled.json")), end = completeEnd(buf, from);
    writeJson("inbox.read.json", { from, bytes: end, hash: sha(buf.subarray(0, end)) });
    const printed = buf.subarray(from, end);
    process.stdout.write(lines(printed) ? printed : "(no new lines in inbox.md)\n");
  }
}
