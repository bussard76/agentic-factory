// Launch an integration wave in the integration worktree of a worker host. Waits for the load to drop first.
// Usage: node wave.mjs "<title>" "<summary>" origin/<branch>... [--on <host>]   then: node wavewait.mjs
// Pass each task branch AND the review branch of its passing round (origin/agents/t12 origin/agents/t12-review-2):
// the push gate reads the findings files from the pushed tree, so a wave without them is rejected.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { CMDS, MAIN, ORCA, RUNNER, argHost, file, integrationOn, journal, onHost, orcaEnvArgsOn, sh, worktreeRefOn } from "./lib.mjs";

const host = argHost(process.argv);
const args = process.argv.slice(2).filter((x, i, a) => x !== "--on" && a[i - 1] !== "--on");
const [title, summary, ...branches] = args;
if (!title || !branches.length) throw new Error('usage: node wave.mjs "<title>" "<summary>" origin/<branch>... [--on <host>]');
const b64 = fs.readFileSync(file("integ-wave.sh")).toString("base64");
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const envs = { MAIN, INSTALL_CMD: CMDS.install ?? "", VERIFY_CMD: CMDS.verify ?? "", E2E_CMD: CMDS.e2e ?? "", GATE: "$HOME/.local/bin/gate", TRAILER: process.env.WAVE_TRAILER ?? "" };
if (!envs.VERIFY_CMD) throw new Error("commands.verify is empty: a wave without a verification command is not allowed");
if (!branches.some((b) => /-review-\d+$|-review-final$/.test(b))) console.error("warning: no review branch among the wave branches; the push gate needs the findings files in the pushed tree");
const exportLine = Object.entries(envs).map(([k, v]) => `export ${k}=${k === "GATE" ? `"${v}"` : q(v)}`).join("; ");
const cmd = `clear; T=$(nproc 2>/dev/null || sysctl -n hw.ncpu); while [ "$(cut -d. -f1 /proc/loadavg 2>/dev/null || echo 0)" -ge "$T" ]; do sleep 15; done; ${exportLine}; echo ${b64} | base64 -d > /tmp/integ-wave.sh; bash /tmp/integ-wave.sh ${q(title)} ${q(summary)} ${branches.join(" ")} 2>&1 | tee /tmp/wave.out; echo WAVE-END`;
journal("wave", title, { host: host.name, note: branches.join(" ") });
if (RUNNER === "orca") {
  const j = JSON.parse(sh(ORCA, ["terminal", "create", "--worktree", worktreeRefOn(host, "coordinator-integration"), "--title", `Coordinator ${title.slice(0, 40)}`, "--command", cmd, ...orcaEnvArgsOn(host), "--json"]));
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
  onHost(host, `mkdir -p ~/controller/logs && cd ${q(integrationOn(host))} && (setsid bash -c ${q(cmd)} > ~/controller/logs/wave.log 2>&1 < /dev/null &)`);
  fs.writeFileSync(file("wave-handle.txt"), `${host.name} remote-log\n`);
  console.log("remote-log");
}
