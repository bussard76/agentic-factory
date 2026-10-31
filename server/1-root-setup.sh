#!/usr/bin/env bash
# Step 1, as root on a fresh Ubuntu 24.04+ server (arm64 or amd64): base packages, Docker, gh, Tailscale, the
# "developer" user and, optionally, Orca (.deb or AppImage) as a headless server.
# Usage: sudo bash 1-root-setup.sh [./orca-ide_<version>_<arch>.deb | ./Orca.AppImage | --no-orca]
set -euo pipefail
ORCA_PKG="${1:---no-orca}"
USER_NAME="${FACTORY_USER:-developer}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates git jq unzip build-essential util-linux lsof \
  docker.io docker-compose-v2 docker-buildx gh libasound2t64 needrestart unattended-upgrades

# Tailscale (official install script; the human logs in afterwards with `tailscale up`)
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh

# User
id "$USER_NAME" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$USER_NAME"
usermod -aG docker "$USER_NAME"
install -d -o "$USER_NAME" -g "$USER_NAME" -m 700 "/home/$USER_NAME/.ssh"
[ -f /root/.ssh/authorized_keys ] && [ ! -f "/home/$USER_NAME/.ssh/authorized_keys" ] && \
  install -o "$USER_NAME" -g "$USER_NAME" -m 600 /root/.ssh/authorized_keys "/home/$USER_NAME/.ssh/authorized_keys"

# Orca: .deb preferred; an AppImage is extracted to /opt/Orca (same layout as the .deb)
case "$ORCA_PKG" in
  --no-orca) echo "Orca skipped (runner: terminal)";;
  *.deb) apt-get install -y "$(realpath "$ORCA_PKG")" ;;
  *.AppImage)
    apt-get install -y libgtk-3-0t64 libnss3 libxss1 libgbm1 libatk-bridge2.0-0t64 libdrm2 libxkbcommon0 libnotify4 libsecret-1-0 xdg-utils libuuid1
    tmp="$(mktemp -d)"; cp "$ORCA_PKG" "$tmp/orca.AppImage"; chmod +x "$tmp/orca.AppImage"
    (cd "$tmp" && ./orca.AppImage --appimage-extract >/dev/null)
    rm -rf /opt/Orca && mv "$tmp/squashfs-root" /opt/Orca && rm -rf "$tmp"
    chown root:root /opt/Orca/chrome-sandbox && chmod 4755 /opt/Orca/chrome-sandbox
    ln -sf /opt/Orca/resources/bin/orca-ide /usr/bin/orca-ide ;;
  *) echo "unknown Orca package: $ORCA_PKG"; exit 1 ;;
esac

# needrestart must never restart orca.service on its own: that kills every worker.
install -d /etc/needrestart/conf.d
echo '$nrconf{override_rc}{qr(^orca\.service$)} = 0;' > /etc/needrestart/conf.d/orca.conf

systemctl enable --now docker
echo "OK step 1. Next: 'tailscale up' (browser login), then as $USER_NAME: bash 2-user-setup.sh"
