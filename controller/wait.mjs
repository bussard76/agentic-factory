// Wait for the next worker event and print it. Orca: orchestration messages (worker_done, escalation, question),
// acknowledged after printing. Terminal runner: new DONE/ESCALATE lines under events/. Exits after the first real event
// or after --hours (default 4). Run it in the background and react to its output.
import fs from "node:fs";
import path from "node:path";
import { RUNNER, file, orcaJson } from "./lib.mjs";

const hi = process.argv.indexOf("--hours");
const hours = hi >= 0 ? Number(process.argv[hi + 1]) : 4;
if (!Number.isFinite(hours) || hours <= 0) throw new Error("--hours needs a positive number");
const end = Date.now() + hours * 3600e3;

if (RUNNER === "orca") {
  let ack;
  while (Date.now() < end) {
    let j;
    try { j = orcaJson(["orchestration", "check", "--wait", "--types", "worker_done,escalation,question", "--timeout-ms", "900000", ...(ack ? ["--ack", ack] : [])]); }
    catch (e) { console.log(`orca check failed (${String(e.message).split("\n")[0].slice(0, 120)}), retrying in 30 s`); await new Promise((r) => setTimeout(r, 30000)); continue; }
    ack = undefined;
    const msgs = j.result?.messages ?? [];
    const real = msgs.filter((m) => m.type !== "heartbeat" && !(m.type === "status" && /Setup succeeded/.test(m.subject ?? "")));
    if (real.length) {
      console.log("delivery", j.result.deliveryId, "(ack it with: orca orchestration check --ack <delivery> --json)");
      for (const m of real) console.log("#", m.id, m.type, m.subject ?? "", JSON.parse(m.payload || "{}").dispatchId ?? "", "|", m.body ?? "");
      process.exit(0);
    }
    if (msgs.length) ack = j.result.deliveryId;
  }
} else {
  const dir = file("events"); fs.mkdirSync(dir, { recursive: true });
  const seen = new Map(fs.readdirSync(dir).map((f) => [f, fs.statSync(path.join(dir, f)).size]));
  while (Date.now() < end) {
    for (const f of fs.readdirSync(dir)) {
      const size = fs.statSync(path.join(dir, f)).size;
      if (size > (seen.get(f) ?? 0)) {
        const added = fs.readFileSync(path.join(dir, f), "utf8").slice(seen.get(f) ?? 0).trim();
        if (/^(DONE|ESCALATE)\b/m.test(added)) { console.log("#", f.replace(/\.md$/, ""), "|", added); process.exit(0); }
        seen.set(f, size);
      }
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
}
console.log(`no event after ${hours}h`);
