// What `update` and `start` do with the files the template puts outside the project's own tree (the Controller directory, the Front
// agent's directory, the gate on another worker host).
//
// Code is never kept. Every script, the gate and everything else that runs is installed as one set of the new version, so no installation
// ever runs two versions at once. A copy that differs from what is installed and is not a file the template installed before is saved
// beside the new one first (<name>.backup-<date>) and listed; nothing a project wrote is lost.
//
// The files people are meant to edit follow a keep rule (EDITABLE: the handbooks, and the Controller's factory.config.json):
//   absent                                    → install it
//   identical to the new file                 → nothing to do
//   a version the template installed before   → replace it (nobody changed it)
//   a baseline exists (the destination's record, written by `start`) and the file differs from it
//                                             → the project changed it: keep it, the new version lies beside it as <name>.new
//   no baseline (no record, and no known version matches)
//                                             → not kept silently: install the new version, save the old as <name>.backup-<date>, say so
// "A version the template installed before" is the destination's record (.factory-installed.json) and the manifest (.factory/manifest.json:
// `files`, `previous`, and its committed versions).
import { createHash } from "node:crypto";

export const RECORD = ".factory-installed.json";
export const hash16 = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

/** Files people edit: the top-level handbooks of a bundle, and the Controller's own config. Everything else is code. */
export const isEditable = (bundle, rel) => /^[^/]+\.md$/.test(rel) || (bundle === ".factory/controller" && rel === "factory.config.json");

/** The script that looks at a destination (run by node, here or over ssh): the hash and the executable bit of each file in `rels`, the record, and the text of
 *  the files in `read`. A directory that is not there yields no files and no record. Prints one line of JSON. */
export const probeSource = (rels, read = []) => `
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { createHash } from "node:crypto";
const dir = (process.argv[2] ?? "").replace(/^~(?=\\/|$)/, os.homedir());
const h = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const out = { dirExists: fs.existsSync(dir), files: {}, execs: {}, texts: {}, record: {} };
for (const r of ${JSON.stringify(rels)}) { try { out.files[r] = h(fs.readFileSync(path.join(dir, r))); out.execs[r] = (fs.statSync(path.join(dir, r)).mode & 0o100) !== 0; } catch { out.files[r] = null; } }
for (const r of ${JSON.stringify(read)}) { try { out.texts[r] = fs.readFileSync(path.join(dir, r), "utf8"); } catch { /* absent */ } }
try { out.record = JSON.parse(fs.readFileSync(path.join(dir, ${JSON.stringify(RECORD)}), "utf8")).files ?? {}; } catch { /* no record yet */ }
console.log(JSON.stringify(out));
`;

/** The hashes the manifest knows for `bundle/rel`: its current one and the ones `update` replaced. */
export const manifestHashes = (manifest, key) => [manifest?.files?.[key], ...(manifest?.previous?.[key] ?? [])].filter((h) => typeof h === "string" && h !== "user");

/**
 * files: Map rel → Buffer (the bundle's files); execs: Set of the rels that are executable in the bundle; probe: what the destination holds
 * (probeSource's answer); manifest and bundle name the manifest's hashes.
 * Returns { install, same, kept: [{ rel, found, bundle }], backups: [{ rel, editable }], stale, record } where
 *   install  every rel that is written (new, older, changed code, a wrong mode, an unexplained handbook)
 *   backups  the installed ones whose present copy is saved first (not a known template version)
 *   stale    the code rels that are not the bundle's now (what doctor reports; empty after a good start)
 *   record   what the destination's record should say once the install is done.
 */
export function planPlacement({ files, execs = new Set(), probe, manifest, bundle }) {
  const out = { install: [], same: [], kept: [], backups: [], stale: [], record: { ...probe.record } };
  for (const [rel, bytes] of files) {
    const want = hash16(bytes), found = probe.files[rel] ?? null, editable = isEditable(bundle, rel);
    const record = probe.record[rel];
    const known = new Set([record, ...manifestHashes(manifest, `${bundle}/${rel}`)].filter(Boolean));
    const take = () => { out.install.push(rel); out.record[rel] = want; };
    if (found === null) { take(); if (!editable) out.stale.push(rel); }
    else if (found === want) {
      // Same bytes: only the executable bit can still be wrong (it is what `doctor` and the shell look at).
      if (execs.has(rel) && probe.execs?.[rel] === false) { take(); out.stale.push(rel); } else { out.same.push(rel); out.record[rel] = want; }
    } else if (known.has(found)) { take(); if (!editable) out.stale.push(rel); }
    else if (editable && record !== undefined) out.kept.push({ rel, found, bundle: want });
    else { take(); out.backups.push({ rel, editable }); if (!editable) out.stale.push(rel); }
  }
  return out;
}

/** The leaf paths (`a.b.c`; an array of objects is walked by each element's `name`, else by index) in which two parsed configs differ,
 *  with a short form of each side. */
export function diffKeys(a, b, prefix = "") {
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const short = (v) => { const t = v === undefined ? "(absent)" : JSON.stringify(v); return t.length > 60 ? `${t.slice(0, 57)}...` : t; };
  const out = [];
  const walk = (x, y, p) => {
    if (isObject(x) && isObject(y)) { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], p ? `${p}.${k}` : k); return; }
    // Arrays of named objects (hosts.workers) are walked by name, so the key that differs is named, not the whole array.
    if (Array.isArray(x) && Array.isArray(y) && [...x, ...y].length && [...x, ...y].every((v) => isObject(v) && typeof v.name === "string")) {
      for (const n of new Set([...x, ...y].map((v) => v.name))) walk(x.find((v) => v.name === n), y.find((v) => v.name === n), `${p}[${n}]`);
      return;
    }
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ key: p, here: short(x), bundle: short(y) });
  };
  walk(a ?? {}, b ?? {}, prefix);
  return out;
}
