#!/usr/bin/env node
// Git guardrails installed by agentic-factory. Called from .githooks with a subcommand.
//   test-count       the indexed test count must not drop
//   staged-safety    whitespace and conflict markers, a staged-secret scan, no .env
//   static-checks    the project's typecheck and lint (factory.config.json → commands), skipped for docs-only commits
//   protected-files  protected paths change only with an ADR-NNNN reference in the commit message
//   review-gate      pushes to the main branch need review coverage under docs/reviews/
// Never bypass with --no-verify. Rules: docs/review-protocol.md.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const config = existsSync("factory.config.json") ? JSON.parse(readFileSync("factory.config.json", "utf8")) : {};
const MAIN = config.project?.mainBranch ?? "main";
const commands = config.commands ?? {};

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
const tryGit = (...args) => { try { return git(...args); } catch { return ""; } };
const fail = (message) => { console.error(`\n[factory] ${message}\nSee docs/review-protocol.md. Never use --no-verify.\n`); process.exit(1); };
const headExists = () => Boolean(tryGit("rev-parse", "--verify", "HEAD").trim());

function listFiles(revision) {
  const out = revision === "index" ? git("ls-files", "-z") : headExists() ? git("ls-tree", "-r", "--name-only", "-z", "HEAD") : "";
  return out.split("\0").filter(Boolean);
}
const show = (revision, path) => tryGit("show", `${revision === "index" ? "" : "HEAD"}:${path}`);
const stagedPaths = () => git("diff", "--cached", "--name-only", "--no-renames", "-z").split("\0").filter(Boolean);
// Documentation-only commits skip static checks and need no review coverage on main, EXCEPT the files that set the
// reviewers' standards: they change only through a reviewed task (fast lane with a Tester), like code.
// docs/coordinator.md and docs/dev-workflow.md stay exempt: the human's process decisions are recorded there at once.
const REVIEWED_DOCS = /^(docs\/review-protocol\.md|docs\/architect-protocol\.md|CODING_STANDARDS\.md)$/;
const isDocsOnly = (paths) => paths.length > 0 && paths.every((p) => !REVIEWED_DOCS.test(p) && ((p.startsWith("docs/") && !p.startsWith("docs/adr/")) || (/^[^/]+\.md$/.test(p) && !/^(AGENTS|AGENTS\.factory|ARCHITECTURE)\.md$/.test(p))));

// --- test-count --------------------------------------------------------------------------------
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go)$|Test\.(java|kt)$/;
const TEST_CALL = /\b(?:it|test|describe\.each|test\.each)\s*\(|^\s*def test_|@Test\b|^func Test/gm;
function countTests(revision) {
  return listFiles(revision).filter((p) => TEST_FILE.test(p)).reduce((n, p) => n + (show(revision, p).match(TEST_CALL)?.length ?? 0), 0);
}
function testCount() {
  if (!headExists()) return;
  const before = countTests("HEAD"), after = countTests("index");
  if (after < before) fail(`Test count decreased from ${before} to ${after}. Restore the tests; never weaken a suite.`);
}

// --- staged-safety -----------------------------------------------------------------------------
const SECRET_PATTERNS = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, "private key"],
  [/\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/, "API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "GitHub token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/, "JWT"],
  [/(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["'][^"'\s]{8,}["']/i, "credential assignment"],
];
function stagedSafety() {
  const check = spawnSync("git", ["diff", "--cached", "--check"], { encoding: "utf8" });
  if (check.status !== 0) fail(`Whitespace errors or conflict markers in the staged diff:\n${check.stdout}`);
  const paths = stagedPaths();
  const staged = new Set(paths);
  const symlinks = git("ls-files", "-s", "-z").split("\0").filter((e) => e.startsWith("120000 ")).map((e) => e.split("\t")[1]).filter((p) => staged.has(p));
  const standardLinks = symlinks.filter((p) => show("index", p).includes(".git/factory/"));
  if (standardLinks.length) fail(`A link into this clone's standard is staged, and it would hold this machine's path: ${standardLinks.join(", ")}\nUnstage it. To change that file for this project: agentic-factory deviate <path>.`);
  const env = paths.filter((p) => /(^|\/)\.env(\.|$)/.test(p) && !/\.env\.example$/.test(p));
  if (env.length) fail(`Never commit environment files: ${env.join(", ")}`);
  const findings = [];
  for (const p of paths) {
    if (/\.(png|jpe?g|gif|webp|pdf|zip|woff2?|ttf|otf|ico)$/i.test(p)) continue;
    const content = show("index", p);
    if (content.includes("\0")) continue;
    content.split("\n").forEach((line, i) => {
      if (/factory-guardrails\.mjs$/.test(p)) return;
      for (const [re, label] of SECRET_PATTERNS) if (re.test(line)) findings.push(`${p}:${i + 1}: looks like a ${label}`);
    });
  }
  if (findings.length) fail(`Possible secrets staged:\n${findings.join("\n")}\nUse invented values and keep real ones in .env.`);
}

