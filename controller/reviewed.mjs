// Usage: node reviewed.mjs <task> <review-branch> <review-sha>   or   node reviewed.mjs --architect <task>
// → record the commit a review covered, in the Controller's journal (the commit the wave then merges)
// <review-branch> is the branch the reviewer pushed its findings to, as the Controller's own mkspec names it: <prefix><task>-review-<n>
// (a Tester round), <prefix><task>-review-final (a re-evaluation) or <prefix><task>-conformance (the conformance review); with or
// without origin/. Run it after EVERY verdict, pass or fail, as the first step of handling the reviewer's worker_done, and pass the
// full SHA of the review branch the reviewer reported there (<review-sha>, required): it must be what origin has, or nothing is recorded.
// It fetches origin, resolves the review branch ONCE to a commit, reads the findings file on that commit
// (docs/reviews/<task>-review-<n>.md, -review-final.md or -architecture-conformance.md), takes its one `Verdict:` line and its one
// `Reviewed commit:` line, and refuses unless that commit is on the task's branch (origin/<prefix><task in lower case>), the review
// branch was made from it, and it is not older than the head already recorded for the task. The record is a `review` event with `head`
// and `reviewSha` (the commit it read); the wave binds the review branch to that commit. A fail is recorded too, and it is final for
// that commit; only a later passing re-evaluation (-review-final) undoes a failed Tester round of the same commit (reviewrecord.mjs, SUPERSEDES),
// or a waiver (waiver.mjs) records the decision of the Front agent or the owner that it holds no blocker (the review stays a fail). The head is as trustworthy as the review branch was when it was read: a worker who can push that branch name before
// this runs is not stopped here (debt F54, the push gate's own limit).
// --architect <task>: an Architect branch (<prefix>architecture-baseline or <prefix>stewardship-*, which no Tester reviews) is
// recorded at its tip if, against its merge base with the main branch, it only adds or changes ARCHITECTURE.md, docs/debt.md and
// files under docs/reviews/ that hold no findings (no deletion, rename or mode change).
// Exit 0: recorded. Exit 3: refused, nothing recorded.
import "./cli.mjs";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { BRANCH_PREFIX, MAIN, PROJECT_DIR, config, file, journal } from "./lib.mjs";
import { isSha, lastHead, failedTesterRounds } from "./reviewrecord.mjs";
import { waivableNote } from "./findings.mjs";

const args = process.argv.slice(2);
const architect = args[0] === "--architect";
const [task, reviewBranch, reviewSha] = architect ? args.slice(1) : args;
if (!task || (!architect && !reviewBranch)) throw new Error("usage: node reviewed.mjs <task> <review-branch> <review-sha>   or   node reviewed.mjs --architect <task>");
const git = (...a) => spawnSync("git", ["-C", PROJECT_DIR, ...a], { encoding: "utf8" });
const refuse = (text) => { console.log(`NOT RECORDED: ${text}`); process.exit(3); };
if (!/^[A-Za-z0-9._-]{1,64}$/.test(task)) refuse(`${JSON.stringify(task)} is not a task id.`);
const taskBranch = `${BRANCH_PREFIX}${task.toLowerCase()}`;
const fetched = git("fetch", "-q", "--no-tags", "origin");
if (fetched.status !== 0) refuse(`git fetch failed in ${PROJECT_DIR}: ${(fetched.stderr || "").trim().split("\n")[0]}`);
const resolve = (name) => git("rev-parse", "--verify", "-q", `refs/remotes/origin/${name}^{commit}`).stdout.trim();
const journalText = () => { try { return fs.readFileSync(file("journal.ndjson"), "utf8"); } catch (e) { return e; } };

if (architect) {
  if (!/^(architecture-baseline|stewardship-.+)$/.test(task.toLowerCase())) refuse(`${task} is not an Architect branch (architecture-baseline or stewardship-*).`);
  const tip = resolve(taskBranch);
  if (!tip) refuse(`origin/${taskBranch} not found.`);
  const base = git("merge-base", `refs/remotes/origin/${MAIN}`, tip).stdout.trim();
  if (!base) refuse(`origin/${taskBranch} has no common history with ${MAIN}.`);
  const raw = git("diff", "--no-renames", "--raw", "-z", base, tip).stdout.split("\0");
  const bad = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [om, nm, , , st] = raw[i].replace(/^:/, "").split(" "), p = raw[i + 1];
    const modeOk = (st === "A" && om === "000000" && nm === "100644") || (st === "M" && om === "100644" && nm === "100644");
    const pathOk = p === "ARCHITECTURE.md" || p === "docs/debt.md" || (/^docs\/reviews\/[^/]+$/.test(p) && st === "A" && !/^Reviewed commit:|^Verdict:/m.test(git("show", `${tip}:${p}`).stdout));
    if (!modeOk || !pathOk) bad.push(`${st} ${p}`);
  }
  if (bad.length) refuse(`origin/${taskBranch} changes more than an Architect branch may (${bad.slice(0, 3).join("; ")}).`);
  journal("review", task, { verdict: "pass", path: "architect", head: tip, branch: taskBranch, by: "reviewed.mjs" });
  console.log(`recorded: ${task} Architect branch at ${tip} (documents only).`);
  process.exit(0);
}

