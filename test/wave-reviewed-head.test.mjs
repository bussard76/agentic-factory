// The wave integrates exactly the commit that was reviewed (issue #67). Throwaway repositories with a bare origin and the
// factory's own hooks and guardrails; the Controller's bundle is a copy in a temporary directory; no real Orca, host or home.
// The first two probes are the ones of the PR #65 review (finding 2): a branch that gets a code commit and a forged findings
// file after its review, with and without the docs-only evidence.
import "./support/safe-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeController } from "./fake-controller.mjs";
import { bindBranches, classify, latestReview } from "../controller/reviewrecord.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NOHOOKS = ["-c", "core.hooksPath=/dev/null"];
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCA_")));
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);

// --- the record, as a pure function ------------------------------------------------------------
const line = (o) => JSON.stringify({ ts: "2026-01-01T00:00:00Z", ...o });
const journal = (...events) => events.map((e) => line({ by: "reviewed.mjs", path: "tester", ...e })).join("\n") + "\n";

test("latestReview: the latest review event with a head decides; rework, several rounds, fail after pass, docs-only", () => {
  const first = latestReview(journal({ type: "review", task: "T1", verdict: "pass", head: A }), "t1"); assert.equal(first.state, "ok"); assert.equal(first.head, A);
  // a rework after a failed review: the new review's commit is the one that counts
  let r = latestReview(journal({ type: "review", task: "T1", verdict: "fail", head: A }, { type: "review", task: "T1", verdict: "pass", head: B }), "T1");
  assert.equal(r.state, "ok"); assert.equal(r.head, B);
  // several rounds, a pass, then a conformance fail on that head: not mergeable until the next review passes
  r = latestReview(journal({ type: "review", task: "T1", verdict: "pass", head: A, path: "tester" }, { type: "review", task: "T1", verdict: "fail", head: A, path: "conformance" }), "t1");
  assert.equal(r.state, "failed");
  // the docs-only evidence is a review event too, and a later Tester pass replaces it
  r = latestReview(journal({ type: "review", task: "T1", verdict: "docs-only", head: A, path: "docs-only" }, { type: "review", task: "T1", verdict: "pass", head: C }), "t1");
  assert.equal(r.head, C);
  // other tasks and other event types do not count; a task id is not a prefix match
  assert.equal(latestReview(journal({ type: "review", task: "T10", verdict: "pass", head: A }, { type: "done", task: "T1", head: B }), "t1").state, "none");
  // old review events (a calibration record) have no head: no usable record
  assert.equal(latestReview(journal({ type: "review", task: "T1", verdict: "pass", role: "tester" }), "t1").state, "none");
  assert.equal(latestReview(journal({ type: "review", task: "T1", verdict: "pass", head: "abc" }), "t1").state, "none", "a short head is no commit");
});

test("latestReview: no journal is no record; an unreadable journal, or a damaged line that names the task, is not a record either", () => {
  assert.deepEqual(latestReview(Object.assign(new Error("gone"), { code: "ENOENT" }), "t1"), { state: "none" });
  assert.equal(latestReview(Object.assign(new Error("EACCES"), { code: "EACCES" }), "t1").state, "unreadable");
  const damaged = `${line({ type: "review", task: "T1", verdict: "pass", head: A })}\n{"type":"review","task":"T1","verdict":"fa`;
  assert.equal(latestReview(damaged, "t1").state, "unreadable", "a torn line about the task might be a fail");
  assert.equal(latestReview(`${journal({ type: "review", task: "T1", verdict: "pass", head: A })}{"type":"start","task":"T2"`, "t1").state, "ok", "a torn line about another task is no reason to refuse");
  assert.equal(latestReview(journal({ type: "review", task: "T1", verdict: "maybe", head: A }), "t1").state, "unreadable");
});

test("classify and bindBranches: task branches get the commit, their review branches the same, status branches stay plain", () => {
  assert.deepEqual(classify("origin/agents/t12", "agents/"), { kind: "task", name: "agents/t12", key: "t12" });
  for (const n of ["t12-review-1", "t12-review-final", "t12-conformance"]) assert.deepEqual(classify(`origin/agents/${n}`, "agents/"), { kind: "process", name: `agents/${n}`, key: "t12" });
  assert.equal(classify("origin/status-wave-3", "agents/").kind, "status");
  assert.equal(classify("origin/status-wave-3", "").kind, "status", "an empty prefix does not make it a task");
  assert.equal(classify("origin/feature/x", "agents/").kind, "foreign");
  assert.equal(classify("origin/t5-review-2", "").kind, "process");
  const R2 = "d".repeat(40), R1 = "e".repeat(40);
  const cov = (m) => new Map(Object.entries(m).map(([b, s]) => [b, { reviewSha: s }]));
  const read = (key) => ({ t1: { state: "ok", head: A, covers: cov({ "agents/t1-review-2": R2 }) }, t2: { state: "ok", head: B, covers: cov({}) } })[key] ?? { state: "none" };
  const ok = bindBranches(["origin/agents/t1", "origin/agents/t1-review-2", "origin/agents/t2", "origin/status-wave-1"], { prefix: "agents/", read });
  assert.deepEqual(ok.args, [`origin/agents/t1@${A}`, `origin/agents/t1-review-2~${A}:${R2}`, `origin/agents/t2@${B}`, "origin/status-wave-1"]);
  const bad = bindBranches(["origin/agents/t1", "origin/agents/t9", "origin/agents/t9-review-1", "origin/other"], { prefix: "agents/", read });
  assert.equal(bad.args, undefined);
  assert.equal(bad.problems.length, 2 + 0, "t9 once (its review branch is judged with it), and the foreign branch");
  assert.match(bad.problems.join("\n"), /agents\/t9: the Controller's journal has no record of a passing review[\s\S]*node reviewed\.mjs <task> origin\/agents\/t9-review-<n>/);
  assert.doesNotMatch(bad.problems.join("\n"), /journal\.mjs/, "no unchecked way to record a head is recommended");
  assert.match(bad.problems.join("\n"), /origin\/other: not a branch under the prefix/);
  // a review branch with no task branch in the wave is judged by the record alone; one the record does not cover is refused
  assert.equal(bindBranches(["origin/agents/t1-review-2"], { prefix: "agents/", read }).args[0], `origin/agents/t1-review-2~${A}:${R2}`);
  assert.match(bindBranches(["origin/agents/t1-review-1"], { prefix: "agents/", read }).problems[0], /no passing review of t1 at .* recorded for this branch/);
  assert.match(bindBranches(["origin/agents/t9-review-1"], { prefix: "agents/", read }).problems[0], /no record/);
  assert.equal(classify("origin/agents/t1-specreview", "agents/").kind, "task", "a spec review branch is nothing the wave binds: it needs a record, which reviewed.mjs never writes for it");
  assert.match(bindBranches(["origin/agents/t1"], { prefix: "agents/", read: () => ({ state: "failed", head: A }) }).problems[0], /says fail/);
  assert.match(bindBranches(["origin/agents/t1"], { prefix: "agents/", read: () => ({ state: "unreadable", why: "EISDIR" }) }).problems[0], /EISDIR/);
  assert.match(bindBranches(["origin/agents/t1", "origin/agents/t1"], { prefix: "agents/", read }).problems[0], /listed twice/);
});

// --- a project with a bare origin and the factory's hooks --------------------------------------
function project(cfg = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "af-rev-")));
  const dir = path.join(base, "work"), bare = path.join(base, "origin.git");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  spawnSync("git", ["init", "-q", "-b", "main", dir]);
  const git = (...a) => { const r = spawnSync("git", a, { cwd: dir, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}:\n${r.stderr}${r.stdout}`); return r.stdout.trim(); };
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
  git("config", "user.email", "t@example.invalid"); git("config", "user.name", "T"); git("remote", "add", "origin", bare);
  fs.mkdirSync(path.join(dir, "tools")); fs.copyFileSync(path.join(ROOT, "templates/tools/factory-guardrails.mjs"), path.join(dir, "tools/factory-guardrails.mjs"));
  fs.cpSync(path.join(ROOT, "templates/.githooks"), path.join(dir, ".githooks"), { recursive: true });
  for (const h of fs.readdirSync(path.join(dir, ".githooks"))) fs.chmodSync(path.join(dir, ".githooks", h), 0o755);
  write("factory.config.json", JSON.stringify({ project: { name: "demo", mainBranch: "main" }, commands: {}, ...cfg }, null, 2) + "\n");
  write("README.md", "# Demo\n"); write("docs/guide.md", "Guide\n"); write("src/app.js", "export const a = 1;\n"); write("package.json", "{}\n");
  git("add", "-A"); git("commit", "-qm", "init"); git("push", "-q", "origin", "main");
  git("config", "core.hooksPath", ".githooks");
  const commit = (msg) => { git("add", "-A"); git(...NOHOOKS, "commit", "-qm", msg); return git("rev-parse", "HEAD"); };
  const origin = (...a) => spawnSync("git", ["--git-dir", bare, ...a], { encoding: "utf8" }).stdout.trim();
  // A task branch with one code commit, pushed. Returns its commit.
  const task = (key, files = { [`src/${key}.js`]: `export const ${key} = 1;\n` }, from = "main") => {
    git("checkout", "-q", "-b", `agents/${key}`, from); for (const [f, s] of Object.entries(files)) write(f, s);
    const sha = commit(`${key} work`); git("push", "-q", "origin", `agents/${key}`); git("checkout", "-q", "main"); return sha;
  };
  // The Tester's branch: made from the reviewed commit, one findings file on it.
  const review = (key, sha, { round = 1, verdict = "pass", name = `${key}-review-${round}`, file = `docs/reviews/${key.toUpperCase()}-review-${round}.md` } = {}) => {
    git("checkout", "-q", "-b", `agents/${name}`, sha); write(file, `# Review\n\nVerdict: ${verdict}\nReviewed commit: ${sha}\n`);
    commit(`${key} review`); git("push", "-q", "origin", `agents/${name}`); git("checkout", "-q", "main");
  };
  // A commit on a task branch after its review (what a worker can do after worker_done).
  const push = (key, files, msg = "after the review") => { git("checkout", "-q", `agents/${key}`); for (const [f, s] of Object.entries(files)) write(f, s); const sha = commit(msg); git("push", "-q", "origin", `agents/${key}`); git("checkout", "-q", "main"); return sha; };
  const advanceMain = (files) => { git("checkout", "-q", "main"); for (const [f, s] of Object.entries(files)) write(f, s); const sha = commit("main moves"); git(...NOHOOKS, "push", "-q", "origin", "main"); return sha; };
  return { base, dir, bare, git, write, commit, origin, task, review, push, advanceMain, tip: (b) => origin("rev-parse", b) };
}

