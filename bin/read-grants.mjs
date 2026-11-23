// Read grants for the Controller: tools that limit which paths an agent may read get the project and its worker
// workspaces added, so the Controller can read them without a manual edit. Each grant runs only when its tool is
// installed, is idempotent, and never fails `start`: a grant that cannot be written is reported and skipped.
// To support another tool, add an entry to GRANTS: { name, detect(home), apply(home, paths, controllerDir) → message }.
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./safe-write.mjs";

// A TOML basic string for any path: JSON escapes the quote, the backslash and the control characters the same way, and DEL is added.
const quote = (p) => JSON.stringify(String(p)).replace(/\u007f/g, "\\u007f");

// --- a reader for the one thing we edit ------------------------------------------------------------------
// ~/.lean-ctx/config.toml: allow_paths = [ … ] is a top-level key. This is not a TOML parser: it walks the top level far enough to
// find that key (skipping strings, comments and other values correctly, so a "]" inside a path is just a character), and it throws
// on anything it does not understand. The caller then leaves the file alone.
const WS = /[ \t]/;
function skipString(text, i) {
  const q = text[i], n = text.length;
  if (text.startsWith(q.repeat(3), i)) {
    for (let j = i + 3; j < n; j++) { if (q === '"' && text[j] === "\\") { j++; continue; } if (text.startsWith(q.repeat(3), j)) { j += 3; while (text[j] === q) j++; return j; } }
    throw new Error("unterminated multi-line string");
  }
  for (let j = i + 1; j < n; j++) {
    const c = text[j];
    if (c === "\n") break;
    if (q === '"' && c === "\\") { j++; continue; }
    if (c === q) return j + 1;
  }
  throw new Error("unterminated string");
}
const skipComment = (text, i) => { while (i < text.length && text[i] !== "\n") i++; return i; };
/** Skips whitespace, newlines and comments. */
function skipBlank(text, i) {
  for (;;) {
    if (WS.test(text[i] ?? "") || text[i] === "\n" || text[i] === "\r") i++;
    else if (text[i] === "#") i = skipComment(text, i);
    else return i;
  }
}
/** Returns the end index of the value that starts at i (to the end of its line, at bracket depth 0). */
function skipValue(text, i) {
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") i = skipString(text, i) - 1;
    else if (c === "#") i = skipComment(text, i) - 1;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") { if (--depth < 0) throw new Error("unbalanced bracket"); }
    else if (c === "\n" && depth === 0) return i;
  }
  if (depth) throw new Error("unbalanced bracket");
  return i;
}
function readItem(text, i) {
  const end = skipString(text, i), raw = text.slice(i, end);
  if (raw.startsWith('"""') || raw.startsWith("'''")) throw new Error("multi-line string in allow_paths");
  if (raw[0] === "'") return { value: raw.slice(1, -1), end };
  let value; try { value = JSON.parse(raw); } catch { throw new Error("an escape in allow_paths that is not understood"); }
  return { value, end };
}
/** Finds the top-level allow_paths. Returns { arr, firstTable }; arr is null when the key is absent. Throws when unsure. */
export function scanAllowPaths(text) {
  let i = 0, arr = null, firstTable = -1;
  for (;;) {
    i = skipBlank(text, i);
    if (i >= text.length) break;
    if (text[i] === "[") { firstTable = text.lastIndexOf("\n", i - 1) + 1; break; }
    const key = /^[A-Za-z0-9_-]+|^"[^"\n]*"|^'[^'\n]*'/.exec(text.slice(i));
    if (!key) throw new Error("a line that is not understood");
    let j = i + key[0].length;
    while (WS.test(text[j] ?? "")) j++;
    if (key[0] === "allow_paths" && text[j] === "=") {
      if (arr) throw new Error("allow_paths appears twice");
      j++; while (WS.test(text[j] ?? "")) j++;
      if (text[j] !== "[") throw new Error("allow_paths is not a plain list");
      const open = j; j++;
      const items = []; let comma = false;
      for (;;) {
        j = skipBlank(text, j);
        if (text[j] === "]") break;
        if (text[j] !== '"' && text[j] !== "'") throw new Error("allow_paths holds something other than strings");
        if (items.length && !comma) throw new Error("a missing comma in allow_paths");
        const it = readItem(text, j); items.push(it); j = it.end; comma = false;
        const k = skipBlank(text, j);
        if (text[k] === ",") { comma = true; j = k + 1; }
      }
      const close = j;
      const eol = text.indexOf("\n", close); const rest = text.slice(close + 1, eol < 0 ? text.length : eol);
      if (!/^[ \t\r]*(#.*)?$/.test(rest)) throw new Error("text after the closing bracket of allow_paths");
      arr = { open, close, items, comma, multiline: text.slice(open, close).includes("\n") };
      i = close + 1;
      continue;
    }
    if (text[j] !== "=" && text[j] !== ".") throw new Error("a line that is not understood");
    i = skipValue(text, j);
  }
  return { arr, firstTable };
}

// Adds the missing paths. Everything else in the file, comments inside the array included, stays byte for byte.
export function addTomlAllowPaths(text, paths) {
  const { arr, firstTable } = scanAllowPaths(text);
  const have = arr ? arr.items.map((x) => x.value) : [];
  const add = [...new Set(paths)].filter((p) => !have.includes(p));
  if (!add.length) return { text, added: [] };
  let out;
  if (!arr) {
    const block = `allow_paths = [\n${add.map((p) => `    ${quote(p)},`).join("\n")}\n]\n`;
    const at = firstTable < 0 ? text.length : firstTable;
    const before = text.slice(0, at);
    out = before + (before && !before.endsWith("\n") ? "\n" : "") + block + (firstTable < 0 ? "" : "\n") + text.slice(at);
  } else {
    const last = arr.items.at(-1);
    const lineStart = text.lastIndexOf("\n", arr.close - 1) + 1;
    const closeOwnLine = arr.multiline && /^[ \t]*$/.test(text.slice(lineStart, arr.close));
    if (closeOwnLine) {
      const indent = (/^[ \t]*/.exec(text.slice(arr.open).split("\n")[1] ?? "")?.[0]) || "    ";
      let t = text.slice(0, lineStart) + add.map((p) => `${indent}${quote(p)},\n`).join("") + text.slice(lineStart);
      if (last && !arr.comma) t = t.slice(0, last.end) + "," + t.slice(last.end);
      out = t;
    } else {
      const at = last ? last.end : arr.open + 1;
      out = text.slice(0, at) + (last ? ", " : "") + add.map(quote).join(", ") + text.slice(at);
    }
  }
  // Read the result back: it must hold everything it held before, plus what was added. Otherwise nothing is written.
  const check = scanAllowPaths(out).arr?.items.map((x) => x.value) ?? [];
  if (![...have, ...add].every((p) => check.includes(p))) throw new Error("the edited allow_paths did not read back");
  return { text: out, added: add };
}

export const GRANTS = [
  {
    name: "lean-ctx",
    detect: (home) => fs.existsSync(path.join(home, ".lean-ctx", "config.toml")),
    apply(home, paths) {
      const file = path.join(home, ".lean-ctx", "config.toml");
      // Another writer (the tool itself, another project's start) may change the file while we work: compute from what we read,
      // and compute again when the file differs just before the rename. The rename itself is the only moment that can still lose a write.
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = fs.readFileSync(file, "utf8");
        const { text, added } = addTomlAllowPaths(before, paths);
        if (!added.length) return "allow_paths already has them";   // nothing changes: the live file is not touched
        if (fs.readFileSync(file, "utf8") !== before) continue;
        writeFileAtomic(file, text, fs.statSync(file).mode & 0o777);   // the tool may read it at any moment: whole file or none
        return `allow_paths += ${added.join(", ")}`;
      }
      throw new Error("the file keeps changing");
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
      writeFileAtomic(file, JSON.stringify(settings, null, 2) + "\n", fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o644);
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
    catch (e) { lines.push(`${g.name}: could not write the grant (${String(e.message).split("\n")[0].slice(0, 160)}); the file was left as it is. Add read access for ${unique.join(", ")} by hand`); }
  }
  return lines;
}
