// The review gate's reading of the "Reviewed commit:" line in docs/reviews/ findings files: exactly one 40-character
// lowercase SHA, bare or in one balanced pair of backticks, and nothing else on the line. Each case is a throwaway
// repository with a code commit and a findings commit on top of it, run through `review-gate` as the pre-push hook runs it.
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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "af-review-sha-"));
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

test("review gate: a bare 40-character SHA on the Reviewed commit line passes", () => {
  const r = gate(passing((sha) => `Reviewed commit: ${sha}`));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("review gate: the same SHA in one pair of backticks passes", () => {
  const r = gate(passing((sha) => `Reviewed commit: \`${sha}\``));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

const REJECTED = {
  "a short SHA": (sha) => `Reviewed commit: ${sha.slice(0, 12)}`,
  "a short SHA in backticks": (sha) => `Reviewed commit: \`${sha.slice(0, 12)}\``,
  "an uppercase SHA": (sha) => `Reviewed commit: ${sha.toUpperCase()}`,
  "an uppercase SHA in backticks": (sha) => `Reviewed commit: \`${sha.toUpperCase()}\``,
  "a character in front of the SHA": (sha) => `Reviewed commit: x${sha}`,
  "a character after the SHA": (sha) => `Reviewed commit: ${sha}.`,
  "a character after the SHA inside backticks": (sha) => `Reviewed commit: \`${sha}\`.`,
  "an opening backtick only": (sha) => `Reviewed commit: \`${sha}`,
  "a closing backtick only": (sha) => `Reviewed commit: ${sha}\``,
  "two SHAs on the line": (sha) => `Reviewed commit: ${sha} ${sha}`,
  "two SHAs in backticks": (sha) => `Reviewed commit: \`${sha}\` \`${sha}\``,
  "a 41-character hex run": (sha) => `Reviewed commit: ${sha}0`,
};

for (const [name, line] of Object.entries(REJECTED)) {
  test(`review gate: ${name} on the Reviewed commit line is rejected`, () => {
    const r = gate(passing(line));
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, UNCOVERED);
  });
}

test("review gate: a findings file without a Reviewed commit line is rejected", () => {
  const r = gate(() => "# T1 review\n\nVerdict: pass\n");
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, UNCOVERED);
});
