// Writes a file other programs may read at any moment: into a temporary file in the same directory, then a rename, so a reader sees the
// old or the new content, never half of it. Nothing is written when the file already has that content and mode. A symlinked file
// (dotfiles managers do this) is written through to its target.
import fs from "node:fs";
import path from "node:path";

/** Returns true when it wrote, false when the file already had `text` (a string or a Buffer) and `mode`. The mode is set before the rename. */
export function writeFileAtomic(file, text, mode = 0o644) {
  let target = file;
  try { target = fs.realpathSync(file); } catch {}
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  try { if (fs.readFileSync(target).equals(bytes) && (fs.statSync(target).mode & 0o777) === mode) return false; } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  try { fs.writeFileSync(tmp, bytes, { mode }); fs.chmodSync(tmp, mode); fs.renameSync(tmp, target); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  return true;
}

/** Runs fn while holding the directory lock `<file>.lock` (mkdir is atomic). A lock older than 30 s is a dead holder's and is taken over. */
export function withLock(file, fn) {
  const lock = `${file}.lock`;
  for (let tries = 0; ; tries++) {
    try { fs.mkdirSync(lock); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) { fs.rmdirSync(lock); continue; } } catch {}
      if (tries > 100) throw new Error(`${lock} is held by another run`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}

/**
 * Copies the tree `src` into `dst` file by file through writeFileAtomic (mode of the source kept), leaving files that have no source
 * alone, like fs.cpSync(…, { force: true }) but without a moment in which a script that is run or read is empty or half written.
 * Returns the paths that were written.
 */
export function copyTreeAtomic(src, dst) {
  const written = [];
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name), to = path.join(dst, e.name);
    if (e.isDirectory()) written.push(...copyTreeAtomic(from, to));
    else if (e.isSymbolicLink()) { fs.mkdirSync(dst, { recursive: true }); fs.rmSync(to, { force: true }); fs.cpSync(from, to, { dereference: false }); }
    else if (writeFileAtomic(to, fs.readFileSync(from), fs.statSync(from).mode & 0o777)) written.push(to);
  }
  fs.mkdirSync(dst, { recursive: true });
  return written;
}
