// Spec templates per role. Always generate a spec from here with parameters; never derive one by editing another
// task's spec (that once produced a Tester pointed at the wrong branch). Writes specs/<key>.txt and prints its path.
//
//   node templates/mkspec.mjs dev     <T> <task-ref> <branch> [--level 1|2] [--review <branch>:<file>] [--extra "…"]
//   node templates/mkspec.mjs rework  <T> <n> <task-ref> <branch> <review-branch>:<review-file> [--level 1|2] [--extra "…"]
//   node templates/mkspec.mjs test    <T> <task-ref> <branch> <sha> [--round n] [--review <branch>:<file>]
//   node templates/mkspec.mjs reeval  <T> <task-ref> <branch> <sha> <last-review-branch>:<file>
//   node templates/mkspec.mjs specreview <T> <task-ref> <branch>
//   node templates/mkspec.mjs conf    <T> <task-ref> <branch> <sha> <spec-review-branch>:<file>
//   node templates/mkspec.mjs audit   <since-ISO>
//   node templates/mkspec.mjs retro   <T> <n> "<trigger>" "<worktrees>" "<sources>"
//
// <task-ref> is the task file path (orca-tasks mode) or "#<issue>" (github-issues mode).
import fs from "node:fs";
import path from "node:path";
import { BRANCH_PREFIX, CMDS, HUMAN, MAIN, PROJECT, STEERING, config, file } from "../lib.mjs";

const [role, ...a] = process.argv.slice(2);
const opt = (flag, def) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : def; };
const pos = a.filter((x, i) => !x.startsWith("--") && !(i > 0 && a[i - 1].startsWith("--")));
const split = (s) => { const i = s?.indexOf(":") ?? -1; return i > 0 ? { branch: s.slice(0, i), file: s.slice(i + 1) } : { branch: s, file: "" }; };
const maxRounds = config.reviews?.maxRounds ?? 2;
const taskWhere = (ref) => (STEERING === "github-issues" ? `GitHub issue ${ref} (gh issue view ${ref.replace("#", "")})` : `docs/tasks/${path.basename(ref)}`);
const reportFor = (ref) => `docs/reports/${STEERING === "github-issues" ? `issue-${ref.replace("#", "")}` : path.basename(ref, ".md")}.md`;
const RULES = `Rules: invented data only, demo or mock only, never send or write anything real, never --no-verify, never print secrets, never push to ${MAIN}.`;
const FLAKES = `Known load flakes may be rerun once alone and recorded as unrelated debt. An unchanged test that fails only by timeout under load and passes alone is load debt, not a finding. Failures from foreign host load (network changes) count as environment: rerun and state the count.`;
const DEV_CHECKS = `Checks (Developer stage): ${[CMDS.typecheck, CMDS.lint].filter(Boolean).join(" and ") || "typecheck and lint"}, the affected suites (${CMDS.unit ?? "the unit runner"} <files>) and the browser specs covering your change (through 'gate'). Do NOT run the full '${CMDS.verify ?? "verify"}' or the full '${CMDS.e2e ?? "e2e"}': the independent Tester and the wave run them.`;
const REVIEW_RULE = `Review rule (decided by ${HUMAN}, functional-only): the verdict is 'fail' ONLY for a real functional defect: a specified flow does not work or gives wrong results, data is lost, or a change could reach a real external system (production, real accounts, the human's real data). Missing or weak tests, coverage gaps, edge cases, security, load and style are 'debt candidates' (category tests|edge-case|security|load|style, severity, one-line proposal) and never fail the review. After ${maxRounds} rounds a working feature is integrated; open points become debt plus a preview acceptance item for ${HUMAN}.`;
const REPLY_DEV = `Reply: worker_done with branch, head sha and check results; or escalate one concrete blocker with progress committed and pushed. Never report an unfinished task as done.`;

