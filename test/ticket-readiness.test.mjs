// The "sharpen the ticket" step's check by code: what a ticket must show before the Controller takes it (controller/ticket.mjs), where it runs
// (steering/tasks.mjs, steering/issues.mjs, templates/mkspec.mjs), what it never stops, and the rendered text of the step.
import "./support/safe-env.mjs";
import { tempDir } from "./support/cleanup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assessmentOf, readyGate, readyMode, readyProblems, ticketLevel } from "../controller/ticket.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLI = path.join(ROOT, "bin/agentic-factory.mjs");

// A ticket that passes: every part the check reads, in the T00 form.
const parts = {
  status: "Status: ready",
  assessed: "Assessed: ready as written, 2026-11-25",
  goal: "## Goal\n\nA user can export the list as a file.\n",
  acceptance: "## Observable acceptance\n\n1. Choose export, a file with every row downloads.\n2. An empty list downloads a file with the header only.\n",
  limits: "## Out of scope\n\nImport. It goes to T09.\n",
  level: "## Architecture impact\n\nLevel: 1\nOne route.\n",
  questions: "## Open questions\n\n- (not blocking) Which date format?\n",
};
const ticket = (omit = [], over = {}) => {
  const p = { ...parts, ...over };
  return `# T05: Export\n\n${p.status}\nDepends on: nothing\n${p.assessed}\n\n${["goal", "acceptance", "limits", "level", "questions"].filter((k) => !omit.includes(k)).map((k) => p[k]).join("\n")}`.replace(/\n\n\n+/g, "\n\n");
};
const withQuestions = (items) => ticket([], { questions: `## Open questions\n\n${items}\n` });

