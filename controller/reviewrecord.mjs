// The Controller's own record of which commit of a task was reviewed, and how a wave branch is told apart. A module for
// wave.mjs and reviewed.mjs (nobody runs it); it reads nothing but what it is given, so tests can call it directly.
//
// The record is a `review` event of the Controller's journal (journal.ndjson) with a `head`, written by reviewed.mjs (a Tester
// round, a re-evaluation, a conformance review, an Architect branch) or docsonly.mjs (the docs-only evidence); both mark it
// with `by`, and only such events count (journal.mjs refuses to write one). Both run in the Controller's directory, on its
// host: a push reaches neither, and the file is protected by process only, not by permissions (any process of the same user
// can append to it). What reviewed.mjs copies into the record is what the Controller itself fetched and read at that
// moment (the head named in the findings, the commit of the review branch); a worker who can overwrite a review branch
// before that moment is not stopped by this record, only by the push gate's own limits (debt F54, "longer term").

const SHA = /^[0-9a-f]{40}$/;
export const isSha = (s) => typeof s === "string" && SHA.test(s);
export const TRUSTED = new Set(["reviewed.mjs", "docsonly.mjs"]);
const PRIMARY = new Set(["tester", "final", "docs-only", "architect"]);

const events = (text, key) => {
  const want = String(key).toLowerCase(), out = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let e = null;
    try { e = JSON.parse(line); } catch { /* checked below */ }
    if (!e || typeof e !== "object") {
      // A line that is not JSON may be the very record: if it names the task, the answer is "unreadable", not "none".
      if (line.toLowerCase().includes(want)) return { unreadable: `a journal line that mentions ${key} is not valid JSON: ${line.slice(0, 80)}` };
      continue;
    }
    if (e.type === "review" && String(e.task).toLowerCase() === want && isSha(e.head) && TRUSTED.has(e.by)) out.push(e);
  }
  return { list: out };
};

/** Which later event may undo which earlier failed review of THE SAME commit. A failed review is final for its commit against
 *  everything except the one event written for this: the re-evaluation (`final`) that follows the last failed Tester round
 *  (PR #53: after the round limit the final functional re-evaluation reviews the very commit that round failed). So:
 *    tester fail       is superseded by a LATER passing final; by nothing else (not by another Tester pass, not by docs-only
 *                      or Architect, not by a conformance pass)
 *    final fail        is never superseded
 *    conformance fail  is never superseded (a new commit needs a new review)
 *  Every pass event is judged against the failures that are still standing for its commit. */
export const SUPERSEDES = { final: new Set(["tester"]) };   // a passing event of this path supersedes earlier failed events of these paths

/** The state of a task's review, from the text of the journal, in the order the events were written.
 *  { state: "ok", head, event, covers }   the latest primary review (Tester round, re-evaluation, docs-only, Architect) passed
 *                                         and no failed review of that commit is left standing (see SUPERSEDES); `covers` maps
 *                                         each review branch with a passing record for that commit to its event
 *  { state: "failed", head, event }       the latest primary review failed, or a failed review of the commit still stands
 *  { state: "none" }                      no usable event names the task (a task reviewed before this record existed)
 *  { state: "unreadable", why }           the journal cannot be read, or a line that mentions the task cannot be parsed
 *  A conformance review never binds a head by itself, it can only fail one. `text` is the journal's text, or an Error
 *  (ENOENT: no journal). `key` is the task id in lower case, the part of the branch name after the branch prefix. */
export function latestReview(text, key) {
  if (text instanceof Error) return text.code === "ENOENT" ? { state: "none" } : { state: "unreadable", why: text.message };
  const r = events(text, key);
  if (r.unreadable) return { state: "unreadable", why: r.unreadable };
  const standing = new Map();   // head -> the failed events that still stand
  let last = null;
  for (const e of r.list) {
    const conformance = e.path === "conformance";
    if (!conformance && !PRIMARY.has(e.path)) return { state: "unreadable", why: `a review event of ${key} has the path ${JSON.stringify(e.path)}` };
    if (e.verdict === "fail") { standing.set(e.head, [...(standing.get(e.head) ?? []), e]); if (!conformance || last?.event.head === e.head) last = { ok: false, event: e }; }
    else if (e.verdict === "pass" || e.verdict === "docs-only") {
      if (conformance) continue;
      const undone = SUPERSEDES[e.path];
      if (undone) standing.set(e.head, (standing.get(e.head) ?? []).filter((f) => !undone.has(f.path)));
      last = { ok: true, event: e };
    } else return { state: "unreadable", why: `the review event of ${key} has the verdict ${JSON.stringify(e.verdict)}` };
  }
  if (!last) { const any = [...standing.values()].flat().at(-1); return any ? { state: "failed", head: any.head, event: any } : { state: "none" }; }
  const head = last.event.head, left = standing.get(head) ?? [];
  if (!last.ok || left.length) return { state: "failed", head, event: left.at(-1) ?? last.event };
  const covers = new Map();
  for (const e of r.list) if (e.head === head && (e.verdict === "pass" || e.verdict === "docs-only") && e.branch && isSha(e.reviewSha)) covers.set(e.branch, e);
  return { state: "ok", head, event: last.event, covers };
}

