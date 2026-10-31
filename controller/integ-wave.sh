#!/usr/bin/env bash
# Integration wave: merge the passed branches ONE BY ONE into the integration worktree, run the full gates once, push
# to main. No octopus merges: the push gate judges a merge by its own changes against its two parents, and an octopus
# of several reviewed tasks has no such pair, so it would be rejected. No Docker: that is the release gate.
# Fails fast: any setup, merge, gate or push failure ends with a non-zero exit and a line naming the step.
# Usage (inside the integration worktree, env from wave.mjs):
#   integ-wave.sh "<title>" "<summary>" <branch>...   branches as origin/<prefix>/<name>, each task with its review branch
# Env: MAIN, INSTALL_CMD, VERIFY_CMD (required, non-empty), E2E_CMD (optional), GATE (path to gate), TRAILER (optional)
set -uo pipefail
TITLE="$1"; SUMMARY="$2"; shift 2; BR="$*"
MAIN="${MAIN:-main}"; GATE="${GATE:-$HOME/.local/bin/gate}"
[ -n "${VERIFY_CMD:-}" ] || { echo "VERIFY-MISSING: commands.verify is empty; a wave without a verification command is not allowed"; exit 1; }
[ -n "$BR" ] || { echo "NO-BRANCHES"; exit 1; }
# This script resets and cleans the directory it runs in (untracked files included). Only the integration worktree.
[ "$(basename "$PWD")" = "coordinator-integration" ] || [ "${WAVE_WORKTREE_OK:-}" = "1" ] || { echo "WRONG-DIRECTORY: $PWD is not the coordinator-integration worktree (set WAVE_WORKTREE_OK=1 to override)"; exit 1; }
strip() { sed "s/\x1b\[[0-9;]*m//g"; }
git merge --abort 2>/dev/null; git reset -q --hard 2>/dev/null
git fetch -q origin || { echo "FETCH-FAILED"; exit 1; }
git checkout -q -B integration "origin/$MAIN" || { echo "CHECKOUT-FAILED"; exit 1; }
# The integration worktree is disposable: drop untracked AND ignored leftovers (lockfiles or build output from an
# earlier install), otherwise a branch that adds such a file cannot be merged ("would be overwritten").
git clean -fdxq
if [ -n "${INSTALL_CMD:-}" ]; then bash -c "$INSTALL_CMD" > /tmp/wave-install.log 2>&1 || echo "install on $MAIN failed, retrying after merge"; fi
merged=0
for b in $BR; do
  if ! git merge -q --no-ff --no-commit "$b" > /tmp/wave-merge.log 2>&1; then
    u=$(git diff --name-only --diff-filter=U)
    echo "CONFLICT in $b: ${u:-$(tail -2 /tmp/wave-merge.log | tr '\n' ' ')}"; git merge --abort 2>/dev/null; exit 1
  fi
  if git diff --cached --quiet; then git merge --abort 2>/dev/null; echo "nothing from $b"; continue; fi
  # The merged commits passed the commit hooks with their own ADR references; carry those references into the merge
  # message, so a task that touches a protected file (an ADR, AGENTS.md, a hook) merges without a second approval.
  refs=$(git log --format=%B "origin/$MAIN..$b" | grep -oE 'ADR-[0-9]{4}' | sort -u | tr '\n' ' ')
  git commit -q -m "Merge $b ($TITLE)" -m "$SUMMARY" ${refs:+-m "Refs: $refs"} ${TRAILER:+-m "$TRAILER"} > /tmp/wave-commit.log 2>&1 \
    || { strip < /tmp/wave-commit.log | grep -a -iE "fail|protected|factory" | head -6; echo "COMMIT-FAILED for $b"; exit 1; }
  echo "merged $b"; merged=$((merged + 1))
done
[ "$merged" -gt 0 ] || { echo "NOTHING-TO-MERGE"; exit 1; }
if [ -n "${INSTALL_CMD:-}" ]; then bash -c "$INSTALL_CMD" > /tmp/wave-install.log 2>&1 || { echo INSTALL-FAILED; tail -3 /tmp/wave-install.log; exit 1; }; fi
s=$(date +%s)
if "$GATE" bash -c "$VERIFY_CMD" > /tmp/wave-verify.log 2>&1; then echo "verify PASS $(( $(date +%s) - s ))s"; else echo "verify FAIL"; strip < /tmp/wave-verify.log | grep -a -E "^ *×| FAIL |Test Files|  Tests |Error" | head -8; exit 1; fi
if [ -n "${E2E_CMD:-}" ]; then
  s=$(date +%s)
  if "$GATE" bash -c "$E2E_CMD" > /tmp/wave-e2e.log 2>&1; then echo "e2e PASS $(( $(date +%s) - s ))s"; else echo "e2e FAIL"; strip < /tmp/wave-e2e.log | grep -a -E "failed|✘|Error" | head -6; exit 1; fi
fi
git log --oneline -3
if git push origin "integration:$MAIN" > /tmp/wave-push.log 2>&1; then strip < /tmp/wave-push.log | tail -2; echo "PUSHED $MAIN"; else strip < /tmp/wave-push.log | grep -a -E '^\[factory\]|^[0-9a-f]{10}|^remote:|^error:|^fatal:' | head -12; echo "PUSH-FAILED"; exit 1; fi
