// Capacity verdict per worker host (docs/capacity.md): may a suite worker or a read-only worker start there now, and
// how many gate slots should each pool have? Measures the host locally or over ssh, and CALIBRATES the caps:
// the configured numbers are starting values; the cap rises by one step while the host stays quiet and gate waits
// stay short, and falls on pressure or load timeouts. State per host in capacity-state.<host>.json; every change is a
// `decision` event in the journal. --set-suite <n> --by "<the human's words>" sets the suite cap by hand (journaled; the
// automatic step-down on pressure still applies). Usage: node capacity.mjs [--on <host>] [--verbose] [--reset] [--set-suite <n> --by "<quote>"]
import fs from "node:fs";
import { CONTROLLER_HOME, ORCA, PROJECT, RUNNER, argHost, dispatchStates, file, journal, onHost, orcaEnvArgsOn, readJson, trySh, workerStatus, writeJson } from "./lib.mjs";

const host = argHost(process.argv);
const CAP = host.capacity;
const argValue = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const setSuite = argValue("--set-suite"), setBy = argValue("--by");
if (process.argv.includes("--set-suite") && !(/^[1-9]\d*$/.test(setSuite ?? "") && setBy?.trim() && !setBy.startsWith("--"))) {
  console.error('usage: node capacity.mjs --set-suite <n ≥ 1> --by "<what the human said>"'); process.exit(1);
}
const CAL = { mode: "auto", startSuite: 2, startReadonly: 2, step: 1, raiseAfterQuietMinutes: 30, maxSuite: 12, maxReadonly: 8, ...(CAP.calibration ?? {}) };

