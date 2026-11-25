// A recorded waiver for a decided non-blocker in a failed review (controller/waiver.mjs, findings.mjs, reviewrecord.mjs, integ-wave.sh and
// the review gate of the pre-push hook). Throwaway repositories with a bare origin and the factory's own hooks; the Controller's bundle is a
// copy in a temporary directory; no real Orca, host or home. The "try to break it" cases are the ones of the PR #68 reviews, applied to
// the one new door: a forged waiver through a branch or a file, a commit that was never reviewed, a later commit, no or all findings, a
// relabelled class, a level-3 ticket, a lowered level, the round limit with its final re-evaluation (PR #53), and a red gate.
import "./support/safe-env.mjs";
import { tempDir, onCleanup } from "./support/cleanup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bindBranches, latestReview, recordedIssues } from "../controller/reviewrecord.mjs";
import { parseFindings, waivable, waivableNote, CLASSES, NEVER_WAIVABLE, WAIVABLE, FRONT_AGENT_WAIVABLE } from "../controller/findings.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NOHOOKS = ["-c", "core.hooksPath=/dev/null"];
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCA_") && k !== "FACTORY_WAIVED"));
const A = "a".repeat(40), B = "b".repeat(40), R1 = "1".repeat(40), R2 = "2".repeat(40), R3 = "3".repeat(40);

// --- findings: the strict reading --------------------------------------------------------------
const heading = (id, sev, cls, title = "Something") => `### ${id} [${sev}] [${cls}] ${title}\n- Where: \`x:1\`\n- Problem: p\n`;
const FILE = (sha, { verdict = "fail", gates = "Gates: verify pass, e2e none", findings = [["F1", "blocker", "process"]], body } = {}) =>
  `# T1 review, round 1\n\nVerdict: ${verdict}\nReviewed commit: ${sha}\n${gates ? `${gates}\n` : ""}Ponytail: fine\n\n## Spec checklist\n| # | Requirement | Code | Test | Status |\n\n## Findings\n${body ?? findings.map(([id, sev, cls, t]) => heading(id, sev, cls, t)).join("\n")}\n## Debt candidates\n| Category | Severity | Where | Proposal |\n| security | low | x | y |\n`;

test("the findings parser reads the class from the heading, strictly; anything else is not waivable, with the way out", () => {
  const ok = parseFindings(FILE(A, { findings: [["F1", "blocker", "functional"], ["F2", "minor", "style"]] }));
  assert.equal(ok.ok, true); assert.deepEqual(ok.findings.map((f) => [f.id, f.severity, f.cls]), [["F1", "blocker", "functional"], ["F2", "minor", "style"]]); assert.deepEqual(ok.gates, { verify: "pass", e2e: "none" });
  const bad = {
    "a finding without a class (the old form)": "### [blocker] The approval came after the build\n- Where: x\n",
    "a finding with an id but no class": "### F1 [blocker] No class\n",
    "an unknown class": heading("F1", "blocker", "cosmetic"),
    "a class in capitals": heading("F1", "blocker", "Style"),
    "two classes in one heading": "### F1 [blocker] [style] [security] Two\n",
    "a class only in prose": "### F1 [blocker] Prose\n- Class: style\n",
    "an id used twice": `${heading("F1", "major", "style")}\n${heading("F1", "minor", "style")}`,
    "a heading that is no finding under Findings": `${heading("F1", "major", "style")}\n### Notes\nsecurity: none\n`,
    "no Findings section": "# T1 review\nVerdict: fail\n",
  };
  for (const [name, body] of Object.entries(bad)) {
    const text = name === "no Findings section" ? body : FILE(A, { body });
    const p = parseFindings(text);
    assert.equal(p.ok, false, name);
    assert.match(waivableNote(text, "tester"), /not waivable/, name);
    assert.match(waivable(p, ["F1"], "tester").why, /A new review with the current template is needed \(a new Tester round, mkspec test; after the round limit the re-evaluation, mkspec reeval\)/, name);
  }
  // a finding heading hidden in another section, two or a malformed Gates line
  assert.equal(parseFindings(FILE(A).replace("## Spec checklist", `## Spec checklist\n${heading("F9", "blocker", "security")}`)).ok, false, "a finding outside ## Findings");
  assert.equal(parseFindings(FILE(A, { gates: "Gates: verify green" })).ok, false, "a Gates line that is not the format");
  assert.equal(parseFindings(FILE(A, { gates: "Gates: verify pass, e2e none\nGates: verify pass, e2e pass" })).ok, false, "two Gates lines");
});

test("what can never be waived is decided from the class and the gate line: security, data-corruption, input-loss and gate, in any severity, and a red gate", () => {
  assert.deepEqual(NEVER_WAIVABLE, ["security", "data-corruption", "input-loss", "gate"]); assert.equal(CLASSES.length, 7);
  for (const cls of NEVER_WAIVABLE) for (const sev of ["blocker", "major", "minor"]) {
    const p = parseFindings(FILE(A, { findings: [["F1", "blocker", "process"], ["F2", sev, cls]] }));
    const w = waivable(p, ["F1", "F2"], "tester");
    assert.equal(w.ok, false, `${cls} ${sev}`); assert.match(w.why, new RegExp(`F2 \\(${cls}\\) can never be waived`));
    assert.equal(waivable(p, ["F1"], "tester").ok, false, `${cls} ${sev} is not made waivable by leaving it out`);
  }
  const red = parseFindings(FILE(A, { gates: "Gates: verify fail, e2e none" })); assert.match(waivable(red, ["F1"], "tester").why, /red gate is never waived/);
  assert.match(waivable(parseFindings(FILE(A, { gates: "Gates: verify pass, e2e fail" })), ["F1"], "tester").why, /red gate/);
  assert.match(waivable(parseFindings(FILE(A, { gates: "" })), ["F1"], "tester").why, /states its gates on one "Gates:" line/, "a Tester round without a gates line");
  assert.equal(waivable(parseFindings(FILE(A, { gates: "" })), ["F1"], "final").ok, true, "a re-evaluation runs no full suite and has no such line");
  // the findings it must name
  const two = parseFindings(FILE(A, { findings: [["F1", "blocker", "process"], ["F2", "major", "functional"], ["F3", "minor", "style"]] }));
  assert.equal(waivable(two, ["F1", "F2"], "tester").ok, true, "a minor finding need not be named");
  assert.equal(waivable(two, ["F1", "F2", "F3"], "tester").ok, true);
  assert.match(waivable(two, ["F1"], "tester").why, /F2 \[major\] is not named/);
  assert.match(waivable(two, [], "tester").why, /names the findings it waives; none is named/);
  assert.match(waivable(two, ["all"], "tester").why, /no such finding in the file: all/);
  assert.match(waivable(two, ["*"], "tester").why, /no such finding/);
  assert.match(waivable(two, ["F1", "F1", "F2"], "tester").why, /named twice/);
  assert.match(waivable(parseFindings(FILE(A, { findings: [["F1", "minor", "style"]] })), ["F1"], "tester").why, /no blocker or major/);
});

// --- the record ---------------------------------------------------------------------------------
const line = (o) => JSON.stringify({ ts: "2026-01-01T00:00:00Z", ...o });
const fail = (head, n, o = {}) => ({ type: "review", task: "T1", verdict: "fail", path: "tester", head, by: "reviewed.mjs", branch: `agents/t1-review-${n}`, reviewSha: String(n).repeat(40), file: `docs/reviews/T1-review-${n}.md`, ...o });
const waiver = (head, n, o = {}) => ({ type: "waiver", task: "T1", by: "waiver.mjs", head, branch: `agents/t1-review-${n}`, reviewSha: String(n).repeat(40), file: `docs/reviews/T1-review-${n}.md`, path: "tester", findings: ["F1"], decider: "front-agent", words: "this is no blocker", reason: "r", followUp: "T2", ...o });
const J = (...events) => events.map((e) => line(e)).join("\n") + "\n";

test("latestReview: a waiver turns 'failed' into 'waived' for exactly the review it names; the review stays a fail", () => {
  const failed = latestReview(J(fail(A, 1)), "t1", 2); assert.equal(failed.state, "failed");
  const w = latestReview(J(fail(A, 1), waiver(A, 1)), "t1", 2);
  assert.equal(w.state, "waived"); assert.equal(w.head, A); assert.equal(w.event.verdict, "fail"); assert.deepEqual([...w.covers.keys()], ["agents/t1-review-1"]);
  const notWaived = {
    "a waiver before the failure it names": J(waiver(A, 1), fail(A, 1)),
    "a waiver for another reviewed commit": J(fail(A, 1), waiver(B, 1)),
    "a waiver for another review branch": J(fail(A, 1), waiver(A, 2)),
    "a waiver for another commit of the same review branch": J(fail(A, 1), waiver(A, 1, { reviewSha: B })),
    "a waiver for another findings file": J(fail(A, 1), waiver(A, 1, { file: "docs/reviews/T1-review-2.md" })),
    "a waiver that is not written by waiver.mjs (journal.mjs, an editor, reviewed.mjs)": J(fail(A, 1), waiver(A, 1, { by: "reviewed.mjs" })),
    "a waiver with no `by`": J(fail(A, 1), (({ by, ...rest }) => rest)(waiver(A, 1))),
    "a waiver decided by the Controller": J(fail(A, 1), waiver(A, 1, { decider: "controller" })),
    "a waiver that names no finding": J(fail(A, 1), waiver(A, 1, { findings: [] })),
    "a waiver without words": J(fail(A, 1), waiver(A, 1, { words: " " })),
    "a waiver without a follow-up": J(fail(A, 1), waiver(A, 1, { followUp: undefined })),
  };
  for (const [name, text] of Object.entries(notWaived)) assert.equal(latestReview(text, "t1", 2).state, "failed", name);
  assert.equal(latestReview(J(fail(A, 1), waiver(A, 1)), "t2", 2).state, "none", "another task's waiver is none of its business");
});

