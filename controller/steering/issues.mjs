// Steering mode github-issues: tickets are GitHub issues (gh CLI). Labels from factory.config.json → steering. Usage:
// node steering/issues.mjs ready                 → JSON list of open, unassigned issues with the ready label and no open blockers, and (steering.readyCheck: enforce)
//                                                  only those ready to code: assessed, with goal, acceptance criteria, limits and level, no blocking question open
// node steering/issues.mjs claim <n>             → assigns the authenticated account, swaps ready → in-progress, records in the journal whether the issue declares a documentation ticket
// node steering/issues.mjs comment <n> <file>    → posts the file's content as a comment (review verdicts, decisions)
// node steering/issues.mjs needs-human <n> <text>→ labels needs-human and comments the question
// node steering/issues.mjs close <n> <text>      → closes with a comment (after the wave reached main)
import "../cli.mjs";
import fs from "node:fs";
import { PROJECT_DIR, config, declaredProblem, journal, sh, ticketLevel } from "../lib.mjs";
import { readyGate, readyMode } from "../ticket.mjs";

const ready = config.steering?.readyLabel ?? "ready-for-agent";
const MODE = readyMode(config);
const gh = (...a) => sh("gh", a, { cwd: PROJECT_DIR });
const [cmd, n, arg] = process.argv.slice(2);
if (cmd === "ready") {
  // One query for the whole list, because the heartbeat asks every minute. A server without the blockers field fails the
  // query, and the caller then reports the tickets as unreadable rather than handing out blocked ones.
  const query = `query($owner: String!, $name: String!, $label: String!) { repository(owner: $owner, name: $name) { issues(states: OPEN, first: 100, labels: [$label]) { nodes { number title body assignees(first: 1) { nodes { login } } labels(first: 100) { nodes { name } } issueDependenciesSummary { blockedBy } } } } }`;
  const list = JSON.parse(gh("api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `label=${ready}`, "-f", `query=${query}`)).data.repository.issues.nodes;
  const unblocked = (i) => {
    const blockers = i.issueDependenciesSummary?.blockedBy;
    if (!Number.isInteger(blockers)) console.error(`#${i.number}: its blockers cannot be read, so it is left out`);
    return blockers === 0;
  };
  // With the check on enforce an issue that is not ready to code is left out and says why on stderr; with warn it stays in the list.
  const sharp = (i) => { if (MODE === "warn") return true; const g = readyGate(`#${i.number}`, i.body ?? "", { mode: MODE }); if (g.message) console.error(`${g.message} It is left out of the ready list.`); return !g.stop; };
  const open = list.filter((i) => !i.assignees.nodes.length).filter(unblocked).filter(sharp).map((i) => ({ number: i.number, title: i.title, level: /level\s*(\d)/i.exec(i.body ?? "")?.[1] ?? "?", labels: i.labels.nodes.map((l) => l.name) }));
  console.log(JSON.stringify(open, null, 1));
} else if (cmd === "claim") {
  // The issue's text as it is when the Controller takes it, before any worker runs: whether it declares a documentation ticket
  // (`Level: 1`, `Documentation only: yes`) goes into the Controller's own journal, which docsonly.mjs reads. Unreadable = not declared.
  // Its level goes in as well (the lines `Level: <n>`; the highest, none when unreadable): a waiver reads who may decide from this record, never from the issue as it is later.
  let documentation = false, level = null;
  // Before anything changes: an issue that is not ready to code is not claimed (enforce) or claimed with the warning (warn). One that cannot be read counts as
  // not ready. One that is already in progress is never stopped.
  let body = null, started = false;
  try { const v = JSON.parse(gh("issue", "view", n, "--json", "body,labels")); body = v.body ?? ""; started = (v.labels ?? []).some((l) => l.name === (config.steering?.inProgressLabel ?? "in-progress")); } catch { /* unreadable */ }
  const gate = body === null ? { stop: MODE !== "warn", message: `#${n} cannot be read, so it is not known to be ready to code.` } : readyGate(`#${n}`, body, { mode: MODE, started });
  if (gate.message) console.error(gate.message);
  if (gate.stop) process.exit(1);
  try { documentation = declaredProblem(body ?? "") === ""; level = ticketLevel(body ?? ""); } catch { /* stays false and unknown */ }
  gh("issue", "edit", n, "--add-assignee", "@me", "--remove-label", ready, "--add-label", "in-progress");
  journal("claim", n, { documentation, level });
  console.log("ok");
}
else if (cmd === "comment") { gh("issue", "comment", n, "--body-file", arg); console.log("ok"); }
else if (cmd === "needs-human") { gh("issue", "edit", n, "--add-label", "needs-human"); gh("issue", "comment", n, "--body", arg); console.log("ok"); }
else if (cmd === "close") { gh("issue", "close", n, "--comment", arg); console.log("ok"); }
else throw new Error("usage: ready | claim <n> | comment <n> <file> | needs-human <n> <text> | close <n> <text>");
