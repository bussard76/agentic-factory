// Shared for the Front-agent scripts: load factory.config.json and resolve the host the Controller runs on.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const expand = (p) => (p ? p.replace(/^~(?=$|\/)/, os.homedir()) : p);
export function loadConfig(dir) {
  const p = process.env.FACTORY_CONFIG ?? path.join(dir, "factory.config.json");
  if (!fs.existsSync(p)) throw new Error(`factory.config.json not found at ${p}; copy the .factory/front-agent bundle or set FACTORY_CONFIG`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
/** How old status.md may get before it counts as stale. An idle Controller is woken at most every wake.idleMinutes and writes
 *  status.md when it is woken, so the limit is never below that interval plus a margin (the heartbeat looks for a reason at
 *  every tenth minute, and the Controller needs time to write). hosts.frontAgent.staleMinutes below the floor is raised, with a note. */
export const STALE_MARGIN_MINUTES = 15;
export function staleLimit(cfg) {
  const idle = Number(cfg.hosts?.controller?.wake?.idleMinutes);
  const floor = (idle > 0 ? idle : 30) + STALE_MARGIN_MINUTES;
  const set = Number(cfg.hosts?.frontAgent?.staleMinutes);
  const limit = set > floor ? set : floor;
  const note = set > 0 && set < floor ? `hosts.frontAgent.staleMinutes is ${set}, below the Controller's idle wake interval ${floor - STALE_MARGIN_MINUTES} min (hosts.controller.wake.idleMinutes) plus ${STALE_MARGIN_MINUTES} min: the limit is ${limit} min. Raise staleMinutes to ${floor} or more, or remove it` : "";
  return { limit, note };
}
// Which configured host is the machine this runs on. factory.config.json is shared by every machine, so it cannot say; each machine
// says it itself, once, with `agentic-factory this-machine <ssh target>`, in ~/.config/agentic-factory/this-machine.json: the ssh
// targets that reach THIS machine, and the id of the machine that said so. A marker copied to another machine (dotfiles, a cloned
// home) carries the other machine's id and counts for nothing there. FACTORY_MACHINE_ID replaces the id (tests).
export const markerFile = () => path.join(os.homedir(), ".config/agentic-factory/this-machine.json");
export function machineId() {
  if (process.env.FACTORY_MACHINE_ID !== undefined) return process.env.FACTORY_MACHINE_ID;
  for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) try { const t = fs.readFileSync(f, "utf8").trim(); if (t) return t; } catch { /* next */ }
  if (process.platform === "darwin") return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(spawnSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8" }).stdout ?? "")?.[1] ?? "";
  return "";
}
export function readMarker() {
  try { const m = JSON.parse(fs.readFileSync(markerFile(), "utf8")); return { machineId: String(m.machineId ?? ""), ssh: Array.isArray(m.ssh) ? m.ssh.filter((t) => typeof t === "string" && t) : [] }; } catch { return { machineId: "", ssh: [], missing: true }; }
}
/** The user an ssh target `user@host` names, or "". */
export const sshUser = (ssh) => (String(ssh ?? "").includes("@") ? String(ssh).split("@")[0] : "");
/** True when `h` is a remote host that the marker says is this machine: its ssh target is listed, this machine is the one that wrote
 *  the marker, and the target's user (when it names one) is the user running this. No name, path or address is ever compared. */
export function isThisMachine(h) {
  if (!h?.ssh || (h.kind ?? "remote") !== "remote") return false;
  const m = readMarker();
  if (m.missing || !m.ssh.includes(h.ssh) || m.machineId !== machineId()) return false;
  const user = sshUser(h.ssh);
  return !user || user === os.userInfo().username;
}
/** The worker host the Controller runs on (hosts.controller.host), with kind, ssh and paths resolved. A host that is this machine is
 *  "local": a Front agent that lives here reads the Controller's files directly instead of over an ssh alias that does not resolve. */
export function controllerHost(cfg) {
  const name = cfg.hosts?.controller?.host ?? "local";
  const list = cfg.hosts?.workers?.length ? cfg.hosts.workers : [{ name: "local", kind: "local" }];
  const h = list.find((x) => x.name === name) ?? list[0];
  const kind = h.kind ?? (h.ssh ? "remote" : "local");
  return { name: h.name, kind: isThisMachine({ ...h, kind }) ? "local" : kind, ssh: h.ssh, sshConfig: h.sshConfig, workspacesDir: h.workspacesDir, capacity: h.capacity };
}
