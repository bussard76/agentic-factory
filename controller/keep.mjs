// Keeps a finished worker for the human: cleanup then neither releases it nor removes its worktree. This marker is the
// only keep cleanup honours for workers that start.mjs started in a new worktree, because Orca keeps those open by default
// and a keep-open set in Orca by hand looks the same. --off removes the marker. Journaled as a decision.
// Usage: node keep.mjs <key from workers.json> [--off] [--by "<why>"]
import { journal, readJson, writeJson } from "./lib.mjs";

const [key] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--by");
const off = process.argv.includes("--off"), byAt = process.argv.indexOf("--by"), by = byAt >= 0 ? process.argv[byAt + 1] : undefined;
const workers = readJson("workers.json", {});
if (!key || !workers[key]) { console.error(`usage: node keep.mjs <key> [--off] [--by "<why>"]; known keys: ${Object.keys(workers).join(", ") || "none"}`); process.exit(1); }
if (off) delete workers[key].keep; else workers[key].keep = true;
writeJson("workers.json", workers);
journal("decision", "controller", { note: `${off ? "no longer keeping" : "keeping"} worker ${key}`, ...(by ? { by } : {}) });
console.log(`${off ? "no longer keeping" : "keeping"} ${workers[key].name ?? key}`);