test("latestReview: a waiver of one commit never covers a later one; every standing failure needs its own waiver", () => {
  // reuse for a later commit: the new head has its own review, and the old waiver is about the old head
  assert.equal(latestReview(J(fail(A, 1), waiver(A, 1), fail(B, 2)), "t1", 2).state, "failed", "the rework's own review failed");
  assert.equal(latestReview(J(fail(A, 1), waiver(A, 1), { ...fail(B, 2), verdict: "pass" }), "t1", 2).state, "ok", "a pass of the new commit");
  assert.equal(latestReview(J(fail(A, 1), waiver(A, 1), { ...fail(B, 2), verdict: "pass" }), "t1", 2).head, B);
  // a second failed review of the same commit (conformance) is a standing failure of its own
  const conf = fail(A, 3, { path: "conformance", file: "docs/reviews/T1-architecture-conformance.md", branch: "agents/t1-conformance" });
  assert.equal(latestReview(J(fail(A, 1), waiver(A, 1), conf), "t1", 2).state, "failed");
  const both = latestReview(J(fail(A, 1), waiver(A, 1), conf, waiver(A, 3, { path: "conformance", file: conf.file, branch: conf.branch })), "t1", 2);
  assert.equal(both.state, "waived"); assert.deepEqual([...both.covers.keys()].sort(), ["agents/t1-conformance", "agents/t1-review-1"]);
  // a Tester pass of the same commit after a waived failure: still the waived state (a pass does not undo a fail), never a worse one
  assert.equal(latestReview(J(fail(A, 1), waiver(A, 1), { ...fail(A, 2), verdict: "pass" }), "t1", 2).state, "waived");
});

test("latestReview: the round limit and the final re-evaluation (PR #53) with a waiver", () => {
  // round 1 and round 2 failed, the limit is 2: a waiver of round 2's review; a passing re-evaluation of that commit is a plain pass
  const rounds = [fail(A, 1), fail(B, 2)];
  assert.equal(latestReview(J(...rounds, waiver(B, 2)), "t1", 2).state, "waived", "waived at the limit, without a re-evaluation");
  const reeval = (verdict, extra = {}) => fail(B, 3, { path: "final", verdict, file: "docs/reviews/T1-review-final.md", branch: "agents/t1-review-final", ...extra });
  assert.equal(latestReview(J(...rounds, waiver(B, 2), reeval("pass")), "t1", 2).state, "ok", "the re-evaluation passes: its pass undoes the Tester fail, the waiver is not needed");
  // a re-evaluation that FAILS after the waiver is a new failed review of the same commit: the waiver of the round does not cover it
  const after = latestReview(J(...rounds, waiver(B, 2), reeval("fail")), "t1", 2);
  assert.equal(after.state, "failed"); assert.equal(after.event.path, "final");
  assert.equal(latestReview(J(...rounds, waiver(B, 2), reeval("fail"), waiver(B, 3, { path: "final", file: "docs/reviews/T1-review-final.md", branch: "agents/t1-review-final" })), "t1", 2).state, "waived", "its own waiver");
  // before the limit a passing re-evaluation supersedes nothing, and a waiver is about the review it names
  assert.equal(latestReview(J(fail(A, 1), reeval("pass", { head: A })), "t1", 2).state, "failed");
});

test("bindBranches: a waived task is bound like a passed one, its failed review branch has to go with it, and what is waived is reported", () => {
  const read = () => ({ state: "waived", head: A, covers: new Map([["agents/t1-review-1", { reviewSha: R1, file: "docs/reviews/T1-review-1.md" }]]), failures: [{ branch: "agents/t1-review-1", file: "docs/reviews/T1-review-1.md" }], waivers: [{ decider: "owner", followUp: "T2", ts: "t" }] });
  const ok = bindBranches(["origin/agents/t1", "origin/agents/t1-review-1"], { prefix: "agents/", read });
  assert.deepEqual(ok.args, [`origin/agents/t1@${A}`, `origin/agents/t1-review-1~${A}:${R1}=docs/reviews/T1-review-1.md`]);
  assert.deepEqual(ok.waived.map((w) => [w.task, w.head, w.files[0].file, w.files[0].decider]), [["t1", A, "docs/reviews/T1-review-1.md", "owner"]]);
  const lone = bindBranches(["origin/agents/t1"], { prefix: "agents/", read });
  assert.match(lone.problems[0], /failed and is waived[\s\S]*add origin\/agents\/t1-review-1 to the wave/);
  const failed = bindBranches(["origin/agents/t1"], { prefix: "agents/", read: () => ({ state: "failed", head: A, standing: [{}], waived: [] }) });
  assert.match(failed.problems[0], /says fail/); assert.doesNotMatch(failed.problems[0], /waiver/, "a failed review is not shown a way out: a waiver is somebody else's decision");
  assert.match(bindBranches(["origin/agents/t1"], { prefix: "agents/", read: () => ({ state: "failed", head: A, standing: [{}, {}], waived: [{}] }) }).problems[0], /1 of the 2 failed reviews standing for [0-9a-f]{40} have a waiver \(waiver\.mjs\); each one needs its own/);
  assert.deepEqual(bindBranches(["origin/agents/t1"], { prefix: "agents/", read: () => ({ state: "ok", head: A, covers: new Map() }) }).waived, [], "nothing waived, nothing reported");
});

// --- a project with a bare origin and the factory's hooks (as in wave-reviewed-head.test.mjs) -----------
function project(cfg = {}) {
  const base = fs.realpathSync(tempDir("af-wv-"));
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
  write("docs/tasks/T1-x.md", "# T1: x\n\nStatus: building\nLevel: 1\n"); write("docs/tasks/T2-follow.md", "# T2: follow-up\n\nStatus: draft\nLevel: 1\n");
  git("add", "-A"); git("commit", "-qm", "init"); git("push", "-q", "origin", "main");
  git("config", "core.hooksPath", ".githooks");
  const commit = (msg) => { git("add", "-A"); git(...NOHOOKS, "commit", "-qm", msg); return git("rev-parse", "HEAD"); };
  const origin = (...a) => spawnSync("git", ["--git-dir", bare, ...a], { encoding: "utf8" }).stdout.trim();
  const task = (key, files = { [`src/${key}.js`]: `export const ${key} = 1;\n` }) => {
    git("checkout", "-q", "-b", `agents/${key}`, "main"); for (const [f, s] of Object.entries(files)) write(f, s);
    const sha = commit(`${key} work`); git("push", "-q", "origin", `agents/${key}`); git("checkout", "-q", "main"); return sha;
  };
  // the review branch of a round: made from the reviewed commit, one findings file on it
  const review = (key, sha, text, { round = 1, name = `${key}-review-${round}`, file = `docs/reviews/${key.toUpperCase()}-review-${round}.md` } = {}) => {
    git("checkout", "-q", "-B", `agents/${name}`, sha); write(file, text); commit(`${key} review`); git("push", "-q", "-f", "origin", `agents/${name}`); git("checkout", "-q", "main");
  };
  const push = (key, files, msg = "after the review") => { git("checkout", "-q", `agents/${key}`); for (const [f, s] of Object.entries(files)) write(f, s); const sha = commit(msg); git("push", "-q", "origin", `agents/${key}`); git("checkout", "-q", "main"); return sha; };
  const onMain = (files) => { git("checkout", "-q", "main"); for (const [f, s] of Object.entries(files)) write(f, s); const sha = commit("main moves"); git(...NOHOOKS, "push", "-q", "origin", "main"); return sha; };
  return { base, dir, bare, git, write, commit, origin, task, review, push, onMain, tip: (b) => origin("rev-parse", b) };
}
const mainHas = (p, f) => spawnSync("git", ["--git-dir", p.bare, "cat-file", "-e", `main:${f}`]).status === 0;

