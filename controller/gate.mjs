#!/usr/bin/env node
// gate <command…>: runs a full gate in a parallel slot, first come first served (docs/testing.md). Cross-platform
// (no flock needed): tickets and slots are files under $TMPDIR/<project>-gate-<pool>/; a ticket is the queue
// position, a slot is held by creating its file exclusively. Only the oldest live ticket may take a free slot, so
// newer gates cannot overtake older ones. Stale tickets and slots (dead pid) are removed. Slot counts come from
// ~/controller/gate-slots.json (written by capacity.mjs) or GATE_SLOTS / GATE_E2E_SLOTS, default 2 / 1.
// Wait and run time go to the journal (type gate) when ~/controller/journal.mjs exists.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
if (!args.length) { console.error("usage: gate <command…>"); process.exit(2); }
const home = os.homedir();
const cfgPath = path.join(home, "controller/factory.config.json");
const project = process.env.FACTORY_PROJECT ?? (fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")).project?.name : null) ?? "factory";
const pool = /e2e|playwright|cypress/.test(args.join(" ")) ? "e2e" : "unit";
const slotsFile = path.join(home, "controller/gate-slots.json");
const envSlots = pool === "e2e" ? process.env.GATE_E2E_SLOTS : process.env.GATE_SLOTS;
const slots = Math.max(1, Number(envSlots ?? (fs.existsSync(slotsFile) ? JSON.parse(fs.readFileSync(slotsFile, "utf8"))[pool] : null) ?? (pool === "e2e" ? 1 : 2)) || 1);
const dir = path.join(os.tmpdir(), `${project}-gate-${pool}`);
fs.mkdirSync(dir, { recursive: true });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const pidOf = (file) => { try { return Number(fs.readFileSync(path.join(dir, file), "utf8").trim()); } catch { return NaN; } };
const sweep = () => { for (const f of fs.readdirSync(dir)) { const pid = pidOf(f); if (!alive(pid)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} } } };

const ticket = `ticket-${Date.now().toString().padStart(14, "0")}-${process.pid}`;
fs.writeFileSync(path.join(dir, ticket), String(process.pid));
const t0 = Date.now();
let slot = null;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (;;) {
  sweep();
  const tickets = fs.readdirSync(dir).filter((f) => f.startsWith("ticket-")).sort();
  if (tickets[0] === ticket) {
    for (let i = 1; i <= slots; i++) {
      try { fs.writeFileSync(path.join(dir, `slot-${i}`), String(process.pid), { flag: "wx" }); slot = `slot-${i}`; break; } catch {}
    }
    if (slot) break;
  }
  sleep(3000);
}
fs.unlinkSync(path.join(dir, ticket));
const t1 = Date.now();
const release = () => { try { fs.unlinkSync(path.join(dir, slot)); } catch {} };
process.on("exit", release); process.on("SIGINT", () => { release(); process.exit(130); }); process.on("SIGTERM", () => { release(); process.exit(143); });
const r = spawnSync(args[0], args.slice(1), { stdio: "inherit", shell: false });
const t2 = Date.now();
release();
const journal = path.join(home, "controller/journal.mjs");
if (fs.existsSync(journal)) spawnSync("node", [journal, "gate", process.env.GATE_TASK ?? "gate", `slot_pool=${pool}`, `wait_min=${Math.round((t1 - t0) / 60000)}`, `minutes=${Math.round((t2 - t1) / 60000)}`, `verdict=${r.status === 0 ? "pass" : "fail"}`], { stdio: "ignore" });
process.exit(r.status ?? 1);
