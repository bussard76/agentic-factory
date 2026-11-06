#!/bin/bash
# Keeps the human's local preview on the current origin/<main>. Runs every 3 minutes from a launchd agent (macOS)
# or a systemd timer (its oneshot service needs KillMode=process, or the preview ends with this script); restarts only
# when origin/<main> moved or the preview process is not running.
# Config: edit the block below (init fills it) or export the variables before calling.
set -u
export PATH=/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$HOME/.local/share/pnpm:$HOME/.local/bin:$PATH
PROJECT="${PREVIEW_PROJECT:-{{PROJECT}}}"
W="${PREVIEW_WORKTREE:-$HOME/Development/${PROJECT}-preview}"     # a separate clone or worktree, never the working repo
ENV_LINK="${PREVIEW_ENV_LINK:-$HOME/Development/${PROJECT}/.env}"  # the real .env, linked into the preview (read-only use)
ENV_FILE="${PREVIEW_ENV_FILE:-{{PREVIEW_ENV_FILE}}}"              # extra variables for the preview mode (e.g. a private data copy)
MAIN="${PREVIEW_MAIN:-{{MAIN}}}"
PORT="${PREVIEW_PORT:-{{PREVIEW_PORT}}}"
INSTALL_CMD="${PREVIEW_INSTALL:-{{INSTALL_CMD}}}"
START_CMD="${PREVIEW_START:-{{PREVIEW_CMD}}}"
PID=/tmp/${PROJECT}-preview.pid
LOG=/tmp/${PROJECT}-preview.log

# Bash does not expand a ~ inside quotes, and the config writes the path with one.
case "$ENV_FILE" in "~/"*) ENV_FILE="$HOME/${ENV_FILE#"~/"}" ;; esac
# Without its env file the app falls back to its default state, which can be the human's real data. So nothing starts,
# and a preview that already runs stays as it is.
if [ -n "$ENV_FILE" ] && { [ ! -f "$ENV_FILE" ] || [ ! -r "$ENV_FILE" ]; }; then
  echo "$(date '+%F %T') not starting the preview: env file $ENV_FILE is missing or unreadable"
  exit 0
fi

cd "$W" || { echo "preview worktree $W missing"; exit 1; }
git fetch -q origin || exit 0
new=$(git rev-parse "origin/$MAIN"); cur=$(cat .preview-sha 2>/dev/null || true)
running=no; [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null && running=yes
[ "$new" = "$cur" ] && [ "$running" = yes ] && exit 0
echo "$(date '+%F %T') updating ${cur:0:7} -> ${new:0:7} (running=$running)"
if [ "$running" = yes ]; then pkill -TERM -P "$(cat "$PID")" 2>/dev/null; kill -TERM "$(cat "$PID")" 2>/dev/null; sleep 5; fi
git checkout -q --detach "$new" && git clean -fdq -e .preview-sha -e .env
[ -f "$ENV_LINK" ] && ln -sfn "$ENV_LINK" .env
if [ -n "$INSTALL_CMD" ] && ! bash -c "$INSTALL_CMD" > "/tmp/${PROJECT}-preview-install.log" 2>&1; then echo "install failed, see /tmp/${PROJECT}-preview-install.log"; exit 1; fi
# The env file may hold unquoted values with spaces, so read it line by line instead of sourcing it.
( if [ -f "$ENV_FILE" ]; then while IFS= read -r line; do case "$line" in ""|\#*) continue;; esac; export "${line%%=*}=${line#*=}"; done < "$ENV_FILE"; fi
  export PORT="$PORT" WEB_PORT="$PORT"
  exec nohup bash -c "$START_CMD" > "$LOG" 2>&1 ) &
echo $! > "$PID"; echo "$new" > .preview-sha
echo "$(date '+%F %T') started ${new:0:7} on http://localhost:$PORT (pid $(cat "$PID"))"
