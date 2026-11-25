// What a ticket must show before the Controller takes it: the form check behind the Front agent's "sharpen the ticket" step.
// Pure functions on the ticket's text, no configuration and no file access, so the steering scripts, mkspec.mjs, lib.mjs and `agentic-factory status` all read
// a ticket the same way. The check sees form, never quality: it cannot tell a good acceptance criterion from a vague one (docs/workflow.md, "Sharpen the ticket").

/** The ticket's prose only: not an HTML comment, not a fenced code block (the same reading as declaredProblem in lib.mjs). */
export function proseLines(text) {
  const prose = String(text).replace(/<!--[\s\S]*?(-->|$)/g, ""), kept = [];
  let fence = "";
  for (const l of prose.split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (fence) { if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = ""; continue; }
    if (m) { fence = m[1]; continue; }
    kept.push(l);
  }
  return kept;
}

/** The change level a ticket states (1, 2 or 3), from its prose only (as declaredProblem). Every `Level:` line must read `Level: <1|2|3>`; with
 *  several (a ticket repeats it under "Architecture impact") the highest counts. null when there is none or one is not a plain level
 *  (an unfilled template `Level: 1 | 2 | 3`): unknown, which a caller treats as the highest. */
export function ticketLevel(text) {
  const lines = proseLines(text).filter((l) => /^level:/i.test(l));
  if (!lines.length) return null;
  const levels = lines.map((l) => /^Level: ([123])[ \t]*$/.exec(l)?.[1]);
  return levels.some((v) => !v) ? null : Math.max(...levels.map(Number));
}

/** The outcomes of the Front agent's assessment. `needs clarification` is the one that is not ready to code. */
export const OUTCOMES = ["ready as written", "ready after gaps closed from context", "needs clarification"];
export const READY_OUTCOMES = OUTCOMES.slice(0, 2);
const ASSESSED = /^Assessed:[ \t]*(.+?),[ \t]*(\d{4}-\d{2}-\d{2})[ \t]*$/;
/** The ticket's `Assessed: <outcome>, <YYYY-MM-DD>` line: { outcome, date }, or null when there is none or not exactly one of this form. */
export function assessmentOf(text) {
  const lines = proseLines(text).filter((l) => /^assessed:/i.test(l));
  const m = lines.length === 1 ? ASSESSED.exec(lines[0]) : null;
  return m && OUTCOMES.includes(m[1].trim().toLowerCase()) ? { outcome: m[1].trim().toLowerCase(), date: m[2] } : null;
}

// The template's own hint sentences (older copies of docs/tasks/T00-template.md carry them as prose): a section that holds only these is unfilled.
const PLACEHOLDERS = [
  "One paragraph from the user's perspective: what works afterwards that does not work now.",
  "Numbered checks a Tester can run and a human can try on the preview, each with the sentence to try.",
  "What this task deliberately does not do, and where that goes instead.",
];
// Heading names a section is known by. The T00 names first; the others are what to-tickets writes into an issue.
const SECTIONS = {
  goal: ["goal", "what to build"],
  acceptance: ["observable acceptance", "acceptance criteria", "acceptance"],
  limits: ["out of scope", "not in scope", "limits"],
  questions: ["open questions"],
};
/** The body lines of the first `## <name>` section (any of the names, any case), up to the next `## ` heading; null when there is none. */
function section(lines, names) {
  const start = lines.findIndex((l) => { const m = /^## +(.+?)[ \t:]*$/.exec(l); return m && names.includes(m[1].toLowerCase()); });
  if (start < 0) return null;
  const rest = lines.slice(start + 1), end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).map((l) => l.trim()).filter((l) => l && !PLACEHOLDERS.includes(l) && !/^<[^>]*>$/.test(l));
}
const isItem = (l) => /^(\d+[.)]|[-*])\s+\S/.test(l);

/** What is missing from a ticket for it to be ready to code, as short phrases; [] when nothing is. An assessment of "needs clarification" is never ready. Form only. */
export function readyProblems(text) {
  const lines = proseLines(text), out = [];
  const a = assessmentOf(text);
  if (!a) out.push("no assessment (`Assessed: <outcome>, <YYYY-MM-DD>`)");
  else if (!READY_OUTCOMES.includes(a.outcome)) out.push(`its assessment says "${a.outcome}"`);
  const goal = section(lines, SECTIONS.goal), acc = section(lines, SECTIONS.acceptance), lim = section(lines, SECTIONS.limits);
  if (!goal?.length) out.push("a goal");
  if (!acc?.some(isItem)) out.push("acceptance criteria (a numbered or bulleted list)");
  if (!lim?.length) out.push("the limits (\"Out of scope\")");
  if (ticketLevel(text) === null) out.push("the architecture level (`Level: 1`, `2` or `3`)");
  const blocking = (section(lines, SECTIONS.questions) ?? []).filter((l) => isItem(l) && /\bblocking\b/i.test(l) && !/\b(not|non)[- ]blocking\b/i.test(l) && !/^[-*]\s*\[x\]/i.test(l) && !/\b(answer(ed)?|resolved|decided):/i.test(l));
  if (blocking.length) out.push(`${blocking.length} unanswered blocking open question${blocking.length > 1 ? "s" : ""}`);
  return out;
}

/** The ticket's own Status states in which work on it has begun or ended: the readiness check never touches them (a worker may be running on it). */
export const STARTED = ["building", "review", "passed", "integrated", "paused"];
/** The project's setting, `steering.readyCheck`: "enforce" stops a ticket that is not ready to code, "warn" (also when the key is missing, so `update` never
 *  stops an existing project) only says so. Any other value counts as enforce: a typo must not switch the check off. */
export const readyMode = (config) => (config?.steering?.readyCheck ?? "warn") === "warn" ? "warn" : "enforce";
/** The gate at the moment a ticket would get a worker: { stop, message }. stop only when the project enforces the check and the ticket is not ready to code;
 *  `started` (work on it has begun: never stopped) turns it off. The message is empty when nothing is missing. */
export function readyGate(id, text, { mode, started = false }) {
  const problems = started ? [] : readyProblems(text);
  if (!problems.length) return { stop: false, message: "" };
  const enforce = mode !== "warn";
  return {
    stop: enforce,
    message: `${id} is not ready to code: missing ${problems.join("; ")}. The Front agent's "sharpen the ticket" step fills this in (it assesses the ticket, writes the result into it and marks it ready). `
      + (enforce ? "steering.readyCheck is enforce, so the ticket is not taken: write it as \"Needs front agent\" in status.md and take the next ticket."
        : "steering.readyCheck is warn, so the ticket is still taken; set it to enforce in factory.config.json once your tickets are sharpened."),
  };
}
