// Usage: node waiver.mjs <task> <review-branch> <review-sha> --findings <F1,F2> --decider <front-agent|owner> --words "<their words, verbatim>" --reason "<why this is no blocker>" --follow-up "<ticket id, debt entry or #issue>" [--ref "<task-ref>"]
// → record, in the Controller's journal, a decision of the Front agent or the owner that a FAILED review holds no blocker. The Controller
// never decides a waiver: it records the one it was given and quotes the words. Run it only after a decision, never to make a wave start.
// <review-branch> and <review-sha> are those of the failed review as reviewed.mjs recorded it (the branch of the findings file and its full
// commit id); <task> its ticket id. --findings names every finding the decision covers, by the id the findings file gives it (F1, F2, ...).
// --decider is who decided: owner (the human), or front-agent; for a ticket of level 3, for one whose level cannot be read, and for a failed
// final re-evaluation (-review-final) at any level, only the owner. --words is what they said, verbatim, and --reason and --follow-up say why it is no blocker and where the follow-up lives: a
// ticket file of origin/<main>, a debt entry of docs/debt.md on origin/<main>, or (with GitHub issues) #<n>. --ref is the task reference
// of mkspec ("#12"); with GitHub issues the level is the one the Controller recorded when it took the issue.
// It fetches origin and reads the findings file on the review's own commit, and refuses unless: that review is a recorded failure that still
// stands for the task's latest reviewed commit (a review that was never recorded, an older commit, a passed review: nothing to waive);
// the file is in the current classed format (templates/docs/review-protocol.md) and none of its findings is classed security,
// data-corruption, input-loss or gate (those need a fix, never a waiver); its gates were green; and every blocker and major finding is named.
// It writes a `waiver` event (by waiver.mjs): the wave then starts for that commit, merges exactly it, runs the full gate and pushes. The
// review stays what it is, a fail. A waiver covers that one review of that one commit: a new commit needs a new review, a second failed
// review of the same commit (a failed re-evaluation or conformance review) needs its own waiver.
// Exit 0: recorded. Exit 3: refused, nothing recorded.
import "./cli.mjs";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { BRANCH_PREFIX, MAIN, PROJECT_DIR, config, file, journal, ticketLevel } from "./lib.mjs";
import { DECIDERS, isSha, latestReview } from "./reviewrecord.mjs";
import { parseFindings, waivable } from "./findings.mjs";

