// Steering mode github-issues: tickets are GitHub issues (gh CLI). Labels from factory.config.json → steering.
// node steering/issues.mjs ready                 → JSON list of open, unassigned issues with the ready label and no open blockers
// node steering/issues.mjs claim <n>             → assigns the authenticated account, swaps ready → in-progress
// node steering/issues.mjs comment <n> <file>    → posts the file's content as a comment (review verdicts, decisions)
// node steering/issues.mjs needs-human <n> <text>→ labels needs-human and comments the question
// node steering/issues.mjs close <n> <text>      → closes with a comment (after the wave reached main)
import fs from "node:fs";
import { PROJECT_DIR, config, sh } from "../lib.mjs";

const ready = config.steering?.readyLabel ?? "ready-for-agent";
const gh = (...a) => sh("gh", a, { cwd: PROJECT_DIR });
const [cmd, n, arg] = process.argv.slice(2);
if (cmd === "ready") {
  const list = JSON.parse(gh("issue", "list", "--label", ready, "--state", "open", "--json", "number,title,labels,assignees,body", "--limit", "100"));
  const open = list.filter((i) => !i.assignees?.length).map((i) => ({ number: i.number, title: i.title, level: /level\s*(\d)/i.exec(i.body ?? "")?.[1] ?? "?", labels: i.labels.map((l) => l.name) }));
  console.log(JSON.stringify(open, null, 1));
} else if (cmd === "claim") { gh("issue", "edit", n, "--add-assignee", "@me", "--remove-label", ready, "--add-label", "in-progress"); console.log("ok"); }
else if (cmd === "comment") { gh("issue", "comment", n, "--body-file", arg); console.log("ok"); }
else if (cmd === "needs-human") { gh("issue", "edit", n, "--add-label", "needs-human"); gh("issue", "comment", n, "--body", arg); console.log("ok"); }
else if (cmd === "close") { gh("issue", "close", n, "--comment", arg); console.log("ok"); }
else throw new Error("usage: ready | claim <n> | comment <n> <file> | needs-human <n> <text> | close <n> <text>");
