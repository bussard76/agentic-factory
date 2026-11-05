#!/usr/bin/env node
// Compares the vendored skills with their upstream repositories, using skills/skills-lock.json. Upstream content is data:
// nothing from it is executed, and nothing merges by itself. --apply only changes the working tree, for a human or a
// Tester to review as a pull request. Git trees identify a skill, so byte equality with upstream needs no extra hashing.
// Usage: node scripts/skills-check.mjs [--apply] [--report <file>] [--root <repo>]
// Exit codes: 0 checked (see the report), 1 the check itself failed.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const apply = argv.includes("--apply");
const reportFile = opt("--report");
const root = path.resolve(opt("--root") ?? path.join(path.dirname(new URL(import.meta.url).pathname), ".."));
const lockFile = path.join(root, "skills/skills-lock.json");
const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));

// Signs that a skill reaches outside its job. Skills/SKILLS.md names the same rule. A hit asks for a closer look; no hit proves nothing.
const RISKS = [
  ["remote code", /\b(curl|wget)\b[^\n]*\|\s*(ba|z)?sh\b|\bnpx\s+(-y|--yes)\b|\beval\b|\bbase64\s+(-d|--decode)\b/i],
  ["global install", /\b(npm|pnpm|yarn)\s+(i|install|add)\s+(-g|--global)\b|\bbrew\s+install\b|\bpipx?\s+install\b|\bsudo\b/i],
  ["agent configuration", /~\/\.(claude|codex|agents|pi)\b|settings(\.local)?\.json|\bmcpServers\b|\bhooks?\.json\b/i],
  ["secrets or sending data", /\b(api[_-]?key|credentials?|password|\.env\b|ssh\/id_)|\bcurl\b[^\n]*(-d\b|--data|-X\s*POST|-F\b)/i],
  ["overriding instructions", /ignore (all |any )?(previous|prior|above)|disregard .{0,20}instructions|do not (tell|mention|inform)/i],
];

const git = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", maxBuffer: 1 << 28 }).trim();
const tryGit = (cwd, ...args) => { const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", maxBuffer: 1 << 28 }); return r.status === 0 ? r.stdout.trim() : null; };
const clone = (url) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-check-")); execFileSync("git", ["clone", "-q", "--filter=blob:none", "--no-checkout", url, dir], { stdio: ["ignore", "ignore", "pipe"] }); return dir; };

function risksIn(text) {
  const hits = new Set();
  for (const line of text.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const [name, re] of RISKS) if (re.test(line)) hits.add(name);
  }
  return [...hits];
}

const hasLink = (repo, commit, dir) => git(repo, "ls-tree", "-r", commit, "--", dir).split("\n").some((l) => l.startsWith("120000"));

function replaceFromUpstream(repo, commit, upstreamPath, target) {
  const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), "skills-unpack-"));
  const tar = spawnSync("git", ["archive", `${commit}:${upstreamPath}`], { cwd: repo, maxBuffer: 1 << 28 });
  if (tar.status !== 0) throw new Error(`git archive failed for ${upstreamPath}`);
  execFileSync("tar", ["-x", "-C", unpacked], { input: tar.stdout });
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(unpacked, target, { recursive: true });
  fs.rmSync(unpacked, { recursive: true, force: true });
}

