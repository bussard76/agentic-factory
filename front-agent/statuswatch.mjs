// Front agent: checks the Controller's status file once, on the controller host (local: direct file reads; remote: ssh).
// `agentic-factory start` schedules it every 5 minutes, outside any session, so it needs no agent to start it and works
// with whichever agent sits in front. An alert goes into the Front agent's terminal through Orca once that is idle; until
// then it waits here and the sidebar shows it. It alerts when "On main", "Needs <human>" or "Problems" change, when the
// file goes stale (> 25 min), when more worktrees exist than tasks plus a few (cleanup overdue), and with a SUMMARY marker
// every 30 minutes if the status changed. A lasting problem is announced once.
// Config: factory.config.json next to this script or FACTORY_CONFIG. Usage: node statuswatch.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { controllerHost, expand, loadConfig } from "./hosts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const here = (name) => path.join(HERE, name);
const readJson = (name, fallback) => { try { return JSON.parse(fs.readFileSync(here(name), "utf8")); } catch { return fallback; } };
const IDLE_WAIT_MS = 20_000, SUMMARY_MS = 30 * 60_000, MAX_PENDING = 20;

// Written first: `status` and `doctor` read it, and a Controller that cannot be reached does not mean the watch is gone.
fs.writeFileSync(here("statuswatch.alive"), new Date().toISOString() + "\n");

const cfg = loadConfig(HERE);
const host = controllerHost(cfg);
const ctlDir = cfg.hosts.controller?.controllerDir ?? "~/controller";
const WORKTREE_MAX = (host.capacity?.suiteWorkersMax ?? cfg.capacity?.suiteWorkersMax ?? 4) + (host.capacity?.readOnlyWorkersMax ?? cfg.capacity?.readOnlyWorkersMax ?? 4) + 2;
const ws = `${host.workspacesDir ?? "~/orca/workspaces"}/${cfg.project.name}`;
const section = (text, name) => (text.split(/^## /m).find((s) => s.startsWith(name)) ?? "").split("\n").slice(1).join("\n").trim();

function probe() {
  if (host.kind === "local") {
    const p = path.join(expand(ctlDir), "status.md");
    const mtime = fs.existsSync(p) ? fs.statSync(p).mtimeMs / 1000 : 0;
    const wt = fs.existsSync(expand(ws)) ? fs.readdirSync(expand(ws)).length : 0;
    return { mtime, wt, text: fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "" };
  }
  const out = execFileSync("ssh", [...(host.sshConfig ? ["-F", expand(host.sshConfig)] : []), host.ssh, `stat -c %Y ${ctlDir}/status.md 2>/dev/null || echo 0; echo WT=$(ls ${ws} 2>/dev/null | wc -l); cat ${ctlDir}/status.md 2>/dev/null`], { encoding: "utf8", timeout: 60000 });
  const [mtime, wtLine, ...rest] = out.split("\n");
  return { mtime: Number(mtime), wt: Number(String(wtLine).replace("WT=", "")), text: rest.join("\n") };
}

// A change is always new. A lasting problem is announced once, not every 5 minutes.
function check(state) {
  const alerts = [], problems = {};
  try {
    const { mtime, wt, text } = probe();
    if (wt > WORKTREE_MAX) problems.cleanup = `CLEANUP: ${wt} worktrees on ${host.name}, nudge the Controller`;
    const ageMin = mtime ? Math.round((Date.now() / 1000 - mtime) / 60) : Infinity;
    const now = { main: section(text, "On "), needs: section(text, "Needs "), problems: section(text, "Problems") };
    for (const [k, label] of [["main", "NEW ON MAIN"], ["needs", "NEEDS HUMAN"], ["problems", "PROBLEMS"]]) if (state.last?.[k] !== undefined && state.last[k] !== now[k]) alerts.push(`${label}: ${now[k].replace(/\n/g, " | ").slice(0, 400)}`);
    if (!mtime) problems.status = `NO STATUS: ${ctlDir}/status.md missing on ${host.name} (Controller not started?)`;
    else if (ageMin > 25) problems.status = `STALE: status.md is older than 25 min`;
    state.last = now;
    if (Date.now() - (state.lastSummary ?? 0) > SUMMARY_MS && state.summarised !== text) {
      if (state.summarised !== undefined) alerts.push(`SUMMARY due (status age ${Number.isFinite(ageMin) ? ageMin : "?"} min)`);
      state.summarised = text; state.lastSummary = Date.now();
    }
  } catch (e) { problems.reach = `UNREACHABLE: ${String(e.message).replace(/pair|token|code=/gi, "…").split("\n")[0].slice(0, 120)}`; }
  for (const [k, text] of Object.entries(problems)) if (!state.problems?.[k]) alerts.push(text);
  state.problems = problems;
  return alerts;
}

const orca = (...args) => JSON.parse(execFileSync(process.env.ORCA_CLI_COMMAND ?? readJson("front-agent.json", {}).orcaCommand ?? "orca", [...args, "--json"], { encoding: "utf8", timeout: IDLE_WAIT_MS + 30_000 }));

// A terminal's reported title can stay the agent's own session name, so the title alone does not find it. Whichever agent
// runs there, Orca knows it as an agent in the project's own checkout. Two candidates are a guess, and a guess sends nothing.
function frontAgentTerminal() {
  const { projectDir, handle } = readJson("front-agent.json", {});
  const terminals = orca("terminal", "list").result?.terminals ?? [];
  const named = terminals.find((t) => t.title === `${cfg.project.name} · Front Agent`);
  if (named) return named.handle;
  if (handle && terminals.some((t) => t.handle === handle)) return handle;
  const agents = terminals.filter((t) => t.worktreePath === projectDir && t.agentIdentity && !/· (Controller|Worker|Integration)/.test(t.title ?? ""));
  return agents.length === 1 ? agents[0].handle : null;
}

function deliver(state) {
  if (!state.pending.length || cfg.agents?.runner === "terminal") return;
  const { projectDir } = readJson("front-agent.json", {});
  try {
    const terminal = frontAgentTerminal();
    const idle = terminal && orca("terminal", "wait", "--terminal", terminal, "--for", "tui-idle", "--timeout-ms", String(IDLE_WAIT_MS)).result?.wait?.satisfied === true;
    if (idle) {
      orca("terminal", "send", "--terminal", terminal, "--text", `Status watch for ${cfg.project.name}, read from the Controller's status file. Tell ${cfg.project.humanName ?? "the human"} what matters: ${state.pending.join(" / ")}`, "--enter");
      state.pending = [];
      return;
    }
    const notice = `Status watch: ${state.pending.at(-1).slice(0, 120)}`;
    if (projectDir && state.notice !== notice) { orca("worktree", "set", "--worktree", `path:${projectDir}`, "--comment", notice, "--unread"); state.notice = notice; }
  } catch (e) { console.log(`not delivered: ${String(e.message).replace(/pair|token|code=/gi, "…").split("\n")[0].slice(0, 160)}`); }
}

const state = { pending: [], ...readJson("statuswatch-state.json", {}) };
const alerts = check(state);
for (const alert of alerts) console.log(`${new Date().toISOString()} ${alert}`);
state.pending = [...state.pending, ...alerts].slice(-MAX_PENDING);
deliver(state);
fs.writeFileSync(here("statuswatch-state.json"), JSON.stringify(state, null, 2) + "\n");
