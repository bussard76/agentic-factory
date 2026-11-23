// ~/.local/bin/gate is shared by every project on a host. It is only a dispatcher (controller/gate): it runs the gate.mjs of the
// Controller directory of the project it is called in. So start installs it only when its content differs, never over a dispatcher
// with a higher "# gate-shim: N" number, and by writing a temporary file and renaming it, so a running gate never reads half a file.
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./safe-write.mjs";

const number = (text) => Number(/^# gate-shim: *(\d+)/m.exec(text)?.[1] ?? 0);

/** Installs the dispatcher at <home>/.local/bin/gate. Returns { changed, kept, message }. Throws when it cannot write. */
export function installGate(src, home) {
  const dst = path.join(home, ".local/bin/gate");
  const next = fs.readFileSync(src, "utf8");
  let have = null; try { have = fs.readFileSync(dst, "utf8"); } catch {}
  if (have !== null && number(have) > number(next)) return { changed: false, kept: true, message: "Gate: ~/.local/bin/gate is a newer dispatcher (from a newer factory); left as it is" };
  const changed = writeFileAtomic(dst, next, 0o755);
  return { changed, kept: false, message: `Gate: ~/.local/bin/gate ${changed ? "installed" : "already up to date"} (dispatcher: runs the gate.mjs of the project's own Controller directory)` };
}
