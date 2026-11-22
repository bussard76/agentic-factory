// Precheck for a bot Front agent (hosts.frontAgent.kind = "orca-bot"). `agentic-factory start` copies it into the bot's
// watch directory (~/front-agent/.bots/<bot>/) and creates one Orca automation for the bot that runs it every 5 minutes.
// Exit 0 wakes the bot; any other exit skips the run, so a quiet project costs no model time.
// One bot can watch several projects: projects.json lists them, botwatch.state keeps one line per project.
// It wakes the bot when, in a project's Controller status.md, "Needs <human>", "Needs front agent" or "Problems" changed,
// when status.md is older than hosts.frontAgent.staleMinutes (default 25), is missing, or its host cannot be reached.
// A lasting problem wakes the bot once, when it starts, not every 5 minutes. The first sight of a project is a baseline.
// What woke the bot goes into wake.md next to this script, which the automation's prompt tells the bot to read.
// Local Controllers are read directly, remote ones over ssh. Usage: node botwatch.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { controllerHost, expand } from "./hosts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const here = (name) => path.join(HERE, name);
const NO_STATUS_GRACE_MS = 15 * 60_000;
const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const oneLine = (text) => text.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);

// "Needs front agent" is its own section; every other "Needs …" heading is the human's.
export function sections(text) {
  const out = { needs: "", front: "", problems: "" };
  for (const chunk of text.split(/^## /m).slice(1)) {
    const [heading, ...body] = chunk.split("\n");
    const content = body.join("\n").trim();
    if (/^Needs front agent\b/i.test(heading)) out.front = content;
    else if (/^Needs\b/.test(heading)) out.needs = content;
    else if (/^Problems\b/.test(heading)) out.problems = content;
  }
  return out;
}

function probe(cfg) {
  const host = controllerHost(cfg);
  const dir = cfg.hosts?.controller?.controllerDir ?? "~/controller";
  if (host.kind === "local") {
    const file = path.join(expand(dir), "status.md");
    if (!fs.existsSync(file)) return { host: host.name, mtime: 0, text: "" };
    return { host: host.name, mtime: fs.statSync(file).mtimeMs / 1000, text: fs.readFileSync(file, "utf8") };
  }
  // BatchMode: a password prompt would hang until the precheck's timeout. An ssh failure throws: the host is unreachable.
  const ssh = [...(host.sshConfig ? ["-F", expand(host.sshConfig)] : []), "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host.ssh];
  const out = execFileSync("ssh", [...ssh, `f=${dir}/status.md; if [ -f "$f" ]; then stat -c %Y "$f" 2>/dev/null || stat -f %m "$f"; cat "$f"; else echo 0; fi`], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
  const [mtime, ...rest] = out.split("\n");
  return { host: host.name, mtime: Number(mtime) || 0, text: rest.join("\n") };
}

// One project: compare with its last state line and return the reasons to wake the bot, plus the new state.
export function checkProject(project, prev, now = Date.now(), read = probe) {
  // Each project's own bundle config, never FACTORY_CONFIG: one bot can watch several projects.
  const cfg = JSON.parse(fs.readFileSync(path.join(expand(project.dir), "factory.config.json"), "utf8"));
  const human = cfg.project?.humanName ?? "the human";
  const staleMin = Number(cfg.hosts?.frontAgent?.staleMinutes) || 25;
  const next = { ...prev, firstSeen: prev?.firstSeen ?? now };
  const reasons = [];
  let problem = "";
  try {
    const { host, mtime, text } = read(cfg);
    const ageMin = mtime ? Math.round((now / 1000 - mtime) / 60) : null;
    if (!mtime) problem = now - next.firstSeen >= NO_STATUS_GRACE_MS ? `NO STATUS: status.md missing on ${host} (Controller not started?)` : "";
    else if (ageMin > staleMin) problem = `STALE: status.md is ${ageMin} min old (limit ${staleMin})`;
    if (mtime) {
      const s = sections(text);
      for (const [key, label] of [["needs", `NEEDS ${human.toUpperCase()}`], ["front", "NEEDS FRONT AGENT"], ["problems", "PROBLEMS"]]) {
        const h = digest(s[key]);
        if (prev?.[key] !== undefined && prev[key] !== h) reasons.push(`${label}: ${oneLine(s[key]) || "(now empty)"}`);
        next[key] = h;
      }
    }
  } catch (e) {
    problem = `UNREACHABLE: ${oneLine(String(e.stderr || e.message).replace(/pair|token|code=/gi, "…")).slice(0, 160)}`;
  }
  // Compared by kind, so a stale status that grows older does not wake the bot every 5 minutes.
  const kind = problem.split(":")[0];
  if (problem && kind !== (prev?.problem ?? "")) reasons.push(problem);
  next.problem = kind;
  return { reasons, state: next };
}

// botwatch.state: one line per project, "<project>\t<json>".
export function readState(file) {
  const state = {};
  try { for (const line of fs.readFileSync(file, "utf8").split("\n")) { const i = line.indexOf("\t"); if (i > 0) try { state[line.slice(0, i)] = JSON.parse(line.slice(i + 1)); } catch {} } } catch {}
  return state;
}
export function writeState(file, state) {
  fs.writeFileSync(`${file}.tmp`, Object.entries(state).map(([name, s]) => `${name}\t${JSON.stringify(s)}`).join("\n") + "\n");
  fs.renameSync(`${file}.tmp`, file);
}

function main() {
  const projects = JSON.parse(fs.readFileSync(here("projects.json"), "utf8"));
  const prev = readState(here("botwatch.state"));
  const state = {}, woke = [];
  for (const project of projects) {
    try {
      const { reasons, state: s } = checkProject(project, prev[project.name]);
      state[project.name] = s;
      if (reasons.length) woke.push({ project, reasons });
    } catch (e) {
      // A project whose bundle is gone stays in the state, and the others are still checked.
      if (prev[project.name]) state[project.name] = prev[project.name];
      console.error(`${project.name}: ${oneLine(e.message)}`);
    }
  }
  writeState(here("botwatch.state"), state);
  if (!woke.length) return 1;
  const lines = [`# Watch ${new Date().toISOString()}`, ""];
  for (const { project, reasons } of woke) lines.push(`## ${project.name}`, `Rules: ${path.join(project.dir, "FRONT_BOT.md")}`, ...(project.projectDir ? [`Project: ${project.projectDir}`] : []), ...reasons.map((r) => `- ${r}`), "");
  fs.writeFileSync(here("wake.md"), lines.join("\n"));
  console.log(lines.join("\n"));
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (e) { console.error(`botwatch: ${oneLine(e.message)}`); process.exitCode = 2; }
}
