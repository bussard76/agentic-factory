#!/usr/bin/env bash
# Integration wave: merge the passed branches into the integration worktree, run the full gates once, push to main.
# No Docker: that is the release gate. Usage (run inside the integration worktree, env from wave.mjs):
#   integ-wave.sh "<title>" "<summary>" <branch>...     branches as origin/<prefix>/<name>
# Env: MAIN, INSTALL_CMD, VERIFY_CMD, E2E_CMD, GATE (path to gate), TRAILER (commit trailer line, optional)
set -u
TITLE="$1"; SUMMARY="$2"; shift 2; BR="$*"
MAIN="${MAIN:-main}"; GATE="${GATE:-$HOME/.local/bin/gate}"
strip() { sed "s/\x1b\[[0-9;]*m//g"; }
git merge --abort 2>/dev/null; git reset -q --hard 2>/dev/null
git fetch -q origin && git checkout -q -B integration "origin/$MAIN" && git clean -fdXq
[ -n "${INSTALL_CMD:-}" ] && { bash -c "$INSTALL_CMD" > /tmp/wave-install.log 2>&1 || echo "install on $MAIN failed, retrying after merge"; }
if git merge -q --no-ff --no-commit $BR > /tmp/wave-merge.log 2>&1; then
  echo "octopus merge staged"
  git commit -q -m "$TITLE" -m "$SUMMARY" ${TRAILER:+-m "$TRAILER"} > /tmp/wave-commit.log 2>&1 || { strip < /tmp/wave-commit.log | grep -a -iE "fail|protected|factory" | head -6; echo COMMIT-FAILED; exit 1; }
else
  echo "OCTOPUS FAILED - sequential"; git merge --abort 2>/dev/null; git reset -q --hard "origin/$MAIN"
  for b in $BR; do
    git merge -q --no-ff --no-commit "$b" > /tmp/wave-merge.log 2>&1
    u=$(git diff --name-only --diff-filter=U)
    [ -n "$u" ] && { echo "CONFLICT in $b: $u"; git merge --abort; exit 1; }
    git diff --cached --quiet && { git merge --abort 2>/dev/null; echo "nothing from $b"; continue; }
    git commit -q -m "Merge $b ($TITLE)" ${TRAILER:+-m "$TRAILER"} > /tmp/wave-commit.log 2>&1 || { strip < /tmp/wave-commit.log | grep -a -iE "fail|protected|factory" | head -6; echo COMMIT-FAILED; exit 1; }
    echo "merged $b"
  done
fi
[ -n "${INSTALL_CMD:-}" ] && { bash -c "$INSTALL_CMD" > /tmp/wave-install.log 2>&1 || { echo INSTALL-FAILED; tail -3 /tmp/wave-install.log; exit 1; }; }
s=$(date +%s)
if "$GATE" bash -c "$VERIFY_CMD" > /tmp/wave-verify.log 2>&1; then echo "verify PASS $(( $(date +%s) - s ))s"; else echo "verify FAIL"; strip < /tmp/wave-verify.log | grep -a -E "^ *×| FAIL |Test Files|  Tests |Error" | head -8; exit 1; fi
if [ -n "${E2E_CMD:-}" ]; then
  s=$(date +%s)
  if "$GATE" bash -c "$E2E_CMD" > /tmp/wave-e2e.log 2>&1; then echo "e2e PASS $(( $(date +%s) - s ))s"; else echo "e2e FAIL"; strip < /tmp/wave-e2e.log | grep -a -E "failed|✘|Error" | head -6; exit 1; fi
fi
git log --oneline -3
git push origin "integration:$MAIN" 2>&1 | strip | tail -3