const rb = reviewBranch.replace(/^origin\//, "");
const kind = rb === `${taskBranch}-review-final` ? ["final", "review-final"] : rb === `${taskBranch}-conformance` ? ["conformance", "architecture-conformance"]
  : /^.+-review-\d+$/.test(rb) && rb.startsWith(`${taskBranch}-review-`) ? ["tester", `review-${rb.slice(`${taskBranch}-review-`.length)}`] : null;
if (!kind) refuse(`${reviewBranch} is not a review branch of ${task}: expected ${taskBranch}-review-<n>, ${taskBranch}-review-final or ${taskBranch}-conformance.`);
const [path, fileTail] = kind;
const rbSha = resolve(rb);
if (!rbSha) refuse(`origin/${rb} not found.`);
if (reviewSha === undefined) refuse(`no review SHA given. The reviewer reports its review branch and full SHA in worker_done (the Tester, re-evaluation and conformance specs ask for it) and you pass that SHA, so the commit read is the one reported. A review written before this check reported none: it cannot be recorded, and it is not accepted without one. Send the task back to review (the full path: a new Tester round on the current head, (mkspec test); where the round limit refuses a new round, the re-evaluation mkspec reeval on the commit the last round reviewed), then record that review with the SHA from its worker_done.`);
if (reviewSha !== undefined && reviewSha !== rbSha) refuse(`origin/${rb} is at ${rbSha}, not at ${reviewSha} that the reviewer reported: it was pushed to after the report. Ask for the review again.`);
if (reviewSha !== undefined && !isSha(reviewSha)) refuse(`${JSON.stringify(reviewSha)} is not a full commit id.`);
const findings = `docs/reviews/${task}-${fileTail}.md`;
const shown = git("show", `${rbSha}:${findings}`);
if (shown.status !== 0) refuse(`${findings} is not on origin/${rb} (${rbSha}).`);
const text = shown.stdout;
// Exactly one verdict line and one reviewed-commit line, so a file cannot say two things.
const verdicts = text.split("\n").filter((l) => l.startsWith("Verdict:"));
const verdict = verdicts.length === 1 ? verdicts[0].match(/^Verdict: (pass|fail)\s*$/)?.[1] : "";
if (!verdict) refuse(`${findings} has no single line "Verdict: pass" or "Verdict: fail" (${verdicts.length} Verdict lines).`);
const commits = text.split("\n").filter((l) => /^Reviewed commit:/.test(l));
const head = commits.length === 1 ? /^Reviewed commit:\s*(`?)([0-9a-f]{40})\1\s*$/.exec(commits[0])?.[2] : "";
if (!isSha(head)) refuse(`${findings} has no single line "Reviewed commit: <40-character SHA>" (${commits.length} such lines).`);
const tip = resolve(taskBranch);
if (!tip) refuse(`origin/${taskBranch} not found: there is no branch of ${task} to bind the commit to.`);
if (git("cat-file", "-e", `${head}^{commit}`).status !== 0) refuse(`the reviewed commit ${head} is not in this clone.`);
if (git("merge-base", "--is-ancestor", head, tip).status !== 0) refuse(`the reviewed commit ${head} is not on origin/${taskBranch} (tip ${tip}): the findings do not review this task's branch.`);
if (git("merge-base", "--is-ancestor", head, rbSha).status !== 0) refuse(`origin/${rb} (${rbSha}) was not made from the reviewed commit ${head}.`);
// A re-evaluation (-review-final) starts only after reviews.maxRounds failed Tester rounds, which is what lets it undo the last failed round.
if (path === "final") {
  const limit = Number(config.reviews?.maxRounds ?? 2), failed = failedTesterRounds(journalText(), task);
  if (failed < limit) refuse(`a re-evaluation (${rb}) follows reviews.maxRounds (${limit}) failed Tester rounds, but ${failed} are recorded for ${task}. Record the failed rounds first (node reviewed.mjs ${task} <review-branch> <review-sha> for each), or continue with rework and a new round.`);
}
// A verdict is for a commit the task has not left behind: recording an older head would move the binding backwards.
const before = lastHead(journalText(), task);
if (before && before !== head && git("merge-base", "--is-ancestor", head, before).status === 0) refuse(`${head} is older than ${before}, the head already recorded for ${task}: nothing is recorded for an older review.`);
journal("review", task, { verdict, path, head, branch: rb, reviewSha: rbSha, file: findings, tip, by: "reviewed.mjs" });
console.log(`recorded: ${task} ${path} review says ${verdict} for ${head} (findings ${findings} on origin/${rb} at ${rbSha}).`);
const unwaivable = verdict === "fail" ? waivableNote(text, path) : "";   // only the negative: the Controller never offers a waiver, it is somebody else's decision
if (unwaivable) console.log(`waiver: ${unwaivable}`);
if (tip !== head) console.log(`note: origin/${taskBranch} is at ${tip}, not at the reviewed commit. A wave merges ${head} only if the branch has moved by clean merges of the main branch alone; otherwise it stops and the task goes back to review.`);
