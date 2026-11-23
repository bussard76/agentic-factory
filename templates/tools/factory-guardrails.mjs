#!/usr/bin/env node
// Git guardrails installed by agentic-factory. Called from .githooks with a subcommand.
//   test-count       the indexed test count must not drop
//   staged-safety    whitespace and conflict markers, a staged-secret scan, no .env
//   static-checks    the project's typecheck and lint (factory.config.json → commands), skipped for docs-only commits
//   protected-files  protected paths change only with an ADR-NNNN reference in the commit message
//   review-gate      pushes to the main branch need review coverage under docs/reviews/
//   format-staged    the project's formatter on the fully staged files (commands.formatStaged); off when not configured
//   format-staged --finish <status>   after the other pre-commit steps: takes the formatting back if one failed
//   docs-only [<base>..<head> | --staged] [--base <ref>] [--json]
//                    does a candidate change documentation only? Prints the changed paths and the verdict.
//                    Exit 0 docs-only, 3 not docs-only, 4 unclear (fail closed: treat as not docs-only), 2 usage.
// Never bypass with --no-verify. Rules: docs/review-protocol.md.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

// --- docs-only classifier ----------------------------------------------------------------------
// The docs-only gate path (docs/testing.md) and the Controller's "no separate review for docs" both rest on this. A path
// is documentation only when ALL of these hold, and the candidate is docs-only only when every changed path is:
//   - it is a regular, non-executable file before and after (mode 100644): no symlink, submodule or mode change;
//   - its file type is documentation: Markdown or a raster image (DOC_TYPES); .svg and .mdx, which can carry code, only
//     when the project lists them in docsOnly.extraTypes; a file without an extension never is;
//   - it matches the allowlist docsOnly.paths (default docs/** and top-level Markdown);
//   - it is not a file the factory installs or reads as process state or agent instruction (factorySet below), not an
//     agent instruction file in any spelling and not under a dot path.
// Matching ignores case (a case-insensitive file system makes docs/ADR and docs/adr the same directory). For a range,
// every commit in it is judged as well, so code added and removed again on the way is not docs-only. Anything unclear
// (empty diff, unmerged path, missing ref, invalid setting, git error) is "unclear", which every caller treats as "not".
// The settings and the factory's record are read from the BASE of the candidate, never from the candidate itself.
const DEFAULT_DOCS_PATHS = ["docs/**", "*.md"];
const DOC_TYPES = ["md", "png", "jpg", "jpeg", "gif", "webp"];
const OPT_IN_TYPES = ["svg", "mdx"];
// What the factory installs or reads as process state, standards or agent instruction. The installed files also come
// from the factory's own record in the base tree (.factory/manifest.json, or the untracked standard's standard.json);
// this list covers them when that record is missing, and the factory's tests keep it in step with its templates.
const FACTORY_PATHS = ["AGENTS.md", "AGENTS.factory.md", "ARCHITECTURE.md", "CODING_STANDARDS.md", "design/**", "tools/**",
  "docs/adr/**", "docs/architect-protocol.md", "docs/coordinator.md", "docs/debt.md", "docs/dev-workflow.md", "docs/review-protocol.md",
  "docs/process-decisions.md", "docs/controller-rules.md", "docs/reviews/**", "docs/reports/**", "docs/handoffs/**", "docs/tasks/**"];
