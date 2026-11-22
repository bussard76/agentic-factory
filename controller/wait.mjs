// Wait for the next worker event and print it. Orca: orchestration messages (worker_done, escalation, question),
// which the check marks handled (an older Orca returns a deliveryId to ack). Terminal runner: new DONE/ESCALATE lines under events/. Exits after the first real event
// or after --hours (default 4). Run it in the background and react to its output.
import fs from "node:fs";
import path from "node:path";
import { RUNNER, file, orcaJson } from "./lib.mjs";

const hi = process.argv.indexOf("--hours");
const hours = hi >= 0 ? Number(process.argv[hi + 1]) : 4;
if (!Number.isFinite(hours) || hours <= 0) throw new Error("--hours needs a positive number");
const end = Date.now() + hours * 3600e3;
// Orca's concise view gives the payload as an object, --full and older versions as a JSON string; either may be missing.
const dispatchOf = (payload) => {
  let p = payload;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = null; } }
  return p && typeof p === "object" && typeof p.dispatchId === "string" ? p.dispatchId : "";
};

// Never longer than the window that is left, so a small --hours ends on time.
const pause = () => new Promise((r) => setTimeout(r, Math.max(0, Math.min(30000, end - Date.now()))));

if (RUNNER === "orca") {
  let ack;
  while (Date.now() < end) {
    let j;
    try { j = orcaJson(["orchestration", "check", "--wait", "--types", "worker_done,escalation,question", "--timeout-ms", "900000", "--full", ...(ack ? ["--ack", ack] : [])]); }   // --full: the whole body, not a 200-character preview
    catch (e) { console.log(`orca check failed (${String(e.message).split("\n")[0].slice(0, 120)}), retrying in 30 s`); await pause(); continue; }
    ack = undefined;
    // ok:false or a result without a message list is no answer: log it raw (it may hold mail) and pause instead of spinning.
    if (!j || typeof j !== "object" || j.ok === false || !Array.isArray(j.result?.messages)) {
      let raw; try { raw = JSON.stringify(j).slice(0, 2000); } catch { raw = String(j); }
      console.log(`orca check returned no message list, retrying in 30 s: ${raw}`); await pause(); continue;
    }
    // The check has already marked this batch handled, so nothing below may throw: a crash here loses the mail.
    const msgs = j.result.messages.filter((m) => m && typeof m === "object");
    const real = msgs.filter((m) => m.type !== "heartbeat" && !(m.type === "status" && /Setup succeeded/.test(String(m.subject ?? ""))));
    const delivery = j?.result?.deliveryId;
    if (real.length) {
      if (delivery) console.log("delivery", delivery, "(ack it with: orca orchestration check --ack <delivery> --json)");
      for (const m of real) {
        try {
          if (typeof m.id !== "string" || typeof m.type !== "string") throw new Error("no id or type");
          console.log("#", m.id, m.type, m.subject ?? "", dispatchOf(m.payload), "|", m.body ?? "");
        }
        catch { let raw; try { raw = JSON.stringify(m); } catch { raw = `${m.id} ${m.type}`; } console.log("# raw", raw); }
      }
      process.exit(0);
    }
    if (msgs.length && delivery) ack = delivery;
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
