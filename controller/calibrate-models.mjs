// Model calibration (docs/capacity.md, "Models"): the configured tiers are starting values. This script reads the
// journal and recommends a tier per role from measured outcomes: pass rate and review rounds per role and model.
//   node calibrate-models.mjs            → prints the table and writes model-tiers.json (role → tier) when agents.calibration is auto
//   node calibrate-models.mjs --apply    → also when calibration is manual (the human agreed)
// start.mjs uses model-tiers.json when no --tier is given. Rules (per role, at least 6 finished runs in the window):
//   pass rate ≥ 0.85 and ≤ 1.3 rounds on the current tier → try one tier down (never below small, never for ADR/level-3 work)
//   pass rate < 0.6 or ≥ 2 rounds on average               → one tier up
//   otherwise keep. Changes are logged (type decision) so the audit can verify them.
import fs from "node:fs";
import { MODELS, config, file, journal, readJson, writeJson } from "./lib.mjs";

const daysIdx = process.argv.indexOf("--days");
const windowDays = daysIdx >= 0 ? Number(process.argv[daysIdx + 1]) : 7;
if (!Number.isFinite(windowDays) || windowDays <= 0) throw new Error("--days needs a positive number");
const since = Date.now() - windowDays * 86400e3;
const events = fs.existsSync(file("journal.ndjson")) ? fs.readFileSync(file("journal.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && Date.parse(e.ts) > since) : [];
const tiers = ["small", "default", "large"];
const tierOf = (model) => tiers.find((t) => MODELS[t] === model || config.agents?.fallback?.models?.[t] === model) ?? "default";

// Outcome per (role, tier): reviews with verdict and round; "done" events carry role+model of the worker.
const stats = {};
for (const e of events) {
  if (e.type !== "review" || !e.role || !e.verdict) continue;
  const key = `${e.role}|${tierOf(e.model)}`;
  const s = (stats[key] ??= { role: e.role, tier: tierOf(e.model), n: 0, pass: 0, rounds: 0 });
  s.n++; if (e.verdict === "pass") s.pass++; s.rounds += Number(e.round ?? 1);
}
const current = readJson("model-tiers.json", {});
const rec = { ...current };
const rows = [];
for (const s of Object.values(stats)) {
  if (s.n < 6) { rows.push({ ...s, note: "not enough data" }); continue; }
  const passRate = s.pass / s.n, avgRounds = s.rounds / s.n;
  const i = tiers.indexOf(s.tier);
  let next = s.tier, why = "keep";
  if (passRate >= 0.85 && avgRounds <= 1.3 && i > 0 && !/architect|adr/i.test(s.role)) { next = tiers[i - 1]; why = `pass ${passRate.toFixed(2)}, rounds ${avgRounds.toFixed(1)}: try cheaper`; }
  else if ((passRate < 0.6 || avgRounds >= 2) && i < tiers.length - 1) { next = tiers[i + 1]; why = `pass ${passRate.toFixed(2)}, rounds ${avgRounds.toFixed(1)}: escalate`; }
  rows.push({ ...s, passRate: Number(passRate.toFixed(2)), avgRounds: Number(avgRounds.toFixed(1)), next, why });
  if (next !== (current[s.role] ?? s.tier)) rec[s.role] = next;
}
console.table(rows.map(({ role, tier, n, passRate, avgRounds, next, why, note }) => ({ role, tier, n, passRate, avgRounds, next, why: why ?? note })));
const auto = (config.agents?.calibration ?? "auto") === "auto" || process.argv.includes("--apply");
if (auto && JSON.stringify(rec) !== JSON.stringify(current)) {
  writeJson("model-tiers.json", rec);
  for (const [role, tier] of Object.entries(rec)) if (current[role] !== tier) journal("decision", "controller", { role, note: `model tier ${current[role] ?? "default"} → ${tier} (calibration, ${windowDays}d window)` });
  console.log("model-tiers.json updated:", JSON.stringify(rec));
} else console.log(auto ? "no change" : "calibration is manual: rerun with --apply to write model-tiers.json");