// --- measure (one shell round trip: PSI, memory, load, threads, gate queue, busy processes with cwd) ---------------
const probe = onHost(host, `
for k in cpu memory io; do printf "psi_%s=%s\\n" $k "$(awk '/^some/{for(i=1;i<=NF;i++) if($i ~ /^avg10=/){split($i,a,"="); printf "%s", a[2]}}' /proc/pressure/$k 2>/dev/null)"; done
printf "avail_kb=%s\\n" "$( (awk '/MemAvailable/{print $2; f=1} END{exit !f}' /proc/meminfo 2>/dev/null) || (vm_stat 2>/dev/null | awk -v ps="$(sysctl -n hw.pagesize 2>/dev/null || echo 16384)" '/Pages (free|inactive|speculative)/{gsub("\\\\.","",$NF); s+=$NF} END{if (s>0) print int(s*ps/1024)}') )"
printf "load1=%s\\n" "$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg | awk '{print $2}')"
printf "threads=%s\\n" "$(nproc 2>/dev/null || sysctl -n hw.ncpu)"
for p in unit e2e; do d="\${TMPDIR:-/tmp}/${PROJECT}-gate-$p"; printf "queue_%s=%s\\n" $p "$(ls "$d" 2>/dev/null | grep -c '^ticket-')"; done
ps -eo pid=,pcpu=,comm= --sort=-pcpu 2>/dev/null | head -30 | while read pid pcpu comm; do c=$(readlink /proc/$pid/cwd 2>/dev/null); printf "proc=%s|%s|%s\\n" "$pcpu" "$comm" "$c"; done
`);
const kv = Object.fromEntries(probe.split("\n").filter((l) => l.includes("=") && !l.startsWith("proc=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const num = (v) => (v === "" || v === undefined ? null : Number(v));
const cpu = num(kv.psi_cpu), mem = num(kv.psi_memory), io = num(kv.psi_io);
const availGb = (num(kv.avail_kb) ?? 0) / 1e6, load1 = num(kv.load1) ?? 0, threads = num(kv.threads) ?? 1;
const queue = { unit: num(kv.queue_unit) ?? 0, e2e: num(kv.queue_e2e) ?? 0 };
const foreign = probe.split("\n").filter((l) => l.startsWith("proc=")).map((l) => l.slice(5).split("|")).filter(([pcpu, , cwd]) => Number(pcpu) >= 5 && cwd && !cwd.includes(`/${PROJECT}`)).reduce((s, [pcpu]) => s + Number(pcpu) / 100, 0);
// Count only running workers on this host (lib.mjs workerStatus): an Orca worker until its dispatch is settled, even if its
// agent still sits at the prompt; a terminal-runner worker while its pid is alive. Finished workers must not fill the cap.
// A worker whose state cannot be read counts as running (fail closed). liveTerminals is null when the terminal list fails;
// it only decides records without a dispatch.
const liveTerminals = RUNNER === "orca" ? (() => { try { const t = JSON.parse(trySh(ORCA, ["terminal", "list", ...orcaEnvArgsOn(host), "--json"]) || "null")?.result?.terminals; return Array.isArray(t) ? new Set(t.filter((x) => x.status !== "exited").map((x) => x.handle)) : null; } catch { return null; } })() : null;
const alivePid = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const recorded = Object.values(readJson("workers.json", {})).filter((w) => (w.host ?? "local") === host.name);
const dispatches = RUNNER === "orca" ? dispatchStates(recorded.map((w) => w.dispatch), host) : {};
const statuses = recorded.map((w) => workerStatus(w, { dispatches, terminals: liveTerminals, pidAlive: alivePid }));
const workers = recorded.filter((w, i) => statuses[i] !== "finished");
const suite = workers.filter((w) => !w.readonly).length, readonly = workers.filter((w) => w.readonly).length;
const quota = readJson("quota.json", {});
const recentTimeouts = recentLoadTimeouts(30);

// --- pressure flags and reasons (before any calibration decision uses them) -----------------------------------------
const t = { cpu: CAP.pressure?.cpuAvg10MaxPercent ?? 20, mem: CAP.pressure?.memoryAvg10MaxPercent ?? 5, avail: CAP.availableMemoryMinGb ?? 8, queue: CAP.gateQueueMax ?? 3 };
const cpuHot = cpu === null ? load1 > threads * 0.9 : cpu > t.cpu;      // without PSI (non-Linux): load vs threads
const memKnown = (num(kv.avail_kb) ?? 0) > 0;                              // no MemAvailable and no vm_stat: skip the memory rule, say so
const memHot = (mem !== null && mem > t.mem) || (memKnown && availGb < t.avail);
const queueHot = queue.unit + queue.e2e >= t.queue;
const pressure = [];
if (cpuHot) pressure.push(`cpu pressure ${cpu ?? `load ${load1}`}`);
if (memHot) pressure.push(`memory ${availGb.toFixed(1)} GB available${mem !== null ? `, pressure ${mem}` : ""}`);
if (queueHot) pressure.push(`gate queue ${queue.unit + queue.e2e}`);
if (recentTimeouts) pressure.push(`${recentTimeouts} load timeouts in 30 min`);
if (foreign > threads / 4) pressure.push(`foreign load ~${foreign.toFixed(1)}`);
const hot = pressure.length > 0;
const notes = memKnown ? [] : ["available memory unknown on this host: memory rule skipped"];
if (RUNNER === "orca" && statuses.includes("unknown")) notes.push(`${statuses.filter((x) => x === "unknown").length} recorded workers counted as live: state unavailable from orca`);

// --- calibrated caps --------------------------------------------------------------------------------------------------
const stateName = `capacity-state.${host.name}.json`;
const fresh = () => ({ suiteMax: CAL.mode === "auto" ? Math.min(CAL.startSuite, CAP.suiteWorkersMax ?? CAL.startSuite) : CAP.suiteWorkersMax ?? 4, readonlyMax: CAL.mode === "auto" ? Math.min(CAL.startReadonly, CAP.readOnlyWorkersMax ?? CAL.startReadonly) : CAP.readOnlyWorkersMax ?? 4, quietSince: new Date().toISOString(), roQuietSince: new Date().toISOString(), history: [] });
const state = (process.argv.includes("--reset") ? null : readJson(stateName, null)) ?? fresh();
if (setSuite) {
  state.suiteMax = Number(setSuite); state.quietSince = new Date().toISOString();
  state.history.push({ ts: state.quietSince, dir: "set", suiteMax: state.suiteMax, why: `set by ${setBy}` });
  journal("decision", "controller", { host: host.name, note: `capacity suiteMax set → ${state.suiteMax} by hand`, by: setBy });
}
if (CAL.mode === "auto") {
  const now = Date.now(), nowIso = new Date().toISOString();
  const change = (field, dir, why) => { state.history.push({ ts: nowIso, dir, [field]: state[field], why }); journal("decision", "controller", { host: host.name, note: `capacity ${field} ${dir} → ${state[field]} (${why})` }); };
  if (hot) {
    const lastDown = [...state.history].reverse().find((h) => h.dir === "down");
    if (suite >= state.suiteMax - 1 && state.suiteMax > CAL.startSuite && (!lastDown || now - Date.parse(lastDown.ts) > 15 * 60e3)) { state.suiteMax = Math.max(CAL.startSuite, state.suiteMax - CAL.step); change("suiteMax", "down", pressure.join("; ")); }
    state.quietSince = nowIso; state.roQuietSince = nowIso;
  } else {
    if (suite >= state.suiteMax && now - Date.parse(state.quietSince) > CAL.raiseAfterQuietMinutes * 60e3 && state.suiteMax < CAL.maxSuite) { state.suiteMax += CAL.step; state.quietSince = nowIso; change("suiteMax", "up", `quiet ${CAL.raiseAfterQuietMinutes} min at cap`); }
    if (!memHot && readonly >= state.readonlyMax && now - Date.parse(state.roQuietSince ?? state.quietSince) > CAL.raiseAfterQuietMinutes * 60e3 && state.readonlyMax < CAL.maxReadonly) { state.readonlyMax += CAL.step; state.roQuietSince = nowIso; change("readonlyMax", "up", `quiet ${CAL.raiseAfterQuietMinutes} min at cap`); }
  }
  state.history = state.history.slice(-40);
}
writeJson(stateName, state);

// --- verdict -----------------------------------------------------------------------------------------------------------
const reasons = [...pressure];
if (suite >= state.suiteMax) reasons.push(`suite workers ${suite}/${state.suiteMax} (calibrated cap)`);
const suiteVerdict = reasons.length ? "wait" : "start";
const roVerdict = memHot || readonly >= state.readonlyMax ? "wait" : "start";

// Adaptive gate slots: scale within the configured ranges by CPU pressure (or load without PSI).
const range = (r, d) => (Array.isArray(r) && r.length === 2 ? r : [d, d]);
const [uMin, uMax] = range(CAP.gate?.unitSlotsRange, CAP.gate?.unitSlots ?? 2), [eMin, eMax] = range(CAP.gate?.e2eSlotsRange, CAP.gate?.e2eSlots ?? 1);
const scale = cpu === null ? Math.max(0, 1 - load1 / threads) : Math.max(0, 1 - cpu / 50);
const slots = { unit: Math.round(uMin + (uMax - uMin) * scale), e2e: Math.round(eMin + (eMax - eMin) * scale) };
writeJson(`gate-slots.${host.name}.json`, slots);
if (host.kind === "local") writeJson("gate-slots.json", slots);
else onHost(host, `mkdir -p ${CONTROLLER_HOME} && printf '%s' '${JSON.stringify(slots)}' > ${CONTROLLER_HOME}/gate-slots.json`);

// capOnly: something waits, and only a cap holds it back, no pressure. The Controller can then ask the human to raise it.
const waiting = suiteVerdict === "wait" || roVerdict === "wait";
const verdict = { host: host.name, suite: suiteVerdict, readonly: roVerdict, capOnly: waiting && !hot, ...(waiting ? { measureAgainAt: new Date(Date.now() + 60e3).toISOString() } : {}), caps: { suite: state.suiteMax, readonly: state.readonlyMax, calibration: CAL.mode }, gateUnitSlots: slots.unit, gateE2eSlots: slots.e2e, reason: [...reasons, ...notes].join("; ") || "capacity available",
  measured: { cpuAvg10: cpu, memAvg10: mem, ioAvg10: io, load1, threads, availGb: Number(availGb.toFixed(1)), suite, readonly, queue, foreign: Number(foreign.toFixed(1)), recentTimeouts, quota, history: state.history.slice(-5) } };
journal("capacity", "controller", { host: host.name, note: `${suiteVerdict}/${roVerdict} cap ${state.suiteMax}`, cpu, mem, avail_gb: verdict.measured.availGb, queue: queue.unit + queue.e2e });
console.log(JSON.stringify(process.argv.includes("--verbose") ? verdict : { ...verdict, measured: undefined }));

function recentLoadTimeouts(minutes) {
  if (!fs.existsSync(file("journal.ndjson"))) return 0;
  const since = Date.now() - minutes * 60e3;
  return fs.readFileSync(file("journal.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } })
    .filter((e) => Date.parse(e.ts) > since && e.reason === "load-timeout" && (e.host ?? host.name) === host.name).length;
}
