// What a ticket must show before the Controller takes it: the form check behind the Front agent's "sharpen the ticket" step.
// Pure functions on the ticket's text, no configuration and no file access. This is the one reader of a ticket's prose, sections and level: lib.mjs
// (which adds the configuration) and `agentic-factory status` import it, so every reader sees a ticket the same way. The one other copy of a
// reading is declaredProblem in lib.mjs, which must stay byte for byte equal to the commit hook's own copy (the hook runs without the factory's tree).
// The check sees form, never quality: it cannot tell a good acceptance criterion from a vague one (docs/workflow.md, "Sharpen the ticket").

/** The ticket's prose with its line numbers: { lines: [{ n, s }], unclosed } (`unclosed`: the line of a `<!--` that never ends, else null).
 *  An HTML comment and a fenced code block are no prose; their lines are dropped, the others keep their number. */
export function scan(text) {
  const src = String(text).replace(/^﻿/, "");
  let unclosed = null;
  const prose = src.replace(/<!--[\s\S]*?(-->|$)/g, (m, end, at) => {
    if (!end) unclosed = src.slice(0, at).split("\n").length;
    return m.replace(/[^\n]/g, "");
  });
  const lines = [], fenced = [];
  let fence = "";
  prose.split(/\r?\n/).forEach((s, i) => {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(s);
    if (fence) { if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = ""; else fenced.push({ n: i + 1, s }); return; }
    if (m) { fence = m[1]; return; }
    lines.push({ n: i + 1, s });
  });
  return { lines, fenced, unclosed };
}
/** The ticket's prose lines (as scan, without numbers). */
export const proseLines = (text) => scan(text).lines.map((l) => l.s);

/** The change level a ticket states (1, 2 or 3), from its prose only. Every `Level:` line must read `Level: <1|2|3>`; with several (a ticket repeats
 *  it under "Architecture impact") the highest counts. null when there is none or one is not a plain level (an unfilled template `Level: 1 | 2 | 3`):
 *  unknown, which a caller treats as the highest. */
export function ticketLevel(text) {
  const lines = proseLines(text).filter((l) => /^level:/i.test(l));
  if (!lines.length) return null;
  const levels = lines.map((l) => /^Level: ([123])[ \t]*$/.exec(l)?.[1]);
  return levels.some((v) => !v) ? null : Math.max(...levels.map(Number));
}
/** The ticket's `Status:` word (lower case), "" when there is none. */
export const statusOf = (text) => /^Status:[ \t]*([a-z-]+)/i.exec(proseLines(text).find((l) => /^status:/i.test(l)) ?? "")?.[1]?.toLowerCase() ?? "";

/** The outcomes of the Front agent's assessment. `needs clarification` is the one that is not ready to code. */
export const OUTCOMES = ["ready as written", "ready after gaps closed from context", "needs clarification"];
export const READY_OUTCOMES = OUTCOMES.slice(0, 2);
const ASSESSED = /^Assessed:[ \t]*(.+?),[ \t]*(\d{4})-(\d{2})-(\d{2})[ \t]*$/;
/** The ticket's `Assessed: <outcome>, <YYYY-MM-DD>` line: { outcome, date }, or null when there is none, not exactly one, an unknown outcome or no real date. */
export function assessmentOf(text) {
  const lines = proseLines(text).filter((l) => /^assessed:/i.test(l));
  const m = lines.length === 1 ? ASSESSED.exec(lines[0]) : null;
  if (!m || !OUTCOMES.includes(m[1].trim().toLowerCase())) return null;
  const d = new Date(Date.UTC(+m[2], +m[3] - 1, +m[4]));
  return d.getUTCFullYear() === +m[2] && d.getUTCMonth() === +m[3] - 1 && d.getUTCDate() === +m[4] ? { outcome: m[1].trim().toLowerCase(), date: `${m[2]}-${m[3]}-${m[4]}` } : null;
}

