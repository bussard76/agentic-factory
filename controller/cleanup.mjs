// Controller cleanup, run at the end of EVERY cycle, per worker host: removes worktrees that no running worker uses
// and whose branch is MERGED into origin/<main> (or, with --pushed, identical to its origin branch). A worktree with
// any uncommitted or untracked change is kept, and every kept worktree is printed with its reason. If worker state cannot
// be verified (terminal list failed), nothing is removed or forgotten on that host.
// Cleanup deletes, so anything Orca does not positively report as finished is busy. A worker is finished when Orca reports
// its dispatch settled (lib.mjs workerStatus), even while its agent still sits at the prompt. It is released with
// worker-release (Orca closes the agent terminal only where it may) and forgotten once Orca confirms the release. It is
// NOT released, and keeps its record and worktree, while its worktree has uncommitted or unpushed work, while its terminal
// is shared with a running worker, or while Orca retains it as kept open. Cleanup itself closes no worker terminal: when
// it removes a worktree, it lets `orca worktree rm` stop the setup terminals of the released dispatch, and it keeps a
// worktree in which any other terminal is still open. --dry changes nothing: no fetch, no journal, no removals, no releases.
// Usage: node cleanup.mjs [--on <host>|--all] [--dry] [--pushed] [--prune-remote]
import fs from "node:fs";
import { BRANCH_PREFIX, HOSTS, dispatchStates, file, orcaCall, holdsWorktree, isHelperTerminal, sh, MAIN, ORCA, RUNNER, argHost, journal, onHost, orcaEnvArgsOn, projectDirOn, readJson, trySh, workerStatus, workspacesOn, worktreeRefOn, writeJson } from "./lib.mjs";

