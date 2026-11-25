// The GitLab release script (scripts/gitlab-release.sh) against a fake `glab` and a local bare repo as `origin`.
// The fake answers like the real glab (1.128.0, run against a fake GitLab API; the code paths of the pinned 1.133.0 are the same):
//   `release view <tag>` of a missing release: exit 1, a boxed ERROR with "404 Not Found." (NOT "release does not exist");
//   `release create --no-update` of an existing release: exit 1, "release for tag "<tag>" already exists and --no-update flag was specified.".
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

// FAKE_EXISTING: comma list of tags that have a release. FAKE_API_ERROR: every call fails with this text (no access, no network).
// FAKE_HIDE_EXISTING: view fails with the 404 text although the release exists (create then reports it).
const FAKE_GLAB = `#!/bin/sh
echo "glab $*" >> "$GLAB_LOG"
echo "env autologin=$GLAB_ENABLE_CI_AUTOLOGIN telemetry=$GLAB_SEND_TELEMETRY gitlab_token=\${GITLAB_TOKEN:-} access_token=\${GITLAB_ACCESS_TOKEN:-} oauth_token=\${OAUTH_TOKEN:-}" >> "$GLAB_LOG"
box() { printf '          \\n   ERROR  \\n          \\n  %s\\n' "$1" >&2; }
if [ -n "\${FAKE_API_ERROR:-}" ]; then box "$FAKE_API_ERROR"; exit 1; fi
tag=$3
exists=
case ",$FAKE_EXISTING," in *",$tag,"*) exists=1 ;; esac
case $2 in
  view)
    if [ -n "$exists" ] && [ -z "\${FAKE_HIDE_EXISTING:-}" ]; then echo "name: $tag"; exit 0; fi
    box "404 Not Found."; exit 1 ;;
  create)
    if [ -n "$exists" ]; then box "release for tag \\"$tag\\" already exists and --no-update flag was specified."; exit 1; fi
    echo "• Creating or updating release repo=g/p tag=$tag"; echo "✓ Release created:	url=http://x/r"; exit 0 ;;
esac
exit 3
`;

function setup({ notes = {}, remoteTags = [] } = {}) {
  const dir = fs.realpathSync(tempDir("af-glrel-"));
  const bin = path.join(dir, "bin"), work = path.join(dir, "work"), origin = path.join(dir, "origin.git");
  fs.mkdirSync(bin); fs.mkdirSync(path.join(work, "releases"), { recursive: true });
  fs.writeFileSync(path.join(bin, "glab"), FAKE_GLAB, { mode: 0o755 });   // called as `glab release <verb> <tag> ...`: $1 release, $2 verb, $3 tag
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, GLAB_LOG: path.join(dir, "glab.log"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "CI_PROJECT_PATH"]) delete env[k];
  const git = (extra, ...a) => { const r = spawnSync("git", a, { cwd: work, encoding: "utf8", env: { ...env, ...extra } }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  git({}, "init", "-q", "-b", "main"); git({}, "commit", "-q", "--allow-empty", "-m", "c");
  assert.equal(spawnSync("git", ["init", "-q", "--bare", origin], { encoding: "utf8", env }).status, 0);
  git({}, "remote", "add", "origin", origin);
  const dates = {};
  remoteTags.forEach((t, i) => {   // annotated tags with their own dates
    dates[t] = `2026-01-0${i + 1}T10:00:00+02:00`;
    git({ GIT_COMMITTER_DATE: dates[t] }, "tag", "-a", "-m", t, t);
  });
  git({}, "push", "-q", "origin", "main", ...remoteTags.map((t) => `refs/tags/${t}`));
  for (const t of remoteTags) git({}, "tag", "-d", t);   // a runner's clone of a branch pipeline has none of them: the script must fetch what it needs
  for (const [tag, text] of Object.entries(notes)) fs.writeFileSync(path.join(work, "releases", `${tag}.md`), text);
  const run = (args, extra = {}) => {
    fs.rmSync(env.GLAB_LOG, { force: true });   // each run has its own log
    const r = spawnSync("sh", [SCRIPT, ...args], { cwd: work, encoding: "utf8", env: { ...env, ...extra } });
    const log = fs.existsSync(env.GLAB_LOG) ? fs.readFileSync(env.GLAB_LOG, "utf8") : "";
    const calls = log.split("\n").filter((l) => l.startsWith("glab "));
    return { status: r.status, out: r.stdout, err: r.stderr, log, calls, creates: calls.filter((l) => l.startsWith("glab release create")) };
  };
  return { run, work, dates };
}

test("a tag with notes and no release: created from the notes file with --ref, --no-update and the job token login, telemetry off", () => {
  const { run } = setup({ notes: { "v0.1.5": "Notes.\n" } });
  const r = run(["v0.1.5"]);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.creates, ["glab release create v0.1.5 --ref v0.1.5 --name v0.1.5 --notes-file releases/v0.1.5.md --no-update"]);
  assert.match(r.log, /env autologin=true telemetry=false/);
  assert.match(r.out, /Created the release v0\.1\.5/);
});

test("glab is told the project when CI says which one it is", () => {
  const { run } = setup({ notes: { "v0.1.5": "Notes.\n" } });
  const r = run(["v0.1.5"], { CI_PROJECT_PATH: "group/project" });
  assert.equal(r.status, 0, r.err);
  assert.ok(r.calls.every((c) => c.endsWith("-R group/project")), r.calls.join("\n"));
});

