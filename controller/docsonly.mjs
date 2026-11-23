// node docsonly.mjs <task> <branch> → does the pushed task branch change documentation only (docs/testing.md)?
// Runs main's docs-only check (tools/factory-guardrails.mjs docs-only from origin/<main>, or this clone's installed
// standard; never the branch's own copy) in the Controller's checkout on origin/<main>..origin/<branch>, with the
// settings of origin/<main>'s factory.config.json, and prints its evidence. Exit 0: docs-only, no Tester
// (CONTROLLER.md); the evidence is recorded in the journal as the task's review event, the review it replaces. Any
// other exit: review as usual, and nothing is journaled (the Tester's review is the task's review event).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MAIN, PROJECT_DIR, journal } from "./lib.mjs";

const [task, branch] = process.argv.slice(2);
if (!task || !branch) throw new Error("usage: node docsonly.mjs <task> <branch>");
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
const r = spawnSync("node", [check, "docs-only", `origin/${MAIN}..${head}`, "--json"], { cwd: PROJECT_DIR, encoding: "utf8" });
let result = null;
try { result = JSON.parse(r.stdout.trim().split("\n").at(-1)); } catch {}
if (!result) stop(4, `the docs-only check gave no verdict (exit ${r.status}): ${`${r.stdout}${r.stderr}`.trim().split("\n").slice(-3).join(" | ")}. Review as usual.`);
console.log(`docs-only check of ${ref} at ${head.slice(0, 12)} against origin/${MAIN}:`);
for (const row of result.rows) console.log(`  ${row.status} ${JSON.stringify(row.path)}${row.why ? `  <- ${row.why}` : ""}`);
console.log(`verdict=${result.verdict} reason="${result.reason}"`);
if (r.status === 0 && result.verdict === "docs-only") journal("review", task, { verdict: "docs-only", path: "docs-only", head, paths: result.rows.map((x) => x.path) });
process.exit(r.status === 0 && result.verdict === "docs-only" ? 0 : r.status === 0 ? 4 : r.status ?? 4);
