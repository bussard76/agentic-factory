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
/** The worker host the Controller runs on (hosts.controller.host), with kind, ssh and paths resolved. */
export function controllerHost(cfg) {
  const name = cfg.hosts?.controller?.host ?? "local";
  const list = cfg.hosts?.workers?.length ? cfg.hosts.workers : [{ name: "local", kind: "local" }];
  const h = list.find((x) => x.name === name) ?? list[0];
  return { name: h.name, kind: h.kind ?? (h.ssh ? "remote" : "local"), ssh: h.ssh, sshConfig: h.sshConfig, workspacesDir: h.workspacesDir, capacity: h.capacity };
}
