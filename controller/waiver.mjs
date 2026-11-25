// Usage: node waiver.mjs <task> <review-branch> <review-sha> --findings <F1,F2> --decider <front-agent|owner> --words "<their words, verbatim>" --reason "<why this is no blocker>" --follow-up "<ticket id, debt id or #issue>"
// → record, in the Controller's journal, a decision of the Front agent or the owner that a FAILED review holds no blocker. The Controller
// never decides a waiver: it records the one it was given and quotes the words. Run it only after a decision, never to make a wave start.
// <review-branch> and <review-sha> are those of the failed review as reviewed.mjs recorded it (the branch of the findings file and its full
// commit id); <task> its ticket id. --findings names every finding the decision covers, by the id the findings file gives it (F1, F2, ...).
// WHO MAY DECIDE (--decider): the Front agent may waive only findings classed process or style (findings.mjs, FRONT_AGENT_WAIVABLE), on a ticket of
// level 1 or 2, in a round before the last one. The owner (the human) decides everything else: a functional finding, a ticket of level 3 or one whose
// level cannot be read, the last Tester round and anything after the round limit (a waiver then replaces the re-evaluation only because the owner
// decided it), and a failed re-evaluation (-review-final).
// WHAT THE CODE DOES NOT KNOW: --decider and --words are the caller's claim: it cannot tell who really spoke (debt F55). The class of a finding is the
// reviewer's own claim: it checks ids, format, level, the binding to one commit and the named findings, never that a class is right. Whoever decides
// must read the findings file.
// --words is what they said, verbatim, and --reason and --follow-up say why it is no blocker and where the follow-up lives: a ticket file of
// origin/<main> (not the README or the template), a debt entry of docs/debt.md on origin/<main>, or (with GitHub issues) #<n>. The level comes from the
// ticket on origin/<main>; with GitHub issues from the task's own record (the `taskref` event mkspec wrote when it first made a spec for the task, and
// the Controller's `claim` of that issue), never from a reference typed here (--ref is gone).
// It fetches origin and reads the findings file on the review's own commit, and refuses unless: that review is a recorded failure that still
// stands for the task's latest reviewed commit and has no waiver yet (a review that was never recorded, an older commit, a passed review, a review
// already waived: nothing to waive); the file is in the current classed format (templates/docs/review-protocol.md) and none of its findings is
// classed security, data-corruption, input-loss or gate (those need a fix, never a waiver); its gates were green; and every blocker and major
// finding is named.
// It writes a `waiver` event (by waiver.mjs): the wave then starts for that commit, merges exactly it, runs the full gate and pushes. The
// review stays what it is, a fail. A waiver covers that one review of that one commit: a new commit needs a new review, a second failed
// review of the same commit (a failed re-evaluation or conformance review) needs its own waiver.
// Exit 0: recorded. Exit 3: refused, nothing recorded.
import "./cli.mjs";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { BRANCH_PREFIX, MAIN, PROJECT_DIR, config, file, journal, ticketLevel } from "./lib.mjs";
import { DECIDERS, failedTesterRounds, isSha, latestReview, recordedIssues } from "./reviewrecord.mjs";
import { FRONT_AGENT_WAIVABLE, frontAgentMayWaive, parseFindings, waivable } from "./findings.mjs";