const VALUE = ["--findings", "--decider", "--words", "--reason", "--follow-up", "--ref"];
const argv = process.argv.slice(2), opt = {}, pos = [];
for (let i = 0; i < argv.length; i++) { if (VALUE.includes(argv[i])) opt[argv[i]] = argv[++i]; else pos.push(argv[i]); }
const [task, reviewBranch, reviewSha] = pos;
const usage = 'usage: node waiver.mjs <task> <review-branch> <review-sha> --findings <F1,F2> --decider <front-agent|owner> --words "<their words>" --reason "<why>" --follow-up "<id>" [--ref "<task-ref>"]';
if (!task || !reviewBranch || pos.length !== 3) throw new Error(usage);
const git = (...a) => spawnSync("git", ["-C", PROJECT_DIR, ...a], { encoding: "utf8" });
const refuse = (text) => { console.log(`NOT RECORDED: ${text}`); process.exit(3); };
if (!/^[A-Za-z0-9._-]{1,64}$/.test(task)) refuse(`${JSON.stringify(task)} is not a task id.`);
if (!isSha(reviewSha)) refuse(`${JSON.stringify(reviewSha)} is not a full commit id: pass the review branch's commit as the reviewer reported it.`);
for (const o of ["--findings", "--decider", "--words", "--reason", "--follow-up"]) if (!opt[o]?.trim()) refuse(`${o} is required: a waiver records who decided, in which words, why it is no blocker, which findings it covers and where the follow-up lives.`);
if (!DECIDERS.has(opt["--decider"])) refuse(`--decider is ${JSON.stringify(opt["--decider"])}: it is front-agent or owner. The Controller does not decide a waiver.`);
if (opt["--words"].trim().split(/\s+/).length < 3) refuse(`--words has to be what the ${opt["--decider"]} said, verbatim; fewer than three words is no decision.`);
const named = opt["--findings"].split(",").map((s) => s.trim());
const key = task.toLowerCase(), rb = reviewBranch.replace(/^origin\//, ""), taskBranch = `${BRANCH_PREFIX}${key}`;
const fetched = git("fetch", "-q", "--no-tags", "origin");
if (fetched.status !== 0) refuse(`git fetch failed in ${PROJECT_DIR}: ${(fetched.stderr || "").trim().split("\n")[0]}`);
const resolve = (name) => git("rev-parse", "--verify", "-q", `refs/remotes/origin/${name}^{commit}`).stdout.trim();
const show = (rev, p) => git("show", `${rev}:${p}`);
let journalText; try { journalText = fs.readFileSync(file("journal.ndjson"), "utf8"); } catch (e) { journalText = e; }

// 1. The review: a recorded failure that stands for the task's latest reviewed commit. Nothing is taken from the arguments but the names.
const st = latestReview(journalText, key, Number(config.reviews?.maxRounds ?? 2));
if (st.state === "none" || st.state === "unreadable") refuse(`the Controller's journal has no usable review record of ${task}${st.why ? ` (${st.why})` : ""}: a waiver is for a review that was recorded as a failure (node reviewed.mjs).`);
if (st.state === "ok") refuse(`the latest review of ${task} (${st.event.head}) did not fail: there is nothing to waive.`);
const standing = st.state === "waived" ? st.failures : st.standing;
const review = standing.find((f) => f.branch === rb && f.reviewSha === reviewSha);
if (!review) refuse(`${rb} at ${reviewSha} is not a failed review that stands for ${task}'s latest reviewed commit ${st.head}${standing.length ? ` (it has: ${standing.map((f) => `${f.branch} at ${f.reviewSha}`).join("; ")})` : ""}. A waiver covers one recorded failed review of that commit, nothing else: a review that was never recorded, an older commit and a superseded round are not covered.`);
if (st.state === "waived" && st.waivers.some((w) => w.reviewSha === reviewSha && w.branch === rb)) refuse(`this review of ${task} is already waived.`);
if (!review.file || !review.head || !isSha(review.head)) refuse(`the record of this review has no findings file or reviewed commit.`);
// A failed re-evaluation is the human's decision at every level (review protocol, "Later rounds"): the Front agent does not decide it.
if (review.path === "final" && opt["--decider"] !== "owner") refuse(`${rb} is the final functional re-evaluation: its failure is the owner's decision, at every level (--decider owner, with their words verbatim).`);
// 2. Still what was recorded: the review branch and the task's branch.
const rbTip = resolve(rb);
if (rbTip !== reviewSha) refuse(`origin/${rb} is at ${rbTip || "(missing)"}, not at ${reviewSha}: it was pushed to after the review was recorded. Ask for the review again.`);
const taskTip = resolve(taskBranch);
if (!taskTip) refuse(`origin/${taskBranch} not found.`);
if (git("merge-base", "--is-ancestor", review.head, taskTip).status !== 0) refuse(`the reviewed commit ${review.head} is not on origin/${taskBranch} (tip ${taskTip}) any more.`);
// 3. The findings, read from the commit of the review branch itself, strictly.
const shown = show(reviewSha, review.file);
if (shown.status !== 0) refuse(`${review.file} is not on ${reviewSha}.`);
const commitLines = shown.stdout.split("\n").filter((l) => /^Reviewed commit:/.test(l));
if (commitLines.length !== 1 || /^Reviewed commit:\s*(`?)([0-9a-f]{40})\1\s*$/.exec(commitLines[0])?.[2] !== review.head) refuse(`${review.file} does not name ${review.head} on its one Reviewed commit line.`);
const verdictLines = shown.stdout.split("\n").filter((l) => l.startsWith("Verdict:"));
if (verdictLines.length !== 1 || verdictLines[0].trim() !== "Verdict: fail") refuse(`${review.file} does not say "Verdict: fail" on its one Verdict line: only a failed review is waived.`);
const w = waivable(parseFindings(shown.stdout), named, review.path);
if (!w.ok) refuse(w.why);
// 4. Who may decide: the level comes from the ticket as it is on the main branch (and where the work started), never from the task branch.
const level = ticketLevelOnMain();
const levelText = level === null ? "its level cannot be read from the ticket on the main branch" : `its level is ${level}`;
if (opt["--decider"] !== "owner" && (level === null || level >= 3)) refuse(`${task}: ${levelText}. For a ticket of level 3, or one whose level cannot be established, only the owner decides a waiver (--decider owner, with their words verbatim). The Front agent decides levels 1 and 2.`);
// 5. The follow-up exists where it says.
const followUp = opt["--follow-up"].trim();
const where = followUpProblem(followUp);
if (where) refuse(where);
journal("waiver", task, { by: "waiver.mjs", head: review.head, branch: rb, reviewSha, file: review.file, path: review.path, findings: named, decider: opt["--decider"], words: opt["--words"].trim(), reason: opt["--reason"].trim(), followUp, level, tip: taskTip });
console.log(`recorded: ${task}: ${rb} (${review.file}, still Verdict: fail) is waived for ${review.head}: ${named.join(", ")}; decided by the ${opt["--decider"]}; follow-up ${followUp}.`);
const left = standing.filter((f) => f !== review && !(st.state === "waived" && st.waivers.some((x) => x.reviewSha === f.reviewSha && x.branch === f.branch)));
if (left.length) console.log(`note: ${task} has ${left.length} more failed review(s) standing for ${review.head} (${left.map((f) => f.branch).join(", ")}): each needs its own waiver before the wave starts.`);
console.log(`The wave now starts for ${review.head} if the branch is unchanged (a clean merge of ${MAIN} is fine) and its full gate passes. Add origin/${rb} to the wave: the failed findings file goes to ${MAIN} with it.`);
process.exit(0);

// The task's level as the main branch has it: the higher of the ticket at the commit the task's branch grew from and the ticket now, read
// with git from origin/<main> and never from the task branch. null when it is not a plain level (or there is no ticket).
function ticketLevelOnMain() {
  if (config.steering?.mode === "github-issues") {
    const n = /^#?(\d+)$/.exec(opt["--ref"] ?? "")?.[1];
    if (!n) refuse(`with GitHub issues, pass the task reference: --ref "#<n>" (the level is the one the Controller recorded when it took the issue).`);
    let first = null;
    for (const line of typeof journalText === "string" ? journalText.split("\n") : []) { try { const e = JSON.parse(line); if (e.type === "claim" && String(e.task) === n) { first = e; break; } } catch { /* a torn line */ } }
    return Number.isInteger(first?.level) && first.level >= 1 && first.level <= 3 ? first.level : null;
  }
  const dir = (config.steering?.tasksDir ?? "docs/tasks").replace(/\/$/, "");
  const base = git("merge-base", `refs/remotes/origin/${MAIN}`, `refs/remotes/origin/${taskBranch}`).stdout.trim();
  const levels = [base, `refs/remotes/origin/${MAIN}`].map((rev) => {
    if (!rev) return null;
    const files = git("ls-tree", "--name-only", rev, `${dir}/`).stdout.split("\n").filter((f) => { const n = f.slice(dir.length + 1).toLowerCase(); return n === `${key}.md` || n.startsWith(`${key}-`) && n.endsWith(".md"); });
    return files.length === 1 ? ticketLevel(show(rev, files[0]).stdout) : null;
  });
  return levels.some((l) => l === null) ? null : Math.max(...levels);
}

// Where the follow-up lives: a ticket file or a debt entry on origin/<main>, or an issue number with GitHub issues. Never the task itself.
function followUpProblem(id) {
  const same = id.toLowerCase() === key || id.replace(/^#/, "") === (opt["--ref"] ?? "").replace(/^#/, "") && /^#?\d+$/.test(id);
  if (same) return `the follow-up is ${id}: it has to be another ticket, a debt entry or an issue, not the task that is waived.`;
  if (config.steering?.mode === "github-issues" && /^#\d+$/.test(id)) return "";
  const dir = (config.steering?.tasksDir ?? "docs/tasks").replace(/\/$/, "");
  if (git("ls-tree", "--name-only", `refs/remotes/origin/${MAIN}`, `${dir}/`).stdout.split("\n").some((f) => { const n = f.slice(dir.length + 1).toLowerCase(); return n.endsWith(".md") && (n === `${id.toLowerCase()}.md` || n.startsWith(`${id.toLowerCase()}-`)); })) return "";
  const debt = show(`refs/remotes/origin/${MAIN}`, "docs/debt.md");
  if (debt.status === 0 && debt.stdout.split("\n").some((l) => l.replace(/^\|\s*/, "").startsWith(`${id} |`) || l.replace(/^\|\s*/, "").startsWith(`${id}|`))) return "";
  return `the follow-up ${JSON.stringify(id)} is not a ticket file in ${dir}/ or a debt entry in docs/debt.md on origin/${MAIN}${config.steering?.mode === "github-issues" ? ", nor an issue as #<n>" : ""}: write the follow-up first, then record the waiver.`;
}
