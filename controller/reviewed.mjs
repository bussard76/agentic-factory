// Usage: node reviewed.mjs <task> <review-branch> → record the commit a review covered, in the Controller's journal
// <review-branch> is the branch the reviewer pushed its findings to, as the Controller's own mkspec names it: <prefix><task>-review-<n>
// (a Tester round), <prefix><task>-review-final (a re-evaluation) or <prefix><task>-conformance (the conformance review); with or
// without origin/. Run it after EVERY verdict, pass or fail: the latest one counts, and the wave merges exactly the commit of a
// passing one (CONTROLLER.md, "A wave merges what was reviewed"; docs/review-protocol.md).
// It fetches origin, reads the findings file on that branch (docs/reviews/<task>-review-<n>.md, -review-final.md or
// -architecture-conformance.md), takes its one `Verdict:` line and its one `Reviewed commit:` line, and refuses unless that
// commit is on the task's branch (origin/<prefix><task in lower case>) and the review branch was made from it. The record is a
// `review` event with `head`; nothing else the worker wrote is read. Exit 0: recorded (a note says whether the task's branch
// has already moved past the commit). Exit 3: refused, nothing recorded.
import "./cli.mjs";
import { spawnSync } from "node:child_process";
import { BRANCH_PREFIX, PROJECT_DIR, journal } from "./lib.mjs";
import { isSha } from "./reviewrecord.mjs";

const [task, reviewBranch] = process.argv.slice(2);
if (!task || !reviewBranch) throw new Error("usage: node reviewed.mjs <task> <review-branch>");
const git = (...a) => spawnSync("git", ["-C", PROJECT_DIR, ...a], { encoding: "utf8" });
const refuse = (text) => { console.log(`NOT RECORDED: ${text}`); process.exit(3); };
if (!/^[A-Za-z0-9._-]{1,64}$/.test(task)) refuse(`${JSON.stringify(task)} is not a task id.`);
const rb = reviewBranch.replace(/^origin\//, "");
const taskBranch = `${BRANCH_PREFIX}${task.toLowerCase()}`;
const kind = rb === `${taskBranch}-review-final` ? ["final", "review-final"] : rb === `${taskBranch}-conformance` ? ["conformance", "architecture-conformance"]
  : /^.+-review-\d+$/.test(rb) && rb.startsWith(`${taskBranch}-review-`) ? ["tester", `review-${rb.slice(`${taskBranch}-review-`.length)}`] : null;
if (!kind) refuse(`${reviewBranch} is not a review branch of ${task}: expected ${taskBranch}-review-<n>, ${taskBranch}-review-final or ${taskBranch}-conformance.`);
const [path, fileTail] = kind;
const fetched = git("fetch", "-q", "origin");
if (fetched.status !== 0) refuse(`git fetch failed in ${PROJECT_DIR}: ${(fetched.stderr || "").trim().split("\n")[0]}`);
const findings = `docs/reviews/${task}-${fileTail}.md`;
const shown = git("show", `origin/${rb}:${findings}`);
if (shown.status !== 0) refuse(`${findings} is not on origin/${rb}.`);
const text = shown.stdout;
// Exactly one verdict line and one reviewed-commit line, so a file cannot say two things.
const verdicts = text.split("\n").filter((l) => l.startsWith("Verdict:"));
const verdict = verdicts.length === 1 ? verdicts[0].match(/^Verdict: (pass|fail)\s*$/)?.[1] : "";
if (!verdict) refuse(`${findings} has no single line "Verdict: pass" or "Verdict: fail" (${verdicts.length} Verdict lines).`);
const commits = text.split("\n").filter((l) => /^Reviewed commit:/.test(l));
const head = commits.length === 1 ? /^Reviewed commit:\s*(`?)([0-9a-f]{40})\1\s*$/.exec(commits[0])?.[2] : "";
if (!isSha(head)) refuse(`${findings} has no single line "Reviewed commit: <40-character SHA>" (${commits.length} such lines).`);
const tip = git("rev-parse", "--verify", `origin/${taskBranch}^{commit}`).stdout.trim();
if (!tip) refuse(`origin/${taskBranch} not found: there is no branch of ${task} to bind the commit to.`);
if (git("cat-file", "-e", `${head}^{commit}`).status !== 0) refuse(`the reviewed commit ${head} is not in this clone.`);
if (git("merge-base", "--is-ancestor", head, `origin/${taskBranch}`).status !== 0) refuse(`the reviewed commit ${head} is not on origin/${taskBranch} (tip ${tip}): the findings do not review this task's branch.`);
if (git("merge-base", "--is-ancestor", head, `origin/${rb}`).status !== 0) refuse(`origin/${rb} was not made from the reviewed commit ${head}.`);
journal("review", task, { verdict, path, head, branch: rb, file: findings, tip });
console.log(`recorded: ${task} ${path} review says ${verdict} for ${head} (findings ${findings} on origin/${rb}).`);
if (tip !== head) console.log(`note: origin/${taskBranch} is at ${tip}, not at the reviewed commit. A wave merges ${head} only if the branch has moved by clean merges of the main branch alone; otherwise it stops and the task goes back to review.`);
