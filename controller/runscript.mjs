// Run a local bash script in the integration worktree of a worker host, ending with WAVE-END.
// Usage: node runscript.mjs <script-file> "<title>" [--on <host>]   then: node wavewait.mjs
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CONTROLLER_HOME, ORCA, RUNNER, argHost, file, integrationOn, onHost, orcaEnvArgsOn, sh, worktreeRefOn } from "./lib.mjs";

const host = argHost(process.argv);
const [script, title] = process.argv.slice(2).filter((x, i, a) => x !== "--on" && a[i - 1] !== "--on");
if (!script || !title) throw new Error('usage: node runscript.mjs <script-file> "<title>" [--on <host>]');
const b64 = fs.readFileSync(script).toString("base64");
const name = path.basename(script);
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const cmd = `echo ${b64} | base64 -d > /tmp/${name}; bash /tmp/${name} 2>&1 | tee /tmp/wave.out; echo WAVE-END`;
if (RUNNER === "orca") {
  const out = sh(ORCA, ["terminal", "create", "--worktree", worktreeRefOn(host, "coordinator-integration"), "--title", `Coordinator ${title}`, "--command", cmd, ...orcaEnvArgsOn(host), "--json"]);
  const h = /"handle":\s*"([^"]+)"/.exec(out)?.[1];
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
