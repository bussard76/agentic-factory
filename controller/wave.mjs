// Launch an integration wave in the integration worktree of a worker host. Waits for the load to drop first.
// Usage: node wave.mjs "<title>" "<summary>" origin/<branch>... [--on <host>]   then: node wavewait.mjs
// Pass each task branch AND the review branch of its passing round (origin/agents/t12 origin/agents/t12-review-2):
// the push gate reads the findings files from the pushed tree, so a wave without them is rejected.
// The wave merges exactly the commit that was reviewed, not the branch tip: for each task branch it takes that commit from the
// Controller's own journal (reviewed.mjs and docsonly.mjs write it; the latest review event of the task counts) and hands
// integ-wave.sh `origin/<branch>@<sha>`; a task's review branches go as `origin/<branch>~<sha>`. A task without a usable record
// is not started: the wave prints why and what to do, launches nothing and journals nothing. integ-wave.sh then compares
// the tip of every branch on origin with its commit, and stops the whole wave, merging nothing, if one has moved.
import "./cli.mjs";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { BRANCH_PREFIX, CMDS, CONTROLLER_HOME, MAIN, ORCA, PROJECT, RUNNER, argHost, file, integrationOn, journal, onHost, orcaEnvArgsOn, sh, worktreeRefOn } from "./lib.mjs";
import { bindBranches, latestReview } from "./reviewrecord.mjs";

const host = argHost(process.argv);
const args = process.argv.slice(2).filter((x, i, a) => x !== "--on" && a[i - 1] !== "--on");
const [title, summary, ...branches] = args;
if (!title || !branches.length) throw new Error('usage: node wave.mjs "<title>" "<summary>" origin/<branch>... [--on <host>]');
const b64 = fs.readFileSync(file("integ-wave.sh")).toString("base64");
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const envs = { MAIN, INSTALL_CMD: CMDS.install ?? "", VERIFY_CMD: CMDS.verify ?? "", E2E_CMD: CMDS.e2e ?? "", GATE: `${CONTROLLER_HOME.replace(/^~(?=\/|$)/, "$HOME")}/gate`, WAVE_PROJECT: PROJECT, TRAILER: process.env.WAVE_TRAILER ?? "" };
if (!envs.VERIFY_CMD.trim()) throw new Error("commands.verify is empty or only whitespace: a wave without a verification command is not allowed");
if (!branches.some((b) => /-review-\d+$|-review-final$/.test(b))) console.error("warning: no review branch among the wave branches; the push gate needs the findings files in the pushed tree (a docs-only task has none)");
if (!envs.E2E_CMD.trim()) envs.E2E_CMD = "";
// Before anything is launched or journaled: every task branch needs the Controller's record of what was reviewed. A handbook
// that predates this (an older CONTROLLER.md after `update`) never writes the record, so it ends here, and says so.
const journalText = () => { try { return fs.readFileSync(file("journal.ndjson"), "utf8"); } catch (e) { return e; } };
const bound = bindBranches(branches, { prefix: BRANCH_PREFIX, read: (key) => latestReview(journalText(), key) });
if (bound.problems) {
  console.error(`WAVE-NOT-STARTED: ${bound.problems.length} branch(es) cannot be bound to a reviewed commit. Nothing was launched, merged or journaled.\n${bound.problems.map((p) => `  ${p}`).join("\n")}\n`
    + `The wave merges exactly the commit a review passed, from the Controller's journal. If CONTROLLER.md never told you to run reviewed.mjs, your handbook is older than these scripts: the new one is in .factory/new/CONTROLLER.md after \`agentic-factory update\`; ask the human to merge it.`);
  process.exit(1);
}
const bondedBranches = bound.args;
const exportLine =Object.entries(envs).map(([k, v]) => `export ${k}=${k === "GATE" ? `"${v}"` : q(v)}`).join("; ");
const cmd = `clear; T=$(nproc 2>/dev/null || sysctl -n hw.ncpu); while [ "$(cut -d. -f1 /proc/loadavg 2>/dev/null || echo 0)" -ge "$T" ]; do sleep 15; done; ${exportLine}; echo ${b64} | base64 -d > /tmp/${PROJECT}-integ-wave.sh; WAVE_LOG_DIR=/tmp/${PROJECT}-wave bash /tmp/${PROJECT}-integ-wave.sh ${q(title)} ${q(summary)} ${bondedBranches.join(" ")} 2>&1 | tee /tmp/${PROJECT}-wave.out; echo WAVE-END`;
journal("wave", title, { host: host.name, note: bondedBranches.join(" ") });
if (RUNNER === "orca") {
  const j = JSON.parse(sh(ORCA, ["terminal", "create", "--worktree", worktreeRefOn(host, "coordinator-integration"), "--title", `${PROJECT} · Integration · ${title.slice(0, 40)}`, "--command", cmd, ...orcaEnvArgsOn(host), "--json"]));
  const h = j.result?.terminal?.handle ?? j.result?.handle;
  fs.writeFileSync(file("wave-handle.txt"), `${host.name} ${h}\n`);
  console.log(h);
} else if (host.kind === "local") {
  fs.mkdirSync(file("logs"), { recursive: true });
  const log = fs.openSync(file("logs/wave.log"), "w");
  const child = spawn("bash", ["-c", cmd], { cwd: integrationOn(host), detached: true, stdio: ["ignore", log, log] });
  child.unref();
  fs.writeFileSync(file("wave-handle.txt"), `${host.name} pid:${child.pid}\n`);
  console.log(`pid:${child.pid}`);
} else {
  onHost(host, `mkdir -p ${CONTROLLER_HOME}/logs && cd ${q(integrationOn(host))} && (setsid bash -c ${q(cmd)} > ${CONTROLLER_HOME}/logs/wave.log 2>&1 < /dev/null &)`);
  fs.writeFileSync(file("wave-handle.txt"), `${host.name} remote-log\n`);
  console.log("remote-log");
}