function bundle(p, { journalText = "", extra = {} } = {}) {
  const name = `wv${process.pid}${Math.random().toString(36).slice(2, 8)}`;
  const ctl = path.join(p.base, "ctl"), ws = path.join(p.base, "ws");
  fs.cpSync(path.join(ROOT, "controller"), ctl, { recursive: true });
  fs.writeFileSync(path.join(ctl, "gate"), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  const integ = path.join(ws, name, "coordinator-integration");
  fs.mkdirSync(path.dirname(integ), { recursive: true });
  p.git("worktree", "add", "-q", "--detach", integ, "refs/remotes/origin/main");
  fs.writeFileSync(path.join(ctl, "factory.config.json"), JSON.stringify({ project: { name, mainBranch: "main", branchPrefix: "agents/" }, agents: { runner: "terminal" }, commands: { verify: "true" },
    hosts: { controller: { host: "local", controllerDir: ctl, projectDir: p.dir }, workers: [{ name: "local", kind: "local", projectDir: p.dir, workspacesDir: ws }] }, ...extra }));
  if (journalText) fs.writeFileSync(path.join(ctl, "journal.ndjson"), journalText);
  const bin = path.join(p.base, "bin"); fs.mkdirSync(bin, { recursive: true });
  const raw = (script, args, env = {}) => spawnSync("node", [path.join(ctl, script), ...args], { cwd: ctl, encoding: "utf8", timeout: 60000, env: { ...CLEAN_ENV, HOME: p.base, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...env } });
  // reviewed.mjs needs the review sha the reviewer reported: these tests report the one origin has
  const run = (script, args, env = {}) => raw(script, script === "reviewed.mjs" && args.length === 2 ? [...args, p.tip(args[1].replace(/^origin\//, ""))] : args, env);
  const events = () => (fs.existsSync(path.join(ctl, "journal.ndjson")) ? fs.readFileSync(path.join(ctl, "journal.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const waitEnd = () => { const log = path.join(ctl, "logs/wave.log"); for (let i = 0; i < 300; i++) { const t = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""; if (/^WAVE-END/m.test(t.replace(/echo WAVE-END/g, ""))) return t; spawnSync("sleep", ["0.2"]); } throw new Error("the wave did not end"); };
  const cleanup = () => { for (const f of [`/tmp/${name}-integ-wave.sh`, `/tmp/${name}-wave.out`]) fs.rmSync(f, { force: true }); fs.rmSync(`/tmp/${name}-wave`, { recursive: true, force: true }); };
  onCleanup(cleanup);
  return { name, ctl, integ, run, raw, events, waitEnd, cleanup };
}

// A task with a failed first round: findings on a review branch. `level` and `findings` shape the ticket on main and the review.
function scene({ level = 1, text, ticket, extra, mainFiles = {}, files } = {}) {
  const p = project(); if (ticket !== undefined || level !== 1) mainFiles = { "docs/tasks/T1-x.md": ticket ?? `# T1: x\n\nStatus: building\nLevel: ${level}\n`, ...mainFiles };
  if (Object.keys(mainFiles).length) p.onMain(mainFiles);
  const sha = p.task("t1", files); p.review("t1", sha, text ? text(sha) : FILE(sha));
  const b = bundle(p, { extra });
  return { p, b, sha, rb: "agents/t1-review-1" };
}
const record = (b, round = 1) => b.run("reviewed.mjs", ["T1", `agents/t1-review-${round}`]);
const WORDS = "I decided this is a follow-up, not a blocker";
const waive = (b, sha, over = {}) => {
  const o = { task: "T1", branch: "agents/t1-review-1", sha, findings: "F1", decider: "front-agent", words: WORDS, reason: "the process proof only; content and gate are fine", followUp: "T2", ...over };
  const args = [o.task, o.branch, o.sha]; for (const [flag, k] of [["--findings", "findings"], ["--decider", "decider"], ["--words", "words"], ["--reason", "reason"], ["--follow-up", "followUp"], ["--ref", "ref"]]) if (o[k] !== undefined) args.push(flag, o[k]);
  return b.raw("waiver.mjs", args);
};
const WAVE = ["Title", "Summary", "origin/agents/t1", "origin/agents/t1-review-1"];
const waiverEvents = (b) => b.events().filter((e) => e.type === "waiver");

test("a decided non-blocker goes through: recorded by the Controller, the wave starts for exactly that commit, runs the full gate and pushes; the review stays a fail", () => {
  const { p, b, sha } = scene();
  try {
    const r = record(b); assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /recorded: T1 tester review says fail for [0-9a-f]{40}/); assert.doesNotMatch(r.stdout, /waiver/i, "reviewed.mjs never offers a waiver");
    // nothing starts for a failed review ...
    const before = b.run("wave.mjs", WAVE); assert.equal(before.status, 1); assert.match(before.stderr, /WAVE-NOT-STARTED/); assert.doesNotMatch(before.stderr, /waiver/i, "nor does the wave that does not start"); assert.equal(b.events().filter((e) => e.type === "wave").length, 0);
    // ... until the decision is recorded
    const w = waive(b, p.tip("agents/t1-review-1")); assert.equal(w.status, 0, w.stdout + w.stderr); assert.match(w.stdout, /still Verdict: fail/);
    const [e] = waiverEvents(b);
    assert.deepEqual({ by: e.by, task: e.task, head: e.head, branch: e.branch, reviewSha: e.reviewSha, file: e.file, path: e.path, findings: e.findings, decider: e.decider, words: e.words, followUp: e.followUp, level: e.level },
      { by: "waiver.mjs", task: "T1", head: sha, branch: "agents/t1-review-1", reviewSha: p.tip("agents/t1-review-1"), file: "docs/reviews/T1-review-1.md", path: "tester", findings: ["F1"], decider: "front-agent", words: WORDS, followUp: "T2", level: 1 });
    assert.ok(e.reason && e.ts, "the reason and the time are in it");
    const started = b.run("wave.mjs", WAVE); assert.equal(started.status, 0, started.stdout + started.stderr); assert.match(started.stdout, /WAIVED: t1 at [0-9a-f]{40}: docs\/reviews\/T1-review-1\.md \(decided by the front-agent, follow-up T2\)/);
    const log = b.waitEnd();
    assert.match(log, new RegExp(`merged origin/agents/t1 at ${sha}`)); assert.match(log, /verify PASS/); assert.match(log, /PUSHED main/);
    p.git("fetch", "-q", "origin"); assert.ok(mainHas(p, "src/t1.js"));
    assert.match(p.origin("show", "main:docs/reviews/T1-review-1.md"), /^Verdict: fail$/m, "the failed review is on main as it was: a fail");
    assert.match(p.origin("log", "-5", "--format=%B", "main"), /Waived review: docs\/reviews\/T1-review-1\.md \(it still says Verdict: fail/);
    assert.ok(b.events().some((e2) => e2.type === "wave" && e2.waived?.[0]?.task === "t1"), "the wave event names what was waived");
  } finally { b.cleanup(); }
});

test("a waiver does not weaken the gate: a red full gate keeps the wave from pushing, and the docs-only path is not taken", () => {
  const { p, b, sha } = scene({ extra: { commands: { verify: "false" } } });
  try {
    record(b); assert.equal(waive(b, p.tip("agents/t1-review-1")).status, 0);
    assert.equal(b.run("wave.mjs", WAVE).status, 0);
    const log = b.waitEnd(); assert.match(log, /verify FAIL/); assert.doesNotMatch(log, /PUSHED/); assert.equal(mainHas(p, "src/t1.js"), false);
  } finally { b.cleanup(); }
  // docs-only is on, and the change is documentation only: a waived review still gets the full gate, never the lighter format and Markdown checks
  const q = scene({ mainFiles: { "factory.config.json": JSON.stringify({ project: { name: "demo", mainBranch: "main" }, commands: { formatCheck: "false", markdownCheck: "false" }, docsOnly: { enabled: true, paths: ["docs/**"] } }, null, 2) + "\n" }, files: { "docs/more.md": "More\n" } });
  try {
    record(q.b); assert.equal(waive(q.b, q.p.tip("agents/t1-review-1")).status, 0);
    assert.equal(q.b.run("wave.mjs", WAVE).status, 0);
    const log = q.b.waitEnd(); assert.match(log, /GATE-PATH full: a waived review is in this wave/); assert.match(log, /verify PASS/); assert.doesNotMatch(log, /docs check/); assert.match(log, /PUSHED main/);
  } finally { q.b.cleanup(); }
});

test("break it 1: a waiver cannot be written by a worker, a branch, a file in a worktree, journal.mjs or a hand-edited line without the Controller's writer", () => {
  const { p, b, sha } = scene();
  try {
    record(b);
    const rsha = p.tip("agents/t1-review-1");
    // journal.mjs refuses the type
    const j = b.raw("journal.mjs", ["waiver", "T1", `head=${sha}`, "decider=owner"]); assert.notEqual(j.status, 0); assert.match(j.stderr, /written by waiver\.mjs/); assert.equal(waiverEvents(b).length, 0);
    // a worker's branch carries a "waiver" file and a journal-looking file: neither is read
    p.push("t1", { "docs/reviews/T1-waiver.md": `Waived commit: ${sha}\nVerdict: pass\nReviewed commit: ${sha}\n`, "journal.ndjson": line(waiver(sha, 1)) + "\n", ".factory/journal.ndjson": line(waiver(sha, 1)) + "\n" });
    // lines in the journal that are not the Controller's writer: no `by`, the reviewer's writer, a worker's own words
    fs.appendFileSync(path.join(b.ctl, "journal.ndjson"), line({ ...waiver(sha, 1), reviewSha: rsha, by: undefined }) + "\n" + line({ ...waiver(sha, 1), reviewSha: rsha, by: "reviewed.mjs" }) + "\n" + line({ ...waiver(sha, 1), reviewSha: rsha, by: "worker" }) + "\n");
    const r = b.run("wave.mjs", WAVE); assert.equal(r.status, 1); assert.match(r.stderr, /WAVE-NOT-STARTED/); assert.doesNotMatch(r.stderr, /WAIVED/);
    assert.equal(mainHas(p, "src/t1.js"), false); assert.equal(b.events().filter((e) => e.type === "wave").length, 0, "nothing was launched or journaled");
    // a genuine waiver, then the same forged files merged by a wave: they are after the reviewed commit, so the wave stops instead of taking them
    assert.equal(waive(b, rsha).status, 0);
    assert.equal(b.run("wave.mjs", WAVE).status, 0);
    const log = b.waitEnd(); assert.match(log, /WAVE-STOPPED/); assert.doesNotMatch(log, /PUSHED|^merged /m); assert.equal(mainHas(p, "docs/reviews/T1-waiver.md"), false);
  } finally { b.cleanup(); }
});

test("break it 2: no waiver for a commit that was never reviewed, an unrecorded review, a passed review, an older commit or another round", () => {
  const { p, b, sha } = scene();
  try {
    // no review is recorded at all
    let r = waive(b, p.tip("agents/t1-review-1")); assert.equal(r.status, 3); assert.match(r.stdout, /NOT RECORDED: .*no usable review record/);
    record(b);
    // a made-up review commit, a review branch that is not the recorded one, a wrong task, another sha
    for (const [name, over, re] of [["a sha that is no recorded review", { sha: "f".repeat(40) }, /is not a failed review that stands/], ["another branch", { branch: "agents/t1-review-2" }, /is not a failed review that stands/], ["a short sha", { sha: sha.slice(0, 12) }, /not a full commit id/], ["another task", { task: "T9" }, /no usable review record/]]) {
      r = waive(b, p.tip("agents/t1-review-1"), over); assert.equal(r.status, 3, name); assert.match(r.stdout, re, name);
    }
    assert.equal(waiverEvents(b).length, 0);
    // a review branch that moved after the review was recorded
    p.git("checkout", "-q", "agents/t1-review-1"); p.write("docs/reviews/T1-note.md", "n\n"); p.commit("moved"); p.git("push", "-q", "origin", "agents/t1-review-1"); p.git("checkout", "-q", "main");
    r = waive(b, record_sha(b)); assert.equal(r.status, 3); assert.match(r.stdout, /was pushed to after the review was recorded/);
    // a review that passed has nothing to waive
    const q = scene({ text: (s) => FILE(s, { verdict: "pass", findings: [] }).replace("## Findings\n", "## Findings\nNone.\n") });
    try { record(q.b); r = waive(q.b, q.p.tip("agents/t1-review-1")); assert.equal(r.status, 3); assert.match(r.stdout, /did not fail: there is nothing to waive/); } finally { q.b.cleanup(); }
  } finally { b.cleanup(); }
});
const record_sha = (b) => b.events().find((e) => e.type === "review").reviewSha;

test("break it 3: a waiver is for one commit; the branch moving past it stops the wave, and a new review is a new decision", () => {
  const { p, b, sha } = scene();
  try {
    record(b); assert.equal(waive(b, p.tip("agents/t1-review-1")).status, 0);
    const moved = p.push("t1", { "src/t1.js": "export const t1 = 666;\n" });
    assert.equal(b.run("wave.mjs", WAVE).status, 0);
    const log = b.waitEnd(); assert.match(log, /WAVE-STOPPED/); assert.match(log, new RegExp(`reviewed ${sha}, but origin has ${moved}`)); assert.doesNotMatch(log, /PUSHED|^merged /m);
    assert.equal(mainHas(p, "src/t1.js"), false);
    // the rework gets round 2, which fails too: the waiver of round 1 is about another commit and another review
    p.review("t1", moved, FILE(moved).replace("round 1", "round 2"), { round: 2 });
    assert.equal(record(b, 2).status, 0);
    const r = b.run("wave.mjs", ["Title", "Summary", "origin/agents/t1", "origin/agents/t1-review-2"]); assert.equal(r.status, 1); assert.match(r.stderr, /WAVE-NOT-STARTED/);
    const again = waive(b, p.tip("agents/t1-review-2"), { branch: "agents/t1-review-2", decider: "owner", words: "the owner takes the last round" }); assert.equal(again.status, 0, again.stdout); assert.equal(waiverEvents(b).length, 2);
  } finally { b.cleanup(); }
});

test("break it 4: a waiver names its findings: none, a wildcard, an unknown id or a missing blocker or major is refused; an unclassed review is not waivable at all", () => {
  const two = (s) => FILE(s, { findings: [["F1", "blocker", "process"], ["F2", "major", "style"], ["F3", "minor", "style"]] });
  const { p, b } = scene({ text: two });
  try {
    record(b); const rsha = p.tip("agents/t1-review-1");
    for (const [name, findings, re] of [["none", " ", /--findings is required/], ["a wildcard", "all", /no such finding in the file: all/], ["a star", "*", /no such finding/], ["an unknown id", "F1,F7", /no such finding in the file: F7/], ["only the first blocker", "F1", /F2 \[major\] is not named/], ["a repeated id", "F1,F1,F2", /named twice/]]) {
      const r = waive(b, rsha, { findings }); assert.equal(r.status, 3, name); assert.match(r.stdout, re, name);
    }
    assert.equal(waiverEvents(b).length, 0);
    assert.equal(waive(b, rsha, { findings: "F1,F2" }).status, 0, "every blocker and major named: the minor one need not be");
  } finally { b.cleanup(); }
  // a review written before the classes: recorded as before, never waivable, with the way out
  const old = scene({ text: (s) => `# T1 review, round 1\n\nVerdict: fail\nReviewed commit: ${s}\nGates: verify pass, e2e none\n\n## Findings\n### [blocker] The approval came after the build\n- Where: x\n` });
  try {
    const r = record(old.b); assert.equal(r.status, 0); assert.match(r.stdout, /waiver: not waivable: line \d+ looks like a finding but is not a finding heading[\s\S]*A new review with the current template is needed/);
    const w = waive(old.b, old.p.tip("agents/t1-review-1")); assert.equal(w.status, 3); assert.match(w.stdout, /not in the classed format[\s\S]*A new review with the current template is needed \(a new Tester round, mkspec test; after the round limit the re-evaluation, mkspec reeval\)/);
  } finally { old.b.cleanup(); }
});

test("break it 5: security, data corruption, loss of input and a gate finding, and a red gate, are refused by the code; a relabelled review is another commit of the review branch and stops the wave", () => {
  for (const cls of NEVER_WAIVABLE) {
    const s = scene({ text: (sha) => FILE(sha, { findings: [["F1", "blocker", "process"], ["F2", "major", cls]] }) });
    try { record(s.b); const r = waive(s.b, s.p.tip("agents/t1-review-1"), { findings: "F1,F2" }); assert.equal(r.status, 3, cls); assert.match(r.stdout, new RegExp(`F2 \\(${cls}\\) can never be waived`)); assert.equal(waiverEvents(s.b).length, 0); } finally { s.b.cleanup(); }
  }
  const red = scene({ text: (sha) => FILE(sha, { gates: "Gates: verify fail, e2e none" }) });
  try { record(red.b); const r = waive(red.b, red.p.tip("agents/t1-review-1")); assert.equal(r.status, 3); assert.match(r.stdout, /red gate is never waived/); } finally { red.b.cleanup(); }
  // the Tester's file says "style"; the file on the review branch is then rewritten to say "security" (or the reverse): a different commit
  const { p, b, sha } = scene({ text: (s) => FILE(s, { findings: [["F1", "blocker", "style"]] }) });
  try {
    record(b); assert.equal(waive(b, p.tip("agents/t1-review-1")).status, 0);
    p.review("t1", sha, FILE(sha, { findings: [["F1", "blocker", "security"]] }));   // same name, same reviewed commit, new commit
    assert.equal(b.run("wave.mjs", WAVE).status, 0);
    const log = b.waitEnd(); assert.match(log, /WAVE-STOPPED/); assert.match(log, /reviewed\.mjs read [0-9a-f]{40}, but origin has [0-9a-f]{40}: the review branch was pushed to after the Controller read it/); assert.doesNotMatch(log, /PUSHED/);
    assert.equal(waive(b, p.tip("agents/t1-review-1"), { words: "a second waiver for the relabelled file" }).status, 3, "and it is not recorded for the new commit of the branch either");
  } finally { b.cleanup(); }
});

test("break it 6: who may decide: level 3, or a level that cannot be established, only the owner; the level is the one on main, never the task branch's", () => {
  // level 3 on main: the Front agent is refused, the owner is recorded with the words
  const l3 = scene({ level: 3 });
  try {
    record(l3.b); const rsha = l3.p.tip("agents/t1-review-1");
    const front = waive(l3.b, rsha); assert.equal(front.status, 3); assert.match(front.stdout, /its level is 3[\s\S]*Only the owner decides/); assert.equal(waiverEvents(l3.b).length, 0);
    const owner = waive(l3.b, rsha, { decider: "owner", words: "I, the owner, accept this and want a follow-up" }); assert.equal(owner.status, 0, owner.stdout); assert.deepEqual([waiverEvents(l3.b)[0].decider, waiverEvents(l3.b)[0].level, waiverEvents(l3.b)[0].words], ["owner", 3, "I, the owner, accept this and want a follow-up"]);
  } finally { l3.b.cleanup(); }
  // the Controller is not a decider, and "words" are required
  const c = scene();
  try {
    record(c.b); const rsha = c.p.tip("agents/t1-review-1");
    assert.match(waive(c.b, rsha, { decider: "controller" }).stdout, /front-agent or owner\. The Controller does not decide a waiver/);
    assert.match(waive(c.b, rsha, { words: "ok" }).stdout, /fewer than three words is no decision/);
    assert.match(waive(c.b, rsha, { words: undefined }).stdout, /--words is required/);
    assert.match(waive(c.b, rsha, { followUp: "T1" }).stdout, /not the task that is waived/);
    assert.match(waive(c.b, rsha, { followUp: "T99" }).stdout, /is not a ticket file in docs\/tasks\/ .*or a debt entry/);
    assert.equal(waiverEvents(c.b).length, 0);
  } finally { c.b.cleanup(); }
  // the ticket says level 3 on main, the task branch lowers it to 1: main counts
  const low = scene({ level: 3 });
  try {
    low.p.push("t1", { "docs/tasks/T1-x.md": "# T1: x\n\nStatus: building\nLevel: 1\n" });
    record(low.b); // the branch moved after the review, but the level question is separate: ask it on the recorded commit
    const r = waive(low.b, low.p.tip("agents/t1-review-1")); assert.equal(r.status, 3); assert.match(r.stdout, /its level is 3/);
  } finally { low.b.cleanup(); }
  // main raises the level after the work started (level 1 at the base, 3 now): the higher counts; no ticket on main, or an unfilled one: unknown, owner only
  const raised = scene();
  try { raised.p.onMain({ "docs/tasks/T1-x.md": "# T1: x\n\nStatus: building\nLevel: 3\n" }); record(raised.b); assert.match(waive(raised.b, raised.p.tip("agents/t1-review-1")).stdout, /its level is 3/); } finally { raised.b.cleanup(); }
  for (const [name, ticket] of [["an unfilled template", "# T1\n\nLevel: 1 | 2 | 3\n"], ["no level at all", "# T1\n\nStatus: building\n"]]) {
    const u = scene({ ticket });
    try { record(u.b); const r = waive(u.b, u.p.tip("agents/t1-review-1")); assert.equal(r.status, 3, name); assert.match(r.stdout, /its level cannot be read from the ticket on the main branch[\s\S]*Only the owner/, name); assert.equal(waive(u.b, u.p.tip("agents/t1-review-1"), { decider: "owner", words: "the owner decides this one" }).status, 0, `${name}: the owner may`); } finally { u.b.cleanup(); }
  }
});

test("break it 7: the round limit and the final re-evaluation: only the owner's waiver of round 2 starts the wave, a re-evaluation that fails afterwards needs its own (the owner's), one that passes needs none", () => {
  const { p, b, sha } = scene();
  try {
    record(b); assert.equal(waive(b, p.tip("agents/t1-review-1")).status, 0);   // round 1 failed on `sha`, waived
    const c2 = p.push("t1", { "src/t1.js": "export const t1 = 2;\n" }, "rework");
    p.review("t1", c2, FILE(c2).replace("round 1", "round 2"), { round: 2 }); assert.equal(record(b, 2).status, 0);   // round 2 fails: the limit (2) is reached
    // the old waiver does not cover round 2; a new one does; the wave would start for c2
    assert.equal(b.run("wave.mjs", ["Title", "Summary", "origin/agents/t1", "origin/agents/t1-review-2"]).status, 1);
    // finding 1: the last Tester round is the owner's. The Front agent cannot replace the re-evaluation by a waiver; the owner can.
    const front2 = waive(b, p.tip("agents/t1-review-2"), { branch: "agents/t1-review-2" }); assert.equal(front2.status, 3); assert.match(front2.stdout, /2 Tester round\(s\) of T1 failed and the limit is 2: this is the last round[\s\S]*Only the owner decides/);
    assert.equal(b.run("wave.mjs", ["Title", "Summary", "origin/agents/t1", "origin/agents/t1-review-2"]).status, 1, "still no wave");
    assert.equal(waive(b, p.tip("agents/t1-review-2"), { branch: "agents/t1-review-2", decider: "owner", words: "I, the owner, accept the last round as it is" }).status, 0);
    // the re-evaluation of c2 fails: a failed review of the same commit that the waiver of round 2 does not name
    p.review("t1", c2, FILE(c2, { gates: "" }).replace("round 1", "final"), { name: "t1-review-final", file: "docs/reviews/T1-review-final.md" });
    const rf = record(b, "final"); assert.equal(rf.status, 0, rf.stdout + rf.stderr);
    const blocked = b.run("wave.mjs", ["Title", "Summary", "origin/agents/t1", "origin/agents/t1-review-2", "origin/agents/t1-review-final"]); assert.equal(blocked.status, 1); assert.match(blocked.stderr, /WAVE-NOT-STARTED[\s\S]*1 of the 2 failed reviews standing/);
    // and with its own waiver the wave starts for c2 with both failed findings files
    const byFront = waive(b, p.tip("agents/t1-review-final"), { branch: "agents/t1-review-final" }); assert.equal(byFront.status, 3); assert.match(byFront.stdout, /final functional re-evaluation: its failure is the owner's decision, at every level/);
    assert.equal(waive(b, p.tip("agents/t1-review-final"), { branch: "agents/t1-review-final", decider: "owner", words: "I, the owner, accept this failed re-evaluation" }).status, 0);
    const go = b.run("wave.mjs", ["Title", "Summary", "origin/agents/t1", "origin/agents/t1-review-2", "origin/agents/t1-review-final"]); assert.equal(go.status, 0, go.stdout + go.stderr);
    const log = b.waitEnd(); assert.match(log, new RegExp(`merged origin/agents/t1 at ${c2}`)); assert.match(log, /PUSHED main/);
    assert.notEqual(sha, c2);
  } finally { b.cleanup(); }
});

test("github-issues: the level is the Controller's own record of THIS task: the issue mkspec bound to it and that issue's first claim; a caller's --ref is refused, no or an ambiguous binding means the owner only", () => {
  const { p, b } = scene({ extra: { steering: { mode: "github-issues" } } });
  try {
    record(b); const rsha = p.tip("agents/t1-review-1"), journalFile = path.join(b.ctl, "journal.ndjson");
    const records = (refs, ...c) => { const rest = b.events().filter((e) => e.type !== "claim" && e.type !== "taskref"); fs.writeFileSync(journalFile, [...refs.map((r) => ({ type: "taskref", task: "T1", ref: r, by: "mkspec.mjs" })), ...c.map((x) => ({ type: "claim", documentation: false, ...x })), ...rest].map((e) => JSON.stringify(e)).join("\n") + "\n"); };
    const over = { followUp: "#9" };
    // attack A3: the caller used to pick the claim by --ref; it is not an option any more, whatever it says
    for (const ref of ["#5", "#7"]) { const r = waive(b, rsha, { ...over, ref }); assert.equal(r.status, 3); assert.match(r.stdout, /--ref is not an option of waiver\.mjs|--ref is gone/, ref); }
    records([], { task: "5", level: 1 }, { task: "7", level: 3 });
    assert.match(waive(b, rsha, over).stdout, /its level cannot be read[\s\S]*Only the owner/i, "claims exist, but nothing binds T1 to an issue: the Front agent is refused whatever the claims say");
    records(["#7"], { task: "5", level: 1 }, { task: "7", level: 3 });
    assert.match(waive(b, rsha, over).stdout, /its level is 3/, "T1 is issue 7: its level 3 counts, even with a level 1 claim of another issue (#5) in the journal");
    records(["#5"], { task: "5", level: 1 }, { task: "7", level: 3 });
    assert.match(waive(b, rsha, { ...over, followUp: "#5" }).stdout, /not the task that is waived/, "the follow-up is not the task's own issue (the mapped one, not a typed one)");
    records(["#5", "#7"], { task: "5", level: 1 }, { task: "7", level: 3 });
    assert.match(waive(b, rsha, over).stdout, /its level cannot be read/, "two issues bound to one task id: ambiguous, owner only");
    records(["#12"]); assert.match(waive(b, rsha, over).stdout, /its level cannot be read/, "bound, but no claim record");
    records(["#12"], { task: "12" }); assert.match(waive(b, rsha, over).stdout, /its level cannot be read/, "a claim from before the level was recorded");
    records(["#12"], { task: "12", level: 3 }, { task: "12", level: 1 }); assert.match(waive(b, rsha, over).stdout, /its level is 3/, "the first claim record wins: the issue edited later does not lower it");
    records(["#12"], { task: "12", level: 2 }); assert.match(waive(b, rsha, { ...over, followUp: "T7" }).stdout, /is not a ticket file in docs\/tasks\/ .*or a debt entry in docs\/debt\.md on origin\/main.*nor an issue as #<n>/, "a follow-up that exists nowhere");
    assert.equal(waiverEvents(b).length, 0);
    const ok = waive(b, rsha, over); assert.equal(ok.status, 0, ok.stdout); assert.deepEqual([waiverEvents(b)[0].level, waiverEvents(b)[0].decider, waiverEvents(b)[0].followUp], [2, "front-agent", "#9"]);
  } finally { b.cleanup(); }
});

test("github-issues: mkspec binds the task id to its issue in the Controller's journal (first record, no duplicates), a second issue for the same id makes it ambiguous", () => {
  const { b } = scene({ extra: { steering: { mode: "github-issues" } } });
  try {
    const dev = (ref) => { const r = b.raw("templates/mkspec.mjs", ["dev", "T1", ref, "agents/t1"]); assert.equal(r.status, 0, r.stdout + r.stderr); };
    dev("#12"); dev("#12"); const refs = () => b.events().filter((e) => e.type === "taskref");
    assert.deepEqual(refs().map((e) => [e.task, e.ref, e.by]), [["T1", "#12", "mkspec.mjs"]], "one record, however often a spec is made");
    dev("#13"); assert.deepEqual(refs().map((e) => e.ref), ["#12", "#13"], "a different issue for the same task is recorded too");
    assert.deepEqual([...recordedIssues(fs.readFileSync(path.join(b.ctl, "journal.ndjson"), "utf8"), "t1")].sort(), ["12", "13"], "and the reader sees two: ambiguous");
    assert.equal(recordedIssues(fs.readFileSync(path.join(b.ctl, "journal.ndjson"), "utf8"), "T2").size, 0);
    // a line that is not mkspec's, or has no issue reference, binds nothing
    assert.equal(recordedIssues(J({ type: "taskref", task: "T1", ref: "#4", by: "worker" }, { type: "taskref", task: "T1", ref: "README" }), "T1").size, 0);
  } finally { b.cleanup(); }
});

test("a waived wave needs the failed review branch with it, and an entry the wave does not merge never reaches the push gate", () => {
  const { p, b } = scene();
  try {
    record(b); assert.equal(waive(b, p.tip("agents/t1-review-1")).status, 0);
    const lone = b.run("wave.mjs", ["Title", "Summary", "origin/agents/t1"]); assert.equal(lone.status, 1); assert.match(lone.stderr, /add origin\/agents\/t1-review-1 to the wave/);
  } finally { b.cleanup(); }
  // integ-wave.sh: a WAVE_WAIVED entry that is not one of its own task and review tokens stops the wave (a stale or made-up value)
  const q = scene();
  try {
    record(q.b); const head = q.sha, rsha = q.p.tip("agents/t1-review-1");
    const integ = path.join(q.p.base, "coordinator-integration"); q.p.git("worktree", "add", "-q", "-B", "integration", integ, "refs/remotes/origin/main");
    const wave = (waived, tokens) => spawnSync("bash", [path.join(ROOT, "controller/integ-wave.sh"), "W", "wave", ...tokens], { cwd: integ, encoding: "utf8", env: { ...CLEAN_ENV, MAIN: "main", INSTALL_CMD: "", VERIFY_CMD: "true", E2E_CMD: "", GATE: path.join(q.b.ctl, "gate"), WAVE_PROJECT: JSON.parse(fs.readFileSync(path.join(q.b.ctl, "factory.config.json"), "utf8")).project.name, TRAILER: "", WAVE_LOG_DIR: path.join(q.p.base, "logs"), WAVE_TASKS: "t1", WAVE_WAIVED: waived } });
    const tokens = [`origin/agents/t1@${head}`, `origin/agents/t1-review-1~${head}:${rsha}=docs/reviews/T1-review-1.md`];
    for (const waived of [`${"c".repeat(40)}=docs/reviews/T1-review-1.md`, `${head}=docs/reviews/T9-review-1.md`, `${head}=src/app.js`, "not-a-waiver"]) {
      const r = wave(waived, tokens); assert.notEqual(r.status, 0, waived); assert.match(r.stdout, /WAVE-STOPPED[\s\S]*waived review|not <40-character commit>/, waived); assert.equal(mainHas(q.p, "src/t1.js"), false);
    }
    // without any waiver and a failed review there is nothing to push: the push gate itself refuses the unreviewed commit
    const bare = wave("", tokens); assert.notEqual(bare.status, 0); assert.match(bare.stdout, /PUSH-FAILED|Commits without a passing independent review/); assert.equal(mainHas(q.p, "src/t1.js"), false);
    const good = wave(`${head}=docs/reviews/T1-review-1.md`, tokens); assert.equal(good.status, 0, good.stdout + good.stderr); assert.match(good.stdout, /PUSHED main/);
  } finally { q.b.cleanup(); }
});

// --- the push gate ---------------------------------------------------------------------------------
test("the pre-push gate: a commit whose only review failed is rejected as before; FACTORY_WAIVED covers exactly the named commit, only with its failed findings file in the pushed tree", () => {
  const p = project();
  const mainSha = p.tip("main");
  p.git("checkout", "-q", "-b", "feat"); p.write("src/app.js", "export const a = 2;\n"); const code = p.commit("code");
  p.write("docs/reviews/T1-review-1.md", FILE(code)); p.commit("review"); const tip = p.git("rev-parse", "HEAD");
  const gate = (env = {}, t = tip) => spawnSync("node", ["tools/factory-guardrails.mjs", "review-gate"], { cwd: p.dir, encoding: "utf8", input: `refs/heads/feat ${t} refs/heads/main ${mainSha}\n`, env: { ...CLEAN_ENV, ...env } });
  const UNCOVERED = /Commits without a passing independent review/;
  const out = (env, t) => { const r = gate(env, t); return `${r.stderr}${r.stdout}`; };
  assert.match(out({}), UNCOVERED, "a failed review covers nothing: unchanged");
  assert.match(out({ FACTORY_WAIVED: "" }), UNCOVERED);
  assert.equal(gate({ FACTORY_WAIVED: `${code}=docs/reviews/T1-review-1.md` }).status, 0, "the waived commit with its failed findings file in the tree");
  for (const [name, waived] of [["another commit", `${mainSha}=docs/reviews/T1-review-1.md`], ["a file that is not in the tree", `${code}=docs/reviews/T1-review-9.md`], ["a path outside docs/reviews", `${code}=src/app.js`], ["no file", code], ["a short commit id", `${code.slice(0, 12)}=docs/reviews/T1-review-1.md`]]) {
    assert.match(out({ FACTORY_WAIVED: waived }), UNCOVERED, name);
  }
  // the file has to be a FAILED review of that very commit, said once
  p.write("docs/reviews/T1-review-2.md", FILE(mainSha)); p.write("docs/reviews/T1-review-3.md", FILE(code).replace("Verdict: fail", "Verdict: fail\nVerdict: fail")); p.write("docs/reviews/T1-review-4.md", FILE(code).replace("Verdict: fail", "Verdict: fail\nReviewed commit: ".concat(mainSha))); const tip2 = p.commit("more");
  assert.match(out({ FACTORY_WAIVED: `${code}=docs/reviews/T1-review-2.md` }, tip2), UNCOVERED, "a failed file that names another commit");
  assert.match(out({ FACTORY_WAIVED: `${code}=docs/reviews/T1-review-3.md` }, tip2), UNCOVERED, "a file with two verdict lines");
  assert.match(out({ FACTORY_WAIVED: `${code}=docs/reviews/T1-review-4.md` }, tip2), UNCOVERED, "a file with two reviewed-commit lines");
  // a commit after the waived one is not covered: the waiver is for ancestors of that commit only
  p.write("src/app.js", "export const a = 666;\n"); const later = p.commit("after the review");
  assert.match(out({ FACTORY_WAIVED: `${code}=docs/reviews/T1-review-1.md` }, later), UNCOVERED, "a later commit needs its own review");
});

// --- every review spec demands the class ----------------------------------------------------------------
test("every rendered review spec demands one class per finding from the fixed list; the Tester also states its gates", () => {
  const { b } = scene();
  try {
    const spec = (args) => { const r = b.raw("templates/mkspec.mjs", args); assert.equal(r.status, 0, r.stdout + r.stderr); return fs.readFileSync(r.stdout.trim().split("\n").at(-1), "utf8"); };
    const sha = "d".repeat(40);
    const specs = {
      "Tester round 1": spec(["test", "T1", "docs/tasks/T1-x.md", "agents/t1", sha]),
      "Tester round 2": spec(["test", "T1", "docs/tasks/T1-x.md", "agents/t1", sha, "--round", "2"]),
      "final re-evaluation": spec(["reeval", "T1", "docs/tasks/T1-x.md", "agents/t1", sha, "agents/t1-review-2:docs/reviews/T1-review-2.md"]),
      "architecture spec review": spec(["specreview", "T1", "docs/tasks/T1-x.md", "agents/t1"]),
      "architecture conformance review": spec(["conf", "T1", "docs/tasks/T1-x.md", "agents/t1", sha, "agents/t1-specreview:docs/reviews/T1-architecture-spec.md"]),
    };
    for (const [name, text] of Object.entries(specs)) {
      assert.match(text, /### F<n> \[blocker\|major\|minor\] \[<class>\] <title>/, name);
      for (const cls of CLASSES) assert.ok(text.includes(cls), `${name} names the class ${cls}`);
      assert.ok(text.includes(`${NEVER_WAIVABLE.join(", ")} (never waivable`), `${name}: the never-waivable list is findings.mjs's`); assert.ok(text.includes(`${WAIVABLE.join(", ")} (a decided non-blocker`), `${name}: the waivable list is findings.mjs's`);
      assert.match(text, /A finding without a class, or in another form, can never be waived/, name);
      assert.match(text, /The class is YOUR claim and no code checks it/, name);
    }
    assert.match(specs["Tester round 1"], /'Gates: verify pass\|fail, e2e pass\|fail\|none'/);
    assert.match(fs.readFileSync(path.join(ROOT, "templates/docs/review-protocol.md"), "utf8"), /### F<n> \[blocker\|major\|minor\] \[<class>\] <short title>/, "the findings file format of the protocol");
    assert.match(fs.readFileSync(path.join(ROOT, "templates/docs/review-protocol.md"), "utf8"), /`security`, `data-corruption`, `input-loss`, `gate`/);
    // and what a spec asks for is what the parser accepts
    assert.equal(parseFindings(FILE(sha, { findings: [["F1", "blocker", "functional"]] })).ok, true);
  } finally { b.cleanup(); }
});

// --- status ---------------------------------------------------------------------------------------
test("status --json and the human status list the waivers of the Controller's journal: count, task, commit, who, follow-up; foreign lines are not counted", () => {
  const base = fs.realpathSync(tempDir("af-wvstatus-")), home = path.join(base, "home"), dir = path.join(base, "p");
  fs.mkdirSync(home); fs.mkdirSync(dir);
  const env = { ...CLEAN_ENV, HOME: home, FACTORY_SKIP_ORCA: "1", GIT_CONFIG_NOSYSTEM: "1" };
  const g = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8", env });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@example.invalid"); g("config", "user.name", "T");
  fs.writeFileSync(path.join(dir, "README.md"), "x\n"); g("add", "."); g("commit", "-qm", "init");
  const answers = path.join(base, "answers.json"); fs.writeFileSync(answers, JSON.stringify({ "project.name": "wvst", "project.humanName": "Hu", "agents.default": "claude", "skills.installNow": "no", "rules.confirm": "yes" }));
  const cli = (...a) => spawnSync("node", [path.join(ROOT, "bin/agentic-factory.mjs"), ...a], { cwd: dir, encoding: "utf8", env });
  assert.equal(cli("init", "--answers", answers, "--experimental-terminal-runner").status, 0);
  const none = JSON.parse(cli("status", "--json").stdout); assert.deepEqual(none.work.waivers, { count: 0, list: [] });
  fs.mkdirSync(path.join(home, "controller"), { recursive: true });
  fs.writeFileSync(path.join(home, "controller/journal.ndjson"), J(waiver(A, 1, { task: "T7", followUp: "T9" }), waiver(B, 2, { by: "reviewed.mjs" }), { type: "done", task: "T7" }) + "{\"type\":\"waiver\" torn\n");
  const s = JSON.parse(cli("status", "--json").stdout);
  assert.equal(s.work.waivers.count, 1); assert.deepEqual([s.work.waivers.list[0].task, s.work.waivers.list[0].commit, s.work.waivers.list[0].decider, s.work.waivers.list[0].followUp], ["T7", A, "front-agent", "T9"]);
  assert.match(cli("status").stdout, /Waivers \(a failed review decided to hold no blocker, 1\):\n\s+T7 aaaaaaaaaa by the front-agent, follow-up T9/);
});

// --- PR #76 review: what the independent reviewer found, and now refused ----------------------------------------------------------------
const FUNC = (sha, title = "The specified CSV export drops every second row") => FILE(sha, { findings: [["F1", "blocker", "functional", title]] });

test("review finding 1: the Front agent waives only process and style; a functional finding is the owner's, however the Tester worded it; the set is one constant", () => {
  assert.deepEqual(FRONT_AGENT_WAIVABLE, ["process", "style"]); assert.ok(FRONT_AGENT_WAIVABLE.every((c) => WAIVABLE.includes(c)), "a subset of what the owner may waive");
  // attack A4: a functional blocker, level 2, the Front agent: refused. (It pushed to main before.)
  const s = scene({ level: 2, text: FUNC });
  try {
    record(s.b); const rsha = s.p.tip("agents/t1-review-1");
    const r = waive(s.b, rsha); assert.equal(r.status, 3); assert.match(r.stdout, /F1 \(functional\): the Front agent may waive only findings classed process or style[\s\S]*the owner's decision/); assert.equal(waiverEvents(s.b).length, 0);
    assert.equal(s.b.run("wave.mjs", WAVE).status, 1, "and no wave starts");
    // the owner may, with their words: that is the changed happy path of a functional finding, through the wave to main
    const o = waive(s.b, rsha, { decider: "owner", words: "I, the owner, decided this is a follow-up" }); assert.equal(o.status, 0, o.stdout); assert.equal(waiverEvents(s.b)[0].decider, "owner");
    assert.equal(s.b.run("wave.mjs", WAVE).status, 0); const log = s.b.waitEnd(); assert.match(log, /PUSHED main/);
  } finally { s.b.cleanup(); }
  // attack A4b: a security hole the Tester labelled functional: refused for the Front agent as well (the class is a claim; a functional one is the owner's)
  const m = scene({ text: (sha) => FUNC(sha, "SQL injection in the login query") });
  try { record(m.b); const r = waive(m.b, m.p.tip("agents/t1-review-1")); assert.equal(r.status, 3); assert.match(r.stdout, /Front agent may waive only/); } finally { m.b.cleanup(); }
  // style and process stay the Front agent's (the PR's own case), also named together with a minor functional finding
  const st = scene({ text: (sha) => FILE(sha, { findings: [["F1", "blocker", "style"], ["F2", "minor", "functional"]] }) });
  try {
    record(st.b); const rs = st.p.tip("agents/t1-review-1");
    // round 2 of the review: the Front agent may waive only a review whose findings are ALL process or style, named or not (an unnamed minor functional one too); the owner still may
    for (const findings of ["F1", "F1,F2"]) { const r = waive(st.b, rs, { findings }); assert.equal(r.status, 3, findings); assert.match(r.stdout, /F2 \(functional\)[\s\S]*named or not/); }
    assert.equal(waiverEvents(st.b).length, 0); assert.equal(waive(st.b, rs, { findings: "F1", decider: "owner", words: "the owner takes the minor one too" }).status, 0);
  } finally { st.b.cleanup(); }
  // a re-evaluation file with the classification table of the earlier findings: references to F1 are no finding and the file stays readable (and waivable by the owner)
  const reeval = FILE(A, { gates: "", body: `${heading("F1", "blocker", "functional", "The export drops rows")}\n| Earlier finding | Class |\n|---|---|\n| F1 | functional defect |\n| F2 | debt candidate |\nF2 - round 1 said this is debt\n` });
  assert.equal(parseFindings(reeval).ok, true, "a table row or line that only names F1 or F2 is not a finding");
  assert.equal(waivable(parseFindings(reeval), ["F1"], "final").ok, true);
  const named = scene({ text: (sha) => FILE(sha, { findings: [["F1", "blocker", "style"], ["F2", "minor", "functional"]] }) });
  try { record(named.b); const r = waive(named.b, named.p.tip("agents/t1-review-1"), { findings: "F1,F2" }); assert.equal(r.status, 3, "naming a functional finding is the owner's, even a minor one"); assert.match(r.stdout, /F2 \(functional\)/); } finally { named.b.cleanup(); }
});

test("review finding 1: the round limit comes from the journal's failed rounds, not a branch name; an unreadable limit is the owner's; a failed conformance review after the limit too", () => {
  const { p, b } = scene({ extra: { reviews: { maxRounds: "two rounds" } } });
  try {
    record(b); const r = waive(b, p.tip("agents/t1-review-1")); assert.equal(r.status, 3); assert.match(r.stdout, /reviews\.maxRounds \("two rounds"\) cannot be read[\s\S]*Only the owner/);
    assert.equal(waive(b, p.tip("agents/t1-review-1"), { decider: "owner", words: "the owner decides this one" }).status, 0);
  } finally { b.cleanup(); }
  // one failed Tester round of a limit of 1: this IS the last round, so the Front agent cannot waive it (a limit of 2 above could)
  const one = scene({ extra: { reviews: { maxRounds: 1 } } });
  try { record(one.b); const r = waive(one.b, one.p.tip("agents/t1-review-1")); assert.equal(r.status, 3); assert.match(r.stdout, /1 Tester round\(s\) of T1 failed and the limit is 1/); } finally { one.b.cleanup(); }
  // a failed conformance review of a task whose Tester rounds hit the limit: after the limit, the owner's too
  const c = scene(); 
  try {
    record(c.b); const c2 = c.p.push("t1", { "src/t1.js": "export const t1 = 2;\n" }, "rework");
    c.p.review("t1", c2, FILE(c2).replace("round 1", "round 2"), { round: 2 }); record(c.b, 2);
    c.p.review("t1", c2, FILE(c2, { gates: "" }), { name: "t1-conformance", file: "docs/reviews/T1-architecture-conformance.md" }); assert.equal(c.b.run("reviewed.mjs", ["T1", "agents/t1-conformance"]).status, 0);
    const r = waive(c.b, c.p.tip("agents/t1-conformance"), { branch: "agents/t1-conformance" }); assert.equal(r.status, 3); assert.match(r.stdout, /2 Tester round\(s\) of T1 failed and the limit is 2/);
  } finally { c.b.cleanup(); }
});

test("review finding 2: any line in ## Findings that looks like a blocker or major finding but is no finding heading makes the file unreadable (bold, list, number, deeper heading, id-only, table, any case)", () => {
  const bad = {
    "bold": "**F2 [blocker] [security] token written to the log**\n",
    "a deeper heading": "##### F3 [blocker] [data-corruption] rows overwritten\n",
    "a list item": "- F4 [major] [security] secret in the response\n",
    "a numbered item": "1. [blocker] the export is wrong\n",
    "upper case": "F5 [MAJOR] [gate] the gate is red\n",
    "a table row": "| F7 | [blocker] | security |\n",
    "a blocker named in a body line": "- Problem: this is a [blocker] for the release\n",
  };
  for (const [name, extra] of Object.entries(bad)) {
    const text = FILE(A, { body: `${heading("F1", "blocker", "process")}\n${extra}` });   // attack A4d: F1 is process, the rest hides in the prose
    const p = parseFindings(text); assert.equal(p.ok, false, name); assert.match(p.why, /looks like a finding but is not a finding heading|not a finding heading/, name);
    assert.match(waivable(p, ["F1"], "tester").why, /not in the classed format/, name);
  }
  // a deeper heading outside the section is refused too, and an honest file with prose in its bodies is still read
  assert.equal(parseFindings(FILE(A).replace("## Debt candidates", "##### F9 [blocker] [security] hidden\n\n## Debt candidates")).ok, false, "a ##### finding heading after the section");
  const honest = parseFindings(FILE(A, { findings: [["F1", "blocker", "process", "A missing proof"], ["F2", "minor", "style"]] })); assert.equal(honest.ok, true); assert.equal(honest.findings.length, 2);
  // through the whole path: the review is recorded as before, and the waiver refuses it with the reason
  const s = scene({ text: (sha) => FILE(sha, { findings: [["F1", "blocker", "process"]] }).replace("## Debt candidates\n", "## Debt candidates\n**F2 [blocker] [security] token written to the log**\n") });
  try { record(s.b); assert.equal(waive(s.b, s.p.tip("agents/t1-review-1")).status, 0, "outside the section it is another section's text (the decision names the Findings section only)"); } finally { s.b.cleanup(); }
  const t = scene({ text: (sha) => FILE(sha, { findings: [["F1", "blocker", "process"]] }).replace("## Debt candidates", "**F2 [blocker] [security] token written to the log**\n\n## Debt candidates").replace("## Findings\n", "## Findings\n**F2 [blocker] [security] token written to the log**\n") });
  try { record(t.b); const r = waive(t.b, t.p.tip("agents/t1-review-1")); assert.equal(r.status, 3); assert.match(r.stdout, /looks like a finding but is not a finding heading/); assert.equal(waiverEvents(t.b).length, 0); assert.equal(waive(t.b, t.p.tip("agents/t1-review-1"), { decider: "owner", words: "the owner decides this" }).status, 3, "not even the owner: an unreadable file is not waivable"); } finally { t.b.cleanup(); }
});

test("review finding 3: with GitHub issues a typed --ref is refused as an option, whatever the claims say (see the github-issues tests above for the binding)", () => {
  const { p, b } = scene({ extra: { steering: { mode: "github-issues" } } });
  try {
    record(b); const rsha = p.tip("agents/t1-review-1");
    const r = b.raw("waiver.mjs", ["T1", "agents/t1-review-1", rsha, "--findings", "F1", "--decider", "front-agent", "--words", "this is a follow-up", "--reason", "r", "--follow-up", "#9", "--ref", "#5"]);
    assert.equal(r.status, 3); assert.match(r.stdout, /--ref: not an option of waiver\.mjs\. --ref is gone/); assert.equal(waiverEvents(b).length, 0);
    const bogus = b.raw("waiver.mjs", ["T1", "agents/t1-review-1", rsha, "--bogus", "x"]); assert.equal(bogus.status, 2, "any other option is the shared argument check's usage error"); assert.match(bogus.stderr, /--bogus/);
  } finally { b.cleanup(); }
});

test("review finding 5: a follow-up is a real ticket or debt id: not the README, a template, a header row, a separator or a placeholder row", () => {
  const debt = "| ID | Category | Where |\n|---|---|---|\n| F1 | x | y |\n| <id> | <category> | placeholder |\n\n| N1 | Category | Where |\n|---|---|---|\n| N2 | x | y |\n";
  const { p, b } = scene({ mainFiles: { "docs/tasks/README.md": "# tasks\n", "docs/tasks/T00-template.md": "# T00\n", "docs/tasks/0000-template.md": "# t\n", "docs/debt.md": debt } });
  try {
    record(b); const rsha = p.tip("agents/t1-review-1");
    for (const id of ["README", "readme", "ID", "---", "|---|", "Category", "<id>", "0000-template", "0000", "T00-template", "T00", "N1", "T", "x y", "../T2", ""]) {
      const r = waive(b, rsha, { followUp: id }); assert.equal(r.status, 3, `follow-up ${JSON.stringify(id)}`); assert.equal(waiverEvents(b).length, 0, id);
    }
    assert.match(waive(b, rsha, { followUp: "README" }).stdout, /not the README or the template/);
    assert.equal(waive(b, rsha, { followUp: "F1" }).status, 0, "a real debt id");
    assert.equal(waiverEvents(b)[0].followUp, "F1");
  } finally { b.cleanup(); }
  { const q = scene({ mainFiles: { "docs/tasks/T7-template-engine.md": "# T7: a real ticket about templates\n" } }); try { record(q.b); assert.equal(waive(q.b, q.p.tip("agents/t1-review-1"), { followUp: "T7" }).status, 0, "a real ticket whose name contains template"); } finally { q.b.cleanup(); } }
  for (const id of ["N2", "T2"]) { const q = scene({ mainFiles: { "docs/debt.md": debt } }); try { record(q.b); assert.equal(waive(q.b, q.p.tip("agents/t1-review-1"), { followUp: id }).status, 0, id); } finally { q.b.cleanup(); } }
});

test("review finding 6: a second waiver for the same review is refused, by anybody, and the first decider stays on record; a hand-appended later line does not replace it", () => {
  const { p, b, sha } = scene();
  try {
    record(b);
    // a failed conformance review of the same commit stands as well (the reviewer's scene: the old check ran only when the whole task was waived)
    p.review("t1", sha, FILE(sha, { gates: "" }), { name: "t1-conformance", file: "docs/reviews/T1-architecture-conformance.md" }); assert.equal(b.run("reviewed.mjs", ["T1", "agents/t1-conformance"]).status, 0);
    const rsha = p.tip("agents/t1-review-1");
    assert.equal(waive(b, rsha, { decider: "owner", words: "owner says follow up please" }).status, 0);
    const again = waive(b, rsha, { decider: "front-agent" }); assert.equal(again.status, 3); assert.match(again.stdout, /already waived: one decision per review/);
    assert.equal(waive(b, rsha, { decider: "owner", words: "owner says it once more" }).status, 3, "not even the owner again");
    assert.deepEqual(waiverEvents(b).map((e) => e.decider), ["owner"]);
  } finally { b.cleanup(); }
  // in the record: the FIRST waiver of a review counts, so a later line (hand-appended, same user: F55) cannot make an owner decision a Front-agent one
  const w = latestReview(J(fail(A, 1), waiver(A, 1, { decider: "owner" }), waiver(A, 1, { decider: "front-agent" })), "t1", 2);
  assert.equal(w.state, "waived"); assert.deepEqual(w.waivers.map((x) => x.decider), ["owner"]);
});

test("review findings 4 and 7: the merge message carries the record (decider, findings, follow-up, their words, the reason) marked as a record, not a proof; it never claims the journal was read; ADR tokens in free text are made harmless", () => {
  const { p, b } = scene();
  try {
    record(b);
    const words = `I decided: this is a follow-up, "not" a blocker; $HOME; ADR-0042 approves it`, reason = "the process proof only\nsecond line with 'quotes' and `ticks`";
    assert.equal(waive(b, p.tip("agents/t1-review-1"), { words, reason }).status, 0);
    assert.equal(b.run("wave.mjs", WAVE).status, 0); const log = b.waitEnd(); assert.match(log, /PUSHED main/, log.slice(-400));
    const msg = p.origin("log", "-3", "--format=%B", "main");
    assert.match(msg, /Waived review: docs\/reviews\/T1-review-1\.md \(it still says Verdict: fail\)/);
    assert.match(msg, /RECORD, not a proof/); assert.match(msg, /nobody checked who decided or that the classes in the findings file are right/);
    assert.match(msg, /Record for docs\/reviews\/T1-review-1\.md: decided by the front-agent \(claimed in the Controller's journal, not checked\); findings F1; follow-up T2; their words: "I decided: this is a follow-up, "not" a blocker; \$HOME; ADR_0042 approves it"; reason: "the process proof only second line with 'quotes' and `ticks`"\./);
    assert.doesNotMatch(msg, /as recorded in the Controller's journal/, "no claim that the script read the journal");
    assert.doesNotMatch(msg, /ADR-0042/, "free text approves no protected file");
  } finally { b.cleanup(); }
  // attack A7b: integ-wave.sh by hand with WAVE_WAIVED and no journal record at all: not stopped (debt F55), and what it writes is no claim of a record
  const q = scene();
  try {
    record(q.b); const head = q.sha, rsha = q.p.tip("agents/t1-review-1");
    const integ = path.join(q.p.base, "coordinator-integration"); q.p.git("worktree", "add", "-q", "-B", "integration", integ, "refs/remotes/origin/main");
    const r = spawnSync("bash", [path.join(ROOT, "controller/integ-wave.sh"), "W", "wave", `origin/agents/t1@${head}`, `origin/agents/t1-review-1~${head}:${rsha}=docs/reviews/T1-review-1.md`], { cwd: integ, encoding: "utf8", env: { ...CLEAN_ENV, MAIN: "main", INSTALL_CMD: "", VERIFY_CMD: "true", E2E_CMD: "", GATE: path.join(q.b.ctl, "gate"), WAVE_PROJECT: JSON.parse(fs.readFileSync(path.join(q.b.ctl, "factory.config.json"), "utf8")).project.name, TRAILER: "", WAVE_LOG_DIR: path.join(q.p.base, "logs"), WAVE_TASKS: "t1", WAVE_WAIVED: `${head}=docs/reviews/T1-review-1.md`, WAVE_WAIVED_NOTES: `${head}=docs/reviews/T1-review-1.md:${Buffer.from("made by hand, ADR-0007 is mine").toString("base64")}` } });
    assert.match(r.stdout, /PUSHED main/, `the known limit, F55: the script does not read the journal: ${r.stdout}${r.stderr}`);
    const msg = q.p.origin("log", "-3", "--format=%B", "main"); assert.match(msg, /RECORD, not a proof: it is what the caller of this script passed in/); assert.match(msg, /made by hand, ADR_0007 is mine/); assert.doesNotMatch(msg, /as recorded in the Controller's journal|ADR-0007/);
    assert.equal(q.b.events().filter((e) => e.type === "waiver").length, 0, "and there is indeed no waiver in any journal");
  } finally { q.b.cleanup(); }
});

test("review finding 8: the docs say plainly what the code does not check, next to the claims, and no longer contradict themselves", () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
  for (const f of ["controller/CONTROLLER.md", "docs/reviews.md", "templates/docs/review-protocol.md", "docs/workflow.md", "docs/de/workflow.md", "templates/docs/architect-protocol.md"]) {
    const t = read(f); assert.doesNotMatch(t, /either (may|path can) be taken/, `${f}: the sentence that contradicted itself is gone`);
    assert.match(t, /own claim|eigene Behauptung/, `${f}: the class is the reviewer's claim`);
  }
  for (const f of ["controller/CONTROLLER.md", "docs/reviews.md", "templates/docs/review-protocol.md"]) assert.match(read(f), /who (really )?spoke|who decided/, `${f}: the decider is a claim too`);
  assert.match(read("controller/CONTROLLER.md"), /replaces the re-evaluation only because the owner decided it/); assert.match(read("docs/reviews.md"), /replaces the re-evaluation[^.]*only because the owner decided it/);
  assert.match(read("docs/reviews.md"), /FRONT_AGENT_WAIVABLE/); assert.match(read("docs/reviews.md"), /class never changes the verdict/);
  // what fails a review is unchanged: the sentence of workflow.md stays, and the waiver paragraph says the class changes nothing about it
  assert.match(read("docs/workflow.md"), /a review fails only for real functional defects[^.]*\. Missing tests, coverage gaps, edge cases, security, load and style become debt/);
  assert.match(read("docs/workflow.md"), /The class never changes what fails a review/);
  assert.match(read("debt.md"), /F55[^\n]*the class of a finding is the reviewer's own claim[^\n]*WAVE_WAIVED[^\n]*hand-made value[^\n]*--decider owner/);
  assert.doesNotMatch(read("controller/integ-wave.sh"), /nothing from the host's environment counts|as recorded in the Controller's journal/);
});

// --- PR #76 re-check (round 2) ---------------------------------------------------------------------------------------------------------
test("re-check N1: journal.mjs cannot write a record that carries trust, by type or by a type=/by=/task=/ts= key; a forged taskref or claim decides no level", () => {
  const { p, b } = scene({ extra: { steering: { mode: "github-issues" } } });
  try {
    record(b); const rsha = p.tip("agents/t1-review-1"), before = b.events().length;
    const attempts = [
      ["decision", "T1", "type=taskref", "ref=#5", "by=mkspec.mjs"],   // the reviewer's A3d
      ["decision", "5", "type=claim", "level=1"],
      ["decision", "T1", "by=waiver.mjs"], ["decision", "T1", "task=T9"], ["decision", "T1", "ts=2020-01-01T00:00:00Z"],
      ["taskref", "T1", "ref=#5", "by=mkspec.mjs"], ["claim", "5", "level=1"], ["waiver", "T1", "head=x"],
      ["review", "T1", "type=waiver", "by=waiver.mjs"],
    ];
    for (const a of attempts) { const r = b.raw("journal.mjs", a); assert.notEqual(r.status, 0, a.join(" ")); assert.match(r.stderr, /journal\.mjs|cannot be given/, a.join(" ")); }
    assert.equal(b.events().length, before, "nothing was written");
    assert.equal(b.raw("journal.mjs", ["decision", "T1", "note=x"]).status, 0, "an ordinary event still goes through");
    assert.match(waive(b, rsha, { followUp: "#9" }).stdout, /its level cannot be read/, "no binding came out of it: the Front agent is refused");
  } finally { b.cleanup(); }
});

test("re-check N1: a second, different issue for the task id is recorded as a conflict with a warning, and the level is then the owner's", () => {
  const { p, b } = scene({ extra: { steering: { mode: "github-issues" } } });
  try {
    record(b);
    const dev = (ref) => b.raw("templates/mkspec.mjs", ["dev", "T1", ref, "agents/t1"]);
    assert.equal(dev("#5").stderr.includes("WARNING"), false, "the first binding is no conflict");
    const second = dev("#7"); assert.equal(second.status, 0); assert.match(second.stderr, /WARNING: T1 is already bound to #5 and this call names #7[\s\S]*only the owner decides a waiver/);
    fs.appendFileSync(path.join(b.ctl, "journal.ndjson"), [{ type: "claim", task: "5", level: 1 }, { type: "claim", task: "7", level: 1 }].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const rsha = p.tip("agents/t1-review-1"); assert.match(waive(b, rsha, { followUp: "#9" }).stdout, /its level cannot be read/);
    assert.equal(waive(b, rsha, { followUp: "#9", decider: "owner", words: "the owner decides this one" }).status, 0);
  } finally { b.cleanup(); }
});

test("re-check N2: the follow-up is not the waived task's own ticket, whatever form it takes", () => {
  const { p, b } = scene();
  try {
    record(b); const rsha = p.tip("agents/t1-review-1");
    for (const id of ["T1", "t1", "T1-x", "t1-x"]) { const r = waive(b, rsha, { followUp: id }); assert.equal(r.status, 3, id); assert.match(r.stdout, /not the task that is waived|is not a ticket file/, id); }
    assert.equal(waiverEvents(b).length, 0);
    assert.equal(waive(b, rsha, { followUp: "T2-follow" }).status, 0, "another ticket, in its slug form, is fine");
  } finally { b.cleanup(); }
});
