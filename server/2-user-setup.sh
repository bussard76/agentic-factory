#!/usr/bin/env bash
# Step 2, as the developer user: Node via nvm, pnpm, the agent CLIs, uv, the project repos, dependencies, browsers.
# Usage: bash 2-user-setup.sh <github-org-or-user> <repo>...      (gh must be logged in: gh auth login && gh auth setup-git)
# Env: NODE_MAJOR (22), PNPM_VERSION (latest), CODEX_MODEL (default model for Codex), GIT_NAME, GIT_EMAIL
set -euo pipefail
OWNER="${1:?github owner}"; shift; REPOS=("$@")
[ ${#REPOS[@]} -gt 0 ] || { echo "name at least one repo"; exit 1; }
NODE_MAJOR="${NODE_MAJOR:-22}"

# nvm + Node
if [ ! -d "$HOME/.nvm" ]; then
  git clone --depth 1 https://github.com/nvm-sh/nvm.git "$HOME/.nvm"
  grep -q NVM_DIR "$HOME/.bashrc" || cat >> "$HOME/.bashrc" <<'RC'
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
RC
fi
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
nvm install "$NODE_MAJOR"; nvm alias default "$NODE_MAJOR"
corepack enable
[ -n "${PNPM_VERSION:-}" ] && corepack prepare "pnpm@$PNPM_VERSION" --activate || corepack prepare pnpm@latest --activate

# Agent CLIs (install what you use; logins are the human's job)
npm install -g @openai/codex @earendil-works/pi-coding-agent
command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
mkdir -p "$HOME/.local/bin"
for c in codex pi; do [ -x "$(dirname "$(command -v node)")/$c" ] && ln -sf "$(dirname "$(command -v node)")/$c" "$HOME/.local/bin/$c"; done

# Codex base config: the update prompt would block unattended starts
mkdir -p "$HOME/.codex"
if ! grep -q check_for_update_on_startup "$HOME/.codex/config.toml" 2>/dev/null; then
  printf 'check_for_update_on_startup = false\n%s' "${CODEX_MODEL:+model = \"$CODEX_MODEL\"
model_reasoning_effort = \"high\"
}" >> "$HOME/.codex/config.toml"
fi

# Git identity for the factory's commits
[ -n "${GIT_NAME:-}" ] && git config --global user.name "$GIT_NAME"
[ -n "${GIT_EMAIL:-}" ] && git config --global user.email "$GIT_EMAIL"

# Repos
gh auth status >/dev/null 2>&1 || { echo "first: gh auth login && gh auth setup-git"; exit 1; }
mkdir -p "$HOME/projects" "$HOME/orca/workspaces" "$HOME/controller"
for r in "${REPOS[@]}"; do
  [ -d "$HOME/projects/$r/.git" ] || git clone "https://github.com/$OWNER/$r.git" "$HOME/projects/$r"
  ( cd "$HOME/projects/$r"
    # The hooks are per clone: arm them here, this checkout is where the waves push from.
    # A project with the untracked standard is armed by `agentic-factory start`; a hooks path here would bypass its hooks.
    if grep -Eq '"footprint"[[:space:]]*:[[:space:]]*"minimal"' factory.config.json 2>/dev/null; then echo "$r: run agentic-factory start to arm this clone"; else [ -f .githooks/pre-commit ] && git config core.hooksPath .githooks; fi
    [ -f pnpm-lock.yaml ] && pnpm install --frozen-lockfile || true
    [ -f package-lock.json ] && npm ci || true
    # Playwright browsers where the project uses them
    if grep -rq '"@playwright/test"' package.json packages/*/package.json 2>/dev/null; then pnpm exec playwright install chromium chromium-headless-shell || npx playwright install chromium; fi )
done

echo "OK step 2. Next: 'codex login' and/or 'claude' login, then as root: bash 3-root-finish.sh"
