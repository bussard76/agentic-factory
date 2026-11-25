// Usage: node journal.mjs <type> <task> [key=value ...] → appends one JSON line to journal.ndjson (docs/improvement.md)
import "./cli.mjs";
import { journal } from "./lib.mjs";
const [type, task, ...kv] = process.argv.slice(2);
const types = ["start", "done", "review", "rerun", "stall", "nudge", "wave", "escalation", "decision", "retro", "gate", "capacity", "cleanup"];
const reasons = ["functional", "coverage", "load-timeout", "environment", "spec-gap", "security", "early-stop", "other"];
if (type === "waiver") throw new Error("a waiver event is written by waiver.mjs after it checked the failed review, the findings and who may decide; journal.mjs does not write one");
if (!types.includes(type) || !task) throw new Error(`usage: node journal.mjs type(${types.join("|")}) task [k=v...]`);
const extra = {};
for (const p of kv) { const i = p.indexOf("="); const k = p.slice(0, i), v = p.slice(i + 1); extra[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v; }
if (type === "review" && (extra.head || extra.by || extra.reviewSha)) throw new Error("a review event with a head is written by reviewed.mjs or docsonly.mjs after they checked it; journal.mjs does not write one");
if (extra.reason && !reasons.includes(extra.reason)) throw new Error(`reason must be one of ${reasons.join("|")}`);
journal(type, task, extra);
