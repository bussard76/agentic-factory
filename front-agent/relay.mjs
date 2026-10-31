// Transition helper: forwards Orca worker events addressed to this machine to the Controller's events.md on the
// server, filtered for secrets, and acknowledges them here. Needed only while workers started from this machine
// are still running. Runs until killed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname);
const cfg = JSON.parse(fs.readFileSync(process.env.FACTORY_CONFIG ?? path.join(dir, "factory.config.json"), "utf8"));
const hc = cfg.hosts.controller;
const SSH = [...(hc.sshConfig ? ["-F", hc.sshConfig] : []), hc.ssh];
const clean = (s) => s.split("\n").filter((l) => !/pair|token|code=/i.test(l)).join("\n");
for (;;) {
  let j;
  try {
    const raw = execFileSync("orca", ["orchestration", "check", "--wait", "--types", "worker_done,escalation,question,status", "--timeout-ms", "900000", "--json"], { encoding: "utf8", maxBuffer: 1 << 26 });
    j = JSON.parse(raw.split("\n").filter((l) => !l.includes('"_keepalive"')).join("\n"));
  } catch { await new Promise((r) => setTimeout(r, 30000)); continue; }
  const msgs = (j.result?.messages ?? []).filter((m) => m.type !== "heartbeat");
  if (msgs.length) {
    const text = msgs.map((m) => `- ${new Date().toISOString().slice(0, 16)} [${m.type}] ${m.subject ?? ""} (dispatch ${JSON.parse(m.payload || "{}").dispatchId ?? "?"}, relay ${m.id}): ${m.body ?? ""}`).join("\n");
    try { execFileSync("ssh", [...SSH, `cat >> ${hc.controllerDir ?? "~/controller"}/events.md`], { input: clean(text) + "\n" }); console.log(clean(text)); } catch (e) { console.log("forward failed", String(e).slice(0, 200)); continue; }
  }
  if (j.result?.deliveryId) execFileSync("orca", ["orchestration", "check", "--ack", j.result.deliveryId, "--json"]);
}
