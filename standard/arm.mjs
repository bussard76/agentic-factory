#!/usr/bin/env node
// Arms this clone for the factory's untracked standard: the hooks path, the local exclude list, and the links in a
// worktree. Idempotent. Runs on `start`, `update`, from the post-checkout hook, and in every wave. Nothing here changes
// a tracked file: a file the project tracks at a linked path is its deviation and wins.
// Usage: node <git-common-dir>/factory/arm.mjs [--all]   --all: every worktree of this clone, not only the current one
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BEGIN = "# agentic-factory: begin (generated; do not edit)", END = "# agentic-factory: end";
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const standard = JSON.parse(fs.readFileSync(path.join(HERE, "standard.json"), "utf8"));

const linkTarget = (link) => (link.relative ? link.target : path.join(HERE, link.target));
const isOurs = (target, linked) => target.startsWith(HERE + path.sep) || linked === target;

function linkIn(root, previous) {
  const wanted = new Set(standard.links.map((l) => l.path));
  for (const old of previous) {
    if (wanted.has(old)) continue;
    const p = path.join(root, old);
    try { if (fs.lstatSync(p).isSymbolicLink() && fs.readlinkSync(p).startsWith(HERE + path.sep)) fs.unlinkSync(p); } catch {}
  }
  for (const link of standard.links) {
    const p = path.join(root, link.path), target = linkTarget(link);
    try {
      // A parent that is itself a link (a tracked .claude/skills -> ../.agents/skills) already leads to the right place.
      try { if (fs.lstatSync(path.dirname(p)).isSymbolicLink()) continue; } catch {}
      let stat = null;
      try { stat = fs.lstatSync(p); } catch {}
      if (stat && !stat.isSymbolicLink()) continue;            // a real file: the project's own
      if (stat) {
        const current = fs.readlinkSync(p);
        if (current === target) continue;
        if (!isOurs(current, target)) continue;                // a link the project made
        fs.unlinkSync(p);
      }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.symlinkSync(target, p);
    } catch (error) { console.error(`[factory] could not link ${link.path}: ${error.code ?? error.message}`); }
  }
}

function writeExclude(common) {
  const file = path.join(common, "info/exclude");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const block = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?${END}\\n?`);
  const previous = (block.exec(current)?.[0] ?? "").split("\n").filter((l) => l.startsWith("/") && !l.endsWith("/")).map((l) => l.slice(1));
  const lines = [BEGIN, ...standard.ignores, ...standard.links.map((l) => `/${l.path}`), END, ""].join("\n");
  const rest = current.replace(block, "");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rest + (rest && !rest.endsWith("\n") ? "\n" : "") + lines);
  return previous;
}

const common = path.resolve(git("rev-parse", "--git-common-dir"));
const previous = writeExclude(common);
if (git("config", "--default", "", "core.hooksPath") !== path.join(HERE, "hooks")) git("config", "core.hooksPath", path.join(HERE, "hooks"));
const roots = process.argv.includes("--all")
  ? git("worktree", "list", "--porcelain").split("\n\n").filter((e) => !/^bare$/m.test(e)).map((e) => /^worktree (.*)$/m.exec(e)?.[1]).filter((p) => p && fs.existsSync(p))
  : [git("rev-parse", "--show-toplevel")];
for (const root of roots) linkIn(root, previous);
