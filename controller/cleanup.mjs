// Controller cleanup, run at the end of EVERY cycle, per worker host: removes worktrees that no running worker uses
// and whose branch is merged into origin/<main> or identical to its origin branch. Keeps coordinator-integration and
// anything with uncommitted changes or unpushed commits. --prune-remote deletes merged remote branches with the
// factory's prefix. Usage: node cleanup.mjs [--on <host>|--all] [--dry] [--prune-remote]
import fs from "node:fs";
import { BRANCH_PREFIX, HOSTS, MAIN, ORCA, RUNNER, argHost, file, journal, onHost, orcaEnvArgsOn, projectDirOn, readJson, trySh, workspacesOn, worktreeRefOn, writeJson } from "./lib.mjs";

const dry = process.argv.includes("--dry");
const hosts = process.argv.includes("--all") ? HOSTS : [argHost(process.argv)];
const workers = readJson("workers.json", {});
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
let removed = 0, kept = 0, pruned = 0;
for (const host of hosts) {
  const WS = workspacesOn(host), PD = projectDirOn(host);
  const g = (...a) => onHost(host, `git -C ${q(PD)} ${a.map(q).join(" ")}`).trim();
  g("fetch", "-q", "--prune", "origin");
  let terms = [];
  if (RUNNER === "orca") try { terms = JSON.parse(trySh(ORCA, ["terminal", "list", ...orcaEnvArgsOn(host), "--json"]) || "{}").result?.terminals ?? []; } catch {}
  const busy = new Set([
    ...terms.filter((t) => /· Worker|Controller|Coordinator/.test(t.title ?? "") && t.status !== "exited").map((t) => t.worktreePath),
    ...Object.values(workers).filter((w) => (w.host ?? "local") === host.name && w.pid && alive(w.pid)).map((w) => w.worktree),
  ]);
  const wts = g("worktree", "list", "--porcelain").split("\n\n").map((b) => ({ path: /^worktree (.*)$/m.exec(b)?.[1], branch: /^branch refs\/heads\/(.*)$/m.exec(b)?.[1] })).filter((w) => w.path && (w.path + "/").startsWith(WS.replace(/^~/, "")) || w.path?.includes(`/${WS.split("/").filter(Boolean).slice(-2).join("/")}`));
  for (const w of wts) {
    const name = w.path.split("/").pop();
    const dirty = onHost(host, `git -C ${q(w.path)} status --porcelain --untracked-files=no`).trim();
    const merged = w.branch && onHost(host, `git -C ${q(PD)} merge-base --is-ancestor ${q(w.branch)} origin/${MAIN} && echo yes`).trim() === "yes";
    const pushed = w.branch && g("rev-parse", "-q", "--verify", w.branch) !== "" && g("rev-parse", "-q", "--verify", w.branch) === g("rev-parse", "-q", "--verify", `origin/${w.branch}`);
    if (name === "coordinator-integration" || busy.has(w.path) || dirty || !(merged || pushed)) { kept++; continue; }
    if (dry) { console.log(`[${host.name}] would remove`, name); removed++; continue; }
    try {
      if (RUNNER === "orca") {
        for (const t of terms.filter((t) => t.worktreePath === w.path)) trySh(ORCA, ["terminal", "close", "--terminal", t.handle, ...orcaEnvArgsOn(host), "--json"]);
        trySh(ORCA, ["worktree", "rm", "--worktree", worktreeRefOn(host, name), "--force", ...orcaEnvArgsOn(host), "--json"]);
      } else onHost(host, `git -C ${q(PD)} worktree remove --force ${q(w.path)}`);
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
// Forget finished workers whose worktree is gone (local hosts only; remote records are cleared by the Controller when it reads worker_done).
for (const [k, w] of Object.entries(workers)) if (w.pid && !alive(w.pid) && !fs.existsSync(w.worktree ?? "")) delete workers[k];
if (!dry) writeJson("workers.json", workers);
journal("cleanup", "controller", { note: `removed ${removed}, kept ${kept}, pruned ${pruned}` });
console.log(`cleanup: removed ${removed}, kept ${kept}, pruned remote ${pruned}`);
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