// integ-wave.sh with the tokens wave.mjs builds
function script(p, tokens0, { env = {}, verify = "true" } = {}) {
  // a review branch token written as origin/<b>~<task sha> gets the commit origin has for the branch now (what reviewed.mjs would have read)
  const tokens = tokens0.map((t) => (/~[0-9a-f]{40}$/.test(t) ? `${t}:${p.tip(t.replace(/^origin\//, "").replace(/~.*$/, ""))}` : t));
  const integ = path.join(p.base, `coordinator-integration`);
  if (!fs.existsSync(integ)) p.git("worktree", "add", "-q", "-B", "integration", integ, "refs/remotes/origin/main");
  const ctl = fakeController(p.base, {});
  const out = spawnSync("bash", [path.join(ROOT, "controller/integ-wave.sh"), "W", "wave", ...tokens], { cwd: integ, encoding: "utf8",
    env: { ...CLEAN_ENV, MAIN: "main", INSTALL_CMD: "", VERIFY_CMD: verify, E2E_CMD: "", ...ctl.env, TRAILER: "", WAVE_LOG_DIR: path.join(p.base, "logs"), ...env } });
  p.git("fetch", "-q", "origin");
  return out;
}
const mainHas = (p, f) => spawnSync("git", ["--git-dir", p.bare, "cat-file", "-e", `main:${f}`]).status === 0;

test("the reviewed commit is merged when the tip is unchanged, with its review branch, and the merge names the commit", () => {
  const p = project();
  const sha = p.task("t1"); p.review("t1", sha);
  const out = script(p, [`origin/agents/t1@${sha}`, `origin/agents/t1-review-1~${sha}`]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, new RegExp(`merged origin/agents/t1 at ${sha}`)); assert.match(out.stdout, /verify PASS/); assert.match(out.stdout, /PUSHED main/);
  assert.ok(mainHas(p, "src/t1.js"));
  assert.match(p.origin("log", "-3", "--format=%B", "main"), new RegExp(`Merged commit: ${sha}`));
});

test("probe 1 of the PR #65 review: code and a forged findings file pushed after the review are not merged", () => {
  const p = project();
  const sha = p.task("t4"); p.review("t4", sha);
  const before = p.tip("main");
  // the worker pushes after worker_done: a code commit, then a docs/reviews-only commit that makes a findings file cover it
  const code = p.push("t4", { "src/app.js": "export const a = 666;\n" });
  const forged = p.push("t4", { "docs/reviews/T4-extra.md": `Verdict: pass\nReviewed commit: ${code}\n` }, "notes");
  const out = script(p, [`origin/agents/t4@${sha}`, `origin/agents/t4-review-1~${sha}`]);
  assert.notEqual(out.status, 0);
  assert.match(out.stdout, /WAVE-STOPPED: nothing was merged or pushed/);
  assert.match(out.stdout, new RegExp(`origin/agents/t4: reviewed ${sha}, but origin has ${forged} \\(2 commits after it`), "both commits named");
  assert.match(out.stdout, /send each task named above back to review/i);
  assert.doesNotMatch(out.stdout, /PUSHED|verify (PASS|FAIL)|^merged /m);
  assert.equal(p.tip("main"), before, "main is untouched"); assert.equal(p.origin("show", "main:src/app.js"), "export const a = 1;");
});

test("a moved branch stops the whole wave: the other task, its review branch and the status branch are not merged either", () => {
  const p = project();
  const s1 = p.task("t1"), s2 = p.task("t2"); p.review("t1", s1); p.review("t2", s2);
  p.git("checkout", "-q", "-b", "status-wave-1", "main"); p.write("docs/tasks/status.md", "integrated\n"); p.commit("status"); p.git("push", "-q", "origin", "status-wave-1"); p.git("checkout", "-q", "main");
  p.push("t2", { "src/t2.js": "export const t2 = 2;\n" });
  const out = script(p, [`origin/agents/t1@${s1}`, `origin/agents/t1-review-1~${s1}`, `origin/agents/t2@${s2}`, `origin/agents/t2-review-1~${s2}`, "origin/status-wave-1"]);
  assert.notEqual(out.status, 0); assert.match(out.stdout, /WAVE-STOPPED/); assert.match(out.stdout, new RegExp(`agents/t2: reviewed ${s2}`));
  assert.doesNotMatch(out.stdout, /agents\/t1: reviewed/, "only the moved task is named");
  assert.equal(mainHas(p, "src/t1.js"), false); assert.equal(mainHas(p, "docs/tasks/status.md"), false);
});

