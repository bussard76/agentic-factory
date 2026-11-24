// Usage: node docsonly.mjs <task> <branch> [--ref "<task-ref>"] → does the pushed task branch change documentation only (docs/testing.md)?
// Runs main's docs-only check (tools/factory-guardrails.mjs docs-only from origin/<main>, or this clone's installed
// standard; never the branch's own copy) in the Controller's checkout on origin/<main>..origin/<branch>, with the
// settings of origin/<main>'s factory.config.json, and prints its evidence. Exit 0: docs-only, no Tester
// (CONTROLLER.md); the evidence is recorded in the journal as the task's review event, the review it replaces. Any
// other exit: review as usual, and nothing is journaled (the Tester's review is the task's review event).
// <task> is the Controller's ticket id (T12), and the branch must be the one the Controller's flow made for it
// (project.branchPrefix + the id in lower case): then the ticket's own spec review (docs/reviews/<task>-architecture-spec.md)
// and report (docs/reports/…) may be on the branch, as they are in every task of the flow, and nothing else under
// docs/reviews, docs/reports or the tickets. The ticket comes from these arguments and from origin/<main>'s tree, never
// from the branch. --ref is the task reference of mkspec ("#12" in github-issues mode, where it names the report); in
// orca-tasks mode the report is named after the ticket's file on origin/<main> and --ref is not needed.
import "./cli.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BRANCH_PREFIX, MAIN, PROJECT_DIR, journal } from "./lib.mjs";

const args = process.argv.slice(2);
const refAt = args.indexOf("--ref");
const taskRef = refAt >= 0 ? args[refAt + 1] : undefined;
const [task, branch] = args.filter((_, i) => refAt < 0 || (i !== refAt && i !== refAt + 1));
if (!task || !branch || (refAt >= 0 && !taskRef)) throw new Error('usage: node docsonly.mjs <task> <branch> [--ref "<task-ref>"]');
const git = (...a) => spawnSync("git", ["-C", PROJECT_DIR, ...a], { encoding: "utf8" });
const stop = (code, text) => { console.log(text); process.exit(code); };
const fetched = git("fetch", "-q", "origin");
if (fetched.status !== 0) stop(4, `git fetch failed in ${PROJECT_DIR}: ${(fetched.stderr || "").trim().split("\n")[0]}. Unclear: review as usual.`);
// The setting as it is on main, not the Controller's copy of the config (which changes only with agentic-factory update).
let cfg = {};
try { cfg = JSON.parse(git("show", `origin/${MAIN}:factory.config.json`).stdout); } catch {}
if (cfg.docsOnly?.enabled !== true) stop(3, `docsOnly.enabled is not set in origin/${MAIN}:factory.config.json: every task gets its review.`);
const ref = branch.startsWith("origin/") ? branch : `origin/${branch}`;
const head = git("rev-parse", "--verify", `${ref}^{commit}`).stdout.trim();
if (!head) stop(4, `${ref} not found after a fetch: review as usual.`);
const common = git("rev-parse", "--path-format=absolute", "--git-common-dir").stdout.trim();
const installed = common && path.join(common, "factory/hooks/factory-guardrails.mjs");
let check = installed && fs.existsSync(installed) ? installed : "";
if (!check) {
  const fromMain = git("show", `origin/${MAIN}:tools/factory-guardrails.mjs`);
  if (fromMain.status === 0) { check = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "docs-only-")), "factory-guardrails.mjs"); fs.writeFileSync(check, fromMain.stdout); }
}
if (!check) stop(4, `no docs-only check on origin/${MAIN} (tools/factory-guardrails.mjs) or in this clone's standard: review as usual.`);
// The ticket's own process files count only for the branch the Controller's flow made for this ticket; the check itself
// finds the ticket on origin/<main> and refuses what it cannot establish (then every process file stays "not documentation").
const ticketArgs = [];
if (ref === `origin/${BRANCH_PREFIX}${task.toLowerCase()}`) {
  ticketArgs.push("--ticket", task);
  const issue = /^#?(\d+)$/.exec(taskRef ?? "")?.[1];
  if (cfg.steering?.mode === "github-issues" && issue) ticketArgs.push("--issue", issue);
} else console.log(`note: ${ref} is not the branch of ${task} (${BRANCH_PREFIX}${task.toLowerCase()}), so the ticket's own spec review and report are not accepted on it.`);
const r = spawnSync("node", [check, "docs-only", `origin/${MAIN}..${head}`, ...ticketArgs, "--json"], { cwd: PROJECT_DIR, encoding: "utf8" });
let result = null;
try { result = JSON.parse(r.stdout.trim().split("\n").at(-1)); } catch {}
if (!result) stop(4, `the docs-only check gave no verdict (exit ${r.status}): ${`${r.stdout}${r.stderr}`.trim().split("\n").slice(-3).join(" | ")}. Review as usual.`);
console.log(`docs-only check of ${ref} at ${head.slice(0, 12)} against origin/${MAIN}:`);
for (const row of result.rows) console.log(`  ${row.status} ${JSON.stringify(row.path)}${row.why ? `  <- ${row.why}` : row.note ? `  (${row.note})` : ""}`);
console.log(`verdict=${result.verdict} reason="${result.reason}"`);
if (r.status === 0 && result.verdict === "docs-only") journal("review", task, { verdict: "docs-only", path: "docs-only", head, paths: result.rows.map((x) => x.path), ...(ticketArgs.length ? { ticket: task } : {}) });
process.exit(r.status === 0 && result.verdict === "docs-only" ? 0 : r.status === 0 ? 4 : r.status ?? 4);