const specs = {
  dev() {
    const [T, ref, branch] = pos; const level = opt("--level", "1"); const rv = split(opt("--review")); const extra = opt("--extra", "");
    return `You are the Developer for ${T} (level ${level}) on this host, in a fresh worktree on branch ${branch}.
Steps:
1. git fetch origin; create ${branch} from origin/${MAIN}${rv.branch ? ` and merge origin/${rv.branch} (the passing architecture spec review ${rv.file}; its binding instructions are part of the spec)` : ""}. Read AGENTS.md, docs/coordinator.md (worker rules), ${taskWhere(ref)}${rv.file ? ` and ${rv.file}` : ""}.
2. First write a checklist of every Result and Observable acceptance item into the report draft ${reportFor(ref)}; work through it item by item and push after each item. Do not stop while items remain.
3. Implement every item test-first through public entry points, in small commits. Follow the 'ponytail' and 'tdd' skills. Stay level ${level}: ${level === "2" ? "only the exports, dependencies or routes the task names; nothing beyond" : "no new public export, dependency, route, store or data flow"}. If you need more: stop and escalate.
4. ${DEV_CHECKS} ${FLAKES}
5. Before replying: self-review against the task and every binding instruction, item by item, in the report (name the test that proves each); fix gaps first.
6. Last step: merge origin/${MAIN}, rerun the affected suites, finish ${reportFor(ref)} (files changed, tests added, assumptions, debt candidates), push ${branch} to origin.${extra ? "\n" + extra : ""}
Screenshots: never commit binaries; keep captures untracked under .build/screenshots/ and list them in the report.
${RULES}
Done when: all items implemented, targeted checks green, branch pushed. Continue in this session until then.
${REPLY_DEV}`;
  },
  rework() {
    const [T, n, ref, branch, rvs] = pos; const rv = split(rvs); const level = opt("--level", "1"); const extra = opt("--extra", "");
    return `You are the Developer for ${T}, REWORK ${n}, in this existing worktree on branch ${branch}.
Steps:
1. git fetch origin. Confirm you are on ${branch} at origin/${branch}. Read ${rv.file} (git show origin/${rv.branch}:${rv.file}), ${taskWhere(ref)}, AGENTS.md and the worker rules in docs/coordinator.md.
2. Fix the functional findings exactly as the review states (debt candidates are not part of the rework), each test-first: write the review's proving test through the public entry point, see it fail, then fix. Small commits, push after each finding.${extra ? " " + extra : ""}
3. Stay level ${level}. If a fix needs more: stop and escalate instead of deciding.
4. ${DEV_CHECKS} ${FLAKES}
5. Add a "Rework ${n}" section to ${reportFor(ref)} naming the test that proves each fix.
6. Last step: merge origin/${MAIN}, rerun the affected suites, push ${branch}.
${RULES}
Done when: every blocker and major fixed with a failing-first test, targeted checks green, branch pushed.
${REPLY_DEV}`;
  },
  test() {
    const [T, ref, branch, sha] = pos; const round = opt("--round", "1"); const rv = split(opt("--review"));
    return `You are the INDEPENDENT REVIEWER (Worker Tester, round ${round}) for ${T} on origin/${branch} (fetch; state the full SHA, expected ${sha} or later).
Steps:
1. Read docs/review-protocol.md, ${taskWhere(ref)}${rv.file ? `, the passing architecture spec review ${rv.file} (origin/${rv.branch}; its binding instructions are part of the spec)` : ""} and the report on the branch.
2. Review the whole diff against its merge-base with origin/${MAIN} against every Result and Observable acceptance item. Run 'ponytail-review' on the full diff. Check the level is kept, tests go through public entry points and fail without the implementation, untrusted content is escaped, invented data only, no secrets, no changes to real external systems.
3. Create a temporary branch from the reviewed head and merge current origin/${MAIN} into it; if it conflicts, abort, list the files and review on the branch's own base.
4. Gates: 'gate ${CMDS.verify ?? "verify"}' once${CMDS.e2e ? ` and 'gate ${CMDS.e2e}' once` : ""} (detached with nohup, poll the log). ${FLAKES} Then check the task's main flows in the browser or through the public API with the demo data.
5. Only after the gates finished: write docs/reviews/${T}-review-${round}.md with findings by severity, debt candidates, 'Reviewed commit: <full SHA>' and 'Verdict: pass|fail'. Commit only that file on branch ${BRANCH_PREFIX}${T.toLowerCase()}-review-${round} created from the reviewed head, never --no-verify, push only that branch.
${REVIEW_RULE}
Read-only otherwise; demo or mock only; never send anything; no Docker.
Reply: worker_done with verdict and --report-path docs/reviews/${T}-review-${round}.md.`;
  },
  reeval() {
    const [T, ref, branch, sha, last] = pos; const lv = split(last);
    return `You are the INDEPENDENT REVIEWER for a functional re-evaluation of ${T} (Worker Tester, final round).
${REVIEW_RULE}
Steps:
1. git fetch origin; check out origin/${branch} at exactly ${sha} (state the full SHA). Read ${taskWhere(ref)} and the last review ${lv.file} on origin/${lv.branch}.
2. Classify every finding of that review as 'functional defect' or 'debt candidate'. Do not invent new findings beyond a quick check of the main flows.
3. The last full gates on this commit are in that review; do not rerun the full suites. Run the browser specs or API checks that cover the task's main flows once and look at the flows.
4. Write docs/reviews/${T}-review-final.md: 'Reviewed commit: <full SHA>', 'Verdict: pass|fail', the classification table, the debt candidates, and one sentence ${HUMAN} can try on the preview for each open point. Commit only that file on branch ${BRANCH_PREFIX}${T.toLowerCase()}-review-final from ${sha}, never --no-verify, push only that branch.
Reply: worker_done with verdict and --report-path docs/reviews/${T}-review-final.md.`;
  },
  specreview() {
    const [T, ref, branch] = pos;
    return `You are the Worker Architect for the pre-build architecture spec review of ${T} under docs/architect-protocol.md.
Steps:
1. git fetch origin; create branch ${BRANCH_PREFIX}${T.toLowerCase()}-specreview from origin/${branch}. Read ${taskWhere(ref)}, AGENTS.md, ARCHITECTURE.md (if present) and the connected code.
2. Confirm or raise the level. Are the interfaces exact and buildable, the seams, bounds, states (empty, ambiguous, error), privacy and ownership sufficient? Does the outside-in evidence (design/<feature>/, interfaces, logic diagram) match the spec?
3. Write docs/reviews/${T}-architecture-spec.md with findings and 'Verdict: pass|change-spec|level-3'. Precision-only gaps may be binding instructions for the Developer with a pass; anything design-relevant is change-spec; anything needing ${HUMAN}'s decision is level-3 with options and a recommendation.
4. Commit only that file, never --no-verify, push only your branch.
Done when the review is pushed. Do not write code, do not run test suites, never touch real data.
Reply: worker_done with verdict, level, branch and sha (--report-path docs/reviews/${T}-architecture-spec.md).`;
  },
  conf() {
    const [T, ref, branch, sha, rvs] = pos; const rv = split(rvs);
    return `You are the Worker Architect for the architecture conformance review of ${T} under docs/architect-protocol.md. Read-only except your review file.
Steps:
1. git fetch origin; create branch ${BRANCH_PREFIX}${T.toLowerCase()}-conformance from origin/${branch} at exactly ${sha} (the head the Tester passed; state the full SHA). Merge nothing into it.
2. Read docs/architect-protocol.md, ${taskWhere(ref)}, the passing spec review ${rv.file} (origin/${rv.branch}) and docs/coordinator.md.
3. Coarse boundary check only (decided by ${HUMAN}): no new export, contract, durable store or data flow without a recorded approval, and no forbidden imports. Do NOT hunt logic edge cases; note them as debt candidates. Focused checks only; no full suites. Security and load observations are debt unless a change could reach a real external system.
4. Write docs/reviews/${T}-architecture-conformance.md with findings, 'Reviewed commit: <full SHA>' and 'Verdict: pass|fail'. Commit only that file, never --no-verify, push only your branch.
Reply: worker_done with verdict, branch and sha (--report-path docs/reviews/${T}-architecture-conformance.md).`;
  },
  audit() {
    const [since] = pos;
    return `You are the read-only Pipeline Auditor for the ${PROJECT} agentic factory on this host. Change nothing except your audit file.
Inputs since ${since}: ~/controller/journal.ndjson (one JSON event per line), ~/load.log, ~/controller/status.md and inbox-done.md, the reviews and reports in the project repo changed since then (git log --since), docs/debt.md, docs/coordinator.md (the rules in force), and the previous audits in ~/controller/audits.
Questions: Where is time lost (gate waits, reruns, review rounds, stalls, early stops)? Which failure reasons cluster, by role, model and agent? Which rules or templates cause rework? Which risks grow (debt, flaky tests, load, quotas)? Did the improvements from the previous audit meet their success metrics? Does more parallelism raise throughput or only waiting (gate wait vs run minutes)?
Output: ~/controller/audits/$(date +%F)-<n>.md with: data basis (counts), top 3 improvements and top 3 risks, each with a measured value, cause, concrete proposal, level (1 = docs/templates/scripts/tests, otherwise 'needs ${HUMAN}') and a checkable success metric, plus the verdict on previous improvements. Max 1 page. No real data, no secrets.
Reply: worker_done with the file path and the three improvements in one line each.`;
  },
  retro() {
    const [T, n, trigger, worktrees, sources] = pos;
    return `You are the read-only Worker Retro for ${T} (retro ${n}) on this host. Change nothing except ~/controller/retros/${T}-${n}.md. No test suites, no gates, no git state changes, never print secrets.
Trigger: ${trigger}.
Steps:
1. Follow .agents/skills/retro/SKILL.md (read writing-for-agents as it says). The question: what went well, what didn't, what would we do differently, as changes to the agents' ENVIRONMENT (templates, scripts, docs, checks, coding standards), not blame.
2. Primary sources: the session logs of ${T}'s workers (Codex in ~/.codex/sessions/, Claude in ~/.claude/projects/; match by the worktree paths ${worktrees} and by time; read in bounded slices). Also: ${sources}; the journal entries for ${T}; the spec files ~/controller/specs/${T.toLowerCase()}-*.txt.
3. Look for repeated failing commands, wrong branch or file, forbidden actions attempted, spec gaps that caused rework, findings a check could have caught earlier, slow tool use, missing information.
4. Write ~/controller/retros/${T}-${n}.md: data basis, then 1–3 candidates ordered by severity. Each: category (navigation, automated checks, coding standards, AGENTS.md, tool economy, no-ops, information access), measured cost it removes, the concrete change (prefer an automated check over a new rule), level (1 = templates/controller scripts/docs/checks; otherwise 'needs ${HUMAN}'), and a checkable success metric. Max 1 page. No real data.
Reply: worker_done with the file path and one line per candidate (--report-path ~/controller/retros/${T}-${n}.md).`;
  },
};
if (!specs[role]) throw new Error(`unknown role ${role}; one of ${Object.keys(specs).join(", ")}`);
const text = specs[role]();
fs.mkdirSync(file("specs"), { recursive: true });
const key = `${(pos[0] ?? role).toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${role}${pos[1] && /^\d+$/.test(pos[1]) ? pos[1] : ""}`;
const out = file(`specs/${key}.txt`);
fs.writeFileSync(out, text + "\n");
console.log(out);