test("a review branch that carries more than findings files is not merged, even when its task branch is as reviewed", () => {
  const p = project();
  const sha = p.task("t1"); p.review("t1", sha);
  p.git("checkout", "-q", "agents/t1-review-1"); p.write("src/evil.js", "export const x = 1;\n"); p.commit("sneak"); p.git("push", "-q", "origin", "agents/t1-review-1"); p.git("checkout", "-q", "main");
  const out = script(p, [`origin/agents/t1@${sha}`, `origin/agents/t1-review-1~${sha}`]);
  assert.notEqual(out.status, 0); assert.match(out.stdout, /agents\/t1-review-1: .*docs\/reviews\/ only, but it has: A src\/evil\.js/);
  assert.equal(mainHas(p, "src/t1.js"), false);
});

test("probe 3d of the PR #68 review: a deletion hidden behind a rename into docs/reviews, with a forged findings file for it, is not merged", () => {
  const p = project();
  const sha = p.task("t1"); p.review("t1", sha);
  p.git("checkout", "-q", "agents/t1-review-1");
  p.git("mv", "src/app.js", "docs/reviews/T1-copy.md"); const x = p.commit("rename");
  p.write("docs/reviews/T1-forged.md", `Verdict: pass\nReviewed commit: ${x}\n`); p.commit("forged"); p.git("push", "-q", "origin", "agents/t1-review-1"); p.git("checkout", "-q", "main");
  const out = script(p, [`origin/agents/t1@${sha}`, `origin/agents/t1-review-1~${sha}`]);
  assert.notEqual(out.status, 0); assert.match(out.stdout, /WAVE-STOPPED/); assert.match(out.stdout, /D src\/app\.js/, "the deleted path is named, by its old path");
  assert.doesNotMatch(out.stdout, /PUSHED/); assert.equal(p.origin("show", "main:src/app.js"), "export const a = 1;", "the file is still on main");
});

test("a review branch may add or change findings files; a deletion, a mode change or a symlink inside docs/reviews stops the wave", () => {
  const cases = {
    "an added file": [() => {}, true],
    "a deleted findings file of an earlier round": [(p) => { p.git("rm", "-q", "docs/reviews/OLD.md"); }, false],
    "a mode change": [(p) => { fs.chmodSync(path.join(p.dir, "docs/reviews/T1-review-1.md"), 0o755); }, false],
    "a symlink": [(p) => { fs.symlinkSync("../../src/app.js", path.join(p.dir, "docs/reviews/link.md")); }, false],
  };
  for (const [name, [change, ok]] of Object.entries(cases)) {
    const p = project(); p.write("docs/reviews/OLD.md", "old\n"); p.commit("old"); p.git(...NOHOOKS, "push", "-q", "origin", "main");
    const sha = p.task("t1"); p.review("t1", sha);
    p.git("checkout", "-q", "agents/t1-review-1"); change(p); if (name !== "a mode change") p.write("docs/reviews/more.md", "more\n"); p.commit("change"); p.git("push", "-q", "origin", "agents/t1-review-1"); p.git("checkout", "-q", "main");
    const out = script(p, [`origin/agents/t1@${sha}`, `origin/agents/t1-review-1~${sha}`]);
    assert.equal(out.status === 0, ok, `${name}: ${out.stdout}`);
    if (!ok) assert.match(out.stdout, /WAVE-STOPPED/);
  }
});

test("a review branch pushed to after reviewed.mjs read it is not merged: the wave binds it to the commit that was read", () => {
  const p = project();
  const sha = p.task("t1"); p.review("t1", sha);
  const read = p.tip("agents/t1-review-1");
  const bad = p.push("t1", { "src/app.js": "export const a = 666;\n" });   // the Developer pushes code, then replaces the review branch by a forged one made from it
  p.git("checkout", "-q", "-B", "agents/t1-review-1", bad); p.write("docs/reviews/T1-review-1.md", `Verdict: pass\nReviewed commit: ${bad}\n`); p.commit("forged"); p.git("push", "-q", "-f", "origin", "agents/t1-review-1"); p.git("checkout", "-q", "main");
  const out = script(p, [`origin/agents/t1@${sha}`, `origin/agents/t1-review-1~${sha}:${read}`]);
  assert.notEqual(out.status, 0); assert.match(out.stdout, new RegExp(`reviewed\\.mjs read ${read}, but origin has ${p.tip("agents/t1-review-1")}`)); assert.match(out.stdout, /reviewed .* but origin has/);
  assert.equal(p.origin("show", "main:src/app.js"), "export const a = 1;");
});

test("probe 2: the docs-only evidence is bound to its head too: unchanged it takes the docs path, moved it is not merged", () => {
  const checks = (p) => ({ docsOnly: { enabled: true }, commands: { formatCheck: `echo format >> ${path.join(p.base, "marks")}`, markdownCheck: `echo markdown >> ${path.join(p.base, "marks")}` } });
  let p = project(); p.git("checkout", "-q", "main"); p.write("factory.config.json", JSON.stringify({ project: { name: "demo", mainBranch: "main" }, ...checks(p) })); p.commit("cfg"); p.git(...NOHOOKS, "push", "-q", "origin", "main");
  const sha = p.task("d1", { "docs/guide.md": "Guide v2\n" });
  let out = script(p, [`origin/agents/d1@${sha}`]);
  assert.equal(out.status, 0, out.stdout + out.stderr); assert.match(out.stdout, /GATE-PATH docs-only/); assert.match(out.stdout, /PUSHED main/);
  assert.equal(fs.readFileSync(path.join(p.base, "marks"), "utf8"), "format\nmarkdown\n");
  // the same, and the worker adds code and a forged findings file before the wave
  p = project(); p.write("factory.config.json", JSON.stringify({ project: { name: "demo", mainBranch: "main" }, ...checks(p) })); p.commit("cfg"); p.git(...NOHOOKS, "push", "-q", "origin", "main");
  const d = p.task("d1", { "docs/guide.md": "Guide v2\n" });
  const code = p.push("d1", { "src/app.js": "export const a = 666;\n" }); p.push("d1", { "docs/reviews/D1-notes.md": `Verdict: pass\nReviewed commit: ${code}\n` });
  out = script(p, [`origin/agents/d1@${d}`]);
  assert.notEqual(out.status, 0); assert.match(out.stdout, /WAVE-STOPPED/); assert.match(out.stdout, new RegExp(`reviewed ${d}, but origin has`));
  assert.doesNotMatch(out.stdout, /GATE-PATH|PUSHED/); assert.equal(p.origin("show", "main:src/app.js"), "export const a = 1;");
});

