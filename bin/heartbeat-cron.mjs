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
    `if crontab -l 2>/dev/null | grep -qxF "$line"; then echo exists; exit 0; fi`,
    // An older line for this directory goes, for example one that names a node version that was removed since.
    `{ crontab -l 2>/dev/null | awk -v d="cd \\"$d\\"" -v c='${comment}' '$0 == c { next } index($0, d) && index($0, "statuswatch.mjs") { next } { print }'; echo '${comment}'; echo "$line"; } | crontab - && echo added`,
  ].join("\n");
}

// macOS: launchd, because `crontab -` can be refused there ("Operation not permitted"). Runs every 5 minutes after login.
const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const statusWatchLabel = (project) => `de.agentic-factory.statuswatch.${String(project).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
export function statusWatchPlist(dir, project, nodePath, homeDir) {
  const nodeDir = nodePath.slice(0, nodePath.lastIndexOf("/"));
  const log = `${dir}/statuswatch.log`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(statusWatchLabel(project))}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(nodePath)}</string><string>statuswatch.mjs</string></array>
  <key>WorkingDirectory</key><string>${xml(dir)}</string>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(`${nodeDir}:${homeDir}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`)}</string></dict>
</dict>
</plist>
`;
}