const VALUE = ["--findings", "--decider", "--words", "--reason", "--follow-up"];
const argv = process.argv.slice(2), opt = {}, pos = [], unknown = [];
for (let i = 0; i < argv.length; i++) { if (VALUE.includes(argv[i])) opt[argv[i]] = argv[++i]; else if (argv[i].startsWith("--")) { unknown.push(argv[i]); if (argv[i + 1] && !argv[i + 1].startsWith("--")) i++; } else pos.push(argv[i]); }   // an unknown option takes its value with it
const [task, reviewBranch, reviewSha] = pos;
const usage = 'usage: node waiver.mjs <task> <review-branch> <review-sha> --findings <F1,F2> --decider <front-agent|owner> --words "<their words>" --reason "<why>" --follow-up "<id>"';
const git = (...a) => spawnSync("git", ["-C", PROJECT_DIR, ...a], { encoding: "utf8" });
const refuse = (text) => { console.log(`NOT RECORDED: ${text}`); process.exit(3); };
if (unknown.length) refuse(`${unknown.join(" ")}: not an option of waiver.mjs.${unknown.includes("--ref") ? " --ref is gone: with GitHub issues the level comes from the task's own record (the issue mkspec bound to the task and the Controller's claim of it), never from a reference typed here." : ""} ${usage}`);
if (!task || !reviewBranch || pos.length !== 3) throw new Error(usage);
if (!/^[A-Za-z0-9._-]{1,64}$/.test(task)) refuse(`${JSON.stringify(task)} is not a task id.`);
if (!isSha(reviewSha)) refuse(`${JSON.stringify(reviewSha)} is not a full commit id: pass the review branch's commit as the reviewer reported it.`);
for (const o of VALUE) if (!opt[o]?.trim()) refuse(`${o} is required: a waiver records who decided, in which words, why it is no blocker, which findings it covers and where the follow-up lives.`);
if (!DECIDERS.has(opt["--decider"])) refuse(`--decider is ${JSON.stringify(opt["--decider"])}: it is front-agent or owner. The Controller does not decide a waiver.`);
if (opt["--words"].trim().split(/\s+/).length < 3) refuse(`--words has to be what the ${opt["--decider"]} said, verbatim; fewer than three words is no decision.`);
const named = opt["--findings"].split(",").map((s) => s.trim());
const key = task.toLowerCase(), rb = reviewBranch.replace(/^origin\//, ""), taskBranch = `${BRANCH_PREFIX}${key}`;
const fetched = git("fetch", "-q", "--no-tags", "origin");
if (fetched.status !== 0) refuse(`git fetch failed in ${PROJECT_DIR}: ${(fetched.stderr || "").trim().split("\n")[0]}`);
const resolve = (name) => git("rev-parse", "--verify", "-q", `refs/remotes/origin/${name}^{commit}`).stdout.trim();
const show = (rev, p) => git("show", `${rev}:${p}`);
let journalText; try { journalText = fs.readFileSync(file("journal.ndjson"), "utf8"); } catch (e) { journalText = e; }
const owner = opt["--decider"] === "owner";
const OWNER_ONLY = (why) => `${why} Only the owner decides this (--decider owner, with their words verbatim).`;

// 1. The review: a recorded failure that stands for the task's latest reviewed commit. Nothing is taken from the arguments but the names.
const maxSetting = config.reviews?.maxRounds ?? 2, maxRounds = /^\s*\d+\s*$/.test(String(maxSetting)) && Number(maxSetting) >= 1 ? Number(maxSetting) : null;   // unreadable: null, owner only
const st = latestReview(journalText, key, maxRounds ?? Infinity);
if (st.state === "none" || st.state === "unreadable") refuse(`the Controller's journal has no usable review record of ${task}${st.why ? ` (${st.why})` : ""}: a waiver is for a review that was recorded as a failure (node reviewed.mjs).`);
if (st.state === "ok") refuse(`the latest review of ${task} (${st.event.head}) did not fail: there is nothing to waive.`);
const standing = st.state === "waived" ? st.failures : st.standing;
const review = standing.find((f) => f.branch === rb && f.reviewSha === reviewSha);
if (!review) refuse(`${rb} at ${reviewSha} is not a failed review that stands for ${task}'s latest reviewed commit ${st.head}${standing.length ? ` (it has: ${standing.map((f) => `${f.branch} at ${f.reviewSha}`).join("; ")})` : ""}. A waiver covers one recorded failed review of that commit, nothing else: a review that was never recorded, an older commit and a superseded round are not covered.`);
// One decision per review: a second waiver (by anybody) is refused, so the first decider stays the one on record.
if ([...(st.waivers ?? []), ...(st.waived ?? [])].some((w) => w && w.reviewSha === reviewSha && w.branch === rb)) refuse(`this review of ${task} is already waived: one decision per review, and the first one stands.`);
if (!review.file || !review.head || !isSha(review.head)) refuse(`the record of this review has no findings file or reviewed commit.`);
// The Front agent never decides a failed re-evaluation, the last Tester round or anything after the round limit. Counted from the journal, never from a branch name.
if (review.path === "final" && !owner) refuse(OWNER_ONLY(`${rb} is the final functional re-evaluation: its failure is the owner's decision, at every level.`));
if (!owner) {
  const failedRounds = failedTesterRounds(journalText, key);
  if (maxRounds === null) refuse(OWNER_ONLY(`reviews.maxRounds (${JSON.stringify(maxSetting)}) cannot be read, so the round limit is unknown.`));
  if (failedRounds >= maxRounds) refuse(OWNER_ONLY(`${failedRounds} Tester round(s) of ${task} failed and the limit is ${maxRounds}: this is the last round or beyond the limit, where a waiver would replace the re-evaluation.`));
}
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
const parsed = parseFindings(shown.stdout);
const w = waivable(parsed, named, review.path);
if (!w.ok) refuse(w.why);
if (!owner) { const f = frontAgentMayWaive(parsed, named); if (!f.ok) refuse(f.why); }   // every named finding is process or style (the class is the reviewer's claim)
// 4. Who may decide: the level comes from the ticket as it is on the main branch (and where the work started), never from the task branch.
const issues = githubIssues() ? [...recordedIssues(journalText, task)] : [];
const issue = issues.length === 1 ? issues[0] : null;   // none or several: unknown
const level = ticketLevelOnMain();
const levelText = level === null ? "its level cannot be read from the ticket on the main branch (with GitHub issues: from the task's own recorded issue)" : `its level is ${level}`;
if (!owner && (level === null || level >= 3)) refuse(OWNER_ONLY(`${task}: ${levelText}. The Front agent decides levels 1 and 2 only.`));
// 5. The follow-up exists where it says.
const followUp = opt["--follow-up"].trim();
const where = followUpProblem(followUp);
if (where) refuse(where);
journal("waiver", task, { by: "waiver.mjs", head: review.head, branch: rb, reviewSha, file: review.file, path: review.path, findings: named, decider: opt["--decider"], words: opt["--words"].trim(), reason: opt["--reason"].trim(), followUp, level, tip: taskTip });
console.log(`recorded: ${task}: ${rb} (${review.file}, still Verdict: fail) is waived for ${review.head}: ${named.join(", ")}; decided by the ${opt["--decider"]} (as claimed: the code did not check who spoke, nor that the classes are right); follow-up ${followUp}.`);
const left = standing.filter((f) => f !== review && !(st.state === "waived" && st.waivers.some((x) => x.reviewSha === f.reviewSha && x.branch === f.branch)));
if (left.length) console.log(`note: ${task} has ${left.length} more failed review(s) standing for ${review.head} (${left.map((f) => f.branch).join(", ")}): each needs its own waiver before the wave starts.`);
console.log(`The wave now starts for ${review.head} if the branch is unchanged (a clean merge of ${MAIN} is fine) and its full gate passes. Add origin/${rb} to the wave: the failed findings file goes to ${MAIN} with it.`);
process.exit(0);

function githubIssues() { return config.steering?.mode === "github-issues"; }

// The task's level as the main branch has it: the higher of the ticket at the commit the task's branch grew from and the ticket now, read
// with git from origin/<main> and never from the task branch. null when it is not a plain level (or there is no ticket).
// With GitHub issues: the first `claim` record of the issue that mkspec bound to THIS task (exactly one; none or several: null).
function ticketLevelOnMain() {
  if (githubIssues()) {
    if (!issue) return null;
    let first = null;
    for (const line of typeof journalText === "string" ? journalText.split("\n") : []) { try { const e = JSON.parse(line); if (e.type === "claim" && String(e.task) === issue) { first = e; break; } } catch { /* a torn line */ } }
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

// Where the follow-up lives: a real ticket file or a debt entry on origin/<main>, or an issue number with GitHub issues. Never the task itself, never a
// README, a template, a table header or a separator: the id has to contain a digit (T2, F55, ABC-12), and the debt table is read by its rows.
function followUpProblem(id) {
  const bare = id.replace(/^#/, "");
  const same = id.toLowerCase() === key || (issue !== null && /^#?\d+$/.test(id) && bare === issue);
  if (same) return `the follow-up is ${id}: it has to be another ticket, a debt entry or an issue, not the task that is waived.`;
  if (githubIssues() && /^#\d+$/.test(id)) return "";
  const dir = (config.steering?.tasksDir ?? "docs/tasks").replace(/\/$/, "");
  const wanted = id.toLowerCase();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) && /\d/.test(id)) {
    const isTicket = (f) => { const n = f.slice(dir.length + 1).toLowerCase(); return n.endsWith(".md") && n !== "readme.md" && !/^[a-z]?0+-template\b/.test(n) && !(n === `${key}.md` || n.startsWith(`${key}-`)) && (n === `${wanted}.md` || n.startsWith(`${wanted}-`)); };
    if (git("ls-tree", "--name-only", `refs/remotes/origin/${MAIN}`, `${dir}/`).stdout.split("\n").some(isTicket)) return "";
    const debt = show(`refs/remotes/origin/${MAIN}`, "docs/debt.md");
    if (debt.status === 0) {
      const lines = debt.stdout.split("\n");
      const row = lines.some((l, i) => {
        if (!/^\s*\|/.test(l) || /^[\s|:-]+$/.test(l) || /<[a-z][^>]*>/.test(l) || /^[\s|:-]+$/.test(lines[i + 1] ?? "x") && /^\s*\|/.test(lines[i + 1] ?? "")) return false;   // not a row, a separator, the template's row or a header row
        return l.replace(/^\s*\|/, "").split("|")[0].trim().toLowerCase() === wanted;
      });
      if (row) return "";
    }
  }
  return `the follow-up ${JSON.stringify(id)} is not a ticket file in ${dir}/ (not the README or the template) or a debt entry in docs/debt.md on origin/${MAIN} (an id with a digit, in the first column of a row), nor an issue as #<n> with GitHub issues: write the follow-up first, then record the waiver.`;
}
