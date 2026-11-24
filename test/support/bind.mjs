// The branch tokens wave.mjs hands integ-wave.sh, built from what origin has now (a test that calls the script by hand):
// a task branch as origin/<b>@<tip>, its review branch as origin/<b>~<task tip>:<its tip>, anything else unchanged.
import { spawnSync } from "node:child_process";

export function bind(cwd, branches) {
  const tip = (name) => spawnSync("git", ["ls-remote", "origin", `refs/heads/${name}`], { cwd, encoding: "utf8" }).stdout.split("\t")[0].trim();
  return branches.map((b) => {
    const name = b.replace(/^origin\//, ""), sha = tip(name);
    if (!sha || /^status-wave-\d+$/.test(name)) return `origin/${name}`;
    const task = name.replace(/-(review-(\d+|final)|conformance)$/, "");
    if (task !== name) return tip(task) ? `origin/${name}~${tip(task)}:${sha}` : `origin/${name}`;
    return `origin/${name}@${sha}`;
  });
}
