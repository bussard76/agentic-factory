// Capacity verdict per worker host (docs/capacity.md): may a heavy worker (full test and gate runs, Testers), a light one
// (Developers) or a read-only one start there now, and how many gate slots should each pool have? Measures the host
// locally or over ssh, and CALIBRATES the caps: the configured numbers are starting values; the cap rises by one step
// while the host stays quiet and gate waits stay short, and falls on overload or load timeouts (never on foreign load).
// State per host in capacity-state.<host>.json; every change is a `decision` event in the journal.
// --set-suite <n> --by "<the human's words>" sets the suite cap by hand (journaled; the automatic step-down on overload
// still applies). Usage: node capacity.mjs [--on <host>] [--verbose] [--reset] [--set-suite <n> --by "<quote>"]
import "./cli.mjs";
import fs from "node:fs";
import { CONTROLLER_HOME, DIR, ORCA, PROJECT, PROJECT_DIR, RUNNER, argHost, dispatchStates, file, journal, onHost, orcaEnvArgsOn, projectDirOn, readJson, readState, trySh, workerStatus, workspacesOn, writeJson } from "./lib.mjs";
import { attribute, parseProbe, probeScript, repairCaps, shQuote } from "./capacity-rules.mjs";

const host = argHost(process.argv);
const CAP = host.capacity;
const argValue = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const setSuite = argValue("--set-suite"), setBy = argValue("--by");
const CAL = { mode: "auto", startSuite: 2, startReadonly: 2, step: 1, raiseAfterQuietMinutes: 30, maxSuite: 12, maxReadonly: 8, ...(CAP.calibration ?? {}) };
// A cap set by hand stays within the largest cap the config allows, so a typo cannot switch the cap off for hours.
const SET_MAX = Math.max(CAL.maxSuite, CAP.suiteWorkersMax ?? 0);
if (process.argv.includes("--set-suite") && !(/^[1-9]\d*$/.test(setSuite ?? "") && Number(setSuite) <= SET_MAX && setBy?.trim() && !setBy.startsWith("--"))) {
  console.error(`usage: node capacity.mjs --set-suite <n from 1 to ${SET_MAX}> --by "<what the human said>"`); process.exit(1);
}