// --- static-checks -----------------------------------------------------------------------------
function staticChecks() {
  const paths = stagedPaths();
  if (isDocsOnly(paths)) { console.log("[factory] documentation-only commit: static checks skipped"); return; }
  // A clean merge commit (the staged tree IS the automatic merge of HEAD and MERGE_HEAD, nothing edited by hand): the
  // merged commits passed these checks on their branches and the wave runs the full gates right after. A merge with
  // hand edits (conflict resolution, a smuggled file) is checked like any commit.
  if (spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { stdio: "ignore" }).status === 0) {
    const staged = tryGit("write-tree").trim();
    const auto = spawnSync("git", ["merge-tree", "--write-tree", "HEAD", "MERGE_HEAD"], { encoding: "utf8" });
    if (auto.status === 0 && staged && auto.stdout.trim().split("\n")[0] === staged) { console.log("[factory] clean merge commit: static checks skipped (the wave runs the full gates)"); return; }
    console.log("[factory] merge commit with hand edits: static checks run");
  }
  for (const key of ["typecheck", "lint"]) {
    const cmd = commands[key];
    if (!cmd) continue;
    const r = spawnSync(cmd, { shell: true, stdio: "inherit" });
    if (r.status !== 0) fail(`${key} failed (${cmd}).`);
  }
}

// --- protected-files ---------------------------------------------------------------------------
// Protected paths change only with an accepted ADR reference in the commit message. Dependency lists are NOT protected
// here: a new dependency is a level-2 change that the Architect's spec review decides (AGENTS.md "Change levels").
// The hooks directory is protected wherever it lives (.githooks, or the project's own directory in merge mode).
const HOOKS_DIR = (config.hooks?.dir ?? ".githooks").replace(/\/$/, "");
const PROTECTED = new RegExp(`^(?:ARCHITECTURE\\.md$|AGENTS\\.md$|AGENTS\\.factory\\.md$|docs/adr/|\\.githooks/|${HOOKS_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/|tools/factory-guardrails\\.mjs$)`);
function protectedFiles(messagePath) {
  const changed = stagedPaths();
  const hits = changed.filter((p) => PROTECTED.test(p));
  if (!hits.length) return;
  const message = readFileSync(messagePath, "utf8");
  const refs = [...message.matchAll(/\bADR-(\d{4})\b/g)].map((m) => m[1]);
  // The referenced ADR must be in the index, accepted, and carry a non-empty "Decided by:" line.
  const accepted = refs.some((n) => listFiles("index").some((p) => new RegExp(`^docs/adr/(?:ADR-)?${n}[-.].*\\.md$`).test(p) && /^Status:\s*accepted/m.test(show("index", p)) && /^Decided by:\s*\S/m.test(show("index", p))));
  if (!accepted) fail(`Protected files changed without an accepted ADR reference in the commit message:\n${hits.join("\n")}\nAdd "ADR-NNNN" of an accepted ADR (Status: accepted, with a "Decided by:" line) to the message.`);
}

