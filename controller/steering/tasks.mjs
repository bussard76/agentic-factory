// Steering mode orca-tasks: tickets are docs/tasks/T<n>-*.md files with a Status line.
// node steering/tasks.mjs list [status]     → JSON list of tasks with id, file, status, level. "ready" leaves out a task
//                                             whose "Depends on:" names a task that is not integrated yet
// node steering/tasks.mjs set <T> <status>  → rewrites the Status line (commit it yourself)
// node steering/tasks.mjs next-id           → the next free T number
import fs from "node:fs";
import path from "node:path";
import { PROJECT_DIR, config } from "../lib.mjs";

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
if (cmd === "list") { const all = tasks(); console.log(JSON.stringify(all.filter((t) => !a || t.status === a).filter((t) => a !== "ready" || dependenciesDone(t, all)), null, 1)); }
else if (cmd === "set") { const t = tasks().find((t) => t.id === a); if (!t) throw new Error(`no task ${a}`); const p = path.join(dir, t.file); fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/^Status:.*$/m, `Status: ${b}`)); console.log("ok"); }
else if (cmd === "next-id") { const n = Math.max(0, ...tasks().map((t) => Number(t.id.slice(1)))) + 1; console.log(`T${String(n).padStart(2, "0")}`); }
else throw new Error("usage: list [status] | set <T> <status> | next-id");
