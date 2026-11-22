// Controller cleanup, run at the end of EVERY cycle, per worker host: removes worktrees that no running worker uses
// and whose branch is MERGED into origin/<main> (or, with --pushed, identical to its origin branch). A worktree with
// any uncommitted or untracked change is kept, and every kept worktree is printed with its reason. If worker state cannot
// be verified (terminal list failed), nothing is removed or forgotten on that host. A worker is finished when Orca reports
// its dispatch settled (lib.mjs workerStatus), even while its agent still sits at the prompt: its dispatch is released,
// its terminal closed, its worktree no longer held, and it is forgotten. A worker someone kept open (worker-keep-open)
// keeps its terminal and worktree. --dry changes nothing: no fetch, no journal, no removals, no releases.
// Usage: node cleanup.mjs [--on <host>|--all] [--dry] [--pushed] [--prune-remote]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { BRANCH_PREFIX, HOSTS, dispatchStates, file, holdsWorktree, isHelperTerminal, sh, MAIN, ORCA, RUNNER, argHost, journal, onHost, orcaEnvArgsOn, projectDirOn, readJson, trySh, workerStatus, workspacesOn, worktreeRefOn, writeJson } from "./lib.mjs";

const dry = process.argv.includes("--dry"), allowPushed = process.argv.includes("--pushed");
const hosts = process.argv.includes("--all") ? HOSTS : [argHost(process.argv)];
const workers = readJson("workers.json", {});
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
let removed = 0, kept = 0, pruned = 0, released = 0, closedWaves = 0;
const readText = (name) => { try { return fs.readFileSync(file(name), "utf8"); } catch { return ""; } };
const failedReleases = [], finished = [];
// stdout even when the command exits non-zero: Orca prints its error answer there.
const sh2 = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26 }); return String(r.stdout ?? ""); };
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
  // Worker state from Orca's dispatches. Running and unknown workers hold their worktree; finished ones are released first.
  const mine = Object.entries(workers).filter(([, w]) => (w.host ?? "local") === host.name);
  const dispatches = RUNNER === "orca" ? dispatchStates(mine.map(([, w]) => w.dispatch), host) : {};
  const listed = new Set(terms.filter((t) => t.status !== "exited").map((t) => t.handle));
  const finishedHandles = new Set();
  const busy = new Map();   // worktree path → why it is kept
  for (const [k, w] of mine) {
    const status = workerStatus(w, { dispatches, terminals: listed, pidAlive: alive });
    const keptOpen = Boolean(dispatches[w.dispatch]?.keptOpen);
    if (status !== "finished" || keptOpen) { if (w.worktree && !busy.has(w.worktree)) busy.set(w.worktree, `worker "${w.name ?? k}" ${keptOpen ? "kept open" : status === "running" ? "running" : "state unknown"}`); continue; }
    if (w.terminal) finishedHandles.add(w.terminal);
    finished.push({ host, key: k, w });
    if (dry) { console.log(`[${host.name}] would release the finished worker "${w.name ?? k}"`); continue; }
    if (w.dispatch) {
      const ok = (r) => /"ok": *true/.test(r) || /dispatch_not_found/.test(r);
      if (ok(sh2(ORCA, ["orchestration", "worker-release", "--dispatch", w.dispatch, ...orcaEnvArgsOn(host), "--json"])) || ok(sh2(ORCA, ["orchestration", "worker-abandon", "--dispatch", w.dispatch, ...orcaEnvArgsOn(host), "--json"]))) released++;
      else failedReleases.push(w.dispatch);
    }
    // Orca keeps some finished terminals (an agent it cannot identify); the factory started this one, so it closes it.
    if (RUNNER === "orca" && w.terminal && listed.has(w.terminal)) trySh(ORCA, ["terminal", "close", "--terminal", w.terminal, ...orcaEnvArgsOn(host), "--json"]);
  }
  for (const t of terms) if (holdsWorktree(t.title) && t.status !== "exited" && !finishedHandles.has(t.handle) && t.worktreePath && !busy.has(t.worktreePath)) busy.set(t.worktreePath, `terminal "${t.title}" open`);
  const wsTail = WS.split("/").filter(Boolean).slice(-2).join("/");
  const wts = g("worktree", "list", "--porcelain").split("\n\n").map((b) => ({ path: /^worktree (.*)$/m.exec(b)?.[1], branch: /^branch refs\/heads\/(.*)$/m.exec(b)?.[1] })).filter((w) => w.path && w.path.includes(`/${wsTail}/`));
  // Finished wave terminals pile up in the integration worktree. The newest stays: wavewait and the heartbeat read its result.
  // A shared host lists every project's terminals, and only this repository's own worktree tells them apart. Its path comes
  // from git, because a remote host's configured path can start with ~.
  const integration = wts.find((w) => w.path.split("/").pop() === "coordinator-integration")?.path;
  const newestWave = readText("wave-handle.txt").trim().split(" ")[1];
  for (const t of terms) {
    if (t.handle === newestWave || isHelperTerminal(t.title) || !/^(.* · Integration · |Coordinator )/.test(t.title ?? "") || !integration || t.worktreePath !== integration) continue;
    const output = trySh(ORCA, ["terminal", "read", "--terminal", t.handle, ...orcaEnvArgsOn(host), "--json"]);
    if (!/WAVE-END/.test(output.replace(/echo WAVE-END/g, ""))) continue;
    closedWaves++;
    if (dry) console.log(`[${host.name}] would close the finished wave terminal "${t.title}"`);
    else trySh(ORCA, ["terminal", "close", "--terminal", t.handle, ...orcaEnvArgsOn(host), "--json"]);
  }
  for (const w of wts) {
    const name = w.path.split("/").pop();
    const dirty = onHost(host, `git -C ${q(w.path)} status --porcelain`).trim();   // includes untracked files
    const merged = w.branch && onHost(host, `git -C ${q(PD)} merge-base --is-ancestor ${q(w.branch)} origin/${MAIN} && echo yes`).trim() === "yes";
    const local = w.branch ? g("rev-parse", "-q", "--verify", w.branch) : "", remote = w.branch ? g("rev-parse", "-q", "--verify", `origin/${w.branch}`) : "";
    const pushed = Boolean(local) && local === remote;
    const why = name === "coordinator-integration" ? "integration worktree" : busy.get(w.path)
      ?? (dirty ? "uncommitted or untracked changes" : merged || (allowPushed && pushed) ? ""
        : pushed ? `pushed, not merged into origin/${MAIN} (removed only with --pushed)` : `${w.branch ? `branch ${w.branch}` : "no branch"}, not merged into origin/${MAIN}`);
    if (why) { console.log(`[${host.name}] kept ${name}: ${why}`); kept++; continue; }
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
    } catch (e) { console.log(`[${host.name}] kept ${name}: ${e.message}`); kept++; }
  }
  if (process.argv.includes("--prune-remote")) {
    for (const b of g("branch", "-r", "--merged", `origin/${MAIN}`).split("\n").map((s) => s.trim()).filter((s) => s.startsWith(`origin/${BRANCH_PREFIX}`))) {
      if (!dry) g("push", "-q", "origin", "--delete", b.slice("origin/".length));
      pruned++;
    }
  }
}
// Forget finished workers (released above). A failed release is reported, not retried forever: the dispatch is settled,
// and a record that never leaves keeps waking the Controller. Terminal-runner workers whose pid is dead go as well.
if (!dry) {
  for (const { key } of finished) delete workers[key];
  for (const [k, w] of Object.entries(workers)) if (w.pid && !alive(w.pid)) delete workers[k];
  writeJson("workers.json", workers);
  journal("cleanup", "controller", { note: `removed ${removed}, kept ${kept}, pruned ${pruned}, released ${released}${failedReleases.length ? `, release failed ${failedReleases.join(" ")}` : ""}` });
}
console.log(`cleanup${dry ? " (dry)" : ""}: removed ${removed} worktrees, kept ${kept}, pruned ${pruned} remote branches, released ${released} dispatches, closed ${closedWaves} finished wave terminals${failedReleases.length ? `; release FAILED for ${failedReleases.join(", ")}` : ""}`);
// Every cycle also corrects automatic names: a failure here must not hide what cleanup did.
if (!dry && RUNNER === "orca") for (const host of hosts) try { process.stdout.write(sh("node", [file("names.mjs"), "--on", host.name])); } catch (e) { console.error(`naming entries on ${host.name} failed: ${e.message}`); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
