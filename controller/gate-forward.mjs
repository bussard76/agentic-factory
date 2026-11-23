#!/usr/bin/env node
// gate-forward: 1
// Installed by `start` as ~/.local/bin/gate.mjs, the file that the shim of factory versions before the dispatcher runs. If an older
// factory's start puts its shim back over the shared dispatcher, calls reach this file instead of another project's gate.mjs: it says
// so loudly, then runs the gate.mjs of the project the call is for (same lookup as the dispatcher). It never ends with 0 unless that
// gate did, and without a project or a gate.mjs it fails with a message.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fail = (m) => { console.error(`gate: ${m}`); process.exit(1); };
let c = process.env.FACTORY_CONFIG;
if (!c) for (let d = process.cwd(); ; d = path.dirname(d)) { const f = path.join(d, "factory.config.json"); if (fs.existsSync(f)) { c = f; break; } if (d === path.dirname(d)) break; }
if (!c) fail(`no factory.config.json in ${process.cwd()} or above it, and FACTORY_CONFIG is not set: cannot tell which project this gate is for.`);
let cfg; try { cfg = JSON.parse(fs.readFileSync(c, "utf8")); } catch (e) { fail(`cannot read ${c} (${e.message})`); }
const impl = path.join((cfg.hosts?.controller?.controllerDir ?? "~/controller").replace(/^~(?=\/|$)/, os.homedir()), "gate.mjs");
if (!fs.existsSync(impl)) fail(`no gate.mjs for the project ${cfg.project?.name ?? "?"} (looked in ${path.dirname(impl)}, from ${c}). Run agentic-factory start in that project.`);
console.error("gate: WARNING: this call came through an older factory's ~/.local/bin/gate, not through the dispatcher: an older factory's start put its shim back. The project's own gate is run, but run `agentic-factory start` in every project on this host (the newest factory last) and check `agentic-factory doctor`.");
const r = spawnSync(process.execPath, [impl, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, FACTORY_GATE_DISPATCHED: "forward" } });
if (r.error) fail(`cannot run ${impl} (${r.error.message})`);
process.exit(typeof r.status === "number" ? r.status : 1);
