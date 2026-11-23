import { createHash } from "node:crypto";

const heartbeatCronCheckLine = `if crontab -l 2>/dev/null | grep -F -e "$d/heartbeat.mjs" -e "cd \\"$d\\"" | grep -qF heartbeat.mjs; then echo exists; exit 0; fi`;

// Read-only: prints "exists" when a cron line already runs this directory's heartbeat, else "none". Never writes the crontab.
export const heartbeatCronCheckScript = (dir) => [`d="${dir.replace(/^~(?=\/|$)/, "$HOME")}"`, heartbeatCronCheckLine, "echo none"].join("\n");

// The shell script that adds the heartbeat's cron line on the Controller's host, and brings an older line for this directory
// up to date (for example one without node's directory: under nvm and the like node is on no fixed path, and cron has only
// the PATH given here). It leaves the rest of the crontab alone. It prints "added", "updated" or "exists".
export function heartbeatCronScript(dir, project, nodeDir = "") {
  const d = dir.replace(/^~(?=\/|$)/, "$HOME");
  const comment = `# agentic-factory heartbeat: ${project}`.replace(/'/g, "");
  return [
    `d="${d}"`,
    `line="* * * * * cd \\"$d\\" && PATH=\\"${nodeDir ? `${nodeDir}:` : ""}$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin\\" node heartbeat.mjs >> heartbeat.log 2>&1"`,
    `if crontab -l 2>/dev/null | grep -qxF "$line"; then echo exists; exit 0; fi`,
    // A line written by hand (it names the script but not our `cd`) stays as it is.
    `if crontab -l 2>/dev/null | grep -F "$d/heartbeat.mjs" | grep -vF "cd \\"$d\\"" | grep -q .; then echo exists; exit 0; fi`,
    `old=$(crontab -l 2>/dev/null | grep -F -e "$d/heartbeat.mjs" -e "cd \\"$d\\"" | grep -cF heartbeat.mjs)`,
    `{ crontab -l 2>/dev/null | awk -v d="cd \\"$d\\"" -v c='${comment}' '$0 == c { next } index($0, d) && index($0, "heartbeat.mjs") { next } { print }'; echo '${comment}'; echo "$line"; } | crontab - && { [ "$old" -gt 0 ] && echo updated || echo added; }`,
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
// The hash keeps "My App" and "my-app" apart. node comes through PATH below, because Homebrew's real path names a version
// that an upgrade removes, and launchd would then fail without a line in any log.
export const statusWatchLabel = (project) => `de.agentic-factory.statuswatch.${String(project).toLowerCase().replace(/[^a-z0-9]+/g, "-")}.${createHash("sha256").update(String(project)).digest("hex").slice(0, 6)}`;
const launchdPlist = (label, script, interval, dir, nodePath, homeDir, extraPathDirs = []) => {
  const nodeDir = nodePath.slice(0, nodePath.lastIndexOf("/"));
  const log = `${dir}/${script.replace(/\.mjs$/, "")}.log`;
  const pathDirs = [nodeDir, ...extraPathDirs.filter((d) => d && d !== nodeDir), `${homeDir}/.local/bin`, "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/env</string><string>node</string><string>${script}</string></array>
  <key>WorkingDirectory</key><string>${xml(dir)}</string>
  <key>StartInterval</key><integer>${interval}</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(pathDirs.join(":"))}</string></dict>
</dict>
</plist>
`;
};
export const statusWatchPlist = (dir, project, nodePath, homeDir) => launchdPlist(statusWatchLabel(project), "statuswatch.mjs", 300, dir, nodePath, homeDir);

// The heartbeat the same way, every minute. orcaDir: where the orca command lives, which launchd's PATH does not know.
// The hash also covers the Controller directory, so two factories with one project name keep their own jobs.
export const heartbeatLabel = (project, dir = "") => statusWatchLabel(project).replace(".statuswatch.", ".heartbeat.").replace(/\.[0-9a-f]{6}$/, `.${createHash("sha256").update(`${project}\n${dir}`).digest("hex").slice(0, 6)}`);
export const heartbeatPlist = (dir, project, nodePath, homeDir, orcaDir) => launchdPlist(heartbeatLabel(project, dir), "heartbeat.mjs", 60, dir, nodePath, homeDir, [orcaDir]);
