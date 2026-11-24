// What `update` and `start` do with the files the template puts outside the project's own tree (the Controller directory, the Front
// agent's directory, the gate on another worker host): a file the project changed there is never replaced silently.
//
// The rule, for each file of a bundle (.factory/controller/*, .factory/front-agent/*) and the file already at its destination:
//   absent                                  → install it
//   identical to the bundle's file          → nothing to do
//   what the template installed before      → replace it (nobody changed it)
//   anything else                           → the project changed it: keep it, put the bundle's file beside it as <name>.new, say so
// "What the template installed before" is, in this order of trust, the destination's own record (.factory-installed.json, written by
// `start` after each copy: the hash of every file it placed) and the manifest (.factory/manifest.json: the hash of each file at the last
// `update`, and `previous`, the hashes `update` replaced). The record is exact; the manifest covers a destination that has no record yet.
import { createHash } from "node:crypto";

export const RECORD = ".factory-installed.json";
export const hash16 = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

/** The script that looks at a destination (run by node, here or over ssh): the hash of each file in `rels`, the record, and the text of
 *  the files in `read`. A directory that is not there yields no files and no record. Prints one line of JSON. */
export const probeSource = (rels, read = []) => `
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { createHash } from "node:crypto";
const dir = (process.argv[2] ?? "").replace(/^~(?=\\/|$)/, os.homedir());
const h = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const out = { dirExists: fs.existsSync(dir), files: {}, texts: {}, record: {} };
for (const r of ${JSON.stringify(rels)}) { try { out.files[r] = h(fs.readFileSync(path.join(dir, r))); } catch { out.files[r] = null; } }
for (const r of ${JSON.stringify(read)}) { try { out.texts[r] = fs.readFileSync(path.join(dir, r), "utf8"); } catch { /* absent */ } }
try { out.record = JSON.parse(fs.readFileSync(path.join(dir, ${JSON.stringify(RECORD)}), "utf8")).files ?? {}; } catch { /* no record yet */ }
console.log(JSON.stringify(out));
`;

/** The hashes the manifest knows for `bundle/rel`: its current one and the ones `update` replaced. */
export const manifestHashes = (manifest, key) => [manifest?.files?.[key], ...(manifest?.previous?.[key] ?? [])].filter((h) => typeof h === "string" && h !== "user");

/**
 * files: Map rel → Buffer (the bundle's files); probe: what the destination holds (probeSource's answer); manifest and bundle name the
 * manifest's hashes. Returns { install: [rel], same: [rel], kept: [{ rel, found, bundle }], record: { rel: hash } } where `record` is what
 * the destination's record should say once the install is done.
 */
export function planPlacement({ files, probe, manifest, bundle }) {
  const out = { install: [], same: [], kept: [], record: { ...probe.record } };
  for (const [rel, bytes] of files) {
    const want = hash16(bytes), found = probe.files[rel] ?? null;
    const known = new Set([probe.record[rel], ...manifestHashes(manifest, `${bundle}/${rel}`)].filter(Boolean));
    if (found === null) { out.install.push(rel); out.record[rel] = want; }
    else if (found === want) { out.same.push(rel); out.record[rel] = want; }
    else if (known.has(found)) { out.install.push(rel); out.record[rel] = want; }
    else out.kept.push({ rel, found, bundle: want });
  }
  return out;
}

/** The leaf paths (`a.b.c`; an array is one leaf) in which two parsed configs differ, with a short form of each side. */
export function diffKeys(a, b, prefix = "") {
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const short = (v) => { const t = v === undefined ? "(absent)" : JSON.stringify(v); return t.length > 60 ? `${t.slice(0, 57)}...` : t; };
  const out = [];
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObject(a?.[k]) && isObject(b?.[k])) out.push(...diffKeys(a[k], b[k], p));
    else if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) out.push({ key: p, here: short(a?.[k]), bundle: short(b?.[k]) });
  }
  return out;
}
