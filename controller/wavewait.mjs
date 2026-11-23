// Polls the wave (Orca terminal, local log or remote log) until WAVE-END appears, then prints the filtered tail.
// Times out after 90 minutes.
import fs from "node:fs";
import { CONTROLLER_HOME, ORCA, RUNNER, clean, file, hostNamed, journal, onHost, orcaEnvArgsOn, trySh } from "./lib.mjs";

const [hostName, h] = fs.readFileSync(file("wave-handle.txt"), "utf8").trim().split(" ");
const host = hostNamed(hostName);
const end = Date.now() + 90 * 60e3;
while (Date.now() < end) {
  let text = "";
  if (RUNNER === "orca") {
    try { const r = JSON.parse(trySh(ORCA, ["terminal", "read", "--terminal", h, ...orcaEnvArgsOn(host), "--json"]) || "{}").result ?? {}; text = r.terminal?.tail ?? r.tail ?? r.lines ?? r.text ?? ""; if (Array.isArray(text)) text = text.join("\n"); } catch {}
  } else if (host.kind === "local") { if (fs.existsSync(file("logs/wave.log"))) text = fs.readFileSync(file("logs/wave.log"), "utf8"); }
  else text = onHost(host, `cat ${CONTROLLER_HOME}/logs/wave.log 2>/dev/null`);
  const lines = text.split("\n");
  // Exact lines only: a file name or a test's output that contains WAVE-END must not end the wait.
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim());
  if (plain.includes("WAVE-END")) {
    // Which gate path the wave took (docsOnly.enabled), so the audit can count full gates per task.
    const gatePath = plain.map((l) => /^GATE-PATH (docs-only|full): (.*)$/.exec(l)).filter(Boolean).at(-1);
    if (gatePath) journal("gate", "wave", { path: gatePath[1], reason: gatePath[2].slice(0, 200), pushed: plain.some((l) => /^PUSHED \S+$/.test(l)) });
    console.log(clean(lines.slice(-25).join("\n"))); process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 30000));
}
console.log("TIMEOUT");
