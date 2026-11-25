// Changes a JSON document's values in place, in the text it already has: the bytes outside the changed spans stay as they were (indentation,
// key order, short arrays on one line as a formatter wrote them, the trailing newline). `update` uses it for the tracked factory.config.json,
// which a project's formatter check (prettier --check) holds to its own style; JSON.stringify would break that check.
//
//   patchJson(text, before, after)  the text of `after`, made from the text of `before` by changing only what differs.
//                                   Returns `text` itself when nothing differs (no rewrite at all).
//
// Only objects are walked: a key that is new is added after the last member, in the style of the neighbours; a value that differs (an array,
// a string, a number, or an object whose keys changed type) is replaced as a whole. A key that went away is removed with its separator.

/** Parses the text far enough to know where every value and member begins and ends. */
function parse(text) {
  let i = 0;
  const ws = () => { while (/\s/.test(text[i] ?? "")) i++; };
  const value = () => {
    ws();
    const start = i;
    if (text[i] === "{") {
      i++;
      const members = [];
      ws();
      while (text[i] !== "}") {
        ws();
        const keyStart = i, key = JSON.parse(text.slice(i, (i = stringEnd(i))));
        ws(); i++;   // the colon
        const v = value();
        members.push({ key, keyStart, node: v });
        ws();
        if (text[i] === ",") i++;
        ws();
      }
      i++;
      return { type: "object", start, end: i, members };
    }
    if (text[i] === "[") {
      i++; ws();
      while (text[i] !== "]") { value(); ws(); if (text[i] === ",") i++; ws(); }
      i++;
      return { type: "array", start, end: i };
    }
    if (text[i] === '"') { i = stringEnd(i); return { type: "scalar", start, end: i }; }
    while (i < text.length && !/[,\]}\s]/.test(text[i])) i++;
    return { type: "scalar", start, end: i };
  };
  const stringEnd = (from) => { let j = from + 1; while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1; return j + 1; };
  return value();
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(v) { return Array.isArray(v) ? v.map(canonical) : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v; }

/** The indentation unit of the document: a tab, or the spaces before its first member; two spaces when it has none. */
function unitOf(text) { return /\n(\t| +)"/.exec(text)?.[1] ?? "  "; }

/** The whitespace before the member that starts at `at` (what separates it from the previous token), and the indentation of its line. */
function gapBefore(text, at) { let j = at; while (j > 0 && /\s/.test(text[j - 1])) j--; const gap = text.slice(j, at); return { from: j, gap, indent: gap.includes("\n") ? gap.slice(gap.lastIndexOf("\n") + 1) : null }; }

const render = (value, unit, indent) => JSON.stringify(value, null, unit).replace(/\n/g, `\n${indent}`);

function patchObject(text, node, before, after, unit, edits) {
  for (const [key, next] of Object.entries(after)) {
    const member = node.members.find((m) => m.key === key);
    if (!member) {
      const last = node.members.at(-1);
      const style = last ? gapBefore(text, last.keyStart) : { gap: `\n${unit}`, indent: unit };
      const outer = gapBefore(text, node.end - 1);
      const indent = style.indent ?? "";
      const body = `${JSON.stringify(key)}: ${render(next, unit, indent)}`;
      if (!last) edits.push({ from: node.start, to: node.end, text: `{\n${indent}${body}${outer.indent === null ? "\n" : outer.gap}}` });
      else edits.push({ from: last.node.end, to: last.node.end, text: `,${style.gap}${body}` });
    } else if (same(before[key], next)) continue;
    else if (isObject(before[key]) && isObject(next) && member.node.type === "object") patchObject(text, member.node, before[key], next, unit, edits);
    else edits.push({ from: member.node.start, to: member.node.end, text: render(next, unit, gapBefore(text, member.keyStart).indent ?? "") });
  }
  for (const m of node.members) if (!(m.key in after)) {
    const i = node.members.indexOf(m), prev = node.members[i - 1], gap = gapBefore(text, m.keyStart);
    // The member's own gap goes with it; the last member also takes the comma of the one before.
    if (prev && i === node.members.length - 1) edits.push({ from: prev.node.end, to: m.node.end, text: "" });
    else edits.push({ from: gap.from, to: m.node.end + (text[m.node.end] === "," ? 1 : 0), text: "" });
  }
}

export function patchJson(text, before, after) {
  if (same(before, after)) return text;
  const unit = unitOf(text);
  let out = text;
  // One change at a time, parsing again after each, so that two additions to one object follow each other.
  for (let guard = 0; guard < 50 && !same(JSON.parse(out), after); guard++) {
    const current = JSON.parse(out), edits = [], root = parse(out);
    if (isObject(current) && isObject(after) && root.type === "object") patchObject(out, root, current, after, unit, edits);
    else edits.push({ from: root.start, to: root.end, text: render(after, unit, "") });
    if (!edits.length) break;
    const e = edits.sort((a, b) => b.from - a.from)[0];   // the last span first: the offsets of the others stay right
    out = out.slice(0, e.from) + e.text + out.slice(e.to);
  }
  // Never hand back a document that does not say what `after` says.
  if (!same(JSON.parse(out), after)) return JSON.stringify(after, null, unit) + (text.endsWith("\n") ? "\n" : "");
  return out;
}