// Agent instruction files wherever they are, in any spelling, and everything under a dot path (hooks, CI, tool config).
const NEVER_DOCS = [/(^|\/)\./, /(^|\/)((agents?|claude|gemini|copilot-instructions|conventions|skill)(\.[^/]*)?\.mdx?|[^/]*\.(agent|prompt|instructions|chatmode)\.mdx?)$/i];
const REGULAR = /^100644$/;
// A small glob, case-insensitive: ** any depth (also zero directories with **/), * and ? within one path segment,
// {a,b} alternatives.
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { i++; if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*"; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") { const end = glob.indexOf("}", i); if (end < 0) throw new Error(`unclosed { in ${glob}`); re += `(?:${glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*").replaceAll("?", "[^/]")).join("|")})`; i = end; }
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}
// A docs pattern names a place: a literal first directory ("docs/**", "handbook/**/*.md"), or files at the top level
// ("*.md"). "**", "**/*" or "{docs,src}/**" would make the allowlist the whole repository.
const narrowPattern = (p) => typeof p === "string" && p && !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === ".") && (p.includes("/") ? !/[*?{}[\]]/.test(p.split("/")[0]) : !p.includes("**"));
// A configured path as git names it, relative to the repository root: backslashes become slashes, a leading ./ or /
// (both mean the repository root to the Controller's scripts) and a trailing / go, repeated slashes collapse. null when
// it cannot name something inside the repository (empty, a drive letter, a . or .. segment): the caller refuses it,
// never drops it. Case is ignored later, in the matching.
function repoPath(p) {
  if (typeof p !== "string") return null;
  let s = p.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (/^(\.\/|\/)/.test(s)) s = s.replace(/^(\.\/|\/)/, "");
  s = s.replace(/\/+$/, "");
  return !s || s.includes("\0") || /^[A-Za-z]:/.test(s) || s.split("/").some((x) => x === "." || x === "..") ? null : s;
}
// The settings, the allowlist and the factory's set for a config and the tree it was read from; or an error message.
function docsContext(cfg, rev) {
  const raw = cfg.docsOnly?.paths ?? DEFAULT_DOCS_PATHS, extra = cfg.docsOnly?.extraTypes ?? [];
  const paths = Array.isArray(raw) ? raw.map(repoPath) : null;
  if (!paths || !paths.length || !paths.every(narrowPattern)) return { error: "docsOnly.paths must be a non-empty list of patterns inside the repository that each start with a directory name (docs/**) or name top-level files (*.md)" };
  if (!Array.isArray(extra) || !extra.every((t) => OPT_IN_TYPES.includes(t))) return { error: `docsOnly.extraTypes may only list ${OPT_IN_TYPES.join(", ")}` };
  const factory = [...FACTORY_PATHS];
  const tasksDir = cfg.steering?.tasksDir;
  if (tasksDir !== undefined) {
    const dir = repoPath(tasksDir);
    if (!dir || /[*?{}[\]]/.test(dir)) return { error: `steering.tasksDir must name a directory inside the repository (got ${JSON.stringify(tasksDir)})` };
    factory.push(`${dir}/**`);
  }
  // The factory's own records: an entry that names no path inside the repository makes the check unclear.
  const recorded = [];
  if (rev) try { recorded.push(...Object.keys(JSON.parse(git("show", `${rev}:.factory/manifest.json`)).files ?? {})); } catch {}
  try { const common = git("rev-parse", "--path-format=absolute", "--git-common-dir").trim(); recorded.push(...(JSON.parse(readFileSync(join(common, "factory/standard.json"), "utf8")).links ?? []).map((l) => l.path)); } catch {}
  for (const r of recorded) { const p = repoPath(r); if (!p) return { error: `the factory's record lists a path outside the repository: ${JSON.stringify(r)}` }; factory.push(p.replace(/[*?{}[\]]/g, "?")); }
  try { return { globs: paths, res: paths.map(globToRegExp), types: [...DOC_TYPES, ...extra], factory: factory.map(globToRegExp) }; } catch (e) { return { error: `docsOnly.paths: ${e.message}` }; }
}
// One path: why it is not documentation, or "" when it is.
function pathProblem(p, ctx) {
  if (NEVER_DOCS.some((re) => re.test(p))) return "a dot path or an agent instruction file";
  if (ctx.factory.some((re) => re.test(p))) return "installed or read by the factory (process state, standards, agent instructions)";
  const ext = /\.([^./]+)$/.exec(p.split("/").pop())?.[1]?.toLowerCase();
  if (!ext) return "no file type";
  if (!ctx.types.includes(ext)) return `file type .${ext} is not documentation`;
  return ctx.res.some((re) => re.test(p)) ? "" : "outside the docs allowlist";
}
// entries: { status, oldMode, newMode, path } from `git diff --raw -z --no-renames` (a rename is a delete plus an add).
function classify(entries, ctx) {
  if (ctx.error) return { verdict: "unclear", reason: ctx.error, rows: [] };
  if (!entries.length) return { verdict: "unclear", reason: "no changed paths (empty diff)", rows: [] };
  const rows = entries.map((e) => {
    let why = "";
    if (!/^[AMD]$/.test(e.status)) why = e.status === "U" ? "unmerged" : `change type ${e.status}`;
    else if ((e.status !== "A" && !REGULAR.test(e.oldMode)) || (e.status !== "D" && !REGULAR.test(e.newMode))) why = `mode ${e.status === "A" ? e.newMode : e.oldMode}${e.status === "M" ? ` -> ${e.newMode}` : ""}: only plain files (100644) are documentation`;
    else why = pathProblem(e.path, ctx);
    return { ...e, why };
  });
  const bad = rows.filter((r) => r.why);
  const unclear = bad.find((r) => r.why === "unmerged" || r.why.startsWith("change type X"));
  return { verdict: unclear ? "unclear" : bad.length ? "not-docs-only" : "docs-only", reason: unclear ? `unmerged or unknown change: ${JSON.stringify(unclear.path)}` : bad.length ? `${bad.length} of ${rows.length} paths are not documentation` : `all ${rows.length} paths are documentation`, rows };
}
function parseRaw(out) {
  const parts = out.split("\0"); const entries = [];
  for (let i = 0; i < parts.length - 1; i += 2) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(parts[i]);
    if (!m) throw new Error(`unreadable diff line: ${parts[i]}`);
    entries.push({ oldMode: m[1], newMode: m[2], status: m[3], path: parts[i + 1] });
  }
  return entries;
}
// A commit's own changes: against its parent, a merge against the automatic merge of its two parents. null when that
// cannot be told (octopus merge, conflicting parents).
function commitEntries(sha) {
  const parents = git("rev-list", "--parents", "-n", "1", sha).trim().split(" ").slice(1);
  if (parents.length < 2) return parseRaw(git("diff-tree", "--no-commit-id", "--raw", "-z", "--no-renames", "--no-abbrev", "-r", "--root", sha));
  if (parents.length > 2) return null;
  const auto = spawnSync("git", ["merge-tree", "--write-tree", parents[0], parents[1]], { encoding: "utf8" });
  return auto.status === 0 ? parseRaw(git("diff", "--raw", "-z", "--no-renames", "--no-abbrev", auto.stdout.split("\n")[0], sha)) : null;
}
const configAt = (rev) => { const r = spawnSync("git", ["show", `${rev}:factory.config.json`], { encoding: "utf8" }); return r.status === 0 ? JSON.parse(r.stdout) : {}; };
// Paths are printed as they are when plain, else JSON-quoted: a file name cannot forge lines in a log.
const shownPath = (p) => (/^[\x20-\x7e]*$/.test(p) && !p.includes("  <- ") && !p.startsWith('"') ? p : JSON.stringify(p));
function docsOnly(argv) {
  const EXIT = { "docs-only": 0, "not-docs-only": 3, unclear: 4 };
  const json = argv.includes("--json");
  argv = argv.filter((a) => a !== "--json");
  const report = (r, what, extra = {}) => {
    if (json) console.log(JSON.stringify({ verdict: r.verdict, reason: r.reason, candidate: what, ...extra, rows: r.rows.map(({ status, path, why }) => ({ status, path, why })) }));
    else {
      console.log(`[factory] docs-only check: ${what}`);
      for (const row of r.rows) console.log(`  ${row.status} ${shownPath(row.path)}${row.why ? `  <- ${row.why}` : ""}`);
      console.log(`[factory] docs-only verdict=${r.verdict} paths=${r.rows.length} reason="${r.reason}"`);
    }
    process.exit(EXIT[r.verdict]);
  };
  const baseAt = argv.indexOf("--base");
  const baseRef = baseAt >= 0 ? argv[baseAt + 1] : `origin/${MAIN}`;
  const rest = baseAt < 0 ? argv : argv.filter((a, i) => i !== baseAt && i !== baseAt + 1);
  if ((baseAt >= 0 && !baseRef) || rest.length > 1 || (rest[0]?.startsWith("-") && rest[0] !== "--staged")) { console.error("usage: factory-guardrails.mjs docs-only [<base>..<head> | --staged] [--base <ref>] [--json]"); process.exit(2); }
  try {
    if (rest[0] && rest[0] !== "--staged") {
      const m = /^(.+?)\.\.\.?(.+)$/.exec(rest[0]);
      if (!m) throw new Error(`not a range: ${rest[0]}`);
      const head = git("rev-parse", "--verify", `${m[2]}^{commit}`).trim();
      const base = git("merge-base", git("rev-parse", "--verify", `${m[1]}^{commit}`).trim(), head).trim();
      const ctx = docsContext(configAt(base), base);
      const what = `${rest[0]} (base ${base.slice(0, 12)}, head ${head.slice(0, 12)})`;
      const r = classify(parseRaw(git("diff", "--raw", "-z", "--no-renames", "--no-abbrev", base, head)), ctx);
      if (r.verdict === "docs-only") {
        // Every commit on the way, too: the net diff hides code that was added and removed again.
        for (const sha of git("rev-list", `${base}..${head}`).trim().split("\n").filter(Boolean)) {
          const entries = commitEntries(sha);
          if (entries === null) report({ verdict: "unclear", reason: `commit ${sha.slice(0, 12)}: its own changes cannot be told (octopus or conflicting merge)`, rows: r.rows }, what, { base, head });
          if (!entries.length) continue;
          const c = classify(entries, ctx);
          if (c.verdict !== "docs-only") { const b = c.rows.find((x) => x.why); report({ verdict: c.verdict, reason: `commit ${sha.slice(0, 12)} on the way changes ${b ? `${shownPath(b.path)} (${b.why})` : "something unclear"}`, rows: [...r.rows, ...c.rows.filter((x) => x.why)] }, what, { base, head }); }
        }
      }
      report(r, what, { base, head });
    }
    const base = git("merge-base", git("rev-parse", "--verify", `${baseRef}^{commit}`).trim(), "HEAD").trim();
    const ctx = docsContext(configAt(base), base);
    if (rest[0] === "--staged") report(classify(parseRaw(git("diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev", base)), ctx), `staged changes against ${baseRef} (base ${base.slice(0, 12)})`, { base });
    // The working tree: committed, staged and unstaged changes, and untracked files (which the gate would see too).
    const entries = parseRaw(git("diff", "--raw", "-z", "--no-renames", "--no-abbrev", base));
    for (const p of git("ls-files", "-z", "--others", "--exclude-standard").split("\0").filter(Boolean)) { const s = lstatSync(p); entries.push({ status: "A", oldMode: "000000", newMode: s.isSymbolicLink() ? "120000" : s.mode & 0o111 ? "100755" : "100644", path: p }); }
    report(classify(entries, ctx), `working tree against ${baseRef} (base ${base.slice(0, 12)})`, { base });
  } catch (e) {
    report({ verdict: "unclear", reason: `git could not tell: ${String(e.stderr || e.message).trim().split("\n")[0]}`, rows: [] }, rest[0] ?? "working tree");
  }
}

