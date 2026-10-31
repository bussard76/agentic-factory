// Front agent: polls the Controller's status file every 5 minutes, on the controller host (local: direct file reads;
// remote: ssh). Prints a line when "On main", "Needs <human>" or "Problems" change, when the file goes stale
// (> 25 min), when more worktrees exist than tasks plus a few (cleanup overdue), and a SUMMARY marker every 30 minutes.
// Config: factory.config.json next to this script or FACTORY_CONFIG. Run as a background monitor.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { controllerHost, expand, loadConfig } from "./hosts.mjs";

const cfg = loadConfig(path.dirname(new URL(import.meta.url).pathname));
const host = controllerHost(cfg);
const ctlDir = cfg.hosts.controller?.controllerDir ?? "~/controller";
const WORKTREE_MAX = (host.capacity?.suiteWorkersMax ?? cfg.capacity?.suiteWorkersMax ?? 4) + (host.capacity?.readOnlyWorkersMax ?? cfg.capacity?.readOnlyWorkersMax ?? 4) + 2;
const ws = `${host.workspacesDir ?? "~/orca/workspaces"}/${cfg.project.name}`;
const section = (text, name) => (text.split(/^## /m).find((s) => s.startsWith(name)) ?? "").split("\n").slice(1).join("\n").trim();
function probe() {
  if (host.kind === "local") {
    const p = path.join(expand(ctlDir), "status.md");
    const mtime = fs.existsSync(p) ? fs.statSync(p).mtimeMs / 1000 : 0;
    const wt = fs.existsSync(expand(ws)) ? fs.readdirSync(expand(ws)).length : 0;
    return { mtime, wt, text: fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "" };
  }
  const out = execFileSync("ssh", [...(host.sshConfig ? ["-F", expand(host.sshConfig)] : []), host.ssh, `stat -c %Y ${ctlDir}/status.md 2>/dev/null || echo 0; echo WT=$(ls ${ws} 2>/dev/null | wc -l); cat ${ctlDir}/status.md 2>/dev/null`], { encoding: "utf8", timeout: 60000 });
  const [mtime, wtLine, ...rest] = out.split("\n");
  return { mtime: Number(mtime), wt: Number(String(wtLine).replace("WT=", "")), text: rest.join("\n") };
}
let last = {}, lastSummary = 0;
for (;;) {
  try {
    const { mtime, wt, text } = probe();
    if (wt > WORKTREE_MAX) console.log(`CLEANUP: ${wt} worktrees on ${host.name}, nudge the Controller`);
    const ageMin = mtime ? Math.round((Date.now() / 1000 - mtime) / 60) : Infinity;
    const now = { main: section(text, "On "), needs: section(text, "Needs "), problems: section(text, "Problems") };
    for (const [k, label] of [["main", "NEW ON MAIN"], ["needs", "NEEDS HUMAN"], ["problems", "PROBLEMS"]]) if (last[k] !== undefined && last[k] !== now[k]) console.log(`${label}: ${now[k].replace(/\n/g, " | ").slice(0, 400)}`);
    if (!mtime) console.log(`NO STATUS: ${ctlDir}/status.md missing on ${host.name} (Controller not started?)`);
    else if (ageMin > 25) console.log(`STALE: status.md is ${ageMin} min old`);
    last = now;
    if (Date.now() - lastSummary > 30 * 60_000) { console.log(`SUMMARY due (status age ${Number.isFinite(ageMin) ? ageMin : "?"} min)`); lastSummary = Date.now(); }
  } catch (e) { console.log(`UNREACHABLE: ${String(e.message).replace(/pair|token|code=/gi, "…").slice(0, 120)}`); }
  await new Promise((r) => setTimeout(r, 5 * 60_000));
}
