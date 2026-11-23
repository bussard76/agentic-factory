// Writes a file other programs may read at any moment: into a temporary file in the same directory, then a rename, so a reader sees the
// old or the new content, never half of it. Nothing is written when the file already has that content and mode. A symlinked file
// (dotfiles managers do this) is written through to its target.
import fs from "node:fs";
import path from "node:path";

/** Returns true when it wrote, false when the file already had `text` and `mode`. */
export function writeFileAtomic(file, text, mode = 0o644) {
  let target = file;
  try { target = fs.realpathSync(file); } catch {}
  try { if (fs.readFileSync(target, "utf8") === text && (fs.statSync(target).mode & 0o777) === mode) return false; } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  try { fs.writeFileSync(tmp, text, { mode }); fs.chmodSync(tmp, mode); fs.renameSync(tmp, target); }
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
