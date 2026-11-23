// ~/.local/bin/gate is shared by every project on a host. It is only a dispatcher (controller/gate): it runs the gate.mjs of the
// Controller directory of the project it is called in. ~/.local/bin/gate.mjs is a forwarder (controller/gate-forward.mjs) that catches
// the case where an older factory's start put its old shim back. start installs both only when their content differs, never over
// a higher "gate-shim: N" / "gate-forward: N" number, and by writing a temporary file and renaming it, so a running gate never reads
// half a file.
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./safe-write.mjs";

// The number is on the second line of a file that starts with a shebang; anything else is not one of ours.
const number = (text) => Number(/^#!.*\n(?:#|\/\/) gate-(?:shim|forward): *(\d+)/.exec(text)?.[1] ?? 0);

const GATE = { name: "gate", marker: "gate-shim" }, FORWARD = { name: "gate.mjs", marker: "gate-forward" };

/** What is installed at <home>/.local/bin/gate: "missing", "dispatcher" (with its number), or "older" (a shim of a factory before the dispatcher, or another file). */
export function gateState(home, bundleGate) {
  let text; try { text = fs.readFileSync(path.join(home, ".local/bin/gate"), "utf8"); } catch { return { state: "missing", number: 0 }; }
  const n = number(text);
  if (!n) return { state: "older", number: 0 };
  const ours = bundleGate ? number(fs.readFileSync(bundleGate, "utf8")) : n;
  return { state: n >= ours ? "dispatcher" : "outdated", number: n };
}

function install(src, dst) {
  const next = fs.readFileSync(src, "utf8");
  let have = null; try { have = fs.readFileSync(dst, "utf8"); } catch {}
  if (have !== null && number(have) > number(next)) return { changed: false, kept: true, replaced: false };
  const replaced = have !== null && have !== next && !number(have);
  return { changed: writeFileAtomic(dst, next, 0o755), kept: false, replaced };
}

/** Installs the dispatcher at <home>/.local/bin/gate and the forwarder at gate.mjs. Returns { changed, kept, replaced, message }. Throws when it cannot write. */
export function installGate(src, home, forwardSrc) {
  const bin = path.join(home, ".local/bin");
  const g = install(src, path.join(bin, "gate"));
  if (forwardSrc) { const f = install(forwardSrc, path.join(bin, "gate.mjs")); g.changed ||= f.changed; }
  const message = g.kept ? "Gate: ~/.local/bin/gate is a newer dispatcher (from a newer factory); left as it is"
    : `Gate: ~/.local/bin/gate ${g.changed ? "installed" : "already up to date"} (dispatcher: runs the gate.mjs of the project's own Controller directory)`
      + (g.replaced ? "\n  It replaced the shim of an older factory. If another project on this host still runs an older factory, its start puts that shim back: update it too (its gates are forwarded here meanwhile, with a warning)." : "");
  return { changed: g.changed, kept: g.kept, replaced: g.replaced, message };
}

/**
 * The shell command that start runs on a remote Controller host over ssh: the dispatcher and forwarder (same rules as installGate), the
 * user-level skills, the load logger. It prints "ok" only when the gate files are in place or deliberately kept: a failed install is a
 * failed start, whatever the later steps did.
 */
export function remoteGateScript(remoteDir, remoteLoadlog, quotedProject) {
  return String.raw`mkdir -p ~/.local/bin && v() { sed -n 's|^[#/]* gate-[a-z]*: *\([0-9]*\).*|\1|p' "$1" 2>/dev/null | head -1; } && put() { n=$(v "$1"); o=$(v "$2"); if [ -n "$o" ] && [ -n "$n" ] && [ "$o" -gt "$n" ]; then return 0; fi; cmp -s "$1" "$2" && return 0; install -m 755 "$1" "$2.tmp.$$" && mv -f "$2.tmp.$$" "$2"; } && put ${remoteDir}/gate ~/.local/bin/gate && put ${remoteDir}/gate-forward.mjs ~/.local/bin/gate.mjs && g=ok; for s in ${remoteDir}/skills/*; do n=$(basename "$s"); for t in ~/.claude/skills ~/.agents/skills; do mkdir -p "$t"; [ -e "$t/$n" ] || cp -R "$s" "$t/"; done; done; for p in $(pgrep -f "[b]ash loadlog.sh$" 2>/dev/null); do [ "$(readlink /proc/$p/cwd 2>/dev/null)" = "$(cd ${remoteDir} && pwd)" ] && kill $p; done; pgrep -f "[b]ash ${remoteLoadlog} " >/dev/null || (cd ${remoteDir} && nohup bash ${remoteLoadlog} ${quotedProject} >/dev/null 2>&1 &); [ "$g" = ok ] && echo ok`;
}