// Sections are found by their heading: `#` to `######`, any case, a trailing colon or a parenthetical ("Goal (user view)") ignored, hyphens read as
// spaces. The names are those of the T00 template, of the issues `to-tickets` writes, and their German forms; the first name of a group is shown in messages.
const SECTIONS = {
  goal: { label: "a goal", names: ["goal", "what to build", "ziel"] },
  acceptance: { label: "acceptance criteria (a list)", names: ["observable acceptance", "acceptance criteria", "acceptance", "abnahme", "abnahmekriterien"] },
  limits: { label: "the limits", names: ["out of scope", "not in scope", "non goals", "limits", "nicht im umfang", "abgrenzung", "grenzen"] },
  questions: { label: "", names: ["open questions", "offene fragen"] },
};
const asked = (g) => `${SECTIONS[g].label} (a heading ${SECTIONS[g].names.map((n) => `"${n.replace(/\b\w/, (c) => c.toUpperCase())}"`).join(", ")}, level 1 to 6)`;
// Read by hand, not by one expression: a long run of spaces, "#" or "(" in a heading line must not make the reading slow.
const headingOf = (s) => {
  const m = /^ {0,3}(#{1,6})[ \t](.*)$/.exec(s);
  if (!m) return null;
  let name = m[2].trim(), end = name.length;
  while (end && " \t#".includes(name[end - 1])) end--;
  name = name.slice(0, end);
  const open = name.endsWith(")") ? name.lastIndexOf("(") : -1;
  if (open > 0) name = name.slice(0, open).trim();
  return name ? { level: m[1].length, name: name.replace(/[:：]$/, "").replace(/[-_]/g, " ").split(/\s+/).filter(Boolean).join(" ").toLowerCase() } : null;
};
// The template's own hint sentences (older copies of docs/tasks/T00-template.md carry them as prose): a section that holds only these is unfilled.
const PLACEHOLDERS = [
  "One paragraph from the user's perspective: what works afterwards that does not work now.",
  "Numbered checks a Tester can run and a human can try on the preview, each with the sentence to try.",
  "What this task deliberately does not do, and where that goes instead.",
];
/** The lines of the first section with one of these names, up to the next heading of the same or a higher level; null when there is none. */
function section(lines, names) {
  const i = lines.findIndex((l) => names.includes(headingOf(l.s)?.name));
  if (i < 0) return null;
  const level = headingOf(lines[i].s).level, body = [];
  for (const l of lines.slice(i + 1)) { const h = headingOf(l.s); if (h && h.level <= level) break; body.push(l); }
  return body;
}
const filled = (body) => (body ?? []).filter((l) => l.s.trim() && !PLACEHOLDERS.includes(l.s.trim()) && !/^<[^>]*>$/.test(l.s.trim()));
const BULLET = /^(\s*)(?:[-*+]\s+|\d+[.)]\s*|[a-z][.)]\s+)(.*)$/i;
const isItem = (l) => { const m = BULLET.exec(l); return Boolean(m) && m[2].trim() !== "" && !/^\d+[.)]\d/.test(l.trim()); };

