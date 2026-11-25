// The findings file of a review, read strictly, for the one question a waiver asks: which findings does it hold, of which class,
// and may a human decide that they are no blocker? A module for waiver.mjs and reviewed.mjs (nobody runs it); it reads nothing
// but the text it is given.
//
// What this code does NOT know: whether the class is right, or who really wrote the file. The class is the REVIEWER'S OWN CLAIM about its
// finding. The code checks ids, format, level, the binding to one commit and the named findings; it never checks that a "style" finding is
// really style. Whoever decides a waiver (the Front agent, the owner) has to read the findings file itself.
//
// The format (templates/docs/review-protocol.md, "Findings file format"): under a `## Findings` heading, one heading per finding,
//   ### F<n> [<severity>] [<class>] <title>
// severity: blocker | major | minor. class, exactly one per finding, lower case, from this fixed list:
//   never waivable:  security, data-corruption, input-loss, gate
//   waivable:        functional, process, style
// plus a `Gates: verify pass|fail, e2e pass|fail|none` line for a Tester round. A finding without a readable class, an id used
// twice, a finding heading outside `## Findings`, a heading in the old form (`### [blocker] <title>`): the file is "unreadable"
// and none of its findings can be waived. Unknown is never waivable.

export const NEVER_WAIVABLE = ["security", "data-corruption", "input-loss", "gate"];
export const WAIVABLE = ["functional", "process", "style"];   // what the OWNER may waive
// The one place that says which classes the Front agent may waive on its own. Everything else (a functional finding, a level-3 ticket, the last
// Tester round and anything after the round limit, a failed re-evaluation) is the owner's decision (waiver.mjs). Narrow or widen it here only.
export const FRONT_AGENT_WAIVABLE = ["process", "style"];
export const CLASSES = [...NEVER_WAIVABLE, ...WAIVABLE];
export const SEVERITIES = ["blocker", "major", "minor"];

const HEADING = /^### (F[1-9]\d{0,2}) \[(blocker|major|minor)\] \[([a-z-]+)\] ([^\s[].*)$/;   // the title never starts with a bracket: a second class marker is no title
const LOOKS_LIKE_FINDING = /^#{3,6}\s.*\[(blocker|major|minor)\]/i;
// Inside "## Findings": a line that looks like a blocker or major finding in any markup (bold, list, numbered, a deeper heading, a table row) but is no
// well-formed heading makes the file unreadable (fail closed). A bare reference to an earlier finding ("F1 | functional defect", a classification table of a
// re-evaluation) is no finding and stays readable: only a [blocker] or [major] marker, or a ### heading, makes a line count.
const LOOKS_BLOCKING = /\[(blocker|major)\]/i;
const GATES = /^Gates: verify (pass|fail), e2e (pass|fail|none)\s*$/;

/** What to do when a file cannot be read as classed findings (a review written before the classes existed, or a Tester that did not follow the template). */
export const NEW_ROUND = "A new review with the current template is needed (a new Tester round, mkspec test; after the round limit the re-evaluation, mkspec reeval): its findings file carries a class on every finding.";

