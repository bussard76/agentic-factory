// Every release has its notes in the repo: releases/<tag>.md, committed with the release commit. GitHub's release is created from
// the file and GitLab's pipeline reads it (scripts/gitlab-release.sh), so a release without notes fails here, before the tag.
import "./support/safe-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dir = path.join(ROOT, "releases");
const files = fs.readdirSync(dir);

test("every file in releases/ is named after a version tag and has text", () => {
  assert.ok(files.length > 0);
  for (const f of files) {
    assert.match(f, /^v\d+\.\d+\.\d+\.md$/, `releases/${f}: the name must be v<major>.<minor>.<patch>.md`);
    assert.ok(fs.readFileSync(path.join(dir, f), "utf8").trim().length > 0, `releases/${f} is empty`);
  }
});

test("the version in package.json has its notes file", () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(files.includes(`v${version}.md`), `releases/v${version}.md is missing: add the notes to the release commit`);
});
