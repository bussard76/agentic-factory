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
// orca-tasks mode the report is named after the ticket's file on origin/<main> and --ref is not needed. The ticket must
// declare itself a documentation ticket (`Level: 1` and `Documentation only: yes`, templates/docs/tasks/T00-template.md; in
// github-issues mode the issue's text, read with gh): without that the answer is no, whatever the diff is. It must say so
// both when the work started and now: for a file ticket the base and main's tip, for an issue the Controller's claim record
// (steering/issues.mjs claim) and the live text.
import "./cli.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BRANCH_PREFIX, MAIN, PROJECT_DIR, file, journal } from "./lib.mjs";

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
// The path also needs the ticket's own word: it applies only to a ticket that says it changes documentation only, as
// recorded on origin/<main> (the check reads it there, never on the branch). So without the task's own branch there is no
// ticket to read, and the answer is no.
const ticketArgs = [];
if (ref !== `origin/${BRANCH_PREFIX}${task.toLowerCase()}`) stop(3, `${ref} is not the branch of ${task} (${BRANCH_PREFIX}${task.toLowerCase()}): the docs-only path needs the ticket's own branch and its declaration. Review as usual.`);
ticketArgs.push("--ticket", task);
if (cfg.steering?.mode === "github-issues") {
  // The issue is not in the tree: its text, as it is now (the work has started, the Controller's claim changes labels only).
  const issue = /^#?(\d+)$/.exec(taskRef ?? "")?.[1];
  // The declaration must also hold as the Controller recorded it when it took the issue (steering/issues.mjs claim writes a
  // `claim` event into its own journal, where a worker cannot write): the live text alone can be edited after the work started.
  // An issue taken before that existed has no record and takes the full path.
  let recorded = null;
  try { recorded = fs.readFileSync(file("journal.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.type === "claim" && String(e.task) === String(issue)); } catch { /* no journal */ }
  if (issue && recorded?.documentation !== true) stop(3, `issue #${issue}: the Controller's journal has no claim record that says it was a documentation ticket when it was taken (${recorded ? "it recorded: not declared" : "no record, an issue taken before the declaration existed"}). Review as usual.`);
  if (issue) {
    const body = spawnSync("gh", ["issue", "view", issue, "--json", "body", "--jq", ".body"], { cwd: PROJECT_DIR, encoding: "utf8" });
    if (body.status === 0) {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "docs-only-")), "issue.txt");
      fs.writeFileSync(file, body.stdout);
      ticketArgs.push("--issue", issue, "--ticket-text", file);
    }
  }
}
const r = spawnSync("node", [check, "docs-only", `origin/${MAIN}..${head}`, ...ticketArgs, "--json"], { cwd: PROJECT_DIR, encoding: "utf8" });
let result = null;
try { result = JSON.parse(r.stdout.trim().split("\n").at(-1)); } catch {}
if (!result) stop(4, `the docs-only check gave no verdict (exit ${r.status}): ${`${r.stdout}${r.stderr}`.trim().split("\n").slice(-3).join(" | ")}. Review as usual.`);
console.log(`docs-only check of ${ref} at ${head.slice(0, 12)} against origin/${MAIN}:`);
for (const row of result.rows) console.log(`  ${row.status} ${JSON.stringify(row.path)}${row.why ? `  <- ${row.why}` : row.note ? `  (${row.note})` : ""}`);
console.log(`verdict=${result.verdict} reason="${result.reason}"`);
if (r.status === 0 && result.verdict === "docs-only") journal("review", task, { verdict: "docs-only", path: "docs-only", head, paths: result.rows.map((x) => x.path), ...(ticketArgs.length ? { ticket: task } : {}) });
process.exit(r.status === 0 && result.verdict === "docs-only" ? 0 : r.status === 0 ? 4 : r.status ?? 4);
