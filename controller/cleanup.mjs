// Controller cleanup, run at the end of EVERY cycle, per worker host: removes worktrees that no running worker uses
// and whose branch is MERGED into origin/<main> (or, with --pushed, identical to its origin branch). A worktree with
// any uncommitted or untracked change is kept, and every kept worktree is printed with its reason. If worker state cannot
// be verified (terminal list failed), nothing is removed or forgotten on that host.
// Cleanup deletes, so anything Orca does not positively report as finished is busy. A worker is finished when Orca reports
// its dispatch settled (lib.mjs workerStatus), even while its agent still sits at the prompt. It is released with
// worker-release (Orca closes the agent terminal only where it may) and forgotten once Orca confirms the release. It is
// NOT released, and keeps its record and worktree, while its worktree has uncommitted or unpushed work, while its terminal
// is shared with or owned by another dispatch, while the Controller keeps it (keep.mjs), or while Orca retains it as kept
// open and the record does not say that this is Orca's default for its start (keptByDefault, written by start.mjs).
// A release counts only when Orca answers released or already_released. Cleanup itself closes no worker terminal: when
// it removes a worktree, it lets `orca worktree rm` stop the setup terminals of the released dispatch, and it keeps a
// worktree in which any other terminal is still open. --dry changes nothing: no fetch, no journal, no removals, no releases.
// Usage: node cleanup.mjs [--on <host>|--all] [--dry] [--pushed] [--prune-remote]
import fs from "node:fs";
import path from "node:path";
import { BRANCH_PREFIX, HOSTS, SETTLED_STATES, dispatchStates, file, orcaCall, holdsWorktree, isHelperTerminal, sh, MAIN, ORCA, RUNNER, argHost, journal, onHost, orcaEnvArgsOn, projectDirOn, readJson, trySh, workerStatus, workspacesOn, worktreeRefOn, writeJson } from "./lib.mjs";

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
// Worktrees are matched by directory name: a record may hold a configured path (~/…, or through a symlink) and git the
// real one. Everything is under this project's workspaces directory, and a clash with another project's name errs to busy.
const dirOf = (p) => (p ? path.basename(String(p)) : "");
const RELEASES_MAX = 10, DEADLINE = Date.now() + 3 * 60_000;   // no new release after 3 minutes; the next cycle continues
const T = { timeout: 20_000 };   // every Orca call in this script gives up after 20 s
// The release state in Orca's receipt, wherever it sits: the first *state field naming one of the release outcomes.
const RELEASE_STATES = new Set(["released", "already_released", "retained", "release_pending", "release_unknown"]);
const releaseState = (o) => {
  if (!o || typeof o !== "object") return undefined;
  for (const [k, v] of Object.entries(o)) if (/state$/i.test(k) && RELEASE_STATES.has(v)) return v;
  for (const v of Object.values(o)) { const found = releaseState(v); if (found) return found; }
  return undefined;
};   // per host and run; the rest keep their records and are released in a later cycle
let releases = 0;
const terminalsOf = (host) => {   // null when the state is unknown; one call per host, reused below
  if (RUNNER !== "orca") return [];
  try { const t = JSON.parse(trySh(ORCA, ["terminal", "list", ...orcaEnvArgsOn(host), "--json"], T) || "null")?.result?.terminals; return Array.isArray(t) ? t : null; } catch { return null; }
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
  const wtAt = new Map(wts.map((w) => [dirOf(w.path), w]));
  // Worker state from Orca's dispatches. Only a settled dispatch is finished; running and unknown workers hold their worktree.
  const mine = Object.entries(workers).filter(([, w]) => (w.host ?? "local") === host.name);
  releases = 0;
  const dispatches = RUNNER === "orca" ? dispatchStates(mine.map(([, w]) => w.dispatch), host) : {};
  const listed = new Set(terms.filter((t) => t.status !== "exited").map((t) => t.handle));
  const status = new Map(mine.map(([k, w]) => [k, workerStatus(w, { dispatches, terminals: listed, pidAlive: alive })]));
  const heldTerminals = new Set(mine.filter(([k]) => status.get(k) !== "finished").map(([, w]) => w.terminal).filter(Boolean));
  const releasedAgents = new Set();
  const busy = new Map();   // worktree path → why it is kept
  for (const [k, w] of mine) {
    const name = w.name ?? k, d = dispatches[w.dispatch] ?? {}, wt = wtAt.get(dirOf(w.worktree));
    const hold = (why) => { if (w.worktree && !busy.has(dirOf(w.worktree))) busy.set(dirOf(w.worktree), `worker "${name}" ${why}`); };
    if (status.get(k) !== "finished") { hold(status.get(k) === "unknown" ? "state unknown" : d.state === "abandoned" ? "abandoned, may still run" : "running"); continue; }
    if (w.keep) { hold(`finished, kept by the Controller; \`node keep.mjs ${k} --off\` lets cleanup release it`); continue; }
    if (w.terminal && heldTerminals.has(w.terminal)) { hold("finished, but its terminal is used by a running worker"); continue; }
    // A worktree git does not list may still exist under another path: its work cannot be checked, so it is not released.
    if (!wt && w.worktree && onHost(host, `test -e ${q(w.worktree.replace(/^~\//, ""))} && echo yes`).trim() === "yes") { hold("finished, but its worktree is not in git's worktree list; not released"); continue; }
    if (wt?.dirty) { hold("finished with uncommitted or untracked changes; not released"); continue; }
    if (wt && !wt.merged && !wt.pushed) { hold("finished with commits that are not on origin; not released"); continue; }
    if (d.state === "gone") { hold(`finished? Orca no longer knows dispatch ${w.dispatch}; remove its record by hand once nothing runs there`); continue; }
    if (!w.dispatch) { forget.push(k); continue; }   // a record without a dispatch has nothing to release
    if (++releases > RELEASES_MAX || Date.now() > DEADLINE) { hold("finished; released in a later cycle (at most 10 per run, within the run's time limit)"); continue; }
    // Fresh facts right before the release: state, who owns the terminal now, whether Orca keeps it open, setup terminals.
    const shown = orcaCall(["orchestration", "worker-show", "--dispatch", w.dispatch, "--full"], host);
    if (!shown?.ok) { hold(`finished, but Orca did not answer before the release (${shown?.error?.code ?? "no answer"}); retried next cycle`); continue; }
    const res = shown.result?.terminalResource, now = shown.result?.worker?.state ?? shown.result?.state;
    if (!SETTLED_STATES.has(now)) { hold(`state now ${now ?? "unknown"}`); continue; }
    if (res?.ownerDispatchId && res.ownerDispatchId !== w.dispatch) { hold(`finished, but its terminal now belongs to dispatch ${res.ownerDispatchId}`); continue; }
    if (w.terminal && !res) { hold("finished, but Orca reports no terminal resource for it (a follow-up dispatch may use its terminal); not released"); continue; }
    // Orca keeps every worker started in a new worktree open by default (user_requested). start.mjs marks those records
    // keptByDefault, and for them only the Controller's own keep marker holds. Older records and other starts stay held.
    if (res?.retainedReason === "user_requested" && !w.keptByDefault) { hold(`finished, but Orca keeps it open (user_requested); release it with \`orca orchestration worker-release --dispatch ${w.dispatch}\` when nobody needs it`); continue; }
    const setup = (shown?.result?.worker?.effects ?? []).filter((e) => e.kind === "terminal" && e.role === "setup" && e.id && !heldTerminals.has(e.id)).map((e) => e.id);
    if (dry) { console.log(`[${host.name}] would release the finished worker "${name}"`); }
    else {
      // Only released and already_released mean the terminal is closed; retained and release_pending keep everything.
      const r = orcaCall(["orchestration", "worker-release", "--dispatch", w.dispatch], host), answer = r?.ok ? releaseState(r.result) : r?.error?.code;
      if (!["released", "already_released"].includes(answer)) { failedReleases.push(`${w.dispatch} (${answer ?? "no answer"})`); hold(`finished, release answered ${answer ?? "nothing"}; retried next cycle`); continue; }
      released++; forget.push(k);
    }
    if (w.terminal && res?.ownershipState === "owned") releasedAgents.add(w.terminal);
    for (const id of setup) if (w.worktree) releasedTerms[id] = dirOf(w.worktree);
  }
  for (const t of terms) if (holdsWorktree(t.title) && t.status !== "exited" && !releasedAgents.has(t.handle) && t.worktreePath && !busy.has(dirOf(t.worktreePath))) busy.set(dirOf(t.worktreePath), `terminal "${t.title}" open`);
  // Finished wave terminals pile up in the integration worktree. The newest stays: wavewait and the heartbeat read its result.
  // A shared host lists every project's terminals, and only this repository's own worktree tells them apart. Its path comes
  // from git, because a remote host's configured path can start with ~.
  const integration = wts.find((w) => w.path.split("/").pop() === "coordinator-integration")?.path;
  const newestWave = readText("wave-handle.txt").trim().split(" ")[1];
  for (const t of terms) {
    if (t.handle === newestWave || isHelperTerminal(t.title) || !/^(.* · Integration · |Coordinator )/.test(t.title ?? "") || !integration || t.worktreePath !== integration) continue;
    const output = trySh(ORCA, ["terminal", "read", "--terminal", t.handle, ...orcaEnvArgsOn(host), "--json"], T);
    if (!/WAVE-END/.test(output.replace(/echo WAVE-END/g, ""))) continue;
    closedWaves++;
    if (dry) console.log(`[${host.name}] would close the finished wave terminal "${t.title}"`);
    else trySh(ORCA, ["terminal", "close", "--terminal", t.handle, ...orcaEnvArgsOn(host), "--json"], T);
  }
  for (const w of wts) {
    const name = w.path.split("/").pop();
    const { dirty, merged, pushed } = w;
    // Only the released dispatch's own terminals may go with the worktree. Any other open terminal keeps it.
    const inside = terms.filter((t) => dirOf(t.worktreePath) === name && t.status !== "exited");
    const other = inside.filter((t) => !releasedAgents.has(t.handle) && releasedTerms[t.handle] !== name);
    const why = name === "coordinator-integration" ? "integration worktree" : busy.get(name)
      ?? (dirty ? "uncommitted or untracked changes" : !(merged || (allowPushed && pushed))
        ? (pushed ? `pushed, not merged into origin/${MAIN} (removed only with --pushed)` : `${w.branch ? `branch ${w.branch}` : "no branch"}, not merged into origin/${MAIN}`)
        : other.length ? `terminal "${other[0].title}" open in it${other.length > 1 ? ` (and ${other.length - 1} more)` : ""}` : "");
    if (why) { console.log(`[${host.name}] kept ${name}: ${why}`); kept++; continue; }
    if (dry) { console.log(`[${host.name}] would remove ${name} (${merged ? "merged" : "pushed"})`); removed++; continue; }
    try {
      if (RUNNER === "orca") {
        // The released dispatch's own setup terminals go first; a failed close keeps the worktree.
        for (const t of inside.filter((t) => releasedTerms[t.handle] === name)) {
          if (!orcaCall(["terminal", "close", "--terminal", t.handle], host)?.ok) throw new Error(`closing its setup terminal "${t.title}" failed`);
        }
        const r = trySh(ORCA, ["worktree", "rm", "--worktree", worktreeRefOn(host, name), ...orcaEnvArgsOn(host), "--json"], { timeout: 120_000 });
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
