#!/usr/bin/env bash
# Integration wave: merge the passed branches ONE BY ONE into the integration worktree, run the full gates once, push
# to main. No octopus merges: the push gate judges a merge by its own changes against its two parents, and an octopus
# of several reviewed tasks has no such pair, so it would be rejected. No Docker: that is the release gate.
# Fails fast: any setup, merge, gate or push failure ends with a non-zero exit and a line naming the step.
# Usage (inside the integration worktree, env from wave.mjs):
#   integ-wave.sh "<title>" "<summary>" <branch>...   branches as origin/<prefix>/<name>, each task with its review branch
# Env: WAVE_LOG_DIR (optional), MAIN, INSTALL_CMD, VERIFY_CMD (required, non-empty), E2E_CMD (optional), GATE (absolute path to this project's gate), WAVE_PROJECT (its name), TRAILER (optional)
# Docs-only path (docs/testing.md): with docsOnly.enabled in origin/MAIN's factory.config.json, a wave that changes
# documentation only runs commands.formatCheck and commands.markdownCheck from that config instead of verify and e2e.
# Every other wave runs commands.verify (and commands.e2e) through GATE on the merged candidate and pushes only on success:
# no earlier result (a Developer's or Tester's run, a cached one, an evidence file) and no option or variable replaces it.
set -uo pipefail
# Step logs stay inspectable after the wave; wave.mjs sets a directory per project, so waves of two projects on one host never mix.
LOGS="${WAVE_LOG_DIR:-${TMPDIR:-/tmp}/wave-$$}"; mkdir -p "$LOGS"
TITLE="$1"; SUMMARY="$2"; shift 2; BR="$*"
MAIN="${MAIN:-main}"; GATE="${GATE:-}"
# The gate is this project's own: <controller dir>/gate, in the directory the Controller's factory.config.json names
# (hosts.controller.controllerDir). wave.mjs exports GATE as an absolute path and WAVE_PROJECT as the project's name. Nothing is
# looked up (no PATH, no default); the value is refused unless it is an executable file called gate, outside the worktree being
# judged, in a directory whose factory.config.json names this very project.
gate_refuse() { echo "GATE ($GATE) is refused: $1. GATE is this project's gate, <controller dir>/gate, in the directory hosts.controller.controllerDir names: wave.mjs sets it (with WAVE_PROJECT), and agentic-factory start copies it to every worker host." >&2; exit 1; }
case "$GATE" in /*) ;; *) gate_refuse "not an absolute path (a gate found on the PATH could be another project's)" ;; esac
[ "$(basename "$GATE")" = gate ] || gate_refuse "its name is not gate"
{ [ -f "$GATE" ] && [ -x "$GATE" ]; } || gate_refuse "not an executable file on this host"
GATE_REAL="$(cd "$(dirname "$GATE")" && pwd -P)/gate"; WT_REAL="$(pwd -P)"
WT_TOP="$(git rev-parse --show-toplevel 2>/dev/null)"; [ -n "$WT_TOP" ] || WT_TOP="$WT_REAL"
case "$GATE_REAL" in "$WT_REAL"/*|"$WT_TOP"/*) gate_refuse "it lies inside the worktree being judged" ;; esac
[ -n "${WAVE_PROJECT:-}" ] || gate_refuse "WAVE_PROJECT (the project's name) is not set"
[ "$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1]+"/factory.config.json","utf8")).project?.name??""))}catch{}' "$(dirname "$GATE")")" = "$WAVE_PROJECT" ] || gate_refuse "$(dirname "$GATE")/factory.config.json is missing or does not name the project $WAVE_PROJECT"
# A command that is only whitespace is no command.
blank() { [ -z "$(printf %s "$1" | tr -d '[:space:]')" ]; }
if blank "${VERIFY_CMD:-}"; then echo "VERIFY-MISSING: commands.verify is empty or only whitespace; a wave without a verification command is not allowed"; exit 1; fi
if [ -n "${E2E_CMD:-}" ] && blank "$E2E_CMD"; then echo "E2E-INVALID: commands.e2e is only whitespace; leave it empty for no e2e run, or give a command"; exit 1; fi
[ -n "$BR" ] || { echo "NO-BRANCHES"; exit 1; }
# This script resets and cleans the directory it runs in (untracked files included). Only the integration worktree.
[ "$(basename "$PWD")" = "coordinator-integration" ] || [ "${WAVE_WORKTREE_OK:-}" = "1" ] || { echo "WRONG-DIRECTORY: $PWD is not the coordinator-integration worktree (set WAVE_WORKTREE_OK=1 to override)"; exit 1; }
strip() { sed "s/\x1b\[[0-9;]*m//g"; }
# With the untracked standard, a clean removes the links and an install script (husky's prepare) can reset the hooks path,
# which would switch the review gate off without a word. So: arm again after each of them.
# Fails closed: a project with the untracked standard never pushes from a clone without working hooks. arm.mjs ends by
# checking what git would really run, wherever a hooks path comes from.
STANDARD=0
arm() {
  [ "$STANDARD" = 1 ] || return 0
  a="$(git rev-parse --git-common-dir)/factory/arm.mjs"
  [ -f "$a" ] || { echo "NOT-ARMED: this clone has no factory standard; run agentic-factory start"; exit 1; }
  node "$a" || { echo "NOT-ARMED: see the line above"; exit 1; }
}
git merge --abort 2>/dev/null; git reset -q --hard 2>/dev/null
git fetch -q origin || { echo "FETCH-FAILED"; exit 1; }
# Decided here and once, from this clone and from main: a branch merged below cannot switch the check off.
if [ -f "$(git rev-parse --git-common-dir)/factory/standard.json" ] || git show "origin/$MAIN:factory.config.json" 2>/dev/null | grep -Eq '"footprint"[[:space:]]*:[[:space:]]*"minimal"'; then STANDARD=1; fi
# Also decided once, from main: whether the docs-only path is on, its checks, and the classifier itself (main's copy of
# the guardrails, or this clone's installed standard). A branch merged below cannot choose its own gate path.
cfgget() { git show "origin/$MAIN:factory.config.json" 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));process.stdout.write(typeof v==="boolean"||(typeof v==="string"&&process.argv[2]!=="bool")?String(v):"")}catch{}})' "$1" "${2:-}"; }
# docsOnly.enabled counts only as the JSON boolean true, as in docsonly.mjs and the push gate: the string "true" is not on.
DOCS_ENABLED=$(cfgget docsOnly.enabled bool); FORMAT_CHECK_CMD=$(cfgget commands.formatCheck); MARKDOWN_CHECK_CMD=$(cfgget commands.markdownCheck)
if blank "$FORMAT_CHECK_CMD"; then FORMAT_CHECK_CMD=""; fi; if blank "$MARKDOWN_CHECK_CMD"; then MARKDOWN_CHECK_CMD=""; fi
DOCS_CHECK=""
if [ "$DOCS_ENABLED" = true ]; then
  if [ "$STANDARD" = 1 ]; then DOCS_CHECK="$(git rev-parse --git-common-dir)/factory/hooks/factory-guardrails.mjs"
  elif git show "origin/$MAIN:tools/factory-guardrails.mjs" > "$LOGS/docs-only-check.mjs" 2>/dev/null; then DOCS_CHECK="$LOGS/docs-only-check.mjs"; fi
fi
git checkout -q -B integration "origin/$MAIN" || { echo "CHECKOUT-FAILED"; exit 1; }
# The integration worktree is disposable: drop untracked AND ignored leftovers (lockfiles or build output from an
# earlier install), otherwise a branch that adds such a file cannot be merged ("would be overwritten").
git clean -fdxq
arm
# A dry run still runs the pre-push hook, so a missing review fails in seconds instead of after the gates.
git push --dry-run origin "integration:$MAIN" > "$LOGS/wave-precheck.log" 2>&1 || { strip < "$LOGS/wave-precheck.log" | grep -a -E '^\[factory\]|^error:|^fatal:|rejected' | head -12; echo "PUSH-CHECK-FAILED"; exit 1; }
if [ -n "${INSTALL_CMD:-}" ]; then bash -c "$INSTALL_CMD" > "$LOGS/wave-install.log" 2>&1 || echo "install on $MAIN failed, retrying after merge"; fi
arm
merged=0
for b in $BR; do
  if ! git merge -q --no-ff --no-commit "$b" > "$LOGS/wave-merge.log" 2>&1; then
    u=$(git diff --name-only --diff-filter=U)
    echo "CONFLICT in $b: ${u:-$(tail -2 "$LOGS/wave-merge.log" | tr '\n' ' ')}"; git merge --abort 2>/dev/null; exit 1
  fi
  if git diff --cached --quiet; then git merge --abort 2>/dev/null; echo "nothing from $b"; continue; fi
  # The merged commits passed the commit hooks with their own ADR references; carry those references into the merge
  # message, so a task that touches a protected file (an ADR, AGENTS.md, a hook) merges without a second approval.
  refs=$(git log --format=%B "origin/$MAIN..$b" | grep -oE 'ADR-[0-9]{4}' | sort -u | tr '\n' ' ')
  git commit -q -m "Merge $b ($TITLE)" -m "$SUMMARY" ${refs:+-m "Refs: $refs"} ${TRAILER:+-m "$TRAILER"} > "$LOGS/wave-commit.log" 2>&1 \
    || { strip < "$LOGS/wave-commit.log" | grep -a -iE "fail|protected|factory" | head -6; echo "COMMIT-FAILED for $b"; exit 1; }
  echo "merged $b"; merged=$((merged + 1))
done
[ "$merged" -gt 0 ] || { echo "NOTHING-TO-MERGE"; exit 1; }
if [ -n "${INSTALL_CMD:-}" ]; then bash -c "$INSTALL_CMD" > "$LOGS/wave-install.log" 2>&1 || { echo INSTALL-FAILED; tail -3 "$LOGS/wave-install.log"; exit 1; }; fi
arm
# The docs-only path: main's check decides, on what the wave adds to main. Anything but its exit 0 (not docs-only,
# unclear, a missing or older check) runs the full gates, and so does a docs-only wave with no docs check configured.
docs=0
if [ "$DOCS_ENABLED" = true ]; then
  if [ -n "$DOCS_CHECK" ] && [ -f "$DOCS_CHECK" ] && node "$DOCS_CHECK" docs-only "origin/$MAIN..HEAD" > "$LOGS/wave-docs-only.log" 2>&1; then docs=1; fi
  [ -f "$LOGS/wave-docs-only.log" ] && cat "$LOGS/wave-docs-only.log"
  if [ "$docs" = 1 ] && [ -z "$FORMAT_CHECK_CMD$MARKDOWN_CHECK_CMD" ]; then docs=0; echo "GATE-PATH full: docs-only, but neither commands.formatCheck nor commands.markdownCheck is configured"
  elif [ "$docs" = 1 ]; then echo "GATE-PATH docs-only: format and Markdown checks instead of the full gates"
  else echo "GATE-PATH full: $([ -n "$DOCS_CHECK" ] && echo "not docs-only (see the verdict above)" || echo "no docs-only check on $MAIN")"; fi
fi
if [ "$docs" = 1 ]; then
  for c in "$FORMAT_CHECK_CMD" "$MARKDOWN_CHECK_CMD"; do
    [ -n "$c" ] || continue
    if bash -c "$c" > "$LOGS/wave-docs-check.log" 2>&1; then echo "docs check PASS: $c"; else echo "docs check FAIL: $c"; strip < "$LOGS/wave-docs-check.log" | tail -8; exit 1; fi
  done
else
# The verify and e2e commands come from the Controller's configuration, but the package.json scripts they run live in the
# merged tree. A candidate that changes one of those scripts (directly or through the scripts it calls) would choose what is
# checked, so the wave stops instead of gating it; a change to what verify runs is made outside the wave.
REDEF_JS='const fs=require("fs");let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const sc=(t)=>{try{return t.trim()?JSON.parse(t).scripts??{}:{}}catch{return null}};const a=sc(s),b=sc(fs.existsSync("package.json")?fs.readFileSync("package.json","utf8"):"{}");if(a===null||b===null){console.log("package.json is not valid JSON");process.exit(3)}const cut=(x)=>String(x).split(/[^A-Za-z0-9:_.-]+/),seen=new Set(),todo=cut(process.argv.slice(1).join(" ")),bad=[];while(todo.length){const w=todo.pop();for(const n of [w,"pre"+w,"post"+w]){if(seen.has(n)||!(n in a||n in b))continue;seen.add(n);if(a[n]!==b[n])bad.push(n);todo.push(...cut(b[n]??a[n]))}}if(bad.length){console.log(bad.join(", "));process.exit(3)}})'
if git cat-file -e "origin/$MAIN:package.json" 2>/dev/null || [ -f package.json ]; then
  if ! redef=$(git show "origin/$MAIN:package.json" 2>/dev/null | node -e "$REDEF_JS" "$VERIFY_CMD" "${E2E_CMD:-}"); then
    echo "VERIFY-REDEFINED: the candidate changes what the verify or e2e command runs (package.json scripts: $redef). The wave does not gate a candidate that chooses its own checks; change those scripts outside the wave."; exit 1
  fi
fi
s=$(date +%s)
if "$GATE" bash -c "$VERIFY_CMD" > "$LOGS/wave-verify.log" 2>&1; then echo "verify PASS $(( $(date +%s) - s ))s"; else echo "verify FAIL"; strip < "$LOGS/wave-verify.log" | grep -a -E "^ *×| FAIL |Test Files|  Tests |Error" | head -8; exit 1; fi
if [ -n "${E2E_CMD:-}" ]; then
  s=$(date +%s)
  if "$GATE" bash -c "$E2E_CMD" > "$LOGS/wave-e2e.log" 2>&1; then echo "e2e PASS $(( $(date +%s) - s ))s"; else echo "e2e FAIL"; strip < "$LOGS/wave-e2e.log" | grep -a -E "failed|✘|Error" | head -6; exit 1; fi
fi
fi
git log --oneline -3
arm
if git push origin "integration:$MAIN" > "$LOGS/wave-push.log" 2>&1; then strip < "$LOGS/wave-push.log" | tail -2; echo "PUSHED $MAIN"; else strip < "$LOGS/wave-push.log" | grep -a -E '^\[factory\]|^[0-9a-f]{10}|^remote:|^error:|^fatal:' | head -12; echo "PUSH-FAILED"; exit 1; fi