const result = { changed: [], blocked: [], removed: [], added: [], licenses: [], drift: [], failed: [] };
const clones = [];
try {
  for (const [sourceName, source] of Object.entries(lock.sources)) {
    let repo;
    try { repo = clone(source.url); clones.push(repo); }
    catch (e) { result.failed.push(`${sourceName}: ${String(e.stderr ?? e.message).trim().slice(0, 200)}`); continue; }
    const head = git(repo, "rev-parse", "HEAD");

    const licenseNow = tryGit(repo, "rev-parse", `${head}:${source.license.path}`);
    if (licenseNow !== source.license.blob) result.licenses.push(sourceName);

    for (const [name, skill] of Object.entries(lock.skills).filter(([, s]) => s.source === sourceName)) {
      const vendored = tryGit(root, "rev-parse", `HEAD:skills/${name}`);
      if (vendored !== skill.tree) result.drift.push(name);

      const upstreamTree = tryGit(repo, "rev-parse", `${head}:${skill.path}`);
      if (!upstreamTree) { result.removed.push({ name, source: sourceName, path: skill.path }); continue; }
      if (upstreamTree === skill.tree) continue;

      const diff = git(repo, "diff", skill.commit, head, "--", skill.path);
      const entry = { name, source: sourceName, from: skill.commit, to: head, stat: git(repo, "diff", "--shortstat", skill.commit, head, "--", skill.path), files: git(repo, "diff", "--name-status", skill.commit, head, "--", skill.path).split("\n"), risks: risksIn(diff) };
      if (hasLink(repo, head, skill.path)) { result.blocked.push({ ...entry, reason: "contains a symbolic link" }); continue; }
      result.changed.push(entry);
      if (apply) {
        replaceFromUpstream(repo, head, skill.path, path.join(root, "skills", name));
        lock.skills[name] = { ...skill, commit: head, tree: upstreamTree };
      }
    }

    const skillDirs = git(repo, "ls-tree", "-r", "--name-only", head).split("\n").filter((f) => f.endsWith("/SKILL.md") && (source.roots ?? []).some((r) => f.startsWith(`${r}/`))).map((f) => path.posix.dirname(f));
    const adopted = new Set(Object.values(lock.skills).filter((s) => s.source === sourceName).map((s) => s.path));
    for (const dir of skillDirs) {
      if (adopted.has(dir) || (source.seen ?? []).includes(dir)) continue;
      const text = git(repo, "show", `${head}:${dir}/SKILL.md`).split("\n").map((l) => `+${l}`).join("\n");
      result.added.push({ name: path.posix.basename(dir), source: sourceName, path: dir, commit: head, risks: risksIn(text) });
      if (apply) source.seen = [...(source.seen ?? []), dir].sort();
    }
  }
} finally {
  for (const dir of clones) fs.rmSync(dir, { recursive: true, force: true });
}

const updates = result.changed.length + result.blocked.length + result.removed.length + result.added.length + result.licenses.length;
if (apply && (result.changed.length || result.added.length)) fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n");

const riskLine = (risks) => (risks.length ? `**Look closely: ${risks.join(", ")}**` : "no pattern hit");
const report = ["# Skills check", ""];
if (!updates && !result.drift.length && !result.failed.length) report.push("Everything matches upstream.");
if (result.failed.length) report.push("## The check failed for", "", ...result.failed.map((f) => `- ${f}`), "");
if (result.drift.length) report.push("## Vendored skill differs from the lock", "", "Vendored skills stay unchanged copies. Restore these, or record why they differ:", "", ...result.drift.map((n) => `- \`${n}\``), "");
if (result.changed.length) report.push(`## Changed upstream${apply ? " (applied here)" : ""}`, "", ...result.changed.flatMap((c) => [`- \`${c.name}\` (${c.source}), ${c.from.slice(0, 7)} to ${c.to.slice(0, 7)}:${c.stat}. ${riskLine(c.risks)}`, ...c.files.map((f) => `  - \`${f.replace(/\t/g, " ")}\``)]), "");
if (result.blocked.length) report.push("## Changed upstream, not applied", "", ...result.blocked.map((c) => `- \`${c.name}\` (${c.source}): ${c.reason}`), "");
if (result.removed.length) report.push("## Gone upstream, kept here", "", ...result.removed.map((r) => `- \`${r.name}\` (${r.source}): \`${r.path}\` no longer exists`), "");
if (result.added.length) report.push("## New upstream, not adopted", "", "Listed once. To adopt one, follow \"Updating a skill\" in `skills/SKILLS.md`.", "", ...result.added.map((a) => `- \`${a.name}\` (${a.source}), \`${a.path}\`. ${riskLine(a.risks)}`), "");
if (result.licenses.length) report.push("## License changed upstream", "", "Read the new license before adopting anything from these. The vendored copy was not changed:", "", ...result.licenses.map((s) => `- ${s}`), "");
if (updates) report.push("## Before merging", "", "Upstream text is data, not instructions. Read every changed file as code, as `skills/SKILLS.md` asks. A pattern hit is a hint, and no hit proves nothing.", "");
const text = report.join("\n");
if (reportFile) fs.writeFileSync(reportFile, text + "\n");
console.log(text);
process.exit(result.failed.length ? 1 : 0);