/** The head of the latest usable review event of a task, whatever its verdict (for reviewed.mjs: not to move backwards). */
export function lastHead(text, key) {
  if (text instanceof Error) return "";
  const r = events(text, key);
  return r.list?.at(-1)?.head ?? "";
}

// The branches a task makes besides its own: the Tester's review branches, the re-evaluation, the conformance review.
// They carry findings files only; a wave merges them only as the commit reviewed.mjs read (integ-wave.sh).
const PROCESS = /-(review-(\d+|final)|conformance)$/;
const SPECREVIEW = /-specreview$/;

/** What a wave branch is, from its name (`origin/` optional): "status" (status-wave-<n>, made by the Controller from main),
 *  "process" (a review branch of a task: { key }), "specreview", "task" ({ key }: needs the record), or "foreign" (not under the branch prefix). */
export function classify(branch, prefix = "") {
  const name = branch.replace(/^origin\//, "");
  if (/^status-wave-\d+$/.test(name)) return { kind: "status", name };
  if (!name.startsWith(prefix)) return { kind: "foreign", name };
  const rest = name.slice(prefix.length);
  if (SPECREVIEW.test(rest)) return { kind: "specreview", name, key: rest.replace(SPECREVIEW, "").toLowerCase() };
  if (PROCESS.test(rest)) return { kind: "process", name, key: rest.replace(PROCESS, "").toLowerCase() };
  return { kind: "task", name, key: rest.toLowerCase() };
}

/** The wave's branch arguments with every reviewed commit bound, or the reasons the wave cannot start.
 *  `read(key)` gives latestReview for a task key. Task branches become `<branch>@<sha>`, a task's review branches
 *  `<branch>~<sha>:<review sha>` (the commit reviewed.mjs read; they may add findings files only on top of the task's commit);
 *  status branches stay as they are (integ-wave.sh restricts them to Status: lines of ticket files).
 *  { args } or { problems: [text] }. */
export function bindBranches(branches, { prefix, read }) {
  const parsed = branches.map((b) => ({ b, ...classify(b, prefix) }));
  const problems = [], records = new Map(), once = new Set(), args = [];
  for (const p of parsed) {
    if (p.kind === "foreign") { problems.push(`${p.b}: not a branch under the prefix ${JSON.stringify(prefix)} and not status-wave-<n>: a wave merges only task branches whose review is recorded.`); continue; }
    if (p.kind === "status") { args.push(p.b); continue; }
    if (p.kind === "specreview") { problems.push(`${p.b}: a spec review branch is not merged by a wave: its file reaches the main branch with the task branch, which merged it (mkspec dev). Leave this branch out.`); continue; }
    if (once.has(p.b)) { problems.push(`${p.b}: listed twice.`); continue; }
    once.add(p.b);
    if (!records.has(p.key)) records.set(p.key, read(p.key));
    const r = records.get(p.key);
    if (r.state === "ok") {
      if (p.kind === "task") { args.push(`${p.b}@${r.head}`); continue; }
      const cov = r.covers.get(p.name);
      if (cov && cov.file) args.push(`${p.b}~${r.head}:${cov.reviewSha}=${cov.file}`);
      else problems.push(`${p.b}: no passing review of ${p.key} at ${r.head} is recorded for this branch (run node reviewed.mjs ${p.key} ${p.name} after its review, or leave the branch out).`);
      continue;
    }
    // A review branch of a task is judged with the task: one message per task, from its own branch if it is in the wave.
    if (p.kind === "process" && parsed.some((x) => x.kind === "task" && x.key === p.key)) continue;
    if (r.state === "failed") problems.push(`${p.b}: the review of ${p.key} says fail (head ${r.head}). Nothing is merged for it. Send the task back (rework, then a new review round); the wave takes the head of the review that passes.`);
    else if (r.state === "unreadable") problems.push(`${p.b}: the Controller's journal gives no usable review record for ${p.key} (${r.why}). Nothing is merged for it. Repair the journal line or send the task back to review.`);
    else problems.push(`${p.b}: the Controller's journal has no record of a passing review of ${p.key}, so there is no commit to merge. Nothing is merged for it.\n`
      + `    Either the verdict was not recorded: then run, with the review branch and the full SHA from the reviewer's worker_done,\n`
      + `      node reviewed.mjs <task> origin/${prefix}${p.key}-review-<n> <review-sha>      (-review-final after a re-evaluation; the conformance branch for a level 2/3 task)\n`
      + `    It reads that findings file at that commit, checks that the commit it names is on origin/${prefix}${p.key}, and records it; the wave then merges exactly that commit, and stops with both commits if the branch has moved since.\n`
      + `    Or the review is older than this check (one-time): its reviewer reported no review SHA, so it cannot be recorded and is not accepted without one. Send the task back to review (the full path: a new Tester round on the current head, whose worker_done carries the SHA), then record that.\n`
      + `    No Tester review: a docs-only task is recorded by node docsonly.mjs; an Architect branch (architecture-baseline, stewardship-*) by node reviewed.mjs --architect <task>.`);
  }
  if (problems.length) return { problems };
  return { args, tasks: [...new Set(parsed.filter((p) => p.kind === "task").map((p) => p.key))] };
}
