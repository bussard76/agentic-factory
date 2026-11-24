// Shared for the Front-agent scripts: load factory.config.json and resolve the host the Controller runs on.
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
/** The worker host the Controller runs on (hosts.controller.host), with kind, ssh and paths resolved. */
export function controllerHost(cfg) {
  const name = cfg.hosts?.controller?.host ?? "local";
  const list = cfg.hosts?.workers?.length ? cfg.hosts.workers : [{ name: "local", kind: "local" }];
  const h = list.find((x) => x.name === name) ?? list[0];
  return { name: h.name, kind: h.kind ?? (h.ssh ? "remote" : "local"), ssh: h.ssh, sshConfig: h.sshConfig, workspacesDir: h.workspacesDir, capacity: h.capacity };
}
