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
  const lines = [];
  let fence = "";
  prose.split(/\r?\n/).forEach((s, i) => {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(s);
    if (fence) { if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = ""; return; }
    if (m) { fence = m[1]; return; }
    lines.push({ n: i + 1, s });
  });
  return { lines, unclosed };
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
const headingOf = (s) => {
  const m = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(s);
  return m ? { level: m[1].length, name: m[2].replace(/\s*\([^)]*\)\s*$/, "").replace(/[:：]\s*$/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase() } : null;
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

/** The one explicit form of an open question (docs/workflow.md, "Sharpen the ticket"), in the section "Open questions":
 *    - (blocking) <the question>            or            - (not blocking) <the question>
 *      Answer: <the answer, decided by the human, the date>
 *  The marker comes first and is exactly `(blocking)` or `(not blocking)`. A blocking question is answered by a line that starts with `Answer:` and holds
 *  text, among the lines under it (indented, or following without a blank line); or it is checked `[x]`, or struck through (`~~…~~`), or moved to a section
 *  "Answered questions". Anything else that is not clearly a closed question is a problem that names its line: unclear means not ready. */
function openQuestions(lines) {
  const body = filled(section(lines, SECTIONS.questions.names)), out = [];
  const items = [];
  for (const l of body) {
    if (headingOf(l.s)) break;   // a sub-heading ("### Answered") ends the open ones
    const m = BULLET.exec(l.s);
    const indent = m ? m[1].length : /^\s*/.exec(l.s)[0].length;
    const open = items.at(-1);
    if (isItem(l.s) && (!open || indent <= open.indent)) items.push({ n: l.n, indent, text: m[2].trim(), rest: [], prev: l.n });
    else if (open && (indent > open.indent || l.n === open.prev + 1)) { open.rest.push(l.s.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "")); open.prev = l.n; }
    else if (!/^(none|nothing|no open questions|keine)\.?$/i.test(l.s.trim())) out.push(`line ${l.n} of the open questions is not a list item ("${l.s.trim().slice(0, 40)}")`);
  }
  for (const it of items) {
    const whole = [it.text, ...it.rest].join(" ");
    if (/^\[[xX]\]/.test(it.text) || /^~~.*~~$/.test(whole.trim())) continue;
    const text = it.text.replace(/^\[ \]\s*/, "");
    const marker = /^\((not blocking|blocking)\)/i.exec(text)?.[1].toLowerCase();
    if (!marker) out.push(`line ${it.n}: an open question that starts with neither "(blocking)" nor "(not blocking)" ("${text.slice(0, 40)}")`);
    else if (marker === "blocking" && !it.rest.some((r) => /^Answer:\s*\S/.test(r))) out.push(`line ${it.n}: a blocking question without an "Answer:" line under it ("${text.slice(0, 40)}")`);
  }
  return out;
}

/** What is missing from a ticket for it to be ready to code, as short phrases; [] when nothing is. `status` (default: the ticket's own Status line) must be
 *  "ready". An assessment of "needs clarification" is never ready. Form only. */
export function readyProblems(text, { status } = {}) {
  const { lines, unclosed } = scan(text), out = [];
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
  out.push(...openQuestions(lines));
  return out;
}

/** The ticket's own Status states in which work on it has begun or ended: the readiness check never touches them (a worker may be running on it). */
export const STARTED = ["building", "review", "passed", "integrated", "paused"];
/** The project's setting, `steering.readyCheck`: "enforce" stops a ticket that is not ready to code, "warn" (also when the key is missing, so `update` never
 *  stops an existing project) only says so. Any other value counts as enforce: a typo must not switch the check off. */
export const readyMode = (config) => (config?.steering?.readyCheck ?? "warn") === "warn" ? "warn" : "enforce";
/** The gate at the moment a ticket would get a worker: { stop, message, problems }. stop only when the project enforces the check and the ticket is not ready
 *  to code. Never stopped: a ticket whose work has begun (`started`, or a Status in STARTED). `status` is the ticket's status where it is not in its text (issues:
 *  the label). The message is empty when nothing is missing. */
export function readyGate(id, text, { mode, started = false, status } = {}) {
  const st = status ?? statusOf(text);
  const problems = started || STARTED.includes(st) ? [] : readyProblems(text, { status: st });
  if (!problems.length) return { stop: false, message: "", problems };
  const enforce = mode !== "warn";
  return {
    stop: enforce, problems,
    message: `${id} is not ready to code: ${problems.join("; ")}. The Front agent's "sharpen the ticket" step fills this in (it assesses the ticket, writes the result into it and marks it ready). `
      + (enforce ? "steering.readyCheck is enforce, so the ticket is not taken: write it as \"Needs front agent\" in status.md and take the next ticket."
        : "steering.readyCheck is warn, so the ticket is still taken; to stop such tickets, set steering.readyCheck to \"enforce\" in factory.config.json, run `agentic-factory update` and `start` (do it once `agentic-factory status` lists no ticket as not ready to code)."),
  };
}