const ANSWERED = ["answered", "answered questions", "beantwortet", "beantwortete fragen"];
// A heading meant as the open questions but not one of the names: what stands under it would not be read as questions. Only a heading that as a whole is such
// a name ("Open points", "Open questions for …"), never one that merely contains the words; a bare "Questions" or "Fragen" can also be a topic of its own.
const MEANT_AS_QUESTIONS = /^(?:open|offene) (?:questions?|points?|issues?|fragen|punkte)(?: (?:for|to|für|an) .+)?$/;
const MAYBE_QUESTIONS = /^(?:questions|fragen)$/;
const NOTHING = /^(?:none|nothing|n\/a|no open questions|keine|keine offenen fragen|-|–)\.?$/i;
const MARKER = /^\((not blocking|blocking)\)/i;
const bare = (s) => s.replace(/`[^`]*`/g, "");
const saysBlocking = (s) => /\(blocking\)/i.test(bare(s));
const quote = (s) => s.trim().slice(0, 40);
const answers = (r) => { const m = /^Answer:\s*(.*)$/.exec(r); return Boolean(m) && m[1] !== "" && !/^(?:<|(?:tbd|todo|pending|open|\?+|…|\.\.\.)\.?$)/i.test(m[1].trim()); };
/** A line that is by itself a closed question: `[x]` before the marker, or struck through. */
const closedLine = (s) => { const t = (BULLET.exec(s)?.[2] ?? s).trim(); return /^\[[xX]\]\s*\((?:not )?blocking\)/i.test(t) || (t.startsWith("~~") && t.endsWith("~~") && t.length > 4); };
/** The line numbers under a heading "Answered questions": what stands there is closed. */
function answeredLines(lines) {
  const out = new Set();
  let level = 0;
  for (const l of lines) {
    const h = headingOf(l.s);
    if (h && level && h.level <= level) level = 0;
    if (h && !level && ANSWERED.includes(h.name)) level = h.level;
    if (level) out.add(l.n);
  }
  return out;
}

/** The one explicit form of an open question (docs/workflow.md, "Sharpen the ticket"), in a section "Open questions" (every such section is read, with its
 *  sub-headings; only "Answered questions" is skipped):
 *    - (blocking) <the question>            or            - (not blocking) <the question>
 *      Answer: <the answer, decided by the human, the date>
 *  The marker comes first and is exactly `(blocking)` or `(not blocking)`. A blocking question is answered by a line that starts with `Answer:` and holds a
 *  real answer, among the lines under it (indented, or following without a blank line); or it is checked (`[x] (blocking) …`), or struck through (`~~…~~`), or
 *  moved to a section "Answered questions". Nothing is passed over in silence: any other line that says `(blocking)`, anywhere in the ticket, and anything in
 *  these sections that is not clearly a closed question, is a problem that names its line. */
function openQuestions({ lines, fenced }) {
  const out = [], skip = answeredLines(lines), read = new Set(), ranges = [], items = [];
  const heads = lines.map((l, i) => ({ i, n: l.n, h: headingOf(l.s) })).filter((x) => x.h);
  for (const { i, n, h } of heads) {
    if (!SECTIONS.questions.names.includes(h.name)) {
      // The ticket's title (a level-1 first heading) is never meant as a section; another one is refused only when something stands under it that would be
      // lost: anything for a name meant as the open questions, a list item for a bare "Questions".
      const end = heads.find((x) => x.i > i && x.h.level <= h.level)?.i ?? lines.length;
      const held = () => filled(lines.slice(i + 1, end)).filter((l) => !headingOf(l.s) && !NOTHING.test((BULLET.exec(l.s)?.[2] ?? l.s).trim()));
      const lost = MEANT_AS_QUESTIONS.test(h.name) ? held().length > 0 : MAYBE_QUESTIONS.test(h.name) && held().some((l) => isItem(l.s));
      if (!skip.has(n) && !(n === heads[0].n && h.level === 1) && lost) out.push(`line ${n}: the heading "${quote(lines[i].s)}" looks like the open questions but is not read as them; name it "Open questions"`);
      continue;
    }
    if (ranges.some((r) => n > r.from && n < r.to)) continue;
    const next = heads.find((x) => x.i > i && x.h.level <= h.level);
    ranges.push({ from: n, to: next ? next.n : Infinity });
    let open = null;
    for (const l of lines.slice(i + 1, next ? next.i : lines.length)) {
      if (skip.has(l.n) || !filled([l]).length) continue;
      const sub = headingOf(l.s);
      if (sub) { open = null; if (sub.name.endsWith("?")) out.push(`line ${l.n}: a question written as a heading ("${quote(l.s)}")`); continue; }
      const m = BULLET.exec(l.s);
      const indent = m ? m[1].length : /^\s*/.exec(l.s)[0].length;
      if (isItem(l.s) && (!open || indent <= open.indent)) { open = { n: l.n, indent, text: m[2].trim(), rest: [], prev: l.n }; items.push(open); }
      else if (open && (indent > open.indent || l.n === open.prev + 1)) { open.rest.push(l.s.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "")); open.prev = l.n; }
      else if (!NOTHING.test(l.s.trim())) out.push(`line ${l.n} of the open questions is not a list item ("${quote(l.s)}")`);
    }
  }
  for (const it of items) {
    const whole = [it.text, ...it.rest].join(" ").trim();
    if (NOTHING.test(it.text.replace(/^\[[ xX]\]\s*/, ""))) {
      if (it.rest.length) out.push(`line ${it.n}: "${quote(it.text)}" has lines under it, so it is not clear that nothing is open`);
      continue;
    }
    if (whole.startsWith("~~") && whole.endsWith("~~") && whole.length > 4) { read.add(it.n); continue; }
    const checked = /^\[[xX]\]/.test(it.text), text = it.text.replace(/^\[[ xX]\]\s*/, ""), marker = MARKER.exec(text)?.[1].toLowerCase();
    if (!marker) { out.push(`line ${it.n}: an open question that starts with neither "(blocking)" nor "(not blocking)" ("${quote(text)}")`); read.add(it.n); continue; }
    if (checked || !saysBlocking(text.replace(MARKER, ""))) read.add(it.n);
    if (!checked && marker === "blocking" && !it.rest.some(answers)) out.push(`line ${it.n}: a blocking question without an "Answer:" line with an answer under it ("${quote(text)}")`);
  }
  for (const l of lines) if (!read.has(l.n) && !skip.has(l.n) && saysBlocking(l.s) && !closedLine(l.s)) out.push(`line ${l.n}: says "(blocking)" but is not read as an open question of its own ("${quote(l.s)}"); write it as its own item under "Open questions"`);
  for (const l of fenced) if (saysBlocking(l.s) && ranges.some((r) => l.n > r.from && l.n < r.to)) out.push(`line ${l.n}: a "(blocking)" question inside a code block of the open questions`);
  return out;
}
/** At most five of the open-question problems are named, the rest counted: a message stays readable and a huge ticket crashes nothing. */
const capped = (list) => (list.length > 5 ? [...list.slice(0, 5), `${list.length - 5} more problems in the open questions`] : list);

/** What is missing from a ticket for it to be ready to code, as short phrases; [] when nothing is. `status` (default: the ticket's own Status line) must be
 *  "ready". An assessment of "needs clarification" is never ready. Form only. */
export function readyProblems(text, { status } = {}) {
  const scanned = scan(text), { lines, unclosed } = scanned, out = [];
  const st = status ?? statusOf(text);
  if (st !== "ready") out.push(`its Status is ${st ? `"${st}"` : "missing"}, not "ready"`);
  const a = assessmentOf(text);
  if (!a) out.push("no assessment (`Assessed: <outcome>, <YYYY-MM-DD>` with a real date, once)");
  else if (!READY_OUTCOMES.includes(a.outcome)) out.push(`its assessment says "${a.outcome}"`);
  if (unclosed) out.push(`an unclosed "<!--" comment from line ${unclosed} hides the rest of the ticket`);
  if (!filled(section(lines, SECTIONS.goal.names)).length) out.push(asked("goal"));
  if (!filled(section(lines, SECTIONS.acceptance.names)).some((l) => isItem(l.s))) out.push(asked("acceptance"));
  if (!filled(section(lines, SECTIONS.limits.names)).length) out.push(asked("limits"));
  if (ticketLevel(text) === null) out.push("the architecture level (`Level: 1`, `2` or `3`, as its own line)");
  return out.concat(capped(openQuestions(scanned)));
}

/** The ticket's own Status states in which work on it has begun or ended: the readiness check never touches them (a worker may be running on it). */
export const STARTED = ["building", "review", "passed", "integrated", "paused"];
/** The project's setting, `steering.readyCheck`: "enforce" stops a ticket that is not ready to code, "warn" (also when the key is missing, so the check
 *  stops nothing in an existing project) only says so (the one thing steering/issues.mjs refuses in either setting is an issue that carries needs-info). Any other value counts as enforce: a typo must not switch the check off. */
export const readyMode = (config) => (config?.steering?.readyCheck ?? "warn") === "warn" ? "warn" : "enforce";
/** The gate at the moment a ticket would get a worker: { stop, message, problems }. stop only when the project enforces the check and the ticket is not ready
 *  to code. Never stopped: a ticket whose work has begun (`started`, or a Status in STARTED). `status` is the ticket's status where it is not in its text (issues:
 *  the label). The message is empty when nothing is missing. */
export function readyGate(id, text, { mode, started = false, reviewed = false, status } = {}) {
  const st = status ?? statusOf(text);
  const problems = started || STARTED.includes(st) ? [] : readyProblems(text, { status: st });
  if (!problems.length) return { stop: false, message: "", problems };
  const enforce = mode !== "warn" && !reviewed;
  return {
    stop: enforce, problems,
    message: `${id} is not ready to code: ${problems.join("; ")}. The Front agent's "sharpen the ticket" step fills this in (it assesses the ticket, writes the result into it and marks it ready). `
      + (reviewed ? "It is not stopped: its architecture spec review has passed, so work on it has begun."
        : enforce ? "steering.readyCheck is enforce, so the ticket is not taken: write it as \"Needs front agent\" in status.md and take the next ticket."
        : "steering.readyCheck is warn, so the ticket is still taken; to stop such tickets, set steering.readyCheck to \"enforce\" in factory.config.json, run `agentic-factory update` and `start` (do it once `agentic-factory status` lists no ticket as not ready to code)."),
  };
}

/** The one line a ready listing prints, every time, about what it left out: `[{ id, problems }]`. Short, so that it can stand in every cycle, and it lets a
 *  Controller whose status.md was rewritten (or that was restarted) write the line again. */
export const leftOutLine = (list) => `Left out of the ready list, not ready to code: ${list.map((t) => `${t.id} (${t.problems[0].split(" (a heading")[0].slice(0, 100)}${t.problems.length > 1 ? `, +${t.problems.length - 1} more` : ""})`).join("; ")}. Keep one line for each under "Needs front agent" in status.md for as long as it is left out (carry it into every rewrite; do not announce it again).`;
