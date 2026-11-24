// The Controller's way to read inbox.md and to hand the lines it dealt with to inbox-done.md, so the heartbeat wakes it only for a
// line that is new.
//   node inbox.mjs         prints the complete lines of inbox.md and remembers exactly how many bytes it printed (inbox.read.json)
//   node inbox.mjs --done  moves exactly those lines to inbox-done.md and leaves what arrived since in inbox.md
// One step for the Controller: run --done once the printed lines are dealt with. It refuses, changing nothing, when the start of the
// file is no longer what was printed (somebody edited it); read again then. A line that arrives between the two steps was not printed
// and stays; a half-written last line is neither printed nor moved. The heartbeat counts what comes after the prefix recorded in
// inbox.handled.json (bytes and hash) as new, and a file that does not start with that prefix, or no record, as all new: it never
// writes the record. Lines are never compared by their text, so the same words sent twice are two lines.
// Usage: node inbox.mjs [--done]
import "./cli.mjs";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { file, writeJson } from "./lib.mjs";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const readBytes = () => { try { return fs.readFileSync(file("inbox.md")); } catch { return Buffer.alloc(0); } };
const readJson = (name) => { try { const v = JSON.parse(fs.readFileSync(file(name), "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; } };
/** The bytes up to and including the last newline: a line still being written is not a line yet. */
const complete = (buf) => buf.subarray(0, buf.lastIndexOf(10) + 1);
const lines = (buf) => buf.toString("utf8").split("\n").filter((l) => l.trim()).length;

/** How many lines of inbox.md are new: those after a prefix that matches the record, else all of them. */
export function newLines(buf = readBytes(), handled = readJson("inbox.handled.json")) {
  const n = Number(handled?.bytes);
  if (handled && Number.isInteger(n) && n >= 0 && n <= buf.length && sha(buf.subarray(0, n)) === handled.hash) return lines(buf.subarray(n));
  return lines(buf);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--done")) {
    const read = readJson("inbox.read.json");
    if (!read || !Number.isInteger(read.bytes)) { console.error("inbox.mjs: nothing was read yet; run `node inbox.mjs` first"); process.exit(1); }
    const lock = file("inbox.lock.d");
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.rmdirSync(lock); } catch { /* none */ }
    try { fs.mkdirSync(lock); } catch { console.error("inbox.mjs: another run is moving lines; try again in a moment"); process.exit(1); }
    try {
      const buf = readBytes();
      if (read.bytes > buf.length || sha(buf.subarray(0, read.bytes)) !== read.hash) { console.error("inbox.mjs: inbox.md no longer starts with what you read; nothing was moved. Run `node inbox.mjs` again."); process.exit(1); }
      const done = buf.subarray(0, read.bytes), rest = buf.subarray(read.bytes);
      if (done.length) fs.appendFileSync(file("inbox-done.md"), done);
      // In place, as one write and one truncate: a writer that appends with `cat >>` never meets a replaced file.
      const fd = fs.openSync(file("inbox.md"), "r+");
      try { fs.writeSync(fd, rest, 0, rest.length, 0); fs.ftruncateSync(fd, rest.length); } finally { fs.closeSync(fd); }
      writeJson("inbox.handled.json", { bytes: 0, hash: sha(Buffer.alloc(0)) });
      fs.rmSync(file("inbox.read.json"), { force: true });
      console.log(`moved ${lines(done)} line(s) to inbox-done.md; ${lines(rest)} line(s) arrived since you read it and stay in inbox.md`);
    } finally { try { fs.rmdirSync(lock); } catch { /* gone */ } }
  } else {
    const printed = complete(readBytes());
    writeJson("inbox.read.json", { bytes: printed.length, hash: sha(printed) });
    process.stdout.write(lines(printed) ? printed : "(inbox.md is empty)\n");
  }
}
