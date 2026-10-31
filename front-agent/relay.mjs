// Transition helper: forwards Orca worker events addressed to this machine to the Controller's events.md (local file
// or over ssh on the controller host), filtered for secrets, and acknowledges them here. Needed only while workers
// started from this machine are still running and the Controller lives elsewhere. Runs until killed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { controllerHost, expand, loadConfig } from "./hosts.mjs";

const cfg = loadConfig(path.dirname(new URL(import.meta.url).pathname));
const host = controllerHost(cfg);
const ctlDir = cfg.hosts.controller?.controllerDir ?? "~/controller";
const clean = (s) => s.split("\n").filter((l) => !/pair|token|code=/i.test(l)).join("\n");
const forward = (text) => {
  if (host.kind === "local") fs.appendFileSync(path.join(expand(ctlDir), "events.md"), text + "\n");
  else execFileSync("ssh", [...(host.sshConfig ? ["-F", expand(host.sshConfig)] : []), host.ssh, `cat >> ${ctlDir}/events.md`], { input: text + "\n" });
};
for (;;) {
  let j;
  try {
    const raw = execFileSync("orca", ["orchestration", "check", "--wait", "--types", "worker_done,escalation,question,status", "--timeout-ms", "900000", "--json"], { encoding: "utf8", maxBuffer: 1 << 26 });
    j = JSON.parse(raw.split("\n").filter((l) => !l.includes('"_keepalive"')).join("\n"));
  } catch { await new Promise((r) => setTimeout(r, 30000)); continue; }
  const msgs = (j.result?.messages ?? []).filter((m) => m.type !== "heartbeat");
  if (msgs.length) {
    const text = clean(msgs.map((m) => `- ${new Date().toISOString().slice(0, 16)} [${m.type}] ${m.subject ?? ""} (dispatch ${JSON.parse(m.payload || "{}").dispatchId ?? "?"}, relay ${m.id}): ${m.body ?? ""}`).join("\n"));
    try { forward(text); console.log(text); } catch (e) { console.log("forward failed", String(e).slice(0, 200)); continue; }
  }
  if (j.result?.deliveryId) execFileSync("orca", ["orchestration", "check", "--ack", j.result.deliveryId, "--json"]);
}
