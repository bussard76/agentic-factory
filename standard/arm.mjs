#!/usr/bin/env node
// Arms this clone for the factory's untracked standard: the hooks in git's own hooks directory, the local exclude list,
// and the links in a worktree. Idempotent. Runs on `start` and `update`, from the post-checkout hook, and in every wave.
// Nothing here changes a tracked file: a file the project tracks at a linked path is its deviation and wins.
// The hooks live in <git-common-dir>/hooks because that applies to every worktree and moves with the repository, while
// an absolute core.hooksPath turns every hook off, silently, once the repository moves.
// Usage: node <git-common-dir>/factory/arm.mjs [--all]   --all: every worktree of this clone, not only the current one
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BEGIN = "# agentic-factory: begin (generated; do not edit)", END = "# agentic-factory: end";
const MARKER = "agentic-factory hook";
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const hooksPathIn = (scope) => git("config", scope, "--default", "", "core.hooksPath");
const standard = JSON.parse(fs.readFileSync(path.join(HERE, "standard.json"), "utf8"));

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
  const source = path.join(HERE, "hooks");
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name), to = path.join(target, name), content = fs.readFileSync(from, "utf8");
    if (fs.existsSync(to)) {
      const current = fs.readFileSync(to, "utf8");
      if (current === content) continue;
      // A hook this clone already had, such as git-lfs's, runs first as <hook>.own.
      if (name.endsWith(".mjs") === false && !current.includes(MARKER)) fs.renameSync(to, fs.existsSync(`${to}.own`) ? `${to}.own.bak` : `${to}.own`);
    }
    replaceFile(to, content, fs.statSync(from).mode & 0o777);
  }
}

// A hooks path in this clone would bypass the hooks directory, so it goes. Only a global one forces a path of our own.
function armHooksPath(common) {
  const outer = hooksPathIn("--global") || hooksPathIn("--system");
  const want = outer ? path.join(common, "hooks") : "";
  const local = hooksPathIn("--local");
  if (local === want) return;
  if (want) git("config", "--local", "core.hooksPath", want);
  else try { git("config", "--local", "--unset", "core.hooksPath"); } catch { if (hooksPathIn("--local")) throw new Error("cannot unset core.hooksPath"); }
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
  // The gate first: whatever fails after this, the hooks are armed.
  installHooks(common);
  armHooksPath(common);
  const previous = writeExclude(common);
  const roots = process.argv.includes("--all")
    ? git("worktree", "list", "--porcelain").split("\n\n").filter((e) => !/^bare$/m.test(e)).map((e) => /^worktree (.*)$/m.exec(e)?.[1]).filter((p) => p && fs.existsSync(p))
    : [git("rev-parse", "--show-toplevel")];
  for (const root of roots) linkIn(root, previous);
} catch (error) {
  console.error(`[factory] arming failed: ${error.message}`);
  process.exit(1);
}