/** { ok: true, findings: [{ id, severity, cls, title }], gates: { verify, e2e } | null } or { ok: false, why }. */
export function parseFindings(text) {
  const lines = String(text).split("\n").map((l) => l.replace(/\r$/, ""));
  const sections = lines.map((l, i) => (/^## Findings\s*$/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (sections.length !== 1) return { ok: false, why: `${sections.length} "## Findings" headings (exactly one is needed)` };
  const start = sections[0] + 1;
  let end = lines.findIndex((l, i) => i >= start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const findings = [], seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const inside = i >= start && i < end;
    if (!LOOKS_LIKE_FINDING.test(l) && !(inside && (/^###(\s|$)/.test(l) || LOOKS_BLOCKING.test(l)))) continue;
    if (!inside) return { ok: false, why: `a finding heading outside "## Findings" (line ${i + 1}: ${l.slice(0, 60)})` };
    const m = HEADING.exec(l);
    if (!m) return { ok: false, why: `line ${i + 1} looks like a finding but is not a finding heading of the form "### F<n> [blocker|major|minor] [<class>] <title>": ${l.slice(0, 70)}` };
    const [, id, severity, cls, title] = m;
    if (!CLASSES.includes(cls)) return { ok: false, why: `${id} has the class "${cls}", which is not one of ${CLASSES.join(", ")}` };
    if (seen.has(id)) return { ok: false, why: `${id} is used twice` };
    seen.add(id); findings.push({ id, severity, cls, title });
  }
  // The class is read from the heading and nowhere else: prose in the body cannot add, change or hide one.
  const gateLines = lines.filter((l) => /^Gates:/.test(l));
  if (gateLines.length > 1) return { ok: false, why: `${gateLines.length} "Gates:" lines` };
  let gates = null;
  if (gateLines.length === 1) {
    const g = GATES.exec(gateLines[0]);
    if (!g) return { ok: false, why: `the Gates line is not "Gates: verify pass|fail, e2e pass|fail|none": ${gateLines[0].slice(0, 70)}` };
    gates = { verify: g[1], e2e: g[2] };
  }
  return { ok: true, findings, gates };
}

/** May a human decide that these findings are no blocker? `named` are the ids the waiver names; `path` is the review's kind
 *  (tester, final, conformance). { ok: true } or { ok: false, why }. Pure. */
export function waivable(parsed, named, path) {
  if (!parsed.ok) return { ok: false, why: `the findings file is not in the classed format (${parsed.why}). ${NEW_ROUND}` };
  const { findings, gates } = parsed;
  if (path === "tester" && !gates) return { ok: false, why: `a Tester round states its gates on one "Gates:" line, and this one has none. ${NEW_ROUND}` };
  if (gates && (gates.verify !== "pass" || gates.e2e === "fail")) return { ok: false, why: `the review's gates were red (${JSON.stringify(gates)}): a red gate is never waived` };
  const never = findings.filter((f) => NEVER_WAIVABLE.includes(f.cls));
  if (never.length) return { ok: false, why: `${never.map((f) => `${f.id} (${f.cls})`).join(", ")} can never be waived: security, data corruption, loss of input and a red gate need a fix` };
  const blocking = findings.filter((f) => f.severity !== "minor");
  if (!blocking.length) return { ok: false, why: "the review has no blocker or major finding, so there is nothing a waiver could decide (read the file again: a fail without one is not a review the Controller can act on)" };
  if (!Array.isArray(named) || !named.length) return { ok: false, why: "a waiver names the findings it waives; none is named" };
  const ids = new Set(findings.map((f) => f.id));
  const unknown = named.filter((n) => !ids.has(n));
  if (unknown.length) return { ok: false, why: `no such finding in the file: ${unknown.join(", ")} (it has ${[...ids].join(", ") || "none"})` };
  if (new Set(named).size !== named.length) return { ok: false, why: "a finding is named twice" };
  const open = blocking.filter((f) => !named.includes(f.id));
  if (open.length) return { ok: false, why: `${open.map((f) => `${f.id} [${f.severity}]`).join(", ")} is not named: every blocker and major of the review must be named (minor findings and debt candidates are not blockers)` };
  return { ok: true };
}

/** May the FRONT AGENT (not the owner) decide this waiver on its class? Only findings of FRONT_AGENT_WAIVABLE: any named finding of another class
 *  (a functional defect above all) is the owner's. The class is the reviewer's claim (see the top of this file). Call it after `waivable` said ok. */
export function frontAgentMayWaive(parsed, named) {
  const outside = parsed.findings.filter((f) => named.includes(f.id) && !FRONT_AGENT_WAIVABLE.includes(f.cls));
  if (!outside.length) return { ok: true };
  return { ok: false, why: `${outside.map((f) => `${f.id} (${f.cls})`).join(", ")}: the Front agent may waive only findings classed ${FRONT_AGENT_WAIVABLE.join(" or ")}; a finding of another class is the owner's decision (--decider owner, with their words verbatim)` };
}

/** For reviewed.mjs after it recorded a fail: why no waiver could ever cover this review, or "" when none is ruled out. It never says a
 *  review IS waivable: that is somebody's decision, and the Controller does not offer it. */
export function waivableNote(text, path) {
  const p = parseFindings(text);
  if (!p.ok) return `not waivable: ${p.why}. ${NEW_ROUND}`;
  const w = waivable(p, p.findings.filter((f) => f.severity !== "minor").map((f) => f.id), path);
  return w.ok ? "" : `not waivable: ${w.why}`;
}
