// Names this project's sidebar entries and helper terminals by role (docs/orca.md, "Naming"). Corrects only automatic names and
// folder names, so a name the human set stays. Selects entries by path, and lists only this project's repo, so a shared host's
// other projects stay untouched. An entry with no known role is reported, never guessed.
// Usage: node names.mjs [--on <host>|--all] [--dry]
import path from "node:path";
import { HOSTS, ORCA, PROJECT, RUNNER, argHost, config, orcaEnvArgsOn, readJson, sh } from "./lib.mjs";

const INTEGRATION_DIR = "coordinator-integration";

/** Orca's own terminal names. Any name the human or an agent chose matches neither, so it stays. */
const terminalPurpose = (title = "") => (title === "Setup" ? "Setup" : /^\S+@\S+: /.test(title) ? "Shell" : null);

/** The role name of an entry, or null when it has no known role. A local Controller shares the Front agent's checkout. */
function entryName({ worktree, workerNames, controllerSharesCheckout, onControllerHost }) {
  if (worktree.isMainWorktree) {
    if (!onControllerHost) return null;
    return `${PROJECT} · ${controllerSharesCheckout ? "Front Agent" : "Controller"}`;
  }
  const dir = path.basename(worktree.path);
  if (dir === INTEGRATION_DIR) return `${PROJECT} · Integration`;
  return workerNames[dir] ?? null;
}

const dry = process.argv.includes("--dry");
const hosts = process.argv.includes("--all") ? HOSTS : [argHost(process.argv)];
const controllerHost = config.hosts?.controller?.host ?? "local";
const controllerSharesCheckout = (config.hosts?.workers ?? []).find((h) => h.name === controllerHost)?.kind !== "remote";
const workers = Object.values(readJson("workers.json", {}));

if (RUNNER === "orca") {
  let named = 0, namedTerminals = 0;
  const unknown = [];
  for (const host of hosts) {
    if (!host.orcaRepoId) continue;
    const env = orcaEnvArgsOn(host);
    const workerNames = Object.fromEntries(workers.filter((w) => w.host === host.name && w.worktree).map((w) => [path.basename(w.worktree), w.name]));
    const list = JSON.parse(sh(ORCA, ["worktree", "list", "--repo", `id:${host.orcaRepoId}`, "--limit", "10000", ...env, "--json"]));
    const entries = new Map();
    for (const worktree of list.result?.worktrees ?? []) {
      // `worker-start --name` fixes the name to the folder name, so that counts as automatic too.
      if (worktree.displayNameMode !== "automatic" && worktree.displayName !== path.basename(worktree.path)) { entries.set(worktree.path, worktree.displayName); continue; }
      const name = entryName({ worktree, workerNames, controllerSharesCheckout, onControllerHost: host.name === controllerHost });
      if (!name) { unknown.push(`${host.name}:${worktree.displayName}`); continue; }
      entries.set(worktree.path, name);
      named++;
      if (!dry) sh(ORCA, ["worktree", "set", "--worktree", `id:${worktree.id}`, "--display-name", name, ...env, "--json"]);
    }
    const terminals = JSON.parse(sh(ORCA, ["terminal", "list", ...env, "--json"])).result?.terminals ?? [];
    for (const terminal of terminals) {
      const purpose = terminalPurpose(terminal.title), entry = entries.get(terminal.worktreePath);
      if (!purpose || !entry) continue;
      namedTerminals++;
      if (!dry) sh(ORCA, ["terminal", "rename", "--terminal", terminal.handle, "--title", `${entry} · ${purpose}`, ...env, "--json"]);
    }
  }
  console.log(`names${dry ? " (dry)" : ""}: ${named} entries named${unknown.length ? `; no known role, left as is: ${unknown.join(", ")}` : ""}${namedTerminals ? `; ${namedTerminals} terminals named` : ""}`);
}
