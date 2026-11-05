// Controller cleanup, run at the end of EVERY cycle, per worker host: removes worktrees that no running worker uses
// and whose branch is MERGED into origin/<main> (or, with --pushed, identical to its origin branch). A worktree with
// any uncommitted or untracked change is kept. If worker state cannot be verified (terminal list failed), nothing is
// removed or forgotten on that host. Finished Orca workers get their dispatch released (or abandoned) and are forgotten.
// --dry changes nothing: no fetch, no journal, no removals, no releases.
// Usage: node cleanup.mjs [--on <host>|--all] [--dry] [--pushed] [--prune-remote]
import fs from "node:fs";
import { BRANCH_PREFIX, HOSTS, file, holdsWorktree, sh, MAIN, ORCA, RUNNER, argHost, journal, onHost, orcaEnvArgsOn, projectDirOn, readJson, trySh, workspacesOn, worktreeRefOn, writeJson } from "./lib.mjs";

const dry = process.argv.includes("--dry"), allowPushed = process.argv.includes("--pushed");
const hosts = process.argv.includes("--all") ? HOSTS : [argHost(process.argv)];
const workers = readJson("workers.json", {});
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
let removed = 0, kept = 0, pruned = 0, released = 0, closedWaves = 0;
const readText = (name) => { try { return fs.readFileSync(file(name), "utf8"); } catch { return ""; } };
const failedReleases = [];
const terminalsOf = (host) => {   // null when the state is unknown; one call per host, reused below
  if (RUNNER !== "orca") return [];
  try { const t = JSON.parse(trySh(ORCA, ["terminal", "list", ...orcaEnvArgsOn(host), "--json"]) || "null")?.result?.terminals; return Array.isArray(t) ? t : null; } catch { return null; }
};
const hostTerms = new Map(hosts.map((h) => [h.name, terminalsOf(h)]));
for (const host of hosts) {
  const WS = workspacesOn(host), PD = projectDirOn(host);
  const g = (...a) => onHost(host, `git -C ${q(PD)} ${a.map(q).join(" ")}`).trim();
  if (!dry) g("fetch", "-q", "--prune", "origin");
  const terms = hostTerms.get(host.name);
  if (terms === null) { console.log(`[${host.name}] cannot list terminals; removing nothing here`); continue; }
  const busy = new Set([
    ...terms.filter((t) => holdsWorktree(t.title) && t.status !== "exited").map((t) => t.worktreePath),
    ...Object.values(workers).filter((w) => (w.host ?? "local") === host.name && ((w.pid && alive(w.pid)) || (w.terminal && terms.some((t) => t.handle === w.terminal && t.status !== "exited")))).map((w) => w.worktree),
  ]);
  // Finished wave terminals pile up in the integration worktree. The newest stays: wavewait and the heartbeat read its result.
  const newestWave = readText("wave-handle.txt").trim().split(" ")[1];
  for (const t of terms) {
    if (t.handle === newestWave || !/^(.* · Integration · |Coordinator )/.test(t.title ?? "") || !t.worktreePath?.endsWith("/coordinator-integration")) continue;
    const output = trySh(ORCA, ["terminal", "read", "--terminal", t.handle, ...orcaEnvArgsOn(host), "--json"]);
    if (!/WAVE-END/.test(output.replace(/echo WAVE-END/g, ""))) continue;
    closedWaves++;
    if (!dry) trySh(ORCA, ["terminal", "close", "--terminal", t.handle, ...orcaEnvArgsOn(host), "--json"]);
  }
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
// Forget finished workers: terminal-runner workers whose pid is dead, Orca workers whose terminal is gone or exited
// (their dispatch is released first; a failed release is reported, not counted).
if (!dry) {
  for (const host of hosts) {
    const terms = hostTerms.get(host.name);
    if (RUNNER !== "orca" || terms === null) continue;
    const live = new Set(terms.filter((t) => t.status !== "exited").map((t) => t.handle));
    for (const [k, w] of Object.entries(workers)) {
      if ((w.host ?? "local") !== host.name || !w.terminal || live.has(w.terminal)) continue;
      if (w.dispatch) {
        const ok = (r) => /"ok": *true/.test(r);
        if (ok(trySh(ORCA, ["orchestration", "worker-release", "--dispatch", w.dispatch, ...orcaEnvArgsOn(host), "--json"])) || ok(trySh(ORCA, ["orchestration", "worker-abandon", "--dispatch", w.dispatch, ...orcaEnvArgsOn(host), "--json"]))) released++;
        else { failedReleases.push(w.dispatch); continue; }   // keep the record so the next cycle retries
      }
      delete workers[k];
    }
  }
  for (const [k, w] of Object.entries(workers)) if (w.pid && !alive(w.pid)) delete workers[k];
  writeJson("workers.json", workers);
  journal("cleanup", "controller", { note: `removed ${removed}, kept ${kept}, pruned ${pruned}, released ${released}${failedReleases.length ? `, release failed ${failedReleases.join(" ")}` : ""}` });
}
console.log(`cleanup${dry ? " (dry)" : ""}: removed ${removed} worktrees, kept ${kept}, pruned ${pruned} remote branches, released ${released} dispatches, closed ${closedWaves} finished wave terminals${failedReleases.length ? `; release FAILED for ${failedReleases.join(", ")}` : ""}`);
// Every cycle also corrects automatic names: a failure here must not hide what cleanup did.
if (!dry && RUNNER === "orca") for (const host of hosts) try { process.stdout.write(sh("node", [file("names.mjs"), "--on", host.name])); } catch (e) { console.error(`naming entries on ${host.name} failed: ${e.message}`); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
