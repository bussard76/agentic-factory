// Read grants for the Controller: tools that limit which paths an agent may read get the project and its worker
// workspaces added, so the Controller can read them without a manual edit. Each grant runs only when its tool is
// installed, is idempotent, and never fails `start`: a grant that cannot be written is reported and skipped.
// To support another tool, add an entry to GRANTS: { name, detect(home), apply(home, paths, controllerDir) → message }.
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./safe-write.mjs";

const quote = (p) => JSON.stringify(p);

// ~/.lean-ctx/config.toml: allow_paths = [ … ] is a top-level key, so a new one goes before the first [table].
export function addTomlAllowPaths(text, paths) {
  // A key that is not a plain list (a string, a table's own key) cannot be extended safely: a second key would break the file.
  if (/^allow_paths\s*=/m.test(text) && !/^allow_paths\s*=\s*\[/m.test(text)) throw new Error("allow_paths is not a plain list");
  const m = /^allow_paths\s*=\s*\[([\s\S]*?)\]/m.exec(text);
  if (m) {
    const have = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((x) => (x[1] !== undefined ? JSON.parse(`"${x[1]}"`) : x[2]));
    const add = paths.filter((p) => !have.includes(p));
    if (!add.length) return { text, added: [] };
    const items = [...have, ...add].map((p) => `    ${quote(p)},`).join("\n");
    return { text: text.slice(0, m.index) + `allow_paths = [\n${items}\n]` + text.slice(m.index + m[0].length), added: add };
  }
  const block = `allow_paths = [\n${paths.map((p) => `    ${quote(p)},`).join("\n")}\n]\n`;
  const table = /^\s*\[/m.exec(text);
  const at = table ? table.index : text.length;
  const before = text.slice(0, at);
  return { text: before + (before && !before.endsWith("\n") ? "\n" : "") + block + text.slice(at), added: paths };
}

export const GRANTS = [
  {
    name: "lean-ctx",
    detect: (home) => fs.existsSync(path.join(home, ".lean-ctx", "config.toml")),
    apply(home, paths) {
      const file = path.join(home, ".lean-ctx", "config.toml");
      const { text, added } = addTomlAllowPaths(fs.readFileSync(file, "utf8"), paths);
      if (!added.length) return "allow_paths already has them";   // nothing changes: the live file is not touched
      writeFileAtomic(file, text, fs.statSync(file).mode & 0o777);   // the tool may read it at any moment: whole file or none
      return `allow_paths += ${added.join(", ")}`;
    },
  },
  {
    // pi's context-mode package reads Claude-style permissions from the session's directory.
    name: "context-mode",
    detect: (home) => fs.existsSync(path.join(home, ".pi", "agent", "npm", "node_modules", "context-mode")),
    apply(home, paths, controllerDir) {
      const file = path.join(controllerDir, ".claude", "settings.local.json");
      const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      settings.permissions ??= {};
      const allow = (settings.permissions.allow ??= []);
      const add = paths.map((p) => `Read(${p}/**)`).filter((r) => !allow.includes(r));
      if (!add.length) return `${file} already allows them`;
      allow.push(...add);
      writeFileAtomic(file, JSON.stringify(settings, null, 2) + "\n");
      return `${file}: ${add.join(", ")}`;
    },
  },
];

/** Runs every grant whose tool is installed. Returns one line per tool that was found; never throws. */
export function applyReadGrants({ home, paths, controllerDir, grants = GRANTS }) {
  const unique = [...new Set(paths.filter(Boolean).map((p) => p.replace(/\/+$/, "")))];
  const lines = [];
  for (const g of grants) {
    let found = false;
    try { found = g.detect(home); } catch { found = false; }
    if (!found) continue;
    try { lines.push(`${g.name}: ${g.apply(home, unique, controllerDir)}`); }
    catch (e) { lines.push(`${g.name}: could not write the grant (${String(e.message).split("\n")[0].slice(0, 160)}); add read access for ${unique.join(", ")} by hand`); }
  }
  return lines;
}
