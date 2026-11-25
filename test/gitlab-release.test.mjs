// The GitLab release script (scripts/gitlab-release.sh) against a fake `glab` and a local bare repo as `origin`.
// It proves the shell logic only. The real jobs run on a GitLab runner and are unproven until their first real pipeline.
import "./support/safe-env.mjs";
import { tempDir } from "./support/cleanup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SCRIPT = path.join(ROOT, "scripts/gitlab-release.sh");

// The fake: `view <tag>` succeeds for tags in FAKE_EXISTING (comma list), else says what glab says for a missing release (or
// FAKE_VIEW_ERROR); `create` logs its arguments, and fails like glab with --no-update when FAKE_CREATE_EXISTS is set.
const FAKE_GLAB = `#!/bin/sh
echo "$*" >> "$GLAB_LOG"
echo "auth=$GLAB_ENABLE_CI_AUTOLOGIN" >> "$GLAB_LOG"
case $2 in
  view)
    case ",$FAKE_EXISTING," in *",$3,"*) echo "name: $3"; exit 0 ;; esac
    if [ -n "\${FAKE_VIEW_ERROR:-}" ]; then echo "$FAKE_VIEW_ERROR"; exit 1; fi
    echo "release does not exist."; exit 1 ;;
  create)
    if [ -n "\${FAKE_CREATE_EXISTS:-}" ]; then echo "release for tag \\"$3\\" already exists and --no-update flag was specified"; exit 1; fi
    echo "created $3"; exit 0 ;;
esac
exit 3
`;

function setup({ notes = {}, remoteTags = [] } = {}) {
  const dir = fs.realpathSync(tempDir("af-glrel-"));
  const bin = path.join(dir, "bin"), work = path.join(dir, "work"), origin = path.join(dir, "origin.git");
  fs.mkdirSync(bin); fs.mkdirSync(path.join(work, "releases"), { recursive: true });
  // glab is called as `glab release view <tag>`: $1 is release, $2 the verb, $3 the tag.
  fs.writeFileSync(path.join(bin, "glab"), FAKE_GLAB, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, GLAB_LOG: path.join(dir, "glab.log"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
  const git = (...a) => { const r = spawnSync("git", a, { cwd: work, encoding: "utf8", env }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  git("init", "-q", "-b", "main"); git("commit", "-q", "--allow-empty", "-m", "c");
  assert.equal(spawnSync("git", ["init", "-q", "--bare", origin], { encoding: "utf8", env }).status, 0);
  git("remote", "add", "origin", origin);
  for (const t of remoteTags) git("tag", t);
  git("push", "-q", "origin", "main", ...remoteTags.map((t) => `refs/tags/${t}`));
  for (const [tag, text] of Object.entries(notes)) fs.writeFileSync(path.join(work, "releases", `${tag}.md`), text);
  const run = (args, extra = {}) => {
    fs.rmSync(env.GLAB_LOG, { force: true });   // each run has its own log
    const r = spawnSync("sh", [SCRIPT, ...args], { cwd: work, encoding: "utf8", env: { ...env, ...extra } });
    const log = fs.existsSync(env.GLAB_LOG) ? fs.readFileSync(env.GLAB_LOG, "utf8") : "";
    return { status: r.status, out: r.stdout, err: r.stderr, log, creates: log.split("\n").filter((l) => l.startsWith("release create")) };
  };
  return { run, work };
}

test("a tag with notes and no release: created from the notes file, with --no-update and the job token login", () => {
  const { run } = setup({ notes: { "v0.1.5": "Notes.\n" } });
  const r = run(["v0.1.5"]);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.creates, ["release create v0.1.5 --name v0.1.5 --notes-file releases/v0.1.5.md --no-update"]);
  assert.match(r.log, /auth=true/);
});

test("no notes file, or an empty one: the job fails with a clear message and creates nothing", () => {
  const { run } = setup({ notes: { "v0.1.6": "" } });
  for (const tag of ["v0.1.5", "v0.1.6"]) {
    const r = run([tag]);
    assert.equal(r.status, 1);
    assert.match(r.err, new RegExp(`no release notes for ${tag.replace(/\./g, "\\.")}: releases/${tag.replace(/\./g, "\\.")}\\.md is missing or empty`));
    assert.deepEqual(r.creates, []);
  }
});

test("an existing release is left alone: exit 0, no create", () => {
  const { run } = setup({ notes: { "v0.1.5": "Notes.\n" } });
  const r = run(["v0.1.5"], { FAKE_EXISTING: "v0.1.5" });
  assert.equal(r.status, 0);
  assert.match(r.out, /already exists, left as it is/);
  assert.deepEqual(r.creates, []);
});

test("a release created between the check and the create does not fail the job or get overwritten", () => {
  const { run } = setup({ notes: { "v0.1.5": "Notes.\n" } });
  const r = run(["v0.1.5"], { FAKE_CREATE_EXISTS: "1" });
  assert.equal(r.status, 0);
  assert.match(r.out, /already exists, left as it is/);
  assert.match(r.creates[0], /--no-update$/);
});

test("a failed look-up (no access, network) is an error, not a missing release", () => {
  const { run } = setup({ notes: { "v0.1.5": "Notes.\n" } });
  const r = run(["v0.1.5"], { FAKE_VIEW_ERROR: "401 Unauthorized" });
  assert.equal(r.status, 1);
  assert.match(r.err, /could not look up the release for v0\.1\.5: 401 Unauthorized/);
  assert.deepEqual(r.creates, []);
});

test("backfill: creates the missing releases oldest first, skips existing ones, tags not on the remote and odd file names", () => {
  const { run } = setup({
    remoteTags: ["v0.1.9", "v0.1.10", "v0.1.11"],
    notes: { "v0.1.9": "a\n", "v0.1.10": "b\n", "v0.1.11": "c\n", "v0.1.12": "not tagged yet\n", "draft": "x\n" },
  });
  const r = run(["--backfill"], { FAKE_EXISTING: "v0.1.11" });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.creates.map((l) => l.split(" ")[2]), ["v0.1.9", "v0.1.10"]);
  assert.match(r.out, /Skipping v0\.1\.12: the tag is not on the remote yet/);
  assert.match(r.out, /Skipping releases\/draft\.md: not named like a version tag/);
  assert.ok(r.creates.every((l) => l.endsWith("--no-update")));
  // Idempotent: with everything created, a second run creates nothing.
  const again = run(["--backfill"], { FAKE_EXISTING: "v0.1.9,v0.1.10,v0.1.11" });
  assert.equal(again.status, 0);
  assert.equal(again.creates.length, 0);
});

test("backfill: an empty notes file fails the run after the others were handled", () => {
  const { run } = setup({ remoteTags: ["v0.1.9", "v0.1.10"], notes: { "v0.1.9": "", "v0.1.10": "b\n" } });
  const r = run(["--backfill"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /no release notes for v0\.1\.9/);
  assert.deepEqual(r.creates.map((l) => l.split(" ")[2]), ["v0.1.10"]);
});

test("usage errors exit 2", () => {
  const { run } = setup();
  assert.equal(run([]).status, 2);
  assert.equal(run(["--bogus"]).status, 2);
  assert.equal(run(["--backfill", "v1"]).status, 2);
});
