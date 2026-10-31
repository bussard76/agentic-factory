#!/usr/bin/env bash
# Step 3, as root, after `tailscale up` and step 2: Playwright system packages and, with Orca installed, orca.service
# bound to the Tailscale address. Usage: sudo bash 3-root-finish.sh [<repo-with-playwright>]
set -euo pipefail
USER_NAME="${FACTORY_USER:-developer}"
REPO="${1:-}"

if [ -n "$REPO" ]; then
  NODE_BIN="$(su - "$USER_NAME" -c 'bash -lc ". ~/.nvm/nvm.sh >/dev/null; dirname $(command -v node)"')"
  (cd "/home/$USER_NAME/projects/$REPO" && PATH="$NODE_BIN:$PATH" npx playwright install-deps chromium) || echo "playwright deps skipped"
fi

if command -v orca-ide >/dev/null; then
  TS_IP="$(tailscale ip -4 | head -1)"
  [ -n "$TS_IP" ] || { echo "Tailscale not connected: run 'tailscale up' first"; exit 1; }
  cat > /etc/systemd/system/orca.service <<UNIT
[Unit]
Description=Orca headless server
After=network-online.target tailscaled.service docker.service
Wants=network-online.target

[Service]
User=$USER_NAME
Group=$USER_NAME
WorkingDirectory=/home/$USER_NAME
Environment=HOME=/home/$USER_NAME
ExecStart=/usr/bin/script -qfc "/usr/bin/orca-ide serve --port 6768 --pairing-address $TS_IP --supervise" /dev/null
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now orca.service
  sleep 5; systemctl --no-pager status orca.service | head -5
  echo "Pairing code: journalctl -u orca.service -n 50. On your machine: orca environment add --name <env> --pairing-code '<code>' (no mobile code)."
fi
echo "OK step 3."