// --- review-gate -------------------------------------------------------------------------------
// What is being pushed must not decide which branch is gated, or a change to mainBranch would switch the gate off for
// itself. So the branch named by the tree being replaced is gated, as well as the one named here. Without a usable config
// in that tree, "main" stays gated.
function gatedBranches(remoteSha) {
  if (/^0+$/.test(remoteSha)) return [MAIN];
  let before;
  try { before = JSON.parse(tryGit("show", `${remoteSha}:factory.config.json`)).project?.mainBranch; } catch {}
  return [MAIN, before ?? "main"];
}
function reviewGate() {
  const updates = readFileSync(0, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" "));
  for (const [, localSha, remoteRef, remoteSha] of updates) {
    if (/^0+$/.test(localSha)) continue; // deleting the branch introduces no commits
    // Without the remote's commits, the range below is empty and nothing would be checked. A plain push is refused by git
    // in this state anyway; a forced one would overwrite those commits unseen.
    if (remoteRef.startsWith("refs/heads/") && !/^0+$/.test(remoteSha) && !shaExists(remoteSha)) fail(`The remote has commits on ${remoteRef} this clone does not. Fetch first.`);
    const branch = gatedBranches(remoteSha).find((b) => remoteRef === `refs/heads/${b}`);
    if (!branch) continue;
    const range = /^0+$/.test(remoteSha) ? localSha : `${remoteSha}..${localSha}`;
    const commits = tryGit("rev-list", "--no-merges", range).trim().split("\n").filter(Boolean);
    const merges = tryGit("rev-list", "--merges", range).trim().split("\n").filter(Boolean);
    const reviews = parseReviews(localSha);
    const uncovered = [];
    for (const sha of [...commits, ...merges]) {
      const files = commitFiles(sha, merges.includes(sha));
      if (isDocsOnly(files) || files.every((f) => f.startsWith("docs/reviews/"))) continue;
      // Fail closed: the reviewed SHA must exist, the commit must be its ancestor and the reviewed SHA an ancestor of
      // the pushed tip (exit status, never output). Commits added after a review are not ancestors of its SHA and
      // therefore uncovered; merges are judged by their own changes above, so several reviewed tasks can share a wave.
      const covered = reviews.some((r) => shaExists(r.sha) && isAncestor(sha, r.sha) && isAncestor(r.sha, localSha));
      if (!covered) uncovered.push(files.some((f) => f.startsWith("<octopus")) ? `${sha.slice(0, 10)} (octopus merge: merge one branch at a time)` : sha.slice(0, 10));
    }
    if (uncovered.length) fail(`Push to ${branch} rejected. Commits without a passing independent review:\n${uncovered.join("\n")}\nA findings file under docs/reviews/ with "Verdict: pass" and "Reviewed commit: <40-char SHA>" must be in the pushed tree, and each commit must be an ancestor of a reviewed SHA (merge the review branch into the wave).`);
  }
}
const shaExists = (sha) => spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`]).status === 0;
const isAncestor = (a, b) => spawnSync("git", ["merge-base", "--is-ancestor", a, b]).status === 0;
function commitFiles(sha, isMerge) {
  if (!isMerge) return tryGit("diff-tree", "--no-commit-id", "--name-only", "-r", sha).trim().split("\n").filter(Boolean);
  // A merge's own changes: what differs from the automatic merge of its two parents. An octopus merge (three or more
  // parents) has no such pair, so it is judged as all-unreviewed; waves merge one branch at a time for this reason.
  const parents = tryGit("rev-list", "--parents", "-n", "1", sha).trim().split(" ").slice(1);
  if (parents.length < 2) return [];
  if (parents.length > 2) return ["<octopus merge: merge one branch at a time>"];
  const auto = tryGit("merge-tree", "--write-tree", parents[0], parents[1]).trim().split("\n")[0];
  return auto ? tryGit("diff", "--name-only", auto, sha).trim().split("\n").filter(Boolean) : ["<conflict>"];
}
function parseReviews(tip) {
  const files = tryGit("ls-tree", "-r", "--name-only", tip, "docs/reviews/").trim().split("\n").filter(Boolean);
  return files.map((f) => tryGit("show", `${tip}:${f}`)).map((t) => ({ pass: /^Verdict:\s*pass\b/m.test(t), sha: /^Reviewed commit:\s*([0-9a-f]{40})\b/m.exec(t)?.[1] })).filter((r) => r.pass && r.sha);
}

const [cmd, arg] = process.argv.slice(2);
({ "test-count": testCount, "staged-safety": stagedSafety, "static-checks": staticChecks, "protected-files": () => protectedFiles(arg), "review-gate": reviewGate }[cmd] ?? (() => fail(`unknown subcommand ${cmd}`)))();