test("a rework after a failed review: the new review's commit is merged, the old one is not", () => {
  const p = project();
  const r1 = p.task("t1"); p.review("t1", r1, { round: 1, verdict: "fail" });
  const r2 = p.push("t1", { "src/t1.js": "export const t1 = 2;\n" }, "rework"); p.review("t1", r2, { round: 2 });
  // the journal's latest record is round 2 (reviewReviewed in the unit test above), so the wave carries r2
  const out = script(p, [`origin/agents/t1@${r2}`, `origin/agents/t1-review-2~${r2}`]);
  assert.equal(out.status, 0, out.stdout + out.stderr); assert.equal(p.origin("show", "main:src/t1.js"), "export const t1 = 2;");
  // a wave built from the first record (stale) is refused: the branch is past it
  const q = project(); const a = q.task("t1"); q.review("t1", a, { round: 1, verdict: "fail" }); const b = q.push("t1", { "src/t1.js": "export const t1 = 2;\n" }, "rework"); q.review("t1", b, { round: 2 });
  const stale = script(q, [`origin/agents/t1@${a}`]);
  assert.notEqual(stale.status, 0); assert.match(stale.stdout, new RegExp(`reviewed ${a}, but origin has ${b}`));
});

test("main moving on after the review is no reason to refuse; a clean merge of main into the task branch is the same commit, a merge with a change is not", () => {
  const p = project();
  const sha = p.task("t1"); p.review("t1", sha);
  p.advanceMain({ "README.md": "# Demo v2\n" });
  let out = script(p, [`origin/agents/t1@${sha}`, `origin/agents/t1-review-1~${sha}`]);
  assert.equal(out.status, 0, out.stdout + out.stderr); assert.ok(mainHas(p, "src/t1.js"));
  // the Controller (or anyone) merges main into the task branch after the review: nothing but main's own changes
  const q = project(); const s = q.task("t2"); q.review("t2", s); q.advanceMain({ "README.md": "# Demo v2\n" });
  q.git("checkout", "-q", "agents/t2"); q.git(...NOHOOKS, "merge", "-q", "--no-edit", "origin/main"); q.git(...NOHOOKS, "push", "-q", "origin", "agents/t2"); q.git("checkout", "-q", "main");
  const merged = q.tip("agents/t2"); assert.notEqual(merged, s);
  out = script(q, [`origin/agents/t2@${s}`, `origin/agents/t2-review-1~${s}`]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, new RegExp(`origin/agents/t2: origin is at ${merged}, the reviewed commit ${s} plus clean merges of main only`)); assert.match(out.stdout, new RegExp(`merged origin/agents/t2 at ${s}`));
  // the same merge with one more change smuggled into it (the shape of a conflict resolution)
  const r = project(); const u = r.task("t3"); r.review("t3", u); r.advanceMain({ "README.md": "# Demo v2\n" });
  r.git("checkout", "-q", "agents/t3"); r.git(...NOHOOKS, "merge", "-q", "--no-commit", "origin/main"); r.write("src/app.js", "export const a = 666;\n"); r.git("add", "-A"); r.git(...NOHOOKS, "commit", "-qm", "merge main"); r.git(...NOHOOKS, "push", "-q", "origin", "agents/t3"); r.git("checkout", "-q", "main");
  out = script(r, [`origin/agents/t3@${u}`]);
  assert.notEqual(out.status, 0); assert.match(out.stdout, /WAVE-STOPPED/); assert.equal(r.origin("show", "main:src/app.js"), "export const a = 1;");
  // a commit on top of a clean merge of main is a moved branch again
  q.push("t2", { "src/t2.js": "export const t2 = 9;\n" });
  assert.notEqual(script(q, [`origin/agents/t2@${s}`]).status, 0);
});

test("a branch that was rewritten, or deleted, after its review is not merged", () => {
  const p = project();
  const sha = p.task("t1"); p.review("t1", sha);
  p.git("checkout", "-q", "agents/t1"); p.git("reset", "-q", "--hard", "main"); p.write("src/other.js", "x\n"); p.commit("rewritten"); p.git("push", "-q", "-f", "origin", "agents/t1"); p.git("checkout", "-q", "main");
  const out = script(p, [`origin/agents/t1@${sha}`]);
  assert.notEqual(out.status, 0); assert.match(out.stdout, new RegExp(`reviewed ${sha}, but origin has`));
  p.git("push", "-q", "origin", ":agents/t1");
  const gone = script(p, [`origin/agents/t1@${sha}`]);
  assert.notEqual(gone.status, 0); assert.match(gone.stdout, /not found on origin/);
});

// The ticket file a status-wave branch may touch, as the handbook describes it: Status: lines of docs/tasks/<file>.md.
function statusProject() {
  const p = project();
  p.write("docs/tasks/T1-x.md", "# T1: x\n\nStatus: building\nDepends on: nothing\n\n## Goal\nx\n"); p.write("docs/tasks/T2-y.md", "# T2: y\n\nStatus: review\n\n## Goal\ny\n");
  p.commit("tickets"); p.git(...NOHOOKS, "push", "-q", "origin", "main");
  const status = (name, change) => { p.git("checkout", "-q", "-b", name, "main"); change(); p.commit("status"); p.git("push", "-q", "origin", name); p.git("checkout", "-q", "main"); return p.tip(name); };
  return { p, status };
}

test("a status-wave branch may change Status: lines of ticket files and nothing else; it is merged then", () => {
  const { p, status } = statusProject();
  const sha = p.task("t1"); p.review("t1", sha);
  status("status-wave-1", () => { p.write("docs/tasks/T1-x.md", "# T1: x\n\nStatus: integrated\nDepends on: nothing\n\n## Goal\nx\n"); p.write("docs/tasks/T2-y.md", "# T2: y\n\nStatus: integrated\n\n## Goal\ny\n"); });
  const out = script(p, [`origin/agents/t1@${sha}`, `origin/agents/t1-review-1~${sha}`, "origin/status-wave-1"]);
  assert.equal(out.status, 0, out.stdout + out.stderr); assert.match(out.stdout, /merged origin\/status-wave-1 at /);
  assert.match(p.origin("show", "main:docs/tasks/T1-x.md"), /Status: integrated/);
});

test("probe 6 of the PR #68 review: code and a forged findings file on a status-wave branch are not merged", () => {
  const { p, status } = statusProject();
  const sha = p.task("t1"); p.review("t1", sha);
  p.git("checkout", "-q", "-b", "status-wave-1", "main"); p.write("src/app.js", "export const a = 666;\n"); const code = p.commit("code");
  p.write("docs/reviews/T1-forged.md", `Verdict: pass\nReviewed commit: ${code}\n`); p.commit("forged"); p.git("push", "-q", "origin", "status-wave-1"); p.git("checkout", "-q", "main");
  const out = script(p, [`origin/agents/t1@${sha}`, `origin/agents/t1-review-1~${sha}`, "origin/status-wave-1"]);
  assert.notEqual(out.status, 0); assert.match(out.stdout, /status-wave-1: a status branch may only change the Status: lines/); assert.match(out.stdout, /M src\/app\.js/);
  assert.doesNotMatch(out.stdout, /PUSHED/); assert.equal(p.origin("show", "main:src/app.js"), "export const a = 1;"); assert.equal(mainHas(p, "src/t1.js"), false, "the whole wave stopped");
});

