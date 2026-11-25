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
// targets that reach THIS machine, kept per machine (its id and its host name), so two machines that share a home each have their entry.
// An entry counts only on the machine whose id AND host name it carries: a record copied to another machine (dotfiles, a copied home)
// counts for nothing there, and a machine without an id never matches. A cloned VM that keeps both the machine id and the host name
// cannot be told from the original: it must get a new machine id or host name, or run `this-machine --forget`.
// FACTORY_MACHINE_ID and FACTORY_HOSTNAME replace them (tests).
export const markerFile = () => path.join(os.homedir(), ".config/agentic-factory/this-machine.json");
let machineIdCache;
export function machineId() {
  if (process.env.FACTORY_MACHINE_ID !== undefined) return process.env.FACTORY_MACHINE_ID;
  if (machineIdCache !== undefined) return machineIdCache;
  for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) try { const t = fs.readFileSync(f, "utf8").trim(); if (t) return (machineIdCache = t); } catch { /* next */ }
  return (machineIdCache = process.platform === "darwin" ? /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(spawnSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8" }).stdout ?? "")?.[1] ?? "" : "");
}
export const hostName = () => String(process.env.FACTORY_HOSTNAME ?? os.hostname()).toLowerCase();
/** The record: { machines: [{ machineId, hostname, ssh: [target…] }] }; anything else reads as "nothing recorded". */
export function readMarker() {
  try {
    const m = JSON.parse(fs.readFileSync(markerFile(), "utf8"));
    const machines = (Array.isArray(m.machines) ? m.machines : []).filter((e) => e && typeof e.machineId === "string" && typeof e.hostname === "string" && Array.isArray(e.ssh)).map((e) => ({ machineId: e.machineId, hostname: e.hostname, ssh: e.ssh.filter((t) => typeof t === "string" && t) }));
    return machines.length ? { machines } : { machines: [], missing: true };
  } catch { return { machines: [], missing: true }; }
}
/** The entry of this machine (same id and host name; never for an empty id), or undefined. */
export const ownEntry = (m = readMarker()) => (machineId() ? m.machines.find((e) => e.machineId === machineId() && e.hostname === hostName()) : undefined);
/** The user an ssh target `user@host` names, or "". */
export const sshUser = (ssh) => (String(ssh ?? "").includes("@") ? String(ssh).split("@")[0] : "");
/** True when `h` is a remote host that the marker says is this machine: its ssh target is listed, this machine is the one that wrote
 *  the marker, and the target's user (when it names one) is the user running this. No name, path or address is ever compared. */
export function isThisMachine(h) {
  if (!h?.ssh || (h.kind ?? "remote") !== "remote") return false;
  if (!ownEntry()?.ssh.includes(h.ssh)) return false;
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
