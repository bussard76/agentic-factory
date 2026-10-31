// Front agent: polls the Controller's status file on the server every 5 minutes.
// Prints a line when "On main", "Needs <human>" or "Problems" change, when the file goes stale (> 25 min), when more
// than WORKTREE_MAX worktrees exist (cleanup overdue), and a SUMMARY marker every 30 minutes.
// Config: factory.config.json next to this script or FACTORY_CONFIG. Run as a background monitor.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname);
const cfgPath = process.env.FACTORY_CONFIG ?? path.join(dir, "factory.config.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const hc = cfg.hosts.controller;
const SSH = [...(hc.sshConfig ? ["-F", hc.sshConfig] : []), hc.ssh];
const WORKTREE_MAX = (cfg.capacity?.suiteWorkersMax ?? 8) + (cfg.capacity?.readOnlyWorkersMax ?? 6) + 2;
const ws = `${hc.workspacesDir ?? "~/orca/workspaces"}/${cfg.project.name}`;
const section = (text, name) => (text.split(/^## /m).find((s) => s.startsWith(name)) ?? "").split("\n").slice(1).join("\n").trim();
let last = {}, lastSummary = 0;
for (;;) {
  try {
    const out = execFileSync("ssh", [...SSH, `stat -c %Y ${hc.controllerDir ?? "~/controller"}/status.md; echo WT=$(ls ${ws} 2>/dev/null | wc -l); cat ${hc.controllerDir ?? "~/controller"}/status.md`], { encoding: "utf8", timeout: 60000 });
    const [mtime, wtLine, ...rest] = out.split("\n");
    const wt = Number(String(wtLine).replace("WT=", ""));
    if (wt > WORKTREE_MAX) console.log(`CLEANUP: ${wt} worktrees on the server, nudge the Controller`);
    const text = rest.join("\n");
    const ageMin = Math.round((Date.now() / 1000 - Number(mtime)) / 60);
    const now = { main: section(text, "On "), needs: section(text, "Needs "), problems: section(text, "Problems") };
    for (const [k, label] of [["main", "NEW ON MAIN"], ["needs", "NEEDS HUMAN"], ["problems", "PROBLEMS"]]) {
      if (last[k] !== undefined && last[k] !== now[k]) console.log(`${label}: ${now[k].replace(/\n/g, " | ").slice(0, 400)}`);
    }
    if (ageMin > 25) console.log(`STALE: status.md is ${ageMin} min old`);
    last = now;
    if (Date.now() - lastSummary > 30 * 60_000) { console.log(`SUMMARY due (status age ${ageMin} min)`); lastSummary = Date.now(); }
  } catch (e) { console.log(`UNREACHABLE: ${String(e.message).replace(/pair|token|code=/gi, "…").slice(0, 120)}`); }
  await new Promise((r) => setTimeout(r, 5 * 60_000));
}