test("a token variable of the project never reaches glab: it would replace the job token", () => {
  const { run } = setup({ notes: { "v0.1.5": "Notes.\n" } });
  const r = run(["v0.1.5"], { GITLAB_TOKEN: "pat", GITLAB_ACCESS_TOKEN: "pat2", OAUTH_TOKEN: "pat3" });
  assert.equal(r.status, 0, r.err);
  assert.match(r.log, /gitlab_token= access_token= oauth_token=\n/);
  assert.ok(!r.log.includes("pat"));
});

test("no notes file, or an empty one: the job fails with a clear message and creates nothing", () => {
  const { run } = setup({ notes: { "v0.1.6": "" } });
  for (const tag of ["v0.1.5", "v0.1.6"]) {
    const r = run([tag]);
    assert.equal(r.status, 1);
    assert.match(r.err, new RegExp(`no release notes for ${tag.replace(/\./g, "\\.")}: releases/${tag.replace(/\./g, "\\.")}\\.md is missing or empty`));
    assert.deepEqual(r.calls, []);
  }
});

test("an existing release is left alone: exit 0, no create", () => {
  const { run } = setup({ notes: { "v0.1.5": "Notes.\n" } });
  const r = run(["v0.1.5"], { FAKE_EXISTING: "v0.1.5" });
  assert.equal(r.status, 0);
  assert.match(r.out, /already exists, left as it is/);
  assert.deepEqual(r.creates, []);
});

test("when the look-up does not show an existing release, create refuses it (--no-update): exit 0, nothing overwritten", () => {
  const { run } = setup({ notes: { "v0.1.5": "Notes.\n" } });
  const r = run(["v0.1.5"], { FAKE_EXISTING: "v0.1.5", FAKE_HIDE_EXISTING: "1" });
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /already exists, left as it is/);
  assert.match(r.creates[0], /--no-update$/);
});

test("no access or no network: both calls fail, the job fails with the reason and creates nothing", () => {
  const { run } = setup({ notes: { "v0.1.5": "Notes.\n" } });
  const r = run(["v0.1.5"], { FAKE_API_ERROR: "401 Unauthorized" });
  assert.equal(r.status, 1);
  assert.match(r.err, /could not create the release for v0\.1\.5: .*401 Unauthorized/s);
});

test("backfill: creates the missing releases oldest first with the date of each tag, skips existing ones, tags not on the remote and odd file names", () => {
  const { run, dates } = setup({
    remoteTags: ["v0.1.9", "v0.1.10", "v0.1.11"],
    notes: { "v0.1.9": "a\n", "v0.1.10": "b\n", "v0.1.11": "c\n", "v0.1.12": "not tagged yet\n", "draft": "x\n", "v1.2.3-rc1": "y\n" },
  });
  const r = run(["--backfill"], { FAKE_EXISTING: "v0.1.11" });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.creates.map((l) => l.split(" ")[3]), ["v0.1.9", "v0.1.10"]);
  assert.ok(r.creates[0].endsWith(`--no-update --released-at ${dates["v0.1.9"]}`), r.creates[0]);
  assert.ok(r.creates[1].endsWith(`--no-update --released-at ${dates["v0.1.10"]}`), r.creates[1]);
  assert.match(r.out, /Skipping v0\.1\.12: the tag is not on the remote yet/);
  assert.match(r.out, /Skipping releases\/draft\.md: not named like a version tag/);
  assert.match(r.out, /Skipping releases\/v1\.2\.3-rc1\.md: not named like a version tag/);
  // Idempotent: with everything created, a second run creates nothing.
  const again = run(["--backfill"], { FAKE_EXISTING: "v0.1.9,v0.1.10,v0.1.11" });
  assert.equal(again.status, 0);
  assert.equal(again.creates.length, 0);
});

test("backfill: a failure shows: the others are handled, the run fails and names what failed", () => {
  const { run } = setup({ remoteTags: ["v0.1.9", "v0.1.10"], notes: { "v0.1.9": "", "v0.1.10": "b\n" } });
  const r = run(["--backfill"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /no release notes for v0\.1\.9/);
  assert.match(r.err, /BACKFILL FAILED for: v0\.1\.9\./);
  assert.deepEqual(r.creates.map((l) => l.split(" ")[3]), ["v0.1.10"]);
});

test("backfill without any notes file says so and succeeds", () => {
  const { run } = setup({});
  const r = run(["--backfill"]);
  assert.equal(r.status, 0);
  assert.match(r.out, /No release notes files/);
});

test("usage errors exit 2", () => {
  const { run } = setup();
  assert.equal(run([]).status, 2);
  assert.equal(run(["--bogus"]).status, 2);
  assert.equal(run(["--backfill", "v1"]).status, 2);
});

test(".gitlab-ci.yml runs this script for a tag and for the manual backfill, and the backfill is not silent about failures", () => {
  const ci = fs.readFileSync(path.join(ROOT, ".gitlab-ci.yml"), "utf8");
  assert.match(ci, /sh scripts\/gitlab-release\.sh "\$CI_COMMIT_TAG"/);
  assert.match(ci, /sh scripts\/gitlab-release\.sh --backfill/);
  assert.match(ci, /\$CI_COMMIT_TAG =~ \/\^v\\d\+\\\.\\d\+\\\.\\d\+\$\//);
  assert.match(ci, /^  image: gitlab\/glab:v\d+\.\d+\.\d+$/m);   // an exact version, from Docker Hub, which more runners reach than registry.gitlab.com
  assert.ok(fs.existsSync(SCRIPT));
});