test("a status-wave branch with a new ticket file, a renamed or deleted one, a changed line besides Status:, or a mode change is not merged", () => {
  const cases = {
    "a new file": (p) => p.write("docs/tasks/T3-z.md", "Status: integrated\n"),
    "a rename": (p) => p.git("mv", "docs/tasks/T2-y.md", "docs/tasks/T9-y.md"),
    "a deletion": (p) => p.git("rm", "-q", "docs/tasks/T2-y.md"),
    "a Status: line and another line": (p) => p.write("docs/tasks/T1-x.md", "# T1: x\n\nStatus: integrated\nDepends on: T2\n\n## Goal\nx\n"),
    "a rename of code into the tickets": (p) => p.git("mv", "src/app.js", "docs/tasks/T7-app.md"),
    "a mode change": (p) => fs.chmodSync(path.join(p.dir, "docs/tasks/T1-x.md"), 0o755),
    "a file outside the ticket directory": (p) => p.write("docs/guide.md", "Status: integrated\n"),
  };
  for (const [name, change] of Object.entries(cases)) {
    const { p, status } = statusProject();
    status("status-wave-1", () => change(p));
    const out = script(p, ["origin/status-wave-1"]);
    assert.notEqual(out.status, 0, name); assert.match(out.stdout, /WAVE-STOPPED/, name); assert.doesNotMatch(out.stdout, /PUSHED/, name);
  }
});

test("a branch that is neither bound nor a status-wave branch stops the script: the probe-1 control, the tip of a plain task branch, is not merged", () => {
  const p = project(); const sha = p.task("t4"); p.review("t4", sha);
  p.push("t4", { "src/app.js": "export const a = 666;\n" });
  const out = script(p, ["origin/agents/t4", "origin/agents/t4-review-1"]);
  assert.notEqual(out.status, 0); assert.match(out.stdout, /agents\/t4: not bound to a reviewed commit and not a status-wave-<n> branch/);
  assert.equal(p.origin("show", "main:src/app.js"), "export const a = 1;");
  assert.notEqual(script(p, ["origin/main"]).status, 0);
});

