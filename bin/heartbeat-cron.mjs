// The shell script that adds the heartbeat's cron line on the Controller's host. It leaves the rest of the crontab alone,
// and a line that already runs this directory's heartbeat stays. It prints "added" or "exists".
export function heartbeatCronScript(dir, project) {
  const d = dir.replace(/^~(?=\/|$)/, "$HOME");
  const comment = `# agentic-factory heartbeat: ${project}`.replace(/'/g, "");
  return [
    `d="${d}"`,
    `line="* * * * * cd \\"$d\\" && PATH=\\"$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin\\" node heartbeat.mjs >> heartbeat.log 2>&1"`,
    `if crontab -l 2>/dev/null | grep -qF -e "$d/heartbeat.mjs" -e "cd \\"$d\\""; then echo exists; exit 0; fi`,
    `{ crontab -l 2>/dev/null; echo '${comment}'; echo "$line"; } | crontab - && echo added`,
  ].join("\n");
}