// --- format-staged -----------------------------------------------------------------------------
// commands.formatStaged: a formatter in write mode, as a string ("pnpm exec prettier --write --ignore-unknown") or as
// { "command": "…", "paths": ["**/*.py"] }. The staged paths are appended as arguments. Off when not set.
// Only FULLY staged files are formatted (index and working tree equal in content and mode): the formatted bytes are
// staged under the index's own mode, so nothing the user did not stage is committed. A partially staged file (unstaged
// content, a mode change, deleted in the working tree) is skipped and named: its unstaged work is never touched.
// Deleted files are not passed; a rename passes the new path only. If a later pre-commit step fails, the hook calls
// `format-staged --finish <status>`, which puts the staged and working-tree versions back as they were before.
function formatStaged(argv) {
  const undoFile = git("rev-parse", "--path-format=absolute", "--git-path", "factory-format-staged.json").trim();
  if (argv[0] === "--finish") {
    if (argv[1] !== "0" && existsSync(undoFile)) undoFormat(JSON.parse(readFileSync(undoFile, "utf8")));
    rmSync(undoFile, { force: true });
    return;
  }
  rmSync(undoFile, { force: true });   // left by a killed hook: what it formatted is staged and in the working tree alike
  const setting = commands.formatStaged;
  if (!setting) return;
  const cmd = typeof setting === "string" ? setting : setting.command;
  const usage = "commands.formatStaged must be a command string or { \"command\": \"…\", \"paths\": [\"**/*.ext\", …] }.";
  if (typeof cmd !== "string" || !cmd.trim()) fail(usage);
  if (typeof setting === "object" && setting.paths !== undefined && !(Array.isArray(setting.paths) && setting.paths.every((p) => typeof p === "string" && p))) fail(usage);
  // A merge, cherry-pick or revert commits work that was formatted on its branch; reformatting would add unreviewed
  // changes to the merge (and turn a clean merge into a hand-edited one).
  for (const h of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) if (spawnSync("git", ["rev-parse", "-q", "--verify", h], { stdio: "ignore" }).status === 0) { console.log(`[factory] ${h} present: format-staged skipped`); return; }
  // `git commit <paths>` / `--only` commits from a temporary index; the real index was updated before this hook ran and
  // would keep the unformatted version. Not formatted, rather than two indexes that disagree.
  if (/(^|[\\/])next-index-[^\\/]*\.lock$/.test(process.env.GIT_INDEX_FILE ?? "")) { console.log("[factory] commit with paths (--only): format-staged skipped; stage the files and commit without paths to format them"); return; }
  let globs = null;
  try { globs = typeof setting === "object" && setting.paths ? setting.paths.map(globToRegExp) : null; } catch (e) { fail(`${usage} ${e.message}`); }
  const staged = parseRaw(git("diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev", "--diff-filter=AM"))
    .filter((e) => /^100(644|755)$/.test(e.newMode)).map((e) => e.path).filter((p) => !globs || globs.some((re) => re.test(p)));
  if (!staged.length) return;
  const unstaged = new Set(git("diff", "--name-only", "-z", "--no-renames").split("\0").filter(Boolean));
  const partial = staged.filter((p) => unstaged.has(p)), paths = staged.filter((p) => !unstaged.has(p));
  if (partial.length) console.log(`[factory] format-staged: ${partial.length} partially staged file(s) not formatted, their unstaged changes untouched: ${partial.map(shownPath).join(", ")}`);
  if (!paths.length) return;
  const before = new Map();
  for (const rec of git("ls-files", "-s", "-z", "--", ...paths).split("\0").filter(Boolean)) { const m = /^(\d{6}) ([0-9a-f]+) 0\t(.*)$/s.exec(rec); if (m) before.set(m[3], { mode: m[1], sha: m[2] }); }
  let failed = "";
  for (let i = 0; i < paths.length && !failed; i += 100) {
    const chunk = paths.slice(i, i + 100).map((p) => (p.startsWith("-") ? `./${p}` : p));
    const r = spawnSync("sh", ["-c", `${cmd} "$@"`, "sh", ...chunk], { stdio: "inherit" });
    if (r.status !== 0) failed = `the formatter failed (exit ${r.status ?? r.signal}): ${cmd}`;
  }
  const hashOf = (p) => git("hash-object", "-w", "--", p).trim();
  if (failed) {
    // These files had no unstaged changes, so their working copy is the staged version: put it back.
    for (const p of paths) { const b = before.get(p); if (b && existsSync(p) && hashOf(p) !== b.sha) writeFileSync(p, execFileSync("git", ["cat-file", "blob", b.sha], { maxBuffer: 1 << 28 })); }
    fail(`${failed}\nNothing was committed; the staged and working-tree files are as they were.`);
  }
  const undo = [];
  for (const p of paths) {
    const b = before.get(p); if (!b) continue;
    const sha = hashOf(p);
    if (sha === b.sha) continue;
    git("update-index", "--cacheinfo", `${b.mode},${sha},${p}`);   // the index's mode, not the working tree's
    undo.push({ path: p, mode: b.mode, before: b.sha, after: sha });
  }
  if (undo.length) writeFileSync(undoFile, JSON.stringify(undo));
  console.log(`[factory] format-staged: formatted ${paths.length} staged file(s), ${undo.length} changed`);
}
// Puts back what format-staged changed, where nothing else changed it since.
function undoFormat(undo) {
  for (const u of undo) {
    const cur = /^(\d{6}) ([0-9a-f]+) 0\t/.exec(tryGit("ls-files", "-s", "--", u.path));
    if (cur && cur[2] === u.after) git("update-index", "--cacheinfo", `${u.mode},${u.before},${u.path}`);
    if (existsSync(u.path) && tryGit("hash-object", "--", u.path).trim() === u.after) writeFileSync(u.path, execFileSync("git", ["cat-file", "blob", u.before], { maxBuffer: 1 << 28 }));
  }
  console.error("[factory] format-staged: the commit stopped, so the formatting was taken back; the staged files are as you staged them");
}

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
    const docsCfg = docsConfigBefore(remoteSha);
    const uncovered = [];
    for (const sha of [...commits, ...merges]) {
      const files = commitFiles(sha, merges.includes(sha));
      if (isDocsOnly(files) || files.every((f) => f.startsWith("docs/reviews/"))) continue;
      if (docsCfg && commitIsDocsByConfig(sha, merges.includes(sha), docsCfg)) continue;
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
// A project that sets its own docs allowlist (docsOnly.enabled and docsOnly.paths) gets the same exemption for those
// paths, read from the tree being replaced like the main branch above: a push cannot widen its own exemption.
function docsConfigBefore(remoteSha) {
  if (/^0+$/.test(remoteSha)) return null;
  try { const cfg = JSON.parse(tryGit("show", `${remoteSha}:factory.config.json`)); return cfg.docsOnly?.enabled === true && cfg.docsOnly.paths !== undefined ? docsContext(cfg, remoteSha) : null; } catch { return null; }
}
function commitIsDocsByConfig(sha, isMerge, ctx) {
  try { const entries = commitEntries(sha); return entries !== null && classify(entries, ctx).verdict === "docs-only"; } catch { return false; }
}
function parseReviews(tip) {
  const files = tryGit("ls-tree", "-r", "--name-only", tip, "docs/reviews/").trim().split("\n").filter(Boolean);
  return files.map((f) => tryGit("show", `${tip}:${f}`)).map((t) => ({ pass: /^Verdict:\s*pass\b/m.test(t), sha: /^Reviewed commit:\s*([0-9a-f]{40})\b/m.exec(t)?.[1] })).filter((r) => r.pass && r.sha);
}

const [cmd, arg, ...more] = process.argv.slice(2);
({ "test-count": testCount, "staged-safety": stagedSafety, "static-checks": staticChecks, "protected-files": () => protectedFiles(arg), "review-gate": reviewGate, "format-staged": () => formatStaged([arg, ...more].filter((a) => a !== undefined)), "docs-only": () => docsOnly([arg, ...more].filter((a) => a !== undefined)) }[cmd] ?? (() => fail(`unknown subcommand ${cmd}`)))();