test("a tag named like a branch, or like main, is not looked at: refs are resolved under refs/remotes/origin", () => {
  const p = project(); const sha = p.task("t1"); p.review("t1", sha);
  const moved = p.push("t1", { "src/t1.js": "export const t1 = 2;\n" });
  p.git("tag", "origin/agents/t1", sha);          // hides the move from a plain `origin/agents/t1` lookup
  let out = script(p, [`origin/agents/t1@${sha}`]);
  assert.notEqual(out.status, 0); assert.match(out.stdout, new RegExp(`reviewed ${sha}, but origin has ${moved}`));
  const q = project(); const qs = q.task("t1"); q.review("t1", qs); q.git("tag", "origin/main", qs);   // an ambiguous main must not stop the wave
  out = script(q, [`origin/agents/t1@${qs}`, `origin/agents/t1-review-1~${qs}`]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
});

// --- wave.mjs and reviewed.mjs in a copy of the Controller's bundle -----------------------------
function bundle(p, { journalText = "", runner = "terminal", hosts, extra = {} } = {}) {
  const name = `rev${process.pid}${Math.random().toString(36).slice(2, 8)}`;
  const ctl = path.join(p.base, "ctl"), ws = path.join(p.base, "ws");
  fs.cpSync(path.join(ROOT, "controller"), ctl, { recursive: true });
  fs.writeFileSync(path.join(ctl, "gate"), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  const integ = path.join(ws, name, "coordinator-integration");
  fs.mkdirSync(path.dirname(integ), { recursive: true });
  p.git("worktree", "add", "-q", "-B", "integration", integ, "refs/remotes/origin/main");
  fs.writeFileSync(path.join(ctl, "factory.config.json"), JSON.stringify({ project: { name, mainBranch: "main", branchPrefix: "agents/" }, agents: { runner }, commands: { verify: "true" },
    hosts: { controller: { host: "local", controllerDir: ctl, projectDir: p.dir }, workers: hosts ?? [{ name: "local", kind: "local", projectDir: p.dir, workspacesDir: ws }] }, ...extra }));
  if (journalText) fs.writeFileSync(path.join(ctl, "journal.ndjson"), journalText);
  const bin = path.join(p.base, "bin"); fs.mkdirSync(bin, { recursive: true });
  const run = (script, args, env = {}) => spawnSync("node", [path.join(ctl, script), ...args], { cwd: ctl, encoding: "utf8", timeout: 60000, env: { ...CLEAN_ENV, HOME: p.base, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...env } });
  const events = () => (fs.existsSync(path.join(ctl, "journal.ndjson")) ? fs.readFileSync(path.join(ctl, "journal.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const waitEnd = () => { const log = path.join(ctl, "logs/wave.log"); for (let i = 0; i < 300; i++) { const t = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""; if (/\nWAVE-END\s*$/.test(t) || /^WAVE-END/m.test(t.replace(/echo WAVE-END/g, ""))) return t; spawnSync("sleep", ["0.2"]); } throw new Error("the wave did not end"); };
  const cleanup = () => { for (const f of [`/tmp/${name}-integ-wave.sh`, `/tmp/${name}-wave.out`]) fs.rmSync(f, { force: true }); fs.rmSync(`/tmp/${name}-wave`, { recursive: true, force: true }); };
  return { name, ctl, integ, run, events, waitEnd, bin, cleanup };
}
const rec = (task, head, extra = {}) => line({ type: "review", task, verdict: "pass", path: "tester", head, by: "reviewed.mjs", ...extra });
// the record reviewed.mjs writes for a review branch it read (what the wave binds the branch to)
const recBranch = (p, task, head, branch, extra = {}) => rec(task, head, { branch, reviewSha: p.tip(branch), ...extra });

test("wave.mjs launches the wave with the journal's commits; the wave merges exactly them", () => {
  const p = project(); const sha = p.task("t1"); p.review("t1", sha);
  const b = bundle(p, { journalText: `${rec("T1", sha)}\n${recBranch(p, "T1", sha, "agents/t1-review-1")}\n` });
  try {
    const r = b.run("wave.mjs", ["Title", "Summary", "origin/agents/t1", "origin/agents/t1-review-1"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const log = b.waitEnd();
    assert.match(log, new RegExp(`merged origin/agents/t1 at ${sha}`)); assert.match(log, /PUSHED main/);
    assert.ok(b.events().some((e) => e.type === "wave" && e.note.includes(`origin/agents/t1@${sha}`) && e.note.includes(`origin/agents/t1-review-1~${sha}:${p.tip("agents/t1-review-1")}`)), "the journal says what was launched");
    p.git("fetch", "-q", "origin"); assert.ok(mainHas(p, "src/t1.js"));
  } finally { b.cleanup(); }
});

test("wave.mjs: a branch that moved after the recorded review stops the wave with both commits; nothing reaches main", () => {
  const p = project(); const sha = p.task("t1"); p.review("t1", sha);
  const b = bundle(p, { journalText: `${rec("T1", sha)}\n${recBranch(p, "T1", sha, "agents/t1-review-1")}\n` });
  try {
    const moved = p.push("t1", { "src/app.js": "export const a = 666;\n" });
    const r = b.run("wave.mjs", ["Title", "Summary", "origin/agents/t1", "origin/agents/t1-review-1"]);
    assert.equal(r.status, 0, "the wave is launched; integ-wave.sh judges the tip on its host, after its own fetch");
    const log = b.waitEnd();
    assert.match(log, /WAVE-STOPPED/); assert.match(log, new RegExp(`reviewed ${sha}, but origin has ${moved}`)); assert.doesNotMatch(log, /PUSHED/);
    assert.equal(p.origin("show", "main:src/app.js"), "export const a = 1;");
  } finally { b.cleanup(); }
});

test("wave.mjs: no record, an unreadable journal, a failed review, or a foreign branch: nothing is launched, journaled or merged, and it says what to do", () => {
  const p = project(); const sha = p.task("t1"); p.review("t1", sha);
  const b = bundle(p);
  const tokens = ["Title", "Summary", "origin/agents/t1", "origin/agents/t1-review-1"];
  let r = b.run("wave.mjs", tokens);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /WAVE-NOT-STARTED/); assert.match(r.stderr, /no record of a passing review of t1/); assert.match(r.stderr, /node reviewed\.mjs <task> origin\/agents\/t1-review-<n>/);
  assert.match(r.stderr, /\.factory\/new\/CONTROLLER\.md/, "an older handbook: the message says so");
  for (const f of ["wave-handle.txt", "logs", "journal.ndjson"]) assert.equal(fs.existsSync(path.join(b.ctl, f)), false, `${f} was not created`);
  // an unreadable journal (a directory where the file should be)
  fs.mkdirSync(path.join(b.ctl, "journal.ndjson"));
  r = b.run("wave.mjs", tokens); assert.equal(r.status, 1); assert.match(r.stderr, /no usable review record for t1 \(EISDIR/);
  fs.rmdirSync(path.join(b.ctl, "journal.ndjson"));
  // the latest review failed
  fs.writeFileSync(path.join(b.ctl, "journal.ndjson"), `${rec("T1", sha)}\n${rec("T1", sha, { verdict: "fail", path: "conformance" })}\n`);
  r = b.run("wave.mjs", tokens); assert.equal(r.status, 1); assert.match(r.stderr, /review of t1 says fail/);
  // a branch that is not a task branch of the project
  fs.writeFileSync(path.join(b.ctl, "journal.ndjson"), `${rec("T1", sha)}\n`);
  r = b.run("wave.mjs", ["Title", "Summary", "origin/agents/t1", "origin/some-other"]); assert.equal(r.status, 1); assert.match(r.stderr, /origin\/some-other: not a branch under the prefix/);
  assert.equal(fs.existsSync(path.join(b.ctl, "wave-handle.txt")), false);
  assert.equal(b.events().some((e) => e.type === "wave"), false); assert.equal(p.tip("main"), p.origin("rev-parse", "main"));
  b.cleanup();
});

test("a task reviewed before this change: reviewed.mjs records it once from its findings, then the wave carries it", () => {
  const p = project(); const sha = p.task("t1"); p.review("t1", sha);
  const b = bundle(p);
  try {
    assert.equal(b.run("wave.mjs", ["T", "S", "origin/agents/t1", "origin/agents/t1-review-1"]).status, 1);
    const r = b.run("reviewed.mjs", ["T1", "origin/agents/t1-review-1"]);
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, new RegExp(`recorded: T1 tester review says pass for ${sha}`));
    assert.deepEqual(b.events().map((e) => [e.type, e.task, e.verdict, e.head, e.path]), [["review", "T1", "pass", sha, "tester"]]);
    assert.equal(b.run("wave.mjs", ["T", "S", "origin/agents/t1", "origin/agents/t1-review-1"]).status, 0);
    assert.match(b.waitEnd(), /PUSHED main/);
  } finally { b.cleanup(); }
});

test("reviewed.mjs: a branch that moved is recorded with a note; findings for a commit not on the branch, a second verdict line, a review branch not made from the commit: refused", () => {
  const p = project(); const sha = p.task("t1"); p.review("t1", sha);
  const b = bundle(p);
  const moved = p.push("t1", { "src/t1.js": "export const t1 = 5;\n" });
  let r = b.run("reviewed.mjs", ["T1", "agents/t1-review-1"]);
  assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, new RegExp(`origin/agents/t1 is at ${moved}, not at the reviewed commit`));
  // findings that name a commit which is not on the task's branch (here: the head of another task)
  const other = p.task("t2", { "src/t2.js": "x\n" });
  p.review("t1", other, { round: 2 });
  r = b.run("reviewed.mjs", ["T1", "agents/t1-review-2"]); assert.equal(r.status, 3); assert.match(r.stdout, /NOT RECORDED: the reviewed commit .* is not on origin\/agents\/t1/);
  // two verdict lines
  p.git("checkout", "-q", "-b", "agents/t1-review-3", sha); p.write("docs/reviews/T1-review-3.md", `Verdict: pass\nVerdict: fail\nReviewed commit: ${sha}\n`); p.commit("r3"); p.git("push", "-q", "origin", "agents/t1-review-3"); p.git("checkout", "-q", "main");
  r = b.run("reviewed.mjs", ["T1", "agents/t1-review-3"]); assert.equal(r.status, 3); assert.match(r.stdout, /no single line "Verdict: pass"/);
  // a review branch built on main, not on the reviewed commit
  p.git("checkout", "-q", "-b", "agents/t1-review-4", "main"); p.write("docs/reviews/T1-review-4.md", `Verdict: pass\nReviewed commit: ${sha}\n`); p.commit("r4"); p.git("push", "-q", "origin", "agents/t1-review-4"); p.git("checkout", "-q", "main");
  r = b.run("reviewed.mjs", ["T1", "agents/t1-review-4"]); assert.equal(r.status, 3); assert.match(r.stdout, /was not made from the reviewed commit/);
  // not a review branch of this task
  assert.equal(b.run("reviewed.mjs", ["T1", "agents/t2-review-1"]).status, 3);
  assert.equal(b.events().length, 1, "only the first call recorded anything");
  b.cleanup();
});

test("a backticked SHA on the Reviewed commit line is read like the push gate reads it; a re-evaluation and a conformance branch are recorded with their path", () => {
  const p = project(); const sha = p.task("t1");
  p.git("checkout", "-q", "-b", "agents/t1-review-final", sha); p.write("docs/reviews/T1-review-final.md", `Verdict: pass\nReviewed commit: \`${sha}\`\n`); p.commit("final"); p.git("push", "-q", "origin", "agents/t1-review-final");
  p.git("checkout", "-q", "-b", "agents/t1-conformance", sha); p.write("docs/reviews/T1-architecture-conformance.md", `Verdict: fail\nReviewed commit: ${sha}\n`); p.commit("conf"); p.git("push", "-q", "origin", "agents/t1-conformance"); p.git("checkout", "-q", "main");
  const b = bundle(p);
  assert.equal(b.run("reviewed.mjs", ["T1", "origin/agents/t1-review-final"]).status, 0);
  assert.equal(b.run("reviewed.mjs", ["T1", "agents/t1-conformance"]).status, 0);
  assert.deepEqual(b.events().map((e) => [e.path, e.verdict]), [["final", "pass"], ["conformance", "fail"]]);
  assert.equal(latestReview(fs.readFileSync(path.join(b.ctl, "journal.ndjson"), "utf8"), "t1").state, "failed");
  b.cleanup();
});

test("a wave started on a remote host carries the bound commits in the command it sends, and its script checks them there", () => {
  const p = project(); const sha = p.task("t1"); p.review("t1", sha);
  const b = bundle(p, { journalText: `${rec("T1", sha)}\n${recBranch(p, "T1", sha, "agents/t1-review-1")}\n`, hosts: [{ name: "build", kind: "remote", ssh: "build-host", projectDir: "/srv/p", workspacesDir: "/srv/ws" }], extra: {} });
  const sent = path.join(p.base, "ssh-command.txt");
  fs.writeFileSync(path.join(b.bin, "ssh"), `#!/bin/sh\nfor a; do last="$a"; done\nprintf %s "$last" > ${JSON.stringify(sent)}\n`, { mode: 0o755 });
  const r = b.run("wave.mjs", ["Title", "Summary", "origin/agents/t1", "origin/agents/t1-review-1", "--on", "build"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const cmd = fs.readFileSync(sent, "utf8");
  assert.ok(cmd.includes(`origin/agents/t1@${sha} origin/agents/t1-review-1~${sha}:${p.tip("agents/t1-review-1")}`), cmd.slice(-400));
  assert.ok(!/ origin\/agents\/t1( |$)/.test(cmd.replace(/echo [A-Za-z0-9+/=]+/, "")), "no unbound task branch in the command");
  // the script it carries is this version: it carries the check
  const b64 = /echo ([A-Za-z0-9+/=]{200,}) \| base64 -d/.exec(cmd)[1];
  assert.match(Buffer.from(b64, "base64").toString(), /WAVE-STOPPED/);
  assert.ok(b.events().some((e) => e.type === "wave" && e.host === "build" && e.note.includes(`@${sha}`)));
  b.cleanup();
});

test("the handbook and the review protocol say it, and the new script has its usage text", () => {
  const handbook = fs.readFileSync(path.join(ROOT, "controller/CONTROLLER.md"), "utf8");
  assert.match(handbook, /A wave merges what was reviewed/); assert.match(handbook, /node reviewed\.mjs <task> <review-branch>/); assert.match(handbook, /WAVE-STOPPED/);
  assert.match(fs.readFileSync(path.join(ROOT, "templates/docs/review-protocol.md"), "utf8"), /merges exactly that commit/);
  assert.match(fs.readFileSync(path.join(ROOT, "controller/integ-wave.sh"), "utf8"), /origin\/<branch>@<sha>/);
  assert.match(fs.readFileSync(path.join(ROOT, "controller/reviewed.mjs"), "utf8"), /^\/\/ Usage: node reviewed\.mjs <task> <review-branch>/);
});

// The docs-only path as it is on main: a declared documentation ticket, docsonly.mjs run for real, its evidence journaled with a head.
function docsTicketProject() {
  const p = project({ docsOnly: { enabled: true } });
  p.write("docs/tasks/T05-words.md", "# T05: words\n\nStatus: building\nDepends on: nothing\nLevel: 1\nDocumentation only: yes\n\n## Goal\nWords.\n");
  p.commit("ticket"); p.git(...NOHOOKS, "push", "-q", "origin", "main");
  const sha = p.task("t05", { "docs/guide.md": "Guide v2\n", "docs/reviews/T05-architecture-spec.md": "# Spec review\n\nVerdict: pass\n", "docs/reports/T05-words.md": "# Report\n" });
  return { p, sha };
}

test("docs-only as on main: docsonly.mjs journals the head it checked, the wave binds to it like to a Tester review", () => {
  const { p, sha } = docsTicketProject();
  const b = bundle(p);
  try {
    const d = b.run("docsonly.mjs", ["T05", "origin/agents/t05"]);
    assert.equal(d.status, 0, d.stdout + d.stderr);
    const ev = b.events().find((e) => e.type === "review");
    assert.equal(ev.head, sha); assert.equal(ev.verdict, "docs-only"); assert.equal(ev.task, "T05");
    assert.equal(latestReview(fs.readFileSync(path.join(b.ctl, "journal.ndjson"), "utf8"), "t05").head, sha);
    // unchanged: the wave merges exactly that head
    assert.equal(b.run("wave.mjs", ["T", "S", "origin/agents/t05"]).status, 0);
    const log = b.waitEnd(); assert.match(log, new RegExp(`merged origin/agents/t05 at ${sha}`)); assert.match(log, /PUSHED main/);
  } finally { b.cleanup(); }
});

test("docs-only as on main: a code commit pushed after the check is not merged, and the check run again no longer says docs-only", () => {
  const { p, sha } = docsTicketProject();
  const b = bundle(p);
  try {
    assert.equal(b.run("docsonly.mjs", ["T05", "origin/agents/t05"]).status, 0);
    const code = p.push("t05", { "src/app.js": "export const a = 666;\n" });
    assert.notEqual(b.run("docsonly.mjs", ["T05", "origin/agents/t05"]).status, 0, "the re-run refuses and journals nothing");
    assert.equal(b.events().filter((e) => e.type === "review").length, 1);
    assert.equal(b.run("wave.mjs", ["T", "S", "origin/agents/t05"]).status, 0);
    const log = b.waitEnd();
    assert.match(log, /WAVE-STOPPED/); assert.match(log, new RegExp(`reviewed ${sha}, but origin has ${code}`)); assert.doesNotMatch(log, /PUSHED/);
    assert.equal(p.origin("show", "main:src/app.js"), "export const a = 1;");
  } finally { b.cleanup(); }
});

// --- findings 3 to 5 of the PR #68 review -------------------------------------------------------
test("latestReview: a failed review of a head is final for it, a conformance pass binds nothing, a later event cannot move the binding to an uncovered commit, untrusted events are ignored", () => {
  const ev = (o) => ({ type: "review", task: "T1", by: "reviewed.mjs", path: "tester", ...o });
  // Tester pass C, conformance fail C, then the Tester verdict is recorded again (the reflex): still failed
  let r = latestReview(journal(ev({ verdict: "pass", head: C }), ev({ verdict: "fail", head: C, path: "conformance" }), ev({ verdict: "pass", head: C })), "t1");
  assert.equal(r.state, "failed"); assert.equal(r.head, C);
  // a conformance pass alone never binds a head, and does not move a binding
  assert.equal(latestReview(journal(ev({ verdict: "pass", head: C, path: "conformance" })), "t1").state, "none");
  r = latestReview(journal(ev({ verdict: "pass", head: A }), ev({ verdict: "pass", head: C, path: "conformance" })), "t1");
  assert.equal(r.state, "ok"); assert.equal(r.head, A, "the conformance review of another commit does not move the head");
  // a conformance fail of an older head does not fail the newer one
  r = latestReview(journal(ev({ verdict: "pass", head: A }), ev({ verdict: "fail", head: A, path: "conformance" }), ev({ verdict: "pass", head: B })), "t1");
  assert.equal(r.state, "ok"); assert.equal(r.head, B);
  // a fail is never a pass: after a failed round the wave does not start, whatever came before
  assert.equal(latestReview(journal(ev({ verdict: "pass", head: A }), ev({ verdict: "fail", head: B })), "t1").state, "failed");
  // only what reviewed.mjs and docsonly.mjs wrote counts: a hand-written line (journal.mjs, an editor) is no record
  assert.equal(latestReview(line({ type: "review", task: "T1", verdict: "pass", path: "architect", head: A }) + "\n", "t1").state, "none");
  assert.equal(latestReview(line({ type: "review", task: "T1", verdict: "pass", path: "architect", head: A, by: "me" }) + "\n", "t1").state, "none");
  // the review branches covered at the bound head, per branch
  r = latestReview(journal(ev({ verdict: "pass", head: A, branch: "agents/t1-review-1", reviewSha: B }), ev({ verdict: "pass", head: A, branch: "agents/t1-conformance", reviewSha: C, path: "conformance" })), "t1");
  assert.equal(r.covers.get("agents/t1-review-1").reviewSha, B); assert.equal(r.covers.get("agents/t1-conformance").reviewSha, C);
});

test("journal.mjs does not write a review event with a head; the wave's message does not recommend it", () => {
  const p = project(); const b = bundle(p);
  const r = b.run("journal.mjs", ["review", "T1", "verdict=pass", "path=architect", `head=${A}`]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /written by reviewed\.mjs or docsonly\.mjs/);
  assert.equal(b.events().length, 0);
  assert.equal(b.run("journal.mjs", ["decision", "T1", "k=v"]).status, 0, "other events are untouched");
  b.cleanup();
});

test("reviewed.mjs: the review sha the reviewer reported must be what origin has; an older head, and a review that is recorded again after a conformance fail, change nothing", () => {
  const p = project(); const sha = p.task("t1"); p.review("t1", sha);
  const b = bundle(p);
  const read = p.tip("agents/t1-review-1");
  // the Developer replaces the review branch after the Tester reported it
  const code = p.push("t1", { "src/app.js": "export const a = 666;\n" });
  p.git("checkout", "-q", "-B", "agents/t1-review-1", code); p.write("docs/reviews/T1-review-1.md", `Verdict: pass\nReviewed commit: ${code}\n`); p.commit("forged"); p.git("push", "-q", "-f", "origin", "agents/t1-review-1"); p.git("checkout", "-q", "main");
  let r = b.run("reviewed.mjs", ["T1", "agents/t1-review-1", read]);
  assert.equal(r.status, 3, r.stdout); assert.match(r.stdout, /pushed to after the report/); assert.equal(b.events().length, 0, "nothing recorded");
  // a rework, reviewed in round 2; round 1 recorded afterwards would move the binding backwards
  const q = project(); const a1 = q.task("t1"); q.review("t1", a1, { round: 1, verdict: "fail" }); const a2 = q.push("t1", { "src/t1.js": "export const t1 = 2;\n" }, "rework"); q.review("t1", a2, { round: 2 });
  const c = bundle(q);
  assert.equal(c.run("reviewed.mjs", ["T1", "agents/t1-review-1"]).status, 0); assert.equal(c.run("reviewed.mjs", ["T1", "agents/t1-review-2", q.tip("agents/t1-review-2")]).status, 0);
  r = c.run("reviewed.mjs", ["T1", "agents/t1-review-1"]); assert.equal(r.status, 3); assert.match(r.stdout, /older than/);
  assert.equal(c.events().length, 2);
  // Tester pass, conformance fail, the Tester verdict recorded again: the wave does not start
  const s = project(); const h = s.task("t1"); s.review("t1", h); s.git("checkout", "-q", "-b", "agents/t1-conformance", h); s.write("docs/reviews/T1-architecture-conformance.md", `Verdict: fail\nReviewed commit: ${h}\n`); s.commit("conf"); s.git("push", "-q", "origin", "agents/t1-conformance"); s.git("checkout", "-q", "main");
  const d = bundle(s);
  for (const br of ["agents/t1-review-1", "agents/t1-conformance", "agents/t1-review-1"]) assert.equal(d.run("reviewed.mjs", ["T1", br]).status, 0);
  const w = d.run("wave.mjs", ["T", "S", "origin/agents/t1", "origin/agents/t1-review-1"]);
  assert.equal(w.status, 1); assert.match(w.stderr, /review of t1 says fail/);
  [b, c, d].forEach((x) => x.cleanup());
});

test("reviewed.mjs --architect records an Architect branch that changes documents only; a branch with code, a rename or a findings file is refused, and the wave then carries it", () => {
  const mk = (files, mv) => { const p = project(); p.git("checkout", "-q", "-b", "agents/architecture-baseline", "main"); for (const [f, s] of Object.entries(files)) p.write(f, s); if (mv) p.git("mv", ...mv); const sha = p.commit("baseline"); p.git("push", "-q", "origin", "agents/architecture-baseline"); p.git("checkout", "-q", "main"); return { p, sha }; };
  let { p, sha } = mk({ "docs/debt.md": "debt\n", "docs/reviews/architecture-baseline.md": "# Baseline\n\nNo drift.\n" });
  const b = bundle(p);
  assert.equal(b.run("wave.mjs", ["T", "S", "origin/agents/architecture-baseline"]).status, 1, "no record: the wave does not start");
  const r = b.run("reviewed.mjs", ["--architect", "architecture-baseline"]); assert.equal(r.status, 0, r.stdout);
  assert.equal(b.run("wave.mjs", ["T", "S", "origin/agents/architecture-baseline"]).status, 0);
  assert.match(b.waitEnd(), new RegExp(`merged origin/agents/architecture-baseline at ${sha}`)); b.cleanup();
  for (const [name, files, mv] of [["code", { "ARCHITECTURE.md": "x\n", "src/app.js": "export const a = 2;\n" }], ["a rename", { "ARCHITECTURE.md": "x\n" }, ["src/app.js", "docs/debt-copy.md"]], ["a findings file", { "docs/reviews/x.md": "Verdict: pass\nReviewed commit: " + A + "\n" }]]) {
    const m = mk(files, mv), c = bundle(m.p);
    assert.equal(c.run("reviewed.mjs", ["--architect", "architecture-baseline"]).status, 3, name); assert.equal(c.events().length, 0, name); c.cleanup();
  }
  assert.equal(bundle(project()).run("reviewed.mjs", ["--architect", "t1"]).status, 3, "a task branch is no Architect branch");
});

test("legitimate flows stay green: a level 2 task with its conformance branch, a re-evaluation, several tasks in one wave, and a red wave run again", () => {
  const p = project();
  const s1 = p.task("t1"); p.review("t1", s1);
  p.git("checkout", "-q", "-b", "agents/t1-conformance", s1); p.write("docs/reviews/T1-architecture-conformance.md", `Verdict: pass\nReviewed commit: ${s1}\n`); p.commit("conf"); p.git("push", "-q", "origin", "agents/t1-conformance"); p.git("checkout", "-q", "main");
  const s2 = p.task("t2"); p.git("checkout", "-q", "-b", "agents/t2-review-final", s2); p.write("docs/reviews/T2-review-final.md", `Verdict: pass\nReviewed commit: ${s2}\n`); p.commit("final"); p.git("push", "-q", "origin", "agents/t2-review-final"); p.git("checkout", "-q", "main");
  const b = bundle(p);
  for (const [t, br] of [["T1", "agents/t1-review-1"], ["T1", "agents/t1-conformance"], ["T2", "agents/t2-review-final"]]) assert.equal(b.run("reviewed.mjs", [t, br]).status, 0);
  const args = ["T", "S", "origin/agents/t1", "origin/agents/t1-review-1", "origin/agents/t1-conformance", "origin/agents/t2", "origin/agents/t2-review-final"];
  // a red wave: the gate fails; the same call again after the gate is fixed merges the same commits
  fs.writeFileSync(path.join(b.ctl, "factory.config.json"), fs.readFileSync(path.join(b.ctl, "factory.config.json"), "utf8").replace('"verify":"true"', '"verify":"false"'));
  assert.equal(b.run("wave.mjs", args).status, 0); assert.match(b.waitEnd(), /verify FAIL/); assert.equal(mainHas(p, "src/t1.js"), false);
  fs.rmSync(path.join(b.ctl, "logs"), { recursive: true });
  fs.writeFileSync(path.join(b.ctl, "factory.config.json"), fs.readFileSync(path.join(b.ctl, "factory.config.json"), "utf8").replace('"verify":"false"', '"verify":"true"'));
  assert.equal(b.run("wave.mjs", args).status, 0);
  const log = b.waitEnd(); assert.match(log, /PUSHED main/); assert.match(log, new RegExp(`merged origin/agents/t1-conformance at `));
  p.git("fetch", "-q", "origin"); assert.ok(mainHas(p, "src/t1.js") && mainHas(p, "src/t2.js"));
  b.cleanup();
});
