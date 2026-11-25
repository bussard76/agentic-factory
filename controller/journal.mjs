// Usage: node journal.mjs <type> <task> [key=value ...] → appends one JSON line to journal.ndjson (docs/improvement.md)
import "./cli.mjs";
import { journal } from "./lib.mjs";
const [type, task, ...kv] = process.argv.slice(2);
const types = ["start", "done", "review", "rerun", "stall", "nudge", "wave", "escalation", "decision", "retro", "gate", "capacity", "cleanup"];
const reasons = ["functional", "coverage", "load-timeout", "environment", "spec-gap", "security", "early-stop", "other"];
// Records that carry trust are written only by the script that checked them: waiver (waiver.mjs), taskref (mkspec.mjs), claim (steering/issues.mjs), review with a head (reviewed.mjs, docsonly.mjs).
// Neither the type argument nor a key=value can name them: `type=`, `task=`, `ts=` and `by=` are not extra fields, they would override the event's own.
const WRITER = { waiver: "waiver.mjs, after it checked the failed review, the findings and who may decide", taskref: "mkspec.mjs", claim: "steering/issues.mjs claim" };
if (WRITER[type]) throw new Error(`a ${type} event is written by ${WRITER[type]}; journal.mjs does not write one`);
if (!types.includes(type) || !task) throw new Error(`usage: node journal.mjs type(${types.join("|")}) task [k=v...]`);
const extra = {};
for (const p of kv) { const i = p.indexOf("="); const k = p.slice(0, i), v = p.slice(i + 1); extra[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v; }
for (const k of ["type", "task", "ts", "by"]) if (k in extra) throw new Error(`${k}= cannot be given to journal.mjs: it would replace the event's own ${k}, and the records that carry trust (waiver, taskref, claim, review) are written only by the scripts that check them`);
if (type === "review" && (extra.head || extra.by || extra.reviewSha)) throw new Error("a review event with a head is written by reviewed.mjs or docsonly.mjs after they checked it; journal.mjs does not write one");
if (extra.reason && !reasons.includes(extra.reason)) throw new Error(`reason must be one of ${reasons.join("|")}`);
journal(type, task, extra);
