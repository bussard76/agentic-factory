// The branch tokens wave.mjs hands integ-wave.sh, built from what origin has now (a test that calls the script by hand):
// a task branch as origin/<b>@<tip>, its review branch as origin/<b>~<task tip>:<its tip>=<its one findings file>, anything else unchanged.
import { spawnSync } from "node:child_process";

export function bind(cwd, branches) {
  const git = (...a) => spawnSync("git", a, { cwd, encoding: "utf8" }).stdout.trim();
  const tip = (name) => git("ls-remote", "origin", `refs/heads/${name}`).split("\t")[0].trim();
  git("fetch", "-q", "--no-tags", "origin");
  return branches.map((b) => {
    const name = b.replace(/^origin\//, ""), sha = tip(name);
    if (!sha || /^status-wave-\d+$/.test(name)) return `origin/${name}`;
    const task = name.replace(/-(review-(\d+|final)|conformance)$/, "");
    if (task === name) return `origin/${name}@${sha}`;
    const t = tip(task);
    if (!t) return `origin/${name}`;
    const base = git("merge-base", t, sha), file = git("diff", "--no-renames", "--name-only", base, sha).split("\n")[0];
    return `origin/${name}~${t}:${sha}=${file}`;
  });
}
