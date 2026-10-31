// Capacity verdict per worker host (docs/capacity.md): may a suite worker or a read-only worker start there now, and
// how many gate slots should each pool have? Measures the host locally or over ssh, and CALIBRATES the caps:
// the configured numbers are starting values; the cap rises by one step while the host stays quiet and gate waits
// stay short, and falls on pressure or load timeouts. State per host in capacity-state.<host>.json.
// Usage: node capacity.mjs [--on <host>] [--verbose] [--reset]
import fs from "node:fs";
import { PROJECT, argHost, file, journal, onHost, readJson, writeJson } from "./lib.mjs";

const host = argHost(process.argv);
const CAP = host.capacity;
const CAL = { mode: "auto", startSuite: 2, startReadonly: 2, step: 1, raiseAfterQuietMinutes: 30, maxSuite: 12, maxReadonly: 8, ...(CAP.calibration ?? {}) };

// One shell round trip collects everything: PSI, memory, load, threads, gate waiters, top CPU consumers with cwd.
const probe = onHost(host, `
for k in cpu memory io; do printf "psi_%s=%s\\n" $k "$(awk '/^some/{for(i=1;i<=NF;i++) if($i ~ /^avg10=/){split($i,a,"="); printf "%s", a[2]}}' /proc/pressure/$k 2>/dev/null)"; done
printf "avail_kb=%s\\n" "$(awk '/MemAvailable/{print $2}' /proc/meminfo 2>/dev/null || sysctl -n hw.memsize 2>/dev/null | awk '{print int($1/1024/4)}')"
printf "load1=%s\\n" "$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg | awk '{print $2}')"
printf "threads=%s\\n" "$(nproc 2>/dev/null || sysctl -n hw.ncpu)"
for p in unit e2e; do printf "queue_%s=%s\\n" $p "$( (command -v lsof >/dev/null && lsof -t /tmp/${PROJECT}-gate-$p-doorman.lock 2>/dev/null | wc -l) || echo 0)"; done
ps -eo pid=,pcpu=,comm= --sort=-pcpu 2>/dev/null | head -30 | while read pid pcpu comm; do c=$(readlink /proc/$pid/cwd 2>/dev/null); printf "proc=%s|%s|%s\\n" "$pcpu" "$comm" "$c"; done
`);
const kv = Object.fromEntries(probe.split("\n").filter((l) => l.includes("=") && !l.startsWith("proc=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const num = (v) => (v === "" || v === undefined ? null : Number(v));
const cpu = num(kv.psi_cpu), mem = num(kv.psi_memory), io = num(kv.psi_io);
const availGb = (num(kv.avail_kb) ?? 0) / 1e6, load1 = num(kv.load1) ?? 0, threads = num(kv.threads) ?? 1;
const queue = { unit: num(kv.queue_unit) ?? 0, e2e: num(kv.queue_e2e) ?? 0 };
const foreign = probe.split("\n").filter((l) => l.startsWith("proc=")).map((l) => l.slice(5).split("|")).filter(([pcpu, , cwd]) => Number(pcpu) >= 5 && cwd && !cwd.includes(`/${PROJECT}`)).reduce((s, [pcpu]) => s + Number(pcpu) / 100, 0);
const workers = Object.values(readJson("workers.json", {})).filter((w) => (w.host ?? "local") === host.name);
const suite = workers.filter((w) => !w.readonly).length, readonly = workers.filter((w) => w.readonly).length;
const quota = readJson("quota.json", {});

// --- calibrated caps -----------------------------------------------------------------------------
const stateName = `capacity-state.${host.name}.json`;
let state = process.argv.includes("--reset") ? null : readJson(stateName, null);
if (!state) state = { suiteMax: CAL.mode === "auto" ? Math.min(CAL.startSuite, CAP.suiteWorkersMax ?? CAL.startSuite) : CAP.suiteWorkersMax ?? 4, readonlyMax: CAL.mode === "auto" ? Math.min(CAL.startReadonly, CAP.readOnlyWorkersMax ?? CAL.startReadonly) : CAP.readOnlyWorkersMax ?? 4, quietSince: new Date().toISOString(), history: [] };
const t = { cpu: CAP.pressure?.cpuAvg10MaxPercent ?? 20, mem: CAP.pressure?.memoryAvg10MaxPercent ?? 5, avail: CAP.availableMemoryMinGb ?? 8, queue: CAP.gateQueueMax ?? 3 };
const cpuHot = cpu === null ? load1 > threads * 0.9 : cpu > t.cpu;
const memHot = (mem !== null && mem > t.mem) || availGb < t.avail;
const queueHot = queue.unit + queue.e2e >= t.queue;
const recentTimeouts = recentLoadTimeouts(30);
const hot = cpuHot || memHot || queueHot || recentTimeouts > 0;
if (CAL.mode === "auto") {
  const now = Date.now();
  if (hot) {
    // Pressure with the cap in use: step down once per 15 minutes, never below the start value.
    const lastDown = state.history.findLast?.((h) => h.dir === "down");
    if (suite >= state.suiteMax - 1 && (!lastDown || now - Date.parse(lastDown.ts) > 15 * 60e3)) { state.suiteMax = Math.max(CAL.startSuite, state.suiteMax - CAL.step); state.history.push({ ts: new Date().toISOString(), dir: "down", suiteMax: state.suiteMax, why: reasonsText() }); }
    state.quietSince = new Date().toISOString();
  } else if (suite >= state.suiteMax && now - Date.parse(state.quietSince) > CAL.raiseAfterQuietMinutes * 60e3 && state.suiteMax < CAL.maxSuite) {
    // Quiet at the cap for long enough: step up and watch.
    state.suiteMax += CAL.step; state.quietSince = new Date().toISOString();
    state.history.push({ ts: state.quietSince, dir: "up", suiteMax: state.suiteMax, why: `quiet ${CAL.raiseAfterQuietMinutes} min at cap` });
  }
  if (!memHot && readonly >= state.readonlyMax && state.readonlyMax < CAL.maxReadonly) state.readonlyMax += CAL.step;
  state.history = state.history.slice(-40);
  writeJson(stateName, state);
}
const reasons = [];
if (cpuHot) reasons.push(`cpu pressure ${cpu ?? `load ${load1}`}`);
if (memHot) reasons.push(`memory ${availGb.toFixed(1)} GB available${mem !== null ? `, pressure ${mem}` : ""}`);
if (queueHot) reasons.push(`gate queue ${queue.unit + queue.e2e}`);
if (recentTimeouts) reasons.push(`${recentTimeouts} load timeouts in 30 min`);
if (suite >= state.suiteMax) reasons.push(`suite workers ${suite}/${state.suiteMax} (calibrated cap)`);
if (foreign > threads / 4) reasons.push(`foreign load ~${foreign.toFixed(1)}`);
function reasonsText() { return reasons.join("; "); }
const suiteVerdict = reasons.length ? "wait" : "start";
const roVerdict = memHot || readonly >= state.readonlyMax ? "wait" : "start";

// Adaptive gate slots: scale within the configured ranges by CPU pressure (or load without PSI).
const range = (r, d) => (Array.isArray(r) && r.length === 2 ? r : [d, d]);
const [uMin, uMax] = range(CAP.gate?.unitSlotsRange, CAP.gate?.unitSlots ?? 2), [eMin, eMax] = range(CAP.gate?.e2eSlotsRange, CAP.gate?.e2eSlots ?? 1);
const scale = cpu === null ? Math.max(0, 1 - load1 / threads) : Math.max(0, 1 - cpu / 50);
const slots = { unit: Math.round(uMin + (uMax - uMin) * scale), e2e: Math.round(eMin + (eMax - eMin) * scale) };
writeJson(`gate-slots.${host.name}.json`, slots);
if (host.kind === "local") writeJson("gate-slots.json", slots);
else onHost(host, `mkdir -p ~/controller && printf '%s' '${JSON.stringify(slots)}' > ~/controller/gate-slots.json`);

const verdict = { host: host.name, suite: suiteVerdict, readonly: roVerdict, caps: { suite: state.suiteMax, readonly: state.readonlyMax, calibration: CAL.mode }, gateUnitSlots: slots.unit, gateE2eSlots: slots.e2e, reason: reasons.join("; ") || "capacity available",
  measured: { cpuAvg10: cpu, memAvg10: mem, ioAvg10: io, load1, threads, availGb: Number(availGb.toFixed(1)), suite, readonly, queue, foreign: Number(foreign.toFixed(1)), recentTimeouts, quota, history: state.history.slice(-5) } };
journal("capacity", "controller", { host: host.name, note: `${suiteVerdict}/${roVerdict} cap ${state.suiteMax}`, cpu, mem, avail_gb: verdict.measured.availGb, queue: queue.unit + queue.e2e });
console.log(JSON.stringify(process.argv.includes("--verbose") ? verdict : { ...verdict, measured: undefined }));

function recentLoadTimeouts(minutes) {
  if (!fs.existsSync(file("journal.ndjson"))) return 0;
  const since = Date.now() - minutes * 60e3;
  return fs.readFileSync(file("journal.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } })
    .filter((e) => Date.parse(e.ts) > since && e.reason === "load-timeout" && (e.host ?? host.name) === host.name).length;
}
