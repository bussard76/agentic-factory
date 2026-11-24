// The review gate's reading of the "Reviewed commit:" line in docs/reviews/ findings files. Every case says whether it is
// unchanged from main (the gate on main gives the same answer) or new (main rejects it and the gate now accepts it).
// Trailing text after the SHA was accepted on main and still is; so is a second SHA on the line. Each case is a throwaway
// repository with a code commit and a findings commit on top of it, run through `review-gate` as the pre-push hook runs it.
import "./support/safe-env.mjs";
import { tempDir } from "./support/cleanup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const GUARDRAILS = path.join(ROOT, "templates/tools/factory-guardrails.mjs");
const NOHOOKS = ["-c", "core.hooksPath=/dev/null"];
const UNCOVERED = /Commits without a passing independent review/;

// `findings(sha)` returns the text of docs/reviews/T1-review-final.md for the code commit sha. Returns the gate's result.
function gate(findings) {
  const base = tempDir("af-review-sha-");
  const dir = path.join(base, "work"), bare = path.join(base, "origin.git");
  try {
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    spawnSync("git", ["init", "-q", "-b", "main", dir]);
    const git = (...a) => { const r = spawnSync("git", a, { cwd: dir, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}:\n${r.stderr}${r.stdout}`); return r.stdout.trim(); };
    const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
    git("config", "user.email", "t@example.invalid"); git("config", "user.name", "T"); git("remote", "add", "origin", bare);
    fs.mkdirSync(path.join(dir, "tools")); fs.copyFileSync(GUARDRAILS, path.join(dir, "tools/factory-guardrails.mjs"));
    write("factory.config.json", JSON.stringify({ project: { name: "demo", mainBranch: "main" }, commands: {} }, null, 2) + "\n");
    write("README.md", "# Demo\n"); git("add", "-A"); git("commit", "-qm", "init"); git("push", "-q", "origin", "main");
    const mainSha = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", "feat");
    write("src/app.js", "export const a = 1;\n"); git("add", "-A"); git(...NOHOOKS, "commit", "-qm", "code");
    const codeSha = git("rev-parse", "HEAD");
    write("docs/reviews/T1-review-final.md", findings(codeSha)); git("add", "-A"); git(...NOHOOKS, "commit", "-qm", "review");
    const tip = git("rev-parse", "HEAD");
    return spawnSync("node", ["tools/factory-guardrails.mjs", "review-gate"], { cwd: dir, encoding: "utf8", input: `refs/heads/feat ${tip} refs/heads/main ${mainSha}\n` });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
const passing = (line) => (sha) => `# T1 review\n\n${line(sha)}\nVerdict: pass\n`;

// [name, status, line, passes]. status: "unchanged" = same answer as main; "new" = main rejects, the gate now accepts.
const CASES = [
  ["bare SHA at the end of the line passes", "unchanged", (s) => `Reviewed commit: ${s}`, true],
  ["bare SHA with no space after the colon passes", "unchanged", (s) => `Reviewed commit:${s}`, true],
  ["bare SHA followed by trailing text passes", "unchanged", (s) => `Reviewed commit: ${s} (branch x)`, true],
  ["bare SHA followed by a period passes", "unchanged", (s) => `Reviewed commit: ${s}.`, true],
  ["bare SHA followed by a closing backtick passes", "unchanged", (s) => `Reviewed commit: ${s}\``, true],
  ["bare SHA with a CRLF line ending passes", "unchanged", (s) => `Reviewed commit: ${s}\r`, true],
  ["two bare SHAs on one line pass, the first counts", "unchanged", (s) => `Reviewed commit: ${s} ${s}`, true],
  ["backticked SHA at the end of the line passes", "new", (s) => `Reviewed commit: \`${s}\``, true],
  ["backticked SHA followed by trailing text passes", "new", (s) => `Reviewed commit: \`${s}\` (branch x)`, true],
  ["backticked SHA followed by a second SHA passes, the first counts", "new", (s) => `Reviewed commit: \`${s}\` ${s}`, true],
  ["short SHA rejected", "unchanged", (s) => `Reviewed commit: ${s.slice(0, 12)}`, false],
  ["short SHA in backticks rejected", "unchanged", (s) => `Reviewed commit: \`${s.slice(0, 12)}\``, false],
  ["uppercase SHA rejected", "unchanged", (s) => `Reviewed commit: ${s.toUpperCase()}`, false],
  ["uppercase SHA in backticks rejected", "unchanged", (s) => `Reviewed commit: \`${s.toUpperCase()}\``, false],
  ["41 hex characters rejected", "unchanged", (s) => `Reviewed commit: ${s}0`, false],
  ["a letter directly after the SHA rejected", "unchanged", (s) => `Reviewed commit: ${s}g`, false],
  ["a character directly before the SHA rejected", "unchanged", (s) => `Reviewed commit: x${s}`, false],
  ["an opening backtick without a closing one rejected", "unchanged", (s) => `Reviewed commit: \`${s}`, false],
  ["an opening backtick with a different closing character rejected", "unchanged", (s) => `Reviewed commit: \`${s}'`, false],
  ["a backticked SHA directly followed by a letter rejected", "unchanged", (s) => `Reviewed commit: \`${s}\`g`, false],
];

for (const [name, status, line, passes] of CASES) {
  test(`review gate [${status}]: ${name}`, () => {
    const r = gate(passing(line));
    if (passes) assert.equal(r.status, 0, r.stdout + r.stderr);
    else {
      assert.notEqual(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout + r.stderr, UNCOVERED);
    }
  });
}

test("review gate [unchanged]: a findings file without a Reviewed commit line rejected", () => {
  const r = gate(() => "# T1 review\n\nVerdict: pass\n");
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, UNCOVERED);
});