test("a sharpened ticket is ready, and each missing part is named with the headings looked for", () => {
  assert.deepEqual(readyProblems(ticket()), []);
  assert.match(readyProblems(ticket([], { assessed: "" })).join(), /no assessment/);
  assert.match(readyProblems(ticket(["goal"])).join(), /a goal \(a heading "Goal", "What to build", "Ziel"/);
  assert.match(readyProblems(ticket(["acceptance"])).join(), /acceptance criteria \(a list\) \(a heading "Observable acceptance"/);
  assert.match(readyProblems(ticket(["limits"])).join(), /the limits \(a heading "Out of scope"/);
  assert.match(readyProblems(ticket(["level"])).join(), /architecture level/);
  assert.equal(readyProblems(ticket(["goal", "limits", "level"], { assessed: "" })).length, 4);
});

test("the unfilled template is not ready: comments, hint sentences, a prose paragraph and `Level: 1 | 2 | 3` do not count", () => {
  const template = fs.readFileSync(path.join(ROOT, "templates/docs/tasks/T00-template.md"), "utf8");
  assert.equal(readyProblems(template).length, 6, readyProblems(template).join("; "));
  const old = "Status: ready\nAssessed: ready as written, 2026-11-25\nLevel: 1\n## Goal\n\nOne paragraph from the user's perspective: what works afterwards that does not work now.\n\n## Observable acceptance\n\nNumbered checks a Tester can run and a human can try on the preview, each with the sentence to try.\n\n## Out of scope\n\nWhat this task deliberately does not do, and where that goes instead.\n";
  assert.match(readyProblems(old).join(), /a goal.*acceptance criteria.*the limits/);
  assert.match(readyProblems(ticket([], { acceptance: "## Observable acceptance\n\nIt should work well.\n" })).join(), /acceptance criteria/);
  assert.equal(ticketLevel("Level: 1 | 2 | 3"), null);
  assert.match(readyProblems(ticket(["goal"], { limits: "```\n## Goal\ntext\n```\n<!-- ## Goal\ntext -->\n## Out of scope\n\nNone.\n" })).join(), /a goal/);
});

test("the template still tells how to declare a documentation ticket, and a ticket that follows it is read as one", () => {
  const template = fs.readFileSync(path.join(ROOT, "templates/docs/tasks/T00-template.md"), "utf8");
  assert.match(template, /<!-- Documentation only: yes -- add this line \(and `Level: 1` below\) ONLY when the result is Markdown or images/);
  assert.match(template, /^Assessed: /m);
});

test("the assessment must be one line with a ready outcome and a real date", () => {
  assert.deepEqual(assessmentOf("Assessed: ready after gaps closed from context, 2026-01-02"), { outcome: "ready after gaps closed from context", date: "2026-01-02" });
  assert.equal(assessmentOf("Assessed: ready as written"), null, "no date");
  assert.equal(assessmentOf("Assessed: ready as written, 2026-13-99"), null, "no real date");
  assert.equal(assessmentOf("Assessed: ready as written, 2026-02-30"), null, "no real date");
  assert.equal(assessmentOf("Assessed: probably fine, 2026-01-02"), null, "not an outcome");
  assert.equal(assessmentOf("Assessed: ready as written, 2026-01-02\nAssessed: ready as written, 2026-01-03"), null, "two lines");
  assert.equal(assessmentOf("```\nAssessed: ready as written, 2026-01-02\n```"), null, "in a code block");
  assert.match(readyProblems(ticket([], { assessed: "Assessed: needs clarification, 2026-11-25" })).join(), /says "needs clarification"/);
  assert.match(readyProblems(ticket([], { assessed: "Assessed: <ready as written | needs clarification>, <YYYY-MM-DD>" })).join(), /no assessment/);
});

test("Status must be ready: needs-info, draft or no Status is not ready to code, and a started ticket is never stopped", () => {
  assert.match(readyProblems(ticket([], { status: "Status: needs-info" })).join(), /its Status is "needs-info", not "ready"/);
  assert.match(readyProblems(ticket([], { status: "Status: draft" })).join(), /"draft"/);
  assert.match(readyProblems(ticket([], { status: "" })).join(), /Status is missing/);
  const g = readyGate("T05", ticket([], { status: "Status: needs-info" }), { mode: "enforce" });
  assert.equal(g.stop, true);
  assert.match(g.message, /T05 is not ready to code: its Status is "needs-info"/);
  assert.equal(readyGate("T05", ticket([], { status: "Status: building" }).replace(/Level: 1/, ""), { mode: "enforce" }).stop, false);
  assert.equal(readyGate("#7", ticket(), { mode: "enforce", status: "needs-info" }).stop, true, "an issue's status comes from its labels");
  assert.equal(readyGate("#7", ticket(), { mode: "enforce", status: "ready" }).stop, false);
});

test("open questions have one explicit form; a blocking one is closed by an Answer line under it, [x], strike-through or the answered section", () => {
  const ok = [
    "- (blocking) Who may export?\n  Answer: admins, decided by the owner, 2026-11-25",
    "- (blocking) Who may export?\n\n  Answer: admins",
    "- (blocking) Who may export?\n  - Answer: admins",
    "- (blocking) Who may export?\nAnswer: admins",
    "- [x] (blocking) Who may export?",
    "- ~~(blocking) Who may export?~~",
    "- ~~(blocking) Who\n  may export?~~",
    "- (not blocking) Who?",
    "- [ ] (not blocking) Who?",
    "1. (blocking) Who?\n   Answer: nobody",
    "None.",
    "- (not blocking) Who?\n\n### Answered questions\n\n- (blocking) Which db?\n  Answer: postgres\n- anything at all",
  ];
  for (const items of ok) assert.deepEqual(readyProblems(withQuestions(items)), [], items);
  assert.deepEqual(readyProblems(ticket(["questions"])), [], "no such section: an old ticket never had one");
  assert.deepEqual(readyProblems(ticket([], { goal: "## Goal\n\nUnblocks the blocking export.\n" })), []);
  const bad = {
    "- (blocking) Who may export?": /line \d+: a blocking question without an "Answer:" line under it/,
    "- (blocking) Who?\n  Answer:": /blocking question without an "Answer:"/,
    "- (blocking) Who?\n\nAnswer: admins": /not a list item/,
    "- (blocking: no) colour?": /line \d+: an open question that starts with neither "\(blocking\)" nor "\(not blocking\)"/,
    "- colour, not a blocking issue": /starts with neither/,
    "- **Blocker:** which DB?": /starts with neither/,
    "- Welche DB? (blockierend)": /starts with neither/,
    "Which DB? (blocking)": /not a list item/,
    "- Which DB? (blocking)": /starts with neither/,
    "- This is blocking, no wait, not blocking: colour": /starts with neither/,
  };
  for (const [items, re] of Object.entries(bad)) assert.match(readyProblems(withQuestions(items)).join("\n"), re, items);
  // the message names the line (counted in the ticket text)
  const text = withQuestions("- (not blocking) fine\n- (blocking) which DB?");
  assert.match(readyProblems(text).join(), new RegExp(`line ${text.split("\n").findIndex((l) => l.includes("which DB")) + 1}:`));
});

test("headings: levels 1 to 6, hyphens, a parenthetical, tabs, German and to-tickets names are accepted; a hidden section is reported", () => {
  const body = (h) => `Status: ready\nAssessed: ready as written, 2026-11-25\nLevel: 2\n\n${h.goal}\n\nx goal text\n\n${h.acc}\n\n1. a\n\n${h.lim}\n\nNone.\n`;
  for (const h of [
    { goal: "### Goal", acc: "### Observable acceptance", lim: "### Out of scope" },
    { goal: "# Goal", acc: "# Acceptance criteria", lim: "# Not in scope" },
    { goal: "## Ziel", acc: "## Abnahme", lim: "## Nicht im Umfang" },
    { goal: "## Ziel", acc: "## Abnahmekriterien", lim: "## Abgrenzung" },
    { goal: "## What to build", acc: "## Acceptance criteria", lim: "## Non-goals" },
    { goal: "## Goal (user view)", acc: "## Acceptance:", lim: "## Out-of-scope" },
    { goal: "##\tGoal", acc: "###### Acceptance", lim: "## LIMITS ##" },
  ]) assert.deepEqual(readyProblems(body(h)), [], JSON.stringify(h));
  for (const list of ["a) one", "+ one", "1.one", "- [ ] one", "* one", "1) one"]) assert.deepEqual(readyProblems(`${body({ goal: "## Goal", acc: "## Acceptance", lim: "## Out of scope" }).replace("1. a", list)}`), [], list);
  const hidden = readyProblems("Status: ready\nAssessed: ready as written, 2026-11-25\nLevel: 1\n<!-- oops\n## Goal\n\nx\n");
  assert.match(hidden.join(), /unclosed "<!--" comment from line 4/);
  assert.match(readyProblems(body({ goal: "## Aim", acc: "## Acceptance", lim: "## Out of scope" })).join(), /a heading "Goal"/);
  assert.deepEqual(readyProblems(body({ goal: "## Goal", acc: "## Acceptance", lim: "## Out of scope" }).replace(/\n/g, "\r\n")), [], "CRLF");
  assert.deepEqual(readyProblems(`﻿${body({ goal: "## Goal", acc: "## Acceptance", lim: "## Out of scope" })}`), [], "a BOM");
});

test("mode: warn when the key is missing, enforce otherwise (a typo does not switch the check off)", () => {
  assert.equal(readyMode({}), "warn");
  assert.equal(readyMode({ steering: { readyCheck: "warn" } }), "warn");
  assert.equal(readyMode({ steering: { readyCheck: "enforce" } }), "enforce");
  assert.equal(readyMode({ steering: { readyCheck: "enfroce" } }), "enforce");
  const bad = ticket(["limits"]);
  assert.equal(readyGate("T05", bad, { mode: "warn" }).stop, false);
  assert.match(readyGate("T05", bad, { mode: "warn" }).message, /T05 is not ready to code: the limits.*sharpen the ticket.*still taken.*set steering.readyCheck to "enforce".*update.*start/);
  const g = readyGate("T05", bad, { mode: "enforce" });
  assert.equal(g.stop, true);
  assert.match(g.message, /the limits.*Front agent's "sharpen the ticket" step fills this in.*not taken/);
  assert.deepEqual(readyGate("T05", bad, { mode: "enforce", started: true }), { stop: false, message: "", problems: [] });
  assert.deepEqual(readyGate("T05", ticket(), { mode: "enforce" }), { stop: false, message: "", problems: [] });
});

// --- the scripts ---------------------------------------------------------------------------------------------------------------------

function controller(steering) {
  const dir = tempDir("af-ready-"), ctl = path.join(dir, "ctl"), project = path.join(dir, "p"), bin = path.join(dir, "bin");
  for (const d of [path.join(ctl, "steering"), path.join(ctl, "templates"), path.join(project, "docs/tasks"), bin]) fs.mkdirSync(d, { recursive: true });
  for (const f of ["lib.mjs", "cli.mjs", "ticket.mjs", "steering/tasks.mjs", "steering/issues.mjs", "templates/mkspec.mjs"]) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(ctl, f));
  fs.writeFileSync(path.join(ctl, "factory.config.json"), JSON.stringify({ project: { name: "p", mainBranch: "main", humanName: "Alex" }, agents: { runner: "orca" }, commands: {}, steering, hosts: { controller: { host: "local" }, workers: [{ name: "local", kind: "local", projectDir: project }] } }));
  const run = (script, ...args) => spawnSync("node", [path.join(ctl, script), ...args], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const task = (name, text) => fs.writeFileSync(path.join(project, "docs/tasks", `${name}.md`), text);
  const status = (name) => /^Status:\s*(\S+)/m.exec(fs.readFileSync(path.join(project, "docs/tasks", `${name}.md`), "utf8"))[1];
  return { dir, ctl, project, bin, run, task, status };
}
const ids = (r) => JSON.parse(r.stdout).map((t) => t.id);

test("tasks: with enforce a ready ticket that is not ready to code is left out, with the reason once; warn and a missing key list it", () => {
  for (const [steering, listed] of [[{ tasksDir: "docs/tasks", readyCheck: "enforce" }, ["T01"]], [{ readyCheck: "warn" }, ["T01", "T02", "T03"]], [{}, ["T01", "T02", "T03"]]]) {
    const c = controller(steering);
    c.task("T01-sharp", ticket());
    c.task("T02-no-limits", ticket(["limits"]));
    c.task("T03-old", "# T03\n\nStatus: ready\nDepends on: nothing\n\n## Goal\n\nSomething.\n");
    const r = c.run("steering/tasks.mjs", "list", "ready");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(ids(r), listed, JSON.stringify(steering));
    if (listed.length === 1) {
      assert.match(r.stderr, /T02 is not ready to code: the limits[\s\S]*T03 is not ready to code: no assessment/);
      // the second listing (the next cycle) does not repeat it
      assert.equal(c.run("steering/tasks.mjs", "list", "ready").stderr, "");
    } else assert.equal(r.stderr, "", "warn says nothing when it only lists");
  }
});

test("tasks: the heartbeat's environment neither prints nor uses up the note", () => {
  const c = controller({ readyCheck: "enforce" });
  c.task("T02-no-limits", ticket(["limits"]));
  const quiet = spawnSync("node", [path.join(c.ctl, "steering/tasks.mjs"), "list", "ready"], { encoding: "utf8", env: { ...process.env, FACTORY_NO_NOTES: "1" } });
  assert.equal(quiet.stderr, "");
  assert.match(c.run("steering/tasks.mjs", "list", "ready").stderr, /T02 is not ready to code/, "the Controller's own call still gets it");
});

test("tasks: a ticket in progress is untouched whatever the setting; needs-info and draft are never taken", () => {
  const c = controller({ readyCheck: "enforce" });
  c.task("T01-building", "# T01\n\nStatus: building\n\nno sections at all\n");
  c.task("T02-review", "# T02\n\nStatus: review\n");
  c.task("T03-needs-info", ticket([], { status: "Status: needs-info", assessed: "Assessed: needs clarification, 2026-11-25" }));
  c.task("T04-complete-but-needs-info", ticket([], { status: "Status: needs-info" }));
  c.task("T05-draft", ticket([], { status: "Status: draft" }));
  assert.deepEqual(ids(c.run("steering/tasks.mjs", "list", "building")), ["T01"]);
  assert.deepEqual(ids(c.run("steering/tasks.mjs", "list", "needs-info")), ["T03", "T04"]);
  assert.deepEqual(ids(c.run("steering/tasks.mjs", "list", "ready")), [], "a needs-info ticket is not ready");
  assert.equal(c.run("steering/tasks.mjs", "set", "T01", "building").status, 0);
  assert.equal(c.run("steering/tasks.mjs", "set", "T02", "building").status, 0, "already past building");
  for (const t of ["T04", "T05"]) {
    const r = c.run("steering/tasks.mjs", "set", t, "building");
    assert.equal(r.status, 1, t);
    assert.match(r.stderr, /its Status is "(needs-info|draft)", not "ready"/);
  }
  assert.equal(c.status("T04-complete-but-needs-info"), "needs-info");
});

test("tasks: set building and check", () => {
  const c = controller({ readyCheck: "enforce" });
  c.task("T01-sharp", ticket());
  c.task("T02-thin", ticket(["acceptance", "level"]));
  const check = c.run("steering/tasks.mjs", "check", "T02");
  assert.equal(check.status, 1);
  assert.equal(JSON.parse(check.stdout).problems.length, 2);
  assert.equal(c.run("steering/tasks.mjs", "check", "T01").status, 0);
  const refused = c.run("steering/tasks.mjs", "set", "T02", "building");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /T02 is not ready to code/);
  assert.equal(c.status("T02-thin"), "ready", "the file is not changed");
  assert.equal(c.run("steering/tasks.mjs", "set", "T01", "building").status, 0);
  assert.equal(c.status("T01-sharp"), "building");
  const w = controller({});
  w.task("T02-thin", ticket(["acceptance"]));
  const done = w.run("steering/tasks.mjs", "set", "T02", "building");
  assert.equal(done.status, 0);
  assert.match(done.stderr, /not ready to code[\s\S]*steering.readyCheck is warn/);
  assert.equal(w.status("T02-thin"), "building");
});

test("mkspec: the first Developer or Architect spec for a ticket file is refused with enforce; a restart, a started ticket, a spec review and warn are not", () => {
  const c = controller({ readyCheck: "enforce" });
  c.task("T05-thin", ticket(["limits"]));
  c.task("T06-sharp", ticket());
  c.task("T07-building", "# T07\n\nStatus: building\n");
  c.task("T10-needs-info", ticket([], { status: "Status: needs-info" }));
  const mk = (...a) => c.run("templates/mkspec.mjs", ...a);
  for (const role of ["dev", "specreview"]) {
    const r = mk(role, "T05", "docs/tasks/T05-thin.md", "agents/t05");
    assert.equal(r.status, 1, role);
    assert.match(r.stderr, /T05 is not ready to code: the limits/);
    assert.equal(fs.existsSync(path.join(c.ctl, "specs", `t05-${role}.txt`)), false, "no spec was written");
    assert.equal(mk(role, "T06", "docs/tasks/T06-sharp.md", "agents/t06").status, 0, role);
    assert.equal(mk(role, "T07", "docs/tasks/T07-building.md", "agents/t07").status, 0, `${role}: a ticket in progress`);
    const ni = mk(role, "T10", "docs/tasks/T10-needs-info.md", "agents/t10");
    assert.equal(ni.status, 1, `${role}: needs-info`);
    assert.match(ni.stderr, /its Status is "needs-info"/);
  }
  assert.equal(mk("dev", "T06", "docs/tasks/T06-sharp.md", "agents/t06", "--extra", "answer").status, 0);
  c.task("T06-sharp", ticket(["limits"]));
  const restart = mk("dev", "T06", "docs/tasks/T06-sharp.md", "agents/t06", "--extra", "answer");
  assert.equal(restart.status, 0, restart.stderr);
  assert.equal(restart.stderr, "");
  // a ticket changed after its architecture spec review: the dev spec carries the review, so it is not stopped halfway
  const mid = mk("dev", "T05", "docs/tasks/T05-thin.md", "agents/t05", "--review", "agents/t05-specreview:docs/reviews/T05-architecture-spec.md");
  assert.equal(mid.status, 0, mid.stderr);
  assert.match(mk("dev", "T08", "docs/tasks/T08-none.md", "agents/t08").stderr, /cannot be read/);
  assert.equal(mk("dev", "T08", "docs/tasks/T08-none.md", "agents/t08").status, 1);
  assert.equal(mk("test", "T05", "docs/tasks/T05-thin.md", "agents/t05", "abc").status, 0);
  assert.equal(mk("rework", "T05", "1", "docs/tasks/T05-thin.md", "agents/t05", "--reason", "x").status, 0);
  const w = controller({});
  w.task("T05-thin", ticket(["limits"]));
  const warned = w.run("templates/mkspec.mjs", "dev", "T05", "docs/tasks/T05-thin.md", "agents/t05");
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /T05 is not ready to code: the limits[\s\S]*is still taken/);
  assert.equal(w.run("templates/mkspec.mjs", "dev", "T09", "docs/tasks/T09-none.md", "agents/t09").stderr, "", "warn is silent about a ticket it cannot read");
});

const issueNode = (number, body, labels = ["ready-for-agent"]) => ({ number, title: `issue ${number}`, body, assignees: { nodes: [] }, labels: { nodes: labels.map((name) => ({ name })) }, issueDependenciesSummary: { blockedBy: 0 } });
function ghStub(c, nodes) {
  const log = path.join(c.dir, "gh.log");
  fs.writeFileSync(path.join(c.bin, "gh"), `#!/usr/bin/env node
import fs from "node:fs";
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
const nodes = ${JSON.stringify(nodes)};
if (a[0] === "api") console.log(JSON.stringify({ data: { repository: { issues: { nodes } } } }));
else if (a[0] === "issue" && a[1] === "view") { const n = nodes.find((x) => String(x.number) === a[2]); if (!n) process.exit(1); console.log(JSON.stringify({ body: n.body, labels: n.labels.nodes })); }
else console.log("ok");`, { mode: 0o755 });
  return () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
}
const issueBody = (omit = [], over = {}) => ticket(omit, over).replace(/^# .*\n\nStatus: ready\n/, "");

test("issues: the labels are the status; ready leaves a not-ready issue out and claim refuses it before anything changes, with enforce", () => {
  const c = controller({ readyCheck: "enforce" });
  const calls = ghStub(c, [issueNode(1, issueBody()), issueNode(2, issueBody(["limits"])), issueNode(3, "Level 2"), issueNode(4, issueBody(["limits"]), ["in-progress"]),
    issueNode(5, issueBody(), ["ready-for-agent", "needs-info"]), issueNode(6, issueBody(), [])]);
  const ready = c.run("steering/issues.mjs", "ready");
  assert.equal(ready.status, 0, ready.stderr);
  assert.deepEqual(JSON.parse(ready.stdout).map((i) => i.number), [1, 4], "the JSON shape is the one the heartbeat reads (the real query is label-filtered, so 4, in progress, would not be in it; the stub lists it and the check does not stop it)");
  assert.match(ready.stderr, /#2 is not ready to code: the limits/);
  assert.match(ready.stderr, /#3 is not ready to code/);
  assert.match(ready.stderr, /#5 is not ready to code: its Status is "needs-info"/);
  for (const n of ["2", "5", "6"]) {
    const refused = c.run("steering/issues.mjs", "claim", n);
    assert.equal(refused.status, 1, n);
    assert.match(refused.stderr, new RegExp(`#${n} is not ready to code`));
  }
  assert.match(c.run("steering/issues.mjs", "claim", "6").stderr, /its Status is "unlabelled", not "ready"/);
  assert.equal(calls().some((a) => a[0] === "issue" && a[1] === "edit"), false, "nothing was relabelled or assigned");
  assert.equal(c.run("steering/issues.mjs", "claim", "1").status, 0);
  assert.equal(calls().filter((a) => a[0] === "issue" && a[1] === "edit").length, 1);
  assert.equal(c.run("steering/issues.mjs", "claim", "4").status, 0, "an issue already in progress is never stopped");
  const missing = c.run("steering/issues.mjs", "claim", "99");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot be read/);
});

test("issues: with warn (or no key) the issue is listed and claimed, with the message", () => {
  const c = controller({});
  const calls = ghStub(c, [issueNode(2, issueBody(["limits"]))]);
  const ready = c.run("steering/issues.mjs", "ready");
  assert.deepEqual(JSON.parse(ready.stdout).map((i) => i.number), [2]);
  assert.equal(ready.stderr, "");
  const claim = c.run("steering/issues.mjs", "claim", "2");
  assert.equal(claim.status, 0, claim.stderr);
  assert.match(claim.stderr, /#2 is not ready to code: the limits[\s\S]*steering.readyCheck is warn/);
  assert.equal(calls().filter((a) => a[0] === "issue" && a[1] === "edit").length, 1);
});

test("lib.mjs has no reading of its own: its ticketLevel is the one of ticket.mjs", () => {
  const lib = fs.readFileSync(path.join(ROOT, "controller/lib.mjs"), "utf8");
  assert.match(lib, /export \{ ticketLevel \} from "\.\/ticket\.mjs";/);
  assert.doesNotMatch(lib, /function proseLines|function ticketLevel/);
  const dir = tempDir("af-ticket-lib-");
  fs.mkdirSync(path.join(dir, "ctl"));
  for (const f of ["lib.mjs", "cli.mjs", "ticket.mjs"]) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(dir, "ctl", f));
  fs.writeFileSync(path.join(dir, "ctl/factory.config.json"), JSON.stringify({ project: { name: "p" }, commands: {}, hosts: { controller: { host: "local" }, workers: [] } }));
  const out = spawnSync("node", ["--input-type=module", "-e", `import { ticketLevel as a } from ${JSON.stringify(path.join(dir, "ctl/lib.mjs"))}; import { ticketLevel as b } from ${JSON.stringify(path.join(dir, "ctl/ticket.mjs"))}; console.log(a === b);`], { encoding: "utf8" });
  assert.equal(out.stdout.trim(), "true", out.stderr);
});

// --- a project, rendered ---------------------------------------------------------------------------------------------------------------

function initProject(kind) {
  const dir = tempDir("af-sharpen-");
  const home = path.join(dir, "home"), project = path.join(dir, "p");
  fs.mkdirSync(home); fs.mkdirSync(project);
  const env = { ...process.env, HOME: home, FACTORY_SKIP_ORCA: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") };
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: project, env, encoding: "utf8" });
  git("config", "--global", "user.name", "t"); git("config", "--global", "user.email", "t@example.com");
  git("init", "-q", "-b", "main"); git("commit", "-q", "--allow-empty", "-m", "Initial");
  const answers = path.join(dir, "answers.json");
  fs.writeFileSync(answers, JSON.stringify({ "steering.mode": "orca-tasks", "rules.confirm": "yes", ...(kind === "bot" ? { "hosts.frontAgent.kind": "orca-bot", "hosts.frontAgent.bot": "front-bot" } : {}) }));
  const cli = (...a) => spawnSync("node", [CLI, ...a], { cwd: project, env, encoding: "utf8" });
  const r = cli("init", "--yes", "--answers", answers);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const read = (f) => fs.readFileSync(path.join(project, f), "utf8");
  return { dir, project, cli, read };
}

test("a new project enforces the check; the step is rendered for both kinds of Front agent, honest about its limits, with the context sources and no placeholder left", () => {
  const p = initProject("terminal");
  const config = JSON.parse(p.read("factory.config.json"));
  assert.equal(config.steering.readyCheck, "enforce");
  assert.deepEqual(config.context.sources, []);
  for (const f of [".factory/front-agent/FRONT_AGENT.md", ".factory/front-agent/FRONT_BOT.md"]) {
    const text = p.read(f);
    assert.match(text, /## Sharpen the ticket \(before it is `ready`\)/, f);
    assert.match(text, /no connection to outside trackers/i, f);
    assert.match(text, /grill-with-docs/, f);
    assert.match(text, /none stated yet: ask .* once where the overall specification and any earlier material/, f);
    assert.match(text, /Assumption:/, f);
    assert.match(text, /has not been run with a real Front agent yet/, f);
    assert.match(text, /issues\.mjs claim/, f);
    assert.match(text, /`ready` without an `Assessed:` line|already `ready` but has no `Assessed:` line/, f);
    assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/, `${f} has an unfilled placeholder`);
  }
  const agent = p.read(".factory/front-agent/FRONT_AGENT.md");
  assert.match(agent, /sharpen each before it becomes ready/);
  assert.match(agent, /Level 1 \*\*and\*\* adds no new interface, data or state/);
  assert.match(agent, /sources you read/);
  assert.match(p.read(".factory/front-agent/FRONT_BOT.md"), /"Needs you" on an item/);
  const wf = p.read("docs/dev-workflow.md");
  assert.match(wf, /## Sharpen the ticket/);
  assert.match(wf, /has not been run with a real Front agent/);
  assert.match(wf, /the gate is `claim`|`claim`, which is the gate/);
  assert.match(wf, /- \(blocking\) Which date format\?\n {2}Answer:/);
  assert.match(p.read("docs/tasks/T00-template.md"), /^Assessed: /m);
  assert.match(p.read("docs/tasks/T00-template.md"), /Documentation only: yes/);
  assert.match(p.read(".factory/controller/CONTROLLER.md"), /## A ticket must be ready to code/);
  config.context.sources = ["docs/spec/overall.md (the overall specification)", "../predecessor/notes (earlier system)"];
  fs.writeFileSync(path.join(p.project, "factory.config.json"), JSON.stringify(config, null, 2));
  const up = p.cli("update");
  assert.equal(up.status, 0, up.stdout + up.stderr);
  assert.match(p.read(".factory/front-agent/FRONT_AGENT.md"), /   - docs\/spec\/overall\.md \(the overall specification\)\n   - \.\.\/predecessor\/notes \(earlier system\)/);
});

test("an existing project after update: the key is not added (so the check only warns); status and doctor list the tickets that are not ready to code", () => {
  const p = initProject("terminal");
  const config = JSON.parse(p.read("factory.config.json"));
  delete config.steering.readyCheck; delete config.context;
  fs.writeFileSync(path.join(p.project, "factory.config.json"), JSON.stringify(config, null, 2));
  const up = p.cli("update");
  assert.equal(up.status, 0, up.stdout + up.stderr);
  assert.equal(JSON.parse(p.read("factory.config.json")).steering.readyCheck, undefined, "update never switches an existing project to enforce");
  assert.equal(readyMode(JSON.parse(p.read(".factory/controller/factory.config.json"))), "warn");
  assert.match(p.read(".factory/front-agent/FRONT_AGENT.md"), /none stated yet/);
  fs.writeFileSync(path.join(p.project, "docs/tasks/T01-old.md"), "# T01\n\nStatus: ready\nLevel: 1\n\n## Goal\n\nA goal.\n");
  fs.writeFileSync(path.join(p.project, "docs/tasks/T02-sharp.md"), ticket());
  fs.writeFileSync(path.join(p.project, "docs/tasks/T03-asks.md"), ticket([], { status: "Status: needs-info", assessed: "Assessed: needs clarification, 2026-11-25" }));
  fs.writeFileSync(path.join(p.project, "docs/tasks/T04-building.md"), "# T04\n\nStatus: building\n");
  const s = JSON.parse(p.cli("status", "--json").stdout);
  assert.deepEqual(s.work.tickets.waitingForYou, ["T03"]);
  assert.deepEqual(s.work.tickets.notReadyToCode.map((t) => t.id), ["T01"]);
  assert.match(s.work.tickets.notReadyToCode[0].missing.join(), /no assessment/);
  assert.match(s.hints.join("\n"), /1 ticket is marked ready but not ready to code \(T01: no assessment[\s\S]*\): sharpen it[\s\S]*readyCheck is warn, so the Controller still takes them/);
  assert.match(s.hints.join("\n"), /1 ticket waits for the human's answer \(needs-info: T03\)/);
  const text = p.cli("status").stdout;
  assert.match(text, /Waiting for the human \(needs-info\): T03/);
  assert.match(text, /Marked ready, not ready to code: T01 \(no assessment/);
  const doctor = p.cli("doctor").stdout;
  assert.match(doctor, /1 ticket is marked ready but not ready to code: T01 \(no assessment[\s\S]*steering.readyCheck is warn, so they are still taken[\s\S]*set it to enforce in factory.config.json, then run update and start/);
  config.steering.readyCheck = "enforce";
  fs.writeFileSync(path.join(p.project, "factory.config.json"), JSON.stringify(config, null, 2));
  fs.rmSync(path.join(p.project, "docs/tasks/T04-building.md")); fs.rmSync(path.join(p.project, "docs/tasks/T02-sharp.md"));
  const e = JSON.parse(p.cli("status", "--json").stdout);
  assert.match(e.hints.join("\n"), /The Controller does not take them/);
  assert.match(p.cli("doctor").stdout, /steering.readyCheck is enforce, so they are not taken/);
});
