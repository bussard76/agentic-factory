// The Controller's own record of which commit of a task was reviewed, and how a wave branch is told apart. A module for
// wave.mjs and reviewed.mjs (nobody runs it); it reads nothing but what it is given, so tests can call it directly.
//
// The record is a `review` event of the Controller's journal (journal.ndjson) with a `head`: written by reviewed.mjs (a
// Tester round, a re-evaluation, a conformance review: it reads the findings file once and records the commit it names)
// and by docsonly.mjs (the docs-only evidence). Both run in the Controller's directory, on its host; a worker's push
// reaches neither. The journal is protected by that, not by file permissions: a process of the same user can append to it.

const SHA = /^[0-9a-f]{40}$/;
export const isSha = (s) => typeof s === "string" && SHA.test(s);

/** The latest review event of a task with a head, from the text of the journal.
 *  { state: "ok", head, event }       latest verdict is pass (a Tester, re-evaluation or conformance review) or docs-only
 *  { state: "failed", head, event }   latest verdict is fail
 *  { state: "none" }                  no review event with a head names the task (a task reviewed before this record existed)
 *  { state: "unreadable", why }       the journal cannot be read, or a line that mentions the task cannot be parsed
 *  `text` is the journal's text, or an Error (ENOENT counts as no journal: "none"). `key` is the task id in lower case,
 *  the part of the branch name after the branch prefix. */
export function latestReview(text, key) {
  if (text instanceof Error) return text.code === "ENOENT" ? { state: "none" } : { state: "unreadable", why: text.message };
  const want = String(key).toLowerCase();
  let latest = null;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let e = null;
    try { e = JSON.parse(line); } catch { /* checked below */ }
    if (!e || typeof e !== "object") {
      // A line that is not JSON may be the very record: if it names the task, the answer is "unreadable", not "none".
      if (line.toLowerCase().includes(want)) return { state: "unreadable", why: `a journal line that mentions ${key} is not valid JSON: ${line.slice(0, 80)}` };
      continue;
    }
    if (e.type !== "review" || String(e.task).toLowerCase() !== want || !isSha(e.head)) continue;
    latest = e;
  }
  if (!latest) return { state: "none" };
  if (latest.verdict === "pass" || latest.verdict === "docs-only") return { state: "ok", head: latest.head, event: latest };
  if (latest.verdict === "fail") return { state: "failed", head: latest.head, event: latest };
  return { state: "unreadable", why: `the latest review event of ${key} has the verdict ${JSON.stringify(latest.verdict)}` };
}

// The branches a task makes besides its own: the Tester's review branches, the re-evaluation, the conformance review, the
// spec review. They carry findings files only; a wave binds them to the task's reviewed commit (integ-wave.sh).
const PROCESS = /-(review-(\d+|final)|conformance|specreview)$/;

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
 *  `<branch>~<sha>` (their commits may add findings files only, on top of that commit); status branches stay as they are.
 *  { args } or { problems: [text] }. */
export function bindBranches(branches, { prefix, read }) {
  const parsed = branches.map((b) => ({ b, ...classify(b, prefix) }));
  const problems = [], records = new Map(), once = new Set();
  for (const p of parsed) {
    if (p.kind === "foreign") { problems.push(`${p.b}: not a branch under the prefix ${JSON.stringify(prefix)} and not status-wave-<n>: a wave merges only task branches whose review is recorded.`); continue; }
    if (p.kind === "status") continue;
    if (once.has(p.b)) { problems.push(`${p.b}: listed twice.`); continue; }
    once.add(p.b);
    if (!records.has(p.key)) records.set(p.key, read(p.key));
    const r = records.get(p.key);
    if (r.state === "ok") continue;
    // A review branch of a task is judged with the task: one message per task, from its own branch if it is in the wave.
    if (p.kind === "process" && parsed.some((x) => x.kind === "task" && x.key === p.key)) continue;
    if (r.state === "failed") problems.push(`${p.b}: the latest review of ${p.key} says fail (head ${r.head}). Nothing is merged for it. Send the task back (rework, then a new review round); the wave takes the head of the review that passes.`);
    else if (r.state === "unreadable") problems.push(`${p.b}: the Controller's journal gives no usable review record for ${p.key} (${r.why}). Nothing is merged for it. Repair the journal line or send the task back to review.`);
    else problems.push(`${p.b}: the Controller's journal has no record of a passing review of ${p.key}, so there is no commit to merge. Nothing is merged for it.\n`
      + `    A task reviewed before the wave bound itself to the reviewed commit has none. That is the one-time case: once, for the review that passed, run\n`
      + `      node reviewed.mjs <task> origin/${prefix}${p.key}-review-<n>      (-review-final after a re-evaluation; the conformance branch for a level 2/3 task)\n`
      + `    It reads that findings file, checks that the commit it names is on origin/${prefix}${p.key}, and records it; the wave then merges exactly that commit, and stops with both commits if the branch has moved since. Or send the task back to review.\n`
      + `    No review at all: a docs-only task is recorded by node docsonly.mjs; an Architect branch by node journal.mjs review <task> verdict=pass path=architect head=<sha it reported>.`);
  }
  if (problems.length) return { problems };
  return { args: parsed.map((p) => (p.kind === "task" ? `${p.b}@${records.get(p.key).head}` : p.kind === "process" ? `${p.b}~${records.get(p.key).head}` : p.b)) };
}