const dry = process.argv.includes("--dry"), allowPushed = process.argv.includes("--pushed");
const hosts = process.argv.includes("--all") ? HOSTS : [argHost(process.argv)];
const workers = readJson("workers.json", {});
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
let removed = 0, kept = 0, pruned = 0, released = 0, closedWaves = 0;
const readText = (name) => { try { return fs.readFileSync(file(name), "utf8"); } catch { return ""; } };
const failedReleases = [], forget = [];
// Setup terminals of released dispatches, remembered until their worktree is gone: handle → worktree path. Only these
// may be stopped with a worktree removal; any other terminal open in a worktree keeps it.
const releasedTerms = readJson("released-terminals.json", {});
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
  const wsTail = WS.split("/").filter(Boolean).slice(-2).join("/");
  const wts = g("worktree", "list", "--porcelain").split("\n\n").map((b) => ({ path: /^worktree (.*)$/m.exec(b)?.[1], branch: /^branch refs\/heads\/(.*)$/m.exec(b)?.[1] })).filter((w) => w.path && w.path.includes(`/${wsTail}/`));
  for (const w of wts) {   // git facts once per worktree; the release decision and the removal both use them
    w.dirty = onHost(host, `git -C ${q(w.path)} status --porcelain`).trim() !== "";   // includes untracked files
    w.merged = Boolean(w.branch) && onHost(host, `git -C ${q(PD)} merge-base --is-ancestor ${q(w.branch)} origin/${MAIN} && echo yes`).trim() === "yes";
    const local = w.branch ? g("rev-parse", "-q", "--verify", w.branch) : "", remote = w.branch ? g("rev-parse", "-q", "--verify", `origin/${w.branch}`) : "";
    w.pushed = Boolean(local) && local === remote;
  }
  const wtAt = new Map(wts.map((w) => [w.path, w]));
  // Worker state from Orca's dispatches. Only a settled dispatch is finished; running and unknown workers hold their worktree.
  const mine = Object.entries(workers).filter(([, w]) => (w.host ?? "local") === host.name);
  const dispatches = RUNNER === "orca" ? dispatchStates(mine.map(([, w]) => w.dispatch), host) : {};
  const listed = new Set(terms.filter((t) => t.status !== "exited").map((t) => t.handle));
  const status = new Map(mine.map(([k, w]) => [k, workerStatus(w, { dispatches, terminals: listed, pidAlive: alive })]));
  const heldTerminals = new Set(mine.filter(([k]) => status.get(k) !== "finished").map(([, w]) => w.terminal).filter(Boolean));
  const releasedAgents = new Set();
  const busy = new Map();   // worktree path → why it is kept
  for (const [k, w] of mine) {
    const name = w.name ?? k, d = dispatches[w.dispatch] ?? {}, wt = wtAt.get(w.worktree);
    const hold = (why) => { if (w.worktree && !busy.has(w.worktree)) busy.set(w.worktree, `worker "${name}" ${why}`); };
    if (status.get(k) !== "finished") { hold(status.get(k) === "unknown" ? "state unknown" : d.state === "abandoned" ? "abandoned, may still run" : "running"); continue; }
    if (d.keptOpen) { hold(`finished, but Orca keeps it open (user_requested); release it with \`orca orchestration worker-release --dispatch ${w.dispatch}\` when nobody needs it`); continue; }
    if (w.terminal && heldTerminals.has(w.terminal)) { hold("finished, but its terminal is used by a running worker"); continue; }
    if (wt?.dirty) { hold("finished with uncommitted or untracked changes; not released"); continue; }
    if (wt && !wt.merged && !wt.pushed) { hold("finished with commits that are not on origin; not released"); continue; }
    if (!w.dispatch) { forget.push(k); continue; }   // a record without a dispatch has nothing to release
    // The dispatch's setup terminals, from Orca's record of what it created, before the release settles it.
    const shown = orcaCall(["orchestration", "worker-show", "--dispatch", w.dispatch, "--full"], host);
    const setup = (shown?.result?.worker?.effects ?? []).filter((e) => e.kind === "terminal" && e.role === "setup" && e.id && !heldTerminals.has(e.id)).map((e) => e.id);
    if (dry) { console.log(`[${host.name}] would release the finished worker "${name}"`); }
    else {
      const r = orcaCall(["orchestration", "worker-release", "--dispatch", w.dispatch], host);
      if (!(r?.ok || r?.error?.code === "dispatch_not_found")) { failedReleases.push(w.dispatch); hold(`finished, release failed (${r?.error?.code ?? "no answer"}); retried next cycle`); continue; }
      released++; forget.push(k);
    }
    if (w.terminal && d.owned) releasedAgents.add(w.terminal);
    for (const id of setup) if (w.worktree) releasedTerms[id] = w.worktree;
  }
  for (const t of terms) if (holdsWorktree(t.title) && t.status !== "exited" && !releasedAgents.has(t.handle) && t.worktreePath && !busy.has(t.worktreePath)) busy.set(t.worktreePath, `terminal "${t.title}" open`);
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
    const { dirty, merged, pushed } = w;
    // Only the released dispatch's own terminals may go with the worktree. Any other open terminal keeps it.
    const other = terms.filter((t) => t.worktreePath === w.path && t.status !== "exited" && !releasedAgents.has(t.handle) && releasedTerms[t.handle] !== w.path);
    const why = name === "coordinator-integration" ? "integration worktree" : busy.get(w.path)
      ?? (dirty ? "uncommitted or untracked changes" : !(merged || (allowPushed && pushed))
        ? (pushed ? `pushed, not merged into origin/${MAIN} (removed only with --pushed)` : `${w.branch ? `branch ${w.branch}` : "no branch"}, not merged into origin/${MAIN}`)
        : other.length ? `terminal "${other[0].title}" open in it${other.length > 1 ? ` (and ${other.length - 1} more)` : ""}` : "");
    if (why) { console.log(`[${host.name}] kept ${name}: ${why}`); kept++; continue; }
    if (dry) { console.log(`[${host.name}] would remove ${name} (${merged ? "merged" : "pushed"})`); removed++; continue; }
    try {
      if (RUNNER === "orca") {
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
// Forget finished workers whose release Orca confirmed; a failed release keeps the record for the next cycle.
// Terminal-runner workers whose pid is dead go as well. Remembered setup terminals that are gone are dropped.
if (!dry) {
  for (const key of forget) delete workers[key];
  const anyListed = new Set([...hostTerms.values()].flatMap((t) => (t ?? []).map((x) => x.handle)));
  if (![...hostTerms.values()].includes(null)) for (const id of Object.keys(releasedTerms)) if (!anyListed.has(id)) delete releasedTerms[id];
  writeJson("released-terminals.json", releasedTerms);
  for (const [k, w] of Object.entries(workers)) if (w.pid && !alive(w.pid)) delete workers[k];
  writeJson("workers.json", workers);
  journal("cleanup", "controller", { note: `removed ${removed}, kept ${kept}, pruned ${pruned}, released ${released}${failedReleases.length ? `, release failed ${failedReleases.join(" ")}` : ""}` });
}
console.log(`cleanup${dry ? " (dry)" : ""}: removed ${removed} worktrees, kept ${kept}, pruned ${pruned} remote branches, released ${released} dispatches, closed ${closedWaves} finished wave terminals${failedReleases.length ? `; release FAILED for ${failedReleases.join(", ")}` : ""}`);
// Every cycle also corrects automatic names: a failure here must not hide what cleanup did.
if (!dry && RUNNER === "orca") for (const host of hosts) try { process.stdout.write(sh("node", [file("names.mjs"), "--on", host.name])); } catch (e) { console.error(`naming entries on ${host.name} failed: ${e.message}`); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
