// Controller cleanup, run at the end of EVERY cycle, per worker host: removes worktrees that no running worker uses
// and whose branch is MERGED into origin/<main> (or, with --pushed, identical to its origin branch). A worktree with
// any uncommitted or untracked change is kept. If worker state cannot be verified (terminal list failed), nothing is
// removed on that host. --dry changes nothing: no fetch, no journal, no removals.
// Usage: node cleanup.mjs [--on <host>|--all] [--dry] [--pushed] [--prune-remote]
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { BRANCH_PREFIX, HOSTS, MAIN, ORCA, RUNNER, argHost, journal, onHost, orcaEnvArgsOn, projectDirOn, readJson, trySh, workspacesOn, worktreeRefOn, writeJson } from "./lib.mjs";

const dry = process.argv.includes("--dry"), allowPushed = process.argv.includes("--pushed");
const hosts = process.argv.includes("--all") ? HOSTS : [argHost(process.argv)];
const workers = readJson("workers.json", {});
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
let removed = 0, kept = 0, pruned = 0;
for (const host of hosts) {
  const WS = workspacesOn(host), PD = projectDirOn(host);
  const g = (...a) => onHost(host, `git -C ${q(PD)} ${a.map(q).join(" ")}`).trim();
  if (!dry) g("fetch", "-q", "--prune", "origin");
  let terms = null;
  if (RUNNER === "orca") { try { terms = JSON.parse(trySh(ORCA, ["terminal", "list", ...orcaEnvArgsOn(host), "--json"]) || "null")?.result?.terminals ?? null; } catch { terms = null; } }
  else terms = [];
  if (terms === null) { console.log(`[${host.name}] cannot list terminals; removing nothing here`); continue; }
  const busy = new Set([
    ...terms.filter((t) => /· Worker|Controller|Coordinator/.test(t.title ?? "") && t.status !== "exited").map((t) => t.worktreePath),
    ...Object.values(workers).filter((w) => (w.host ?? "local") === host.name && ((w.pid && alive(w.pid)) || (w.terminal && terms.some((t) => t.handle === w.terminal && t.status !== "exited")))).map((w) => w.worktree),
  ]);
  const wsTail = WS.split("/").filter(Boolean).slice(-2).join("/");
  const wts = g("worktree", "list", "--porcelain").split("\n\n").map((b) => ({ path: /^worktree (.*)$/m.exec(b)?.[1], branch: /^branch refs\/heads\/(.*)$/m.exec(b)?.[1] })).filter((w) => w.path && w.path.includes(`/${wsTail}/`));
  for (const w of wts) {
    const name = w.path.split("/").pop();
    const dirty = onHost(host, `git -C ${q(w.path)} status --porcelain`).trim();   // includes untracked files
    const merged = w.branch && onHost(host, `git -C ${q(PD)} merge-base --is-ancestor ${q(w.branch)} origin/${MAIN} && echo yes`).trim() === "yes";
    const local = w.branch ? g("rev-parse", "-q", "--verify", w.branch) : "", remote = w.branch ? g("rev-parse", "-q", "--verify", `origin/${w.branch}`) : "";
    const pushed = Boolean(local) && local === remote;
    const removable = !busy.has(w.path) && !dirty && (merged || (allowPushed && pushed));
    if (name === "coordinator-integration" || !removable) { kept++; continue; }
    if (dry) { console.log(`[${host.name}] would remove ${name} (${merged ? "merged" : "pushed"})`); removed++; continue; }
    try {
      if (RUNNER === "orca") {
        for (const t of terms.filter((t) => t.worktreePath === w.path)) trySh(ORCA, ["terminal", "close", "--terminal", t.handle, ...orcaEnvArgsOn(host), "--json"]);
        const r = trySh(ORCA, ["worktree", "rm", "--worktree", worktreeRefOn(host, name), ...orcaEnvArgsOn(host), "--json"]);
        if (!/"ok": *true/.test(r)) throw new Error("orca worktree rm failed");
      } else {
        const r = onHost(host, `git -C ${q(PD)} worktree remove ${q(w.path)} && echo removed`);
        if (!/removed/.test(r)) throw new Error("git worktree remove failed");
      }
      removed++;
    } catch { kept++; }
  }
  if (process.argv.includes("--prune-remote")) {
    for (const b of g("branch", "-r", "--merged", `origin/${MAIN}`).split("\n").map((s) => s.trim()).filter((s) => s.startsWith(`origin/${BRANCH_PREFIX}`))) {
      if (!dry) g("push", "-q", "origin", "--delete", b.slice("origin/".length));
      pruned++;
    }
  }
}
// Forget finished local workers whose worktree is gone.
if (!dry) {
  for (const [k, w] of Object.entries(workers)) if (w.pid && !alive(w.pid) && !fs.existsSync(w.worktree ?? "")) delete workers[k];
  writeJson("workers.json", workers);
  journal("cleanup", "controller", { note: `removed ${removed}, kept ${kept}, pruned ${pruned}` });
}
console.log(`cleanup${dry ? " (dry)" : ""}: removed ${removed}, kept ${kept}, pruned remote ${pruned}`);
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
