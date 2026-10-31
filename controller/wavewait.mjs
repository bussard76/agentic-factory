// Polls the wave (Orca terminal, local log or remote log) until WAVE-END appears, then prints the filtered tail.
// Times out after 90 minutes.
import fs from "node:fs";
import { ORCA, RUNNER, clean, file, hostNamed, onHost, orcaEnvArgsOn, trySh } from "./lib.mjs";

const [hostName, h] = fs.readFileSync(file("wave-handle.txt"), "utf8").trim().split(" ");
const host = hostNamed(hostName);
const end = Date.now() + 90 * 60e3;
while (Date.now() < end) {
  let text = "";
  if (RUNNER === "orca") {
    try { const r = JSON.parse(trySh(ORCA, ["terminal", "read", "--terminal", h, ...orcaEnvArgsOn(host), "--json"]) || "{}").result ?? {}; text = r.terminal?.tail ?? r.tail ?? r.lines ?? r.text ?? ""; if (Array.isArray(text)) text = text.join("\n"); } catch {}
  } else if (host.kind === "local") { if (fs.existsSync(file("logs/wave.log"))) text = fs.readFileSync(file("logs/wave.log"), "utf8"); }
  else text = onHost(host, "cat ~/controller/logs/wave.log 2>/dev/null");
  const lines = text.split("\n");
  const marker = lines.filter((l) => l.includes("WAVE-END")).at(-1) ?? "";
  if (marker && !/echo WAVE-END/.test(marker)) { console.log(clean(lines.slice(-25).join("\n"))); process.exit(0); }
  await new Promise((r) => setTimeout(r, 30000));
}
console.log("TIMEOUT");
