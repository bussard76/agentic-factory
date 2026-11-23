#!/usr/bin/env node
// gate <command…>: runs a full gate in a parallel slot, first come first served (docs/testing.md). Cross-platform
// (no flock needed): tickets and slots are files under $TMPDIR/<project>-gate-<pool>/; a ticket is the queue
// position, a slot is held by creating its file exclusively. Only the oldest live ticket may take a free slot, so
// newer gates cannot overtake older ones. Stale tickets and slots (dead pid) are removed. Slot counts come from
// <controller dir>/gate-slots.json (written by capacity.mjs) or GATE_SLOTS / GATE_E2E_SLOTS, default 2 / 1.
// Wait and run time go to the journal (type gate) when <controller dir>/journal.mjs exists.
// Each project has its own gate: this file in its Controller directory, called by its absolute path (<controller dir>/gate). Its project,
// its queue, its slots and its journal come from that directory (factory.config.json next to this file), never from a config
// in the worktree it is called in: the code that judges a branch is not chosen by the branch. A call from another project's
// worktree is refused.
// Usage: <controller dir>/gate <command…>   (everything after gate is the command; only a first argument --help or -h is gate's own)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
// gate does not use cli.mjs: its arguments are the command it runs. It prints its leading comment itself.
if (args[0] === "--help" || args[0] === "-h") { const l = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1); console.log(l.slice(0, l.findIndex((x) => !x.startsWith("//"))).map((x) => x.replace(/^\/\/ ?/, "")).join("\n")); process.exit(0); }
if (!args.length) { console.error("usage: gate <command…>"); process.exit(2); }
const controllerDir = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = path.join(controllerDir, "factory.config.json");
let cfg = {};
try { if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (e) { console.error(`gate: cannot read ${cfgPath} (${e.message})`); process.exit(1); }
// Only to refuse a mix-up: the working directory's config is read for its project name, never to choose anything.
for (let d = process.cwd(); cfg.project?.name; d = path.dirname(d)) {
  const f = path.join(d, "factory.config.json");
  if (fs.existsSync(f)) { let name; try { name = JSON.parse(fs.readFileSync(f, "utf8")).project?.name; } catch {} if (name && name !== cfg.project.name) { console.error(`gate: this is the gate of the project ${cfg.project.name} (${controllerDir}), but it was called in a worktree of ${name} (${d}). Use that project's own gate. Nothing was run.`); process.exit(1); } break; }
  if (d === path.dirname(d)) break;
}
const project = process.env.FACTORY_PROJECT ?? cfg.project?.name ?? "factory";
const pool = /e2e|playwright|cypress/.test(args.join(" ")) ? "e2e" : "unit";
const slotsFile = path.join(controllerDir, "gate-slots.json");
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
if (r.error) console.error(`gate: cannot start "${args[0]}" (${r.error.code}). gate starts a program without a shell; for shell syntax use: ${path.join(controllerDir, "gate")} bash -c '<command>'`);
const t2 = Date.now();
release();
const journal = path.join(controllerDir, "journal.mjs");
if (fs.existsSync(journal)) spawnSync("node", [journal, "gate", process.env.GATE_TASK ?? "gate", `slot_pool=${pool}`, `wait_min=${Math.round((t1 - t0) / 60000)}`, `minutes=${Math.round((t2 - t1) / 60000)}`, `verdict=${r.status === 0 ? "pass" : "fail"}`], { stdio: "ignore" });
process.exit(r.status ?? 1);
