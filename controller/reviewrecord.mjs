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

/** The state of a task's review, from the text of the journal, in the order the events were written.
 *  { state: "ok", head, event, covers }   the latest primary review (Tester round, re-evaluation, docs-only, Architect) passed
 *                                         and no review of any path failed on that commit; `covers` maps each review branch
 *                                         with a passing record for that commit to its event (the conformance branch too)
 *  { state: "failed", head, event }       the latest primary review failed, or a review of any path failed on the commit
 *  { state: "none" }                      no usable event names the task (a task reviewed before this record existed)
 *  { state: "unreadable", why }           the journal cannot be read, or a line that mentions the task cannot be parsed
 *  A failed review of a head is final for that head: a later pass of the same commit does not undo it. A conformance review
 *  never binds a head by itself, it can only fail one. `text` is the journal's text, or an Error (ENOENT: no journal).
 *  `key` is the task id in lower case, the part of the branch name after the branch prefix. */
export function latestReview(text, key) {
  if (text instanceof Error) return text.code === "ENOENT" ? { state: "none" } : { state: "unreadable", why: text.message };
  const r = events(text, key);
  if (r.unreadable) return { state: "unreadable", why: r.unreadable };
  const poisoned = new Set();
  let last = null;
  for (const e of r.list) {
    const conformance = e.path === "conformance";
    if (!conformance && !PRIMARY.has(e.path)) return { state: "unreadable", why: `a review event of ${key} has the path ${JSON.stringify(e.path)}` };
    if (e.verdict === "fail") { poisoned.add(e.head); if (!conformance || last?.event.head === e.head) last = { ok: false, event: e }; }
    else if ((e.verdict === "pass" || e.verdict === "docs-only") && !conformance) last = { ok: true, event: e };
    else if (!(conformance && e.verdict === "pass")) return { state: "unreadable", why: `the review event of ${key} has the verdict ${JSON.stringify(e.verdict)}` };
  }
  if (!last) return { state: "none" };
  const head = last.event.head;
  if (!last.ok || poisoned.has(head)) return { state: "failed", head, event: last.event };
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

/** What a wave branch is, from its name (`origin/` optional): "status" (status-wave-<n>, made by the Controller from main),
 *  "process" (a review branch of a task: { key }), "task" ({ key }: needs the record), or "foreign" (not under the branch prefix). */
export function classify(branch, prefix = "") {
  const name = branch.replace(/^origin\//, "");
  if (/^status-wave-\d+$/.test(name)) return { kind: "status", name };
  if (!name.startsWith(prefix)) return { kind: "foreign", name };
  const rest = name.slice(prefix.length);
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
    if (once.has(p.b)) { problems.push(`${p.b}: listed twice.`); continue; }
    once.add(p.b);
    if (!records.has(p.key)) records.set(p.key, read(p.key));
    const r = records.get(p.key);
    if (r.state === "ok") {
      if (p.kind === "task") { args.push(`${p.b}@${r.head}`); continue; }
      const cov = r.covers.get(p.name);
      if (cov) args.push(`${p.b}~${r.head}:${cov.reviewSha}`);
      else problems.push(`${p.b}: no passing review of ${p.key} at ${r.head} is recorded for this branch (run node reviewed.mjs ${p.key} ${p.name} after its review, or leave the branch out).`);
      continue;
    }
    // A review branch of a task is judged with the task: one message per task, from its own branch if it is in the wave.
    if (p.kind === "process" && parsed.some((x) => x.kind === "task" && x.key === p.key)) continue;
    if (r.state === "failed") problems.push(`${p.b}: the review of ${p.key} says fail (head ${r.head}). Nothing is merged for it. Send the task back (rework, then a new review round); the wave takes the head of the review that passes.`);
    else if (r.state === "unreadable") problems.push(`${p.b}: the Controller's journal gives no usable review record for ${p.key} (${r.why}). Nothing is merged for it. Repair the journal line or send the task back to review.`);
    else problems.push(`${p.b}: the Controller's journal has no record of a passing review of ${p.key}, so there is no commit to merge. Nothing is merged for it.\n`
      + `    This is what a Controller sees that forgot to record the verdict, and the one-time case of a task reviewed before the wave bound itself to a commit. Run, for the review that passed,\n`
      + `      node reviewed.mjs <task> origin/${prefix}${p.key}-review-<n> [<its sha from worker_done>]      (-review-final after a re-evaluation; the conformance branch for a level 2/3 task)\n`
      + `    It reads that findings file, checks that the commit it names is on origin/${prefix}${p.key}, and records it; the wave then merges exactly that commit, and stops with both commits if the branch has moved since. Or send the task back to review.\n`
      + `    No Tester review: a docs-only task is recorded by node docsonly.mjs; an Architect branch (architecture-baseline, stewardship-*) by node reviewed.mjs --architect <task>.`);
  }
  if (problems.length) return { problems };
  return { args };
}
