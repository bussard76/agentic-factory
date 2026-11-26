// Steering mode orca-tasks: tickets are docs/tasks/T<n>-*.md files with a Status line. Usage:
// node steering/tasks.mjs list [status]     → JSON list of tasks with id, file, status, level. "ready" leaves out a task
//                                             whose "Depends on:" names a task that is not integrated yet, and (steering.readyCheck: enforce) one that is
//                                             not ready to code: no assessment, or a goal, acceptance criteria, limits or level missing, or a blocking question open
// node steering/tasks.mjs check <T>         → what is missing for the task to be ready to code (exit 1 when something is)
// node steering/tasks.mjs set <T> <status>  → rewrites the Status line (commit it yourself)
// node steering/tasks.mjs next-id           → the next free T number
import "../cli.mjs";
import fs from "node:fs";
import path from "node:path";
import { PROJECT_DIR, config, noteOnce } from "../lib.mjs";
import { readyGate, readyMode, readyProblems } from "../ticket.mjs";

const MODE = readyMode(config);

const dir = path.join(PROJECT_DIR, config.steering?.tasksDir ?? "docs/tasks");
const [cmd, a, b] = process.argv.slice(2);
const tasks = () => fs.readdirSync(dir).filter((f) => /^T\d+-.*\.md$/.test(f)).map((f) => {
  const text = fs.readFileSync(path.join(dir, f), "utf8");
  return { id: /^T\d+/.exec(f)[0], file: f, status: /^Status:\s*([a-z-]+)/mi.exec(text)?.[1]?.toLowerCase() ?? "unknown", level: /^Level:\s*(\d)/mi.exec(text)?.[1] ?? /level\s*(\d)/i.exec(text)?.[1] ?? "?" };
});
const taskNumber = (id) => Number(id.slice(1));
// Only task numbers can be checked; a shared interface named in the same line stays the Controller's call.
function dependenciesDone(task, all) {
  const line = /^Depends on:(.*)$/mi.exec(fs.readFileSync(path.join(dir, task.file), "utf8"))?.[1] ?? "";
  return (line.match(/\bT\d+\b/g) ?? []).every((id) => {
    const dependency = all.find((t) => taskNumber(t.id) === taskNumber(id));
    if (!dependency) console.error(`${task.id}: it depends on ${id}, which does not exist, so it is left out`);
    return dependency?.status === "integrated";
  });
}
const textOf = (t) => fs.readFileSync(path.join(dir, t.file), "utf8");
// With the check on enforce a ready task that is not ready to code is left out and says why on stderr, once per task and reason (the heartbeat stays silent);
// with warn it stays in the list and the list says nothing: `agentic-factory status` and `doctor` name such tasks, and the first start of one warns.
function sharp(task) {
  if (MODE === "warn") return true;
  const g = readyGate(task.id, textOf(task), { mode: MODE });
  if (g.message) noteOnce(task.id, g.problems.join("|"), `${g.message} It is left out of the ready list.`);
  return !g.stop;
}
if (cmd === "list") { const all = tasks(); console.log(JSON.stringify(all.filter((t) => !a || t.status === a).filter((t) => a !== "ready" || (dependenciesDone(t, all) && sharp(t))), null, 1)); }
else if (cmd === "check") {
  const t = tasks().find((t) => t.id === a); if (!t) throw new Error(`no task ${a}`);
  const problems = readyProblems(textOf(t)); console.log(JSON.stringify({ id: t.id, status: t.status, problems }, null, 1)); process.exitCode = problems.length ? 1 : 0;
}
else if (cmd === "set") {
  const t = tasks().find((t) => t.id === a); if (!t) throw new Error(`no task ${a}`);
  // A task goes to building only when its Status is ready and it is ready to code; one that already is building (or beyond) is never stopped (the gate knows).
  if (b === "building") { const g = readyGate(t.id, textOf(t), { mode: MODE }); if (g.message) console.error(g.message); if (g.stop) process.exit(1); }
  const p = path.join(dir, t.file); fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/^Status:.*$/m, `Status: ${b}`)); console.log("ok"); }
else if (cmd === "next-id") { const n = Math.max(0, ...tasks().map((t) => Number(t.id.slice(1)))) + 1; console.log(`T${String(n).padStart(2, "0")}`); }
else throw new Error("usage: list [status] | check <T> | set <T> <status> | next-id");
