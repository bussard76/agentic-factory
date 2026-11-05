#!/usr/bin/env node
// Arms this clone for the factory's untracked standard: the hooks in git's own hooks directory, the local exclude list,
// and the links in a worktree. Idempotent. Runs on `start` and `update`, from the post-checkout hook, and in every wave.
// Nothing here changes a tracked file: a file the project tracks at a linked path is its deviation and wins.
// The hooks live in <git-common-dir>/hooks because that applies to every worktree and moves with the repository, while
// an absolute core.hooksPath turns every hook off, silently, once the repository moves.
// It ends by checking what git would really run, wherever a hooks path comes from, and fails if that is not the factory's.
// Usage: node <git-common-dir>/factory/arm.mjs [--all|--check]
//   --all    every worktree of this clone, not only the current one      --check  only the check, changes nothing
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, "hooks");
const BEGIN = "# agentic-factory: begin (generated; do not edit)", END = "# agentic-factory: end";
const IS_FACTORY_HOOK = /^# agentic-factory hook/m;
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const standard = JSON.parse(fs.readFileSync(path.join(HERE, "standard.json"), "utf8"));
const isHook = (name) => !name.endsWith(".mjs");

// Written beside the target and renamed, so a hook or the exclude list is never missing or half written.
function replaceFile(file, content, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  if (mode) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function installHooks(common) {
  const target = path.join(common, "hooks");
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(SOURCE)) {
    const from = path.join(SOURCE, name), to = path.join(target, name), content = fs.readFileSync(from, "utf8"), mode = fs.statSync(from).mode & 0o777;
    if (fs.existsSync(to)) {
      const current = fs.readFileSync(to, "utf8");
      if (current === content) { if ((fs.statSync(to).mode & 0o777) !== mode) fs.chmodSync(to, mode); continue; }
      // A hook this clone already had, such as git-lfs's, runs first as <hook>.own. The newest one runs; an older one is kept.
      if (isHook(name) && !IS_FACTORY_HOOK.test(current)) {
        if (fs.existsSync(`${to}.own`)) fs.renameSync(`${to}.own`, `${to}.own.bak.${Date.now()}`);
        fs.copyFileSync(to, `${to}.own`);
      }
    }
    replaceFile(to, content, mode);
  }
}

// A hooks path in this clone would bypass the hooks directory, so it goes. One from elsewhere makes the check below fail.
function removeLocalHooksPath() {
  const local = () => git("config", "--local", "--default", "", "core.hooksPath");
  if (!local()) return;
  try { git("config", "--local", "--unset-all", "core.hooksPath"); } catch { if (local()) throw new Error("cannot remove the local core.hooksPath"); }
}

function check(common) {
  const expected = path.join(common, "hooks");
  const actual = path.resolve(git("rev-parse", "--git-path", "hooks"));
  const real = fs.existsSync(actual) ? fs.realpathSync(actual) : actual;
  if (real !== expected) throw new Error(`git runs hooks from ${real}, not the factory's, so there is no review gate here. A core.hooksPath is set outside this clone's config: in a global config, an include or a worktree config. Remove it.`);
  for (const name of fs.readdirSync(SOURCE)) {
    const to = path.join(expected, name);
    if (!fs.existsSync(to) || fs.readFileSync(to, "utf8") !== fs.readFileSync(path.join(SOURCE, name), "utf8")) throw new Error(`hook ${name} is missing or changed; run this script without --check`);
    if (isHook(name) && !(fs.statSync(to).mode & 0o111)) throw new Error(`hook ${name} is not executable; run this script without --check`);
  }
}

function writeExclude(common) {
  const file = path.join(common, "info/exclude");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const block = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?${END}\\n?`);
  const previous = (block.exec(current)?.[0] ?? "").split("\n").filter((l) => l.startsWith("/") && !l.endsWith("/")).map((l) => l.slice(1));
  const lines = [BEGIN, ...standard.ignores, ...standard.links.map((l) => `/${l.path}`), END, ""].join("\n");
  const rest = current.replace(block, "");
  const next = rest + (rest && !rest.endsWith("\n") ? "\n" : "") + lines;
  if (next !== current) { fs.mkdirSync(path.dirname(file), { recursive: true }); replaceFile(file, next); }
  return previous;
}

// Ours: into this standard, or into where a clone's standard was before the repository moved.
const pointsIntoStandard = (target) => target.startsWith(HERE + path.sep) || target.includes(`${path.sep}.git${path.sep}factory${path.sep}`);
const isSkillLink = (target, rel) => target === `../../.agents/skills/${path.basename(rel)}`;

function linkIn(root, previous) {
  const wanted = new Set(standard.links.map((l) => l.path));
  for (const old of previous) {
    if (wanted.has(old)) continue;
    const p = path.join(root, old);
    try { if (fs.lstatSync(p).isSymbolicLink() && (pointsIntoStandard(fs.readlinkSync(p)) || isSkillLink(fs.readlinkSync(p), old))) fs.unlinkSync(p); } catch {}
  }
  for (const link of standard.links) {
    const p = path.join(root, link.path), target = link.relative ? link.target : path.join(HERE, link.target);
    try {
      // A parent that is itself a link (a tracked .claude/skills -> ../.agents/skills) already leads to the right place.
      try { if (fs.lstatSync(path.dirname(p)).isSymbolicLink()) continue; } catch {}
      let stat = null;
      try { stat = fs.lstatSync(p); } catch {}
      if (stat && !stat.isSymbolicLink()) continue;            // a real file: the project's own
      if (stat) {
        const current = fs.readlinkSync(p);
        if (current === target) continue;
        if (!pointsIntoStandard(current)) continue;            // a link the project made
        fs.unlinkSync(p);
      }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.symlinkSync(target, p);
    } catch (error) { console.error(`[factory] could not link ${link.path}: ${error.code ?? error.message}`); }
  }
}

try {
  const common = fs.realpathSync(git("rev-parse", "--git-common-dir"));
  if (!process.argv.includes("--check")) {
    // The hooks first: whatever fails after this, they are in place.
    installHooks(common);
    removeLocalHooksPath();
    const previous = writeExclude(common);
    const roots = process.argv.includes("--all")
      ? git("worktree", "list", "--porcelain").split("\n\n").filter((e) => !/^bare$/m.test(e)).map((e) => /^worktree (.*)$/m.exec(e)?.[1]).filter((p) => p && fs.existsSync(p))
      : [git("rev-parse", "--show-toplevel")];
    for (const root of roots) linkIn(root, previous);
  }
  check(common);
} catch (error) {
  console.error(`[factory] arming failed: ${error.message}`);
  process.exit(1);
}
