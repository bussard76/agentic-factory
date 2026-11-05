// The shell script that adds the heartbeat's cron line on the Controller's host. It leaves the rest of the crontab alone,
// and a line that already runs this directory's heartbeat stays. It prints "added" or "exists".
export function heartbeatCronScript(dir, project) {
  const d = dir.replace(/^~(?=\/|$)/, "$HOME");
  const comment = `# agentic-factory heartbeat: ${project}`.replace(/'/g, "");
  return [
    `d="${d}"`,
    `line="* * * * * cd \\"$d\\" && PATH=\\"$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin\\" node heartbeat.mjs >> heartbeat.log 2>&1"`,
    `if crontab -l 2>/dev/null | grep -F -e "$d/heartbeat.mjs" -e "cd \\"$d\\"" | grep -qF heartbeat.mjs; then echo exists; exit 0; fi`,
    `{ crontab -l 2>/dev/null; echo '${comment}'; echo "$line"; } | crontab - && echo added`,
  ].join("\n");
}

// The same for the Front agent's status watch, every 5 minutes on the human's machine.
// nodeDir: under nvm and the like, node is on no fixed path, and cron has only the PATH given here.
export function statusWatchCronScript(dir, project, nodeDir = "") {
  const d = dir.replace(/^~(?=\/|$)/, "$HOME");
  const comment = `# agentic-factory status watch: ${project}`.replace(/'/g, "");
  return [
    `d="${d}"`,
    `line="*/5 * * * * cd \\"$d\\" && PATH=\\"${nodeDir ? `${nodeDir}:` : ""}$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin\\" node statuswatch.mjs >> statuswatch.log 2>&1"`,
    `if crontab -l 2>/dev/null | grep -F "cd \\"$d\\"" | grep -qF statuswatch.mjs; then echo exists; exit 0; fi`,
    `{ crontab -l 2>/dev/null; echo '${comment}'; echo "$line"; } | crontab - && echo added`,
  ].join("\n");
}