// --- measure (one shell round trip: PSI, memory, load, threads, gate queue, CPU per process over ~1 s with cwd) ------
// This project's own directories: what runs from them is never foreign load. On the Controller's own host also the
// directory these scripts run from and the checkout the Controller reads.
const ownDirs = [projectDirOn(host), workspacesOn(host), CONTROLLER_HOME, `~/front-agent/${PROJECT}`, `~/Development/${PROJECT}-preview`, ...(host.kind === "local" ? [DIR, PROJECT_DIR] : [])];
const script = probeScript({ project: PROJECT, ownDirs });
// Over ssh the host's login shell reads the command, which need not be sh.
// A probe that hangs (a dead mount, a stuck ssh) must not hang capacity.mjs and with it start.mjs: it counts as failed.
const PROBE_TIMEOUT_MS = Number(process.env.FACTORY_PROBE_TIMEOUT_MS) || 30_000;   // the variable is for the tests
const probe = parseProbe(onHost(host, host.kind === "local" ? script : `sh -c ${shQuote(script)}`, { timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL" }));
const kv = probe.kv;
const num = (v) => (v === "" || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));   // never NaN
const cpu = num(kv.psi_cpu), mem = num(kv.psi_memory), io = num(kv.psi_io);
const availGb = (num(kv.avail_kb) ?? 0) / 1e6, load1 = num(kv.load1) ?? 0, threads = num(kv.threads) ?? 1;
const queue = { unit: num(kv.queue_unit) ?? 0, e2e: num(kv.queue_e2e) ?? 0 };
// What the probe did not deliver. With any of it missing, nothing is known well enough to start a worker.
const probeGaps = [...(kv.probe !== "end" ? ["no complete answer from the host"] : []), ...(num(kv.load1) === null ? ["load unknown"] : []), ...(num(kv.threads) > 0 ? [] : ["threads unknown"])];
const probeFailed = probeGaps.length ? [`probe failed (${probeGaps.join(", ")})`] : [];
// Cores in use over the sample, by owner; null when the processes could not be sampled. Only `foreign` can hold a start.
const cores = kv.procs === "ok" ? attribute(probe) : null;
const round1 = (v) => (v === null || v === undefined ? null : Number(v.toFixed(1)));
// Without working directories nothing can be told apart: foreign load is then unknown, never 0.
const busyProcs = probe.procs.filter((p) => p.cores > 0);
const blind = kv.lsof === "missing" ? "lsof is missing" : busyProcs.length && busyProcs.every((p) => !p.cwd) ? "no working directory of a busy process could be read" : null;
const foreign = blind ? null : cores?.foreign ?? null;
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
const quota = readState("quota.json", {});
const recentTimeouts = recentLoadTimeouts(30);

// --- pressure flags and reasons (before any calibration decision uses them) -----------------------------------------
// Two classes: heavy (full test and gate runs, Testers with a browser) and light (Developers). Light has a higher CPU limit.
const setting = (v, fallback) => (v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);
const positive = (v, fallback) => setting(v, fallback) || fallback;
const factor = { heavy: positive(CAP.heavyLoadPerThread, 0.9), light: positive(CAP.lightLoadPerThread, 1.5), foreignMax: setting(CAP.foreignLoadMaxPerThread, 0.25), foreignMinLoad: setting(CAP.foreignLoadMinLoadPerThread, 0.5) };
factor.light = Math.max(factor.light, factor.heavy);   // light is never stricter than heavy
const t = { cpu: CAP.pressure?.cpuAvg10MaxPercent ?? 20, mem: CAP.pressure?.memoryAvg10MaxPercent ?? 5, avail: CAP.availableMemoryMinGb ?? 8, queue: CAP.gateQueueMax ?? 3 };
t.lightCpu = Math.max(t.cpu, positive(CAP.pressure?.lightCpuAvg10MaxPercent, Math.round(t.cpu * factor.light / factor.heavy)));
const cpuOver = (psiMax, perThread) => (cpu === null ? load1 > threads * perThread : cpu > psiMax);   // without PSI (non-Linux): load vs threads
const heavyCpuHot = cpuOver(t.cpu, factor.heavy), lightCpuHot = cpuOver(t.lightCpu, factor.light);
const memKnown = (num(kv.avail_kb) ?? 0) > 0;                              // no MemAvailable and no vm_stat: skip the memory rule, say so
const memHot = (mem !== null && mem > t.mem) || (memKnown && availGb < t.avail);
const queueHot = queue.unit + queue.e2e >= t.queue;
// Foreign load holds a start only on a host that is really busy: with a load clearly below its threads there is room.
const foreignOver = foreign !== null && foreign > threads * factor.foreignMax;
const foreignHot = foreignOver && load1 >= threads * factor.foreignMinLoad;
const cpuReason = `cpu pressure ${cpu ?? `load ${load1}`}`;
const memReason = memHot ? [`memory ${availGb.toFixed(1)} GB available${mem !== null ? `, pressure ${mem}` : ""}`] : [];
const queueReason = queueHot ? [`gate queue ${queue.unit + queue.e2e}`] : [];
const timeoutReason = recentTimeouts ? [`${recentTimeouts} load timeouts in 30 min`] : [];
const foreignReason = foreignHot ? [`foreign load ~${foreign.toFixed(1)}`] : [];
const pressure = [...(heavyCpuHot ? [cpuReason] : []), ...memReason, ...queueReason, ...timeoutReason, ...foreignReason];
// The gate queue and load timeouts are about full runs: they hold heavy starts. Light: its CPU limit, memory, foreign load.
const lightPressure = [...(lightCpuHot ? [cpuReason] : []), ...memReason, ...foreignReason];
// What the calibration steps the cap down for: the host past even the light limit, or short of memory, or full runs piling
// up or timing out. Never foreign load: the cap says what this project's own workers can do on this host.
const overload = [...(lightCpuHot ? [cpuReason] : []), ...memReason, ...queueReason, ...timeoutReason];
const hot = pressure.length > 0;
const notes = memKnown ? [] : ["available memory unknown on this host: memory rule skipped"];
if (RUNNER === "orca" && statuses.includes("unknown")) notes.push(`${statuses.filter((x) => x === "unknown").length} recorded workers counted as live: state unavailable from orca`);
const loadNotes = [
  ...(cores === null ? ["processes could not be sampled: foreign load unknown, its rule skipped"] : blind ? [`${blind}: foreign load unknown, its rule skipped`] : []),
  ...(foreignOver && !foreignHot ? [`foreign load ~${foreign.toFixed(1)} does not hold a start: load1 ${load1} is below ${factor.foreignMinLoad} x ${threads} threads`] : []),
];

// --- calibrated caps --------------------------------------------------------------------------------------------------
const stateName = `capacity-state.${host.name}.json`;
const fresh = () => ({ foreignRepair: new Date().toISOString(), suiteMax: CAL.mode === "auto" ? Math.min(CAL.startSuite, CAP.suiteWorkersMax ?? CAL.startSuite) : CAP.suiteWorkersMax ?? 4, readonlyMax: CAL.mode === "auto" ? Math.min(CAL.startReadonly, CAP.readOnlyWorkersMax ?? CAL.startReadonly) : CAP.readOnlyWorkersMax ?? 4, quietSince: new Date().toISOString(), roQuietSince: new Date().toISOString(), history: [] });
const saved = process.argv.includes("--reset") ? null : readState(stateName, null);
const state = saved && Number.isFinite(saved.suiteMax) && Number.isFinite(saved.readonlyMax) && Array.isArray(saved.history) ? saved : fresh();
// Once per state written by an earlier version: give back what the wrong foreign-load figure took from the suite cap.
// Not while the host is unmeasured or overloaded: it then waits for a later run, and real steps down in between are
// counted. A run that sets the cap by hand settles it: the human's number is the cap.
if (!state.foreignRepair && (setSuite || (!probeFailed.length && !overload.length))) {
  const given = setSuite ? null : repairCaps(state, { step: CAL.step, max: CAL.maxSuite, manual: CAL.mode !== "auto" });
  state.foreignRepair = new Date().toISOString();
  if (given?.doubt) {
    journal("decision", "controller", { host: host.name, note: `capacity suiteMax NOT restored, stays ${state.suiteMax}: ${given.steps} step-down(s) for the wrongly measured foreign load are recorded, but ${given.doubt}. To raise it: ask the human, then node capacity.mjs --on ${host.name} --set-suite <n> --by "<their words>"` });
  } else if (given) {
    const why = `${given.steps} earlier step-down(s) had only foreign load as the reason, which was measured wrongly`;
    journal("decision", "controller", { host: host.name, note: `capacity suiteMax restored → ${given.suiteMax}, was ${state.suiteMax} (${why})` });
    state.suiteMax = given.suiteMax; state.quietSince = state.foreignRepair;
    state.history.push({ ts: state.foreignRepair, dir: "restore", suiteMax: state.suiteMax, why });
  }
}
if (setSuite) {
  state.suiteMax = Number(setSuite); state.quietSince = new Date().toISOString();
  state.history.push({ ts: state.quietSince, dir: "set", suiteMax: state.suiteMax, why: `set by ${setBy}` });
  journal("decision", "controller", { host: host.name, note: `capacity suiteMax set → ${state.suiteMax} by hand`, by: setBy });
}
// An unmeasured host is neither quiet nor overloaded: no step either way, and the quiet time starts again.
if (probeFailed.length) state.quietSince = state.roQuietSince = new Date().toISOString();
if (CAL.mode === "auto" && !setSuite && !probeFailed.length) {   // the run that sets the cap by hand makes no automatic step as well
  const now = Date.now(), nowIso = new Date().toISOString();
  const change = (field, dir, why) => { state.history.push({ ts: nowIso, dir, [field]: state[field], why }); journal("decision", "controller", { host: host.name, note: `capacity ${field} ${dir} → ${state[field]} (${why})` }); };
  if (overload.length) {
    const lastDown = [...state.history].reverse().find((h) => h.dir === "down");
    if (suite >= state.suiteMax - 1 && state.suiteMax > CAL.startSuite && (!lastDown || now - Date.parse(lastDown.ts) > 15 * 60e3)) { state.suiteMax = Math.max(CAL.startSuite, state.suiteMax - CAL.step); change("suiteMax", "down", overload.join("; ")); }
  }
  // Whatever holds a heavy start also ends the quiet time: only a quiet host raises a cap.
  if (hot) { state.quietSince = nowIso; state.roQuietSince = nowIso; }
  else {
    if (suite >= state.suiteMax && now - Date.parse(state.quietSince) > CAL.raiseAfterQuietMinutes * 60e3 && state.suiteMax < CAL.maxSuite) { state.suiteMax += CAL.step; state.quietSince = nowIso; change("suiteMax", "up", `quiet ${CAL.raiseAfterQuietMinutes} min at cap`); }
    if (!memHot && readonly >= state.readonlyMax && now - Date.parse(state.roQuietSince ?? state.quietSince) > CAL.raiseAfterQuietMinutes * 60e3 && state.readonlyMax < CAL.maxReadonly) { state.readonlyMax += CAL.step; state.roQuietSince = nowIso; change("readonlyMax", "up", `quiet ${CAL.raiseAfterQuietMinutes} min at cap`); }
  }
}
state.history = state.history.slice(-40);
writeJson(stateName, state);

// --- verdict -----------------------------------------------------------------------------------------------------------
// One cap for heavy and light together: it bounds how many workers that are not read-only run on the host.
const capReason = suite >= state.suiteMax ? [`suite workers ${suite}/${state.suiteMax} (calibrated cap)`] : [];
const reasons = probeFailed.length ? probeFailed : [...pressure, ...capReason], lightReasons = probeFailed.length ? probeFailed : [...lightPressure, ...capReason];
const heavyVerdict = reasons.length ? "wait" : "start";
const lightVerdict = lightReasons.length ? "wait" : "start";
const roVerdict = probeFailed.length || memHot || readonly >= state.readonlyMax ? "wait" : "start";

// Adaptive gate slots: scale within the configured ranges by CPU pressure (or load without PSI).
const range = (r, d) => (Array.isArray(r) && r.length === 2 ? r : [d, d]);
const [uMin, uMax] = range(CAP.gate?.unitSlotsRange, CAP.gate?.unitSlots ?? 2), [eMin, eMax] = range(CAP.gate?.e2eSlotsRange, CAP.gate?.e2eSlots ?? 1);
const scale = probeFailed.length ? 0 : cpu === null ? Math.max(0, 1 - load1 / threads) : Math.max(0, 1 - cpu / 50);   // unmeasured: the fewest slots
const slots = { unit: Math.round(uMin + (uMax - uMin) * scale), e2e: Math.round(eMin + (eMax - eMin) * scale) };
writeJson(`gate-slots.${host.name}.json`, slots);
if (host.kind === "local") writeJson("gate-slots.json", slots);
else onHost(host, `mkdir -p ${CONTROLLER_HOME} && printf '%s' '${JSON.stringify(slots)}' > ${CONTROLLER_HOME}/gate-slots.json`, { timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL" });

// capOnly: a pool waits and only its cap holds it back: the suite cap with nothing else against a Developer, or the
// read-only cap on a quiet host. The Controller can then ask the human to raise it.
const waiting = heavyVerdict === "wait" || lightVerdict === "wait" || roVerdict === "wait";
const capOnly = !probeFailed.length && (capReason.length ? !lightPressure.length : waiting && !hot);
const text = (list) => [...list, ...notes].join("; ") || "capacity available";
// `suite` is `heavy` under its old name, so a handbook that only knows `suite` stays with the stricter class.
const verdict = { host: host.name, suite: heavyVerdict, heavy: heavyVerdict, light: lightVerdict, readonly: roVerdict, capOnly, ...(waiting ? { measureAgainAt: new Date(Date.now() + 60e3).toISOString() } : {}), caps: { suite: state.suiteMax, readonly: state.readonlyMax, calibration: CAL.mode }, gateUnitSlots: slots.unit, gateE2eSlots: slots.e2e, reason: text(reasons), lightReason: text(lightReasons),
  foreignLoad: round1(foreign), unknownLoad: round1(cores?.unknown), ...(loadNotes.length ? { loadNote: loadNotes.join("; ") } : {}),
  measured: { cpuAvg10: cpu, memAvg10: mem, ioAvg10: io, load1: num(kv.load1), threads, availGb: Number(availGb.toFixed(1)), suite, readonly, queue, foreign: round1(foreign), unknown: round1(cores?.unknown), own: round1(cores?.own), limits: { heavyLoad: round1(threads * factor.heavy), lightLoad: round1(threads * factor.light), cpuAvg10: t.cpu, lightCpuAvg10: t.lightCpu, foreign: round1(threads * factor.foreignMax), foreignMinLoad: round1(threads * factor.foreignMinLoad) }, recentTimeouts, quota, history: state.history.slice(-5) } };
journal("capacity", "controller", { host: host.name, note: `heavy ${heavyVerdict}, light ${lightVerdict}, readonly ${roVerdict}, cap ${state.suiteMax}`, heavy: heavyVerdict, light: lightVerdict, readonly: roVerdict, load1: num(kv.load1), cpu, mem, avail_gb: verdict.measured.availGb, queue: queue.unit + queue.e2e, foreign: round1(foreign), unknown: round1(cores?.unknown) });
console.log(JSON.stringify(process.argv.includes("--verbose") ? verdict : { ...verdict, measured: undefined }));

function recentLoadTimeouts(minutes) {
  if (!fs.existsSync(file("journal.ndjson"))) return 0;
  const since = Date.now() - minutes * 60e3;
  return fs.readFileSync(file("journal.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } })
    .filter((e) => Date.parse(e.ts) > since && e.reason === "load-timeout" && (e.host ?? host.name) === host.name).length;
}
