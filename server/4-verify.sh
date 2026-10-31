#!/usr/bin/env bash
# Step 4, as the developer user: can this server take worker orders? Read-only unless --gates.
# Usage: bash 4-verify.sh [<repo>] [--gates]    (--gates runs the repo's verify and e2e commands from factory.config.json)
set -uo pipefail
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null
ok(){ printf 'OK      %s\n' "$1"; }; bad(){ printf 'MISSING %s\n' "$1"; FAIL=1; }; FAIL=0
REPO=""; GATES=""; for a in "$@"; do [ "$a" = "--gates" ] && GATES=1 || REPO="$a"; done
for c in git node pnpm docker gh tailscale flock lsof; do command -v $c >/dev/null && ok "$c $($c --version 2>&1 | head -1 | cut -c1-40)" || bad $c; done
for c in codex claude pi orca-ide uv; do command -v $c >/dev/null && ok "$c" || echo "info    $c not installed"; done
id -nG | grep -qw docker && ok "docker group" || bad "docker group (log in again)"
docker run --rm hello-world >/dev/null 2>&1 && ok "docker run" || bad "docker run"
gh auth status >/dev/null 2>&1 && ok "gh login" || bad "gh login"
[ -f ~/.codex/auth.json ] && ok "codex login" || echo "info    codex not logged in"
grep -q 'check_for_update_on_startup = false' ~/.codex/config.toml 2>/dev/null && ok "codex update prompt off" || echo "info    codex config"
if command -v orca-ide >/dev/null; then systemctl is-active --quiet orca.service && ok "orca.service" || bad "orca.service"; [ -f /etc/needrestart/conf.d/orca.conf ] && ok "needrestart exception" || bad "needrestart exception"; fi
[ -x ~/.local/bin/gate ] && ok "gate installed" || echo "info    ~/.local/bin/gate missing (init copies it)"
# User-level skills: the Controller runs outside the repo and needs these on this host.
for s in orchestration orca-cli writing-for-agents retro; do
  if [ -f ~/.claude/skills/$s/SKILL.md ] || [ -f ~/.agents/skills/$s/SKILL.md ]; then ok "user-level skill $s"; else bad "user-level skill $s (cp -R ~/controller/skills/* ~/.claude/skills/ && cp -R ~/controller/skills/* ~/.agents/skills/)"; fi
done
echo "RAM $(free -g | awk '/Mem/{print $2}') GB, threads $(nproc), disk free $(df -h --output=avail / | tail -1 | tr -d ' ')"
if [ -n "$GATES" ] && [ -n "$REPO" ]; then
  cd ~/projects/"$REPO" || exit 1
  V=$(node -e 'const c=require("./factory.config.json");console.log(c.commands.verify||"")'); E=$(node -e 'const c=require("./factory.config.json");console.log(c.commands.e2e||"")')
  git pull -q && bash -c "$(node -e 'console.log(require("./factory.config.json").commands.install||"true")')" && bash -c "$V" && { [ -z "$E" ] || bash -c "$E"; } && ok "gates green on main" || bad "gates"
fi
exit $FAIL
