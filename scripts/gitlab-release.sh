#!/bin/sh
# Creates the GitLab release page for a tag from releases/<tag>.md. Run by .gitlab-ci.yml, from the project directory, with the
# `glab` CLI in the job's image. Plain POSIX sh: the CLI image is Alpine (busybox).
#
#   gitlab-release.sh <tag>      one tag (the tag pipeline)
#   gitlab-release.sh --backfill every releases/<tag>.md whose tag is on the remote and has no release yet (the manual job)
#
# Authentication is the job's own CI_JOB_TOKEN (GLAB_ENABLE_CI_AUTOLOGIN). glab prefers GITLAB_TOKEN, GITLAB_ACCESS_TOKEN and
# OAUTH_TOKEN over the job token, so a project or group variable of that name would break this job: they are removed here.
# A release that exists is never touched: not updated, not replaced.
#
# "Does the release exist?" is not decided from a message of glab (glab prints no stable text for a missing release: its error
# says only "404 Not Found."). `glab release create --no-update` never overwrites; it fails when the release exists, and that
# failure ("... already exists and --no-update flag was specified.") is the only text matched. Anything else is an error.
set -u
unset GITLAB_TOKEN GITLAB_ACCESS_TOKEN OAUTH_TOKEN
GLAB_ENABLE_CI_AUTOLOGIN=true
GLAB_SEND_TELEMETRY=false   # glab would send usage events to the instance after every command
GLAB_CHECK_UPDATE=false
export GLAB_ENABLE_CI_AUTOLOGIN GLAB_SEND_TELEMETRY GLAB_CHECK_UPDATE

usage() { echo "usage: gitlab-release.sh <tag> | --backfill" >&2; exit 2; }

# glab for this project, whatever the clone's remote URL looks like. It reads no stdin (the backfill loop reads its list from there).
gl() {
  if [ -n "${CI_PROJECT_PATH:-}" ]; then glab "$@" -R "$CI_PROJECT_PATH" </dev/null; else glab "$@" </dev/null; fi
}

# The date of a tag (annotated: the tagger's, else the commit's), ISO 8601. Fetches the tag when the clone lacks it.
tag_date() {
  d=$(git for-each-ref --format='%(creatordate:iso-strict)' "refs/tags/$1" 2>/dev/null)
  if [ -z "$d" ]; then
    if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = true ]; then depth=--depth=1; else depth=; fi
    # shellcheck disable=SC2086
    git fetch -q --no-tags $depth origin "refs/tags/$1:refs/tags/$1" </dev/null >&2 || return 1
    d=$(git for-each-ref --format='%(creatordate:iso-strict)' "refs/tags/$1" 2>/dev/null)
  fi
  [ -n "$d" ] || return 1
  echo "$d"
}

# release_one <tag> [dated]: 0 created or already there, 1 failed (the reason is on stderr).
# With "dated" the release gets the date of the tag as its release date, not the day it is created.
release_one() {
  tag=$1
  notes="releases/$tag.md"
  if [ ! -s "$notes" ]; then
    echo "ERROR: no release notes for $tag: $notes is missing or empty. Add the file to the release commit; no release is created without it." >&2
    return 1
  fi
  # A saving, not the decision: if this succeeds the release is there. If it fails for any reason, create decides.
  if gl release view "$tag" >/dev/null 2>&1; then
    echo "Release $tag already exists, left as it is."
    return 0
  fi
  date_args=
  if [ "${2:-}" = dated ]; then
    if ! released=$(tag_date "$tag"); then
      echo "ERROR: could not read the date of the tag $tag (fetching it from the remote failed)." >&2
      return 1
    fi
    date_args=$released
  fi
  # --ref "$tag": glab looks up no tag first (that lookup needs GitLab 18.8 for a job token), and a tag that is missing makes the
  # call fail instead of creating the tag at the head of the default branch.
  if [ -n "$date_args" ]; then
    out=$(gl release create "$tag" --ref "$tag" --name "$tag" --notes-file "$notes" --no-update --released-at "$date_args" 2>&1)
  else
    out=$(gl release create "$tag" --ref "$tag" --name "$tag" --notes-file "$notes" --no-update 2>&1)
  fi
  status=$?
  if [ $status -eq 0 ]; then
    echo "$out"
    echo "Created the release $tag from $notes."
    return 0
  fi
  case $out in
    *"already exists and --no-update"*|*"Release already exists"*) echo "Release $tag already exists, left as it is."; return 0 ;;
  esac
  echo "ERROR: could not create the release for $tag: $out" >&2
  return 1
}

# 0: the tag is on the remote, 1: it is not, 2: the remote could not be asked
tag_on_remote() {
  refs=$(git ls-remote --tags origin "refs/tags/$1" </dev/null) || return 2
  [ -n "$refs" ]
}

backfill() {
  failed=
  found=0
  # Oldest version first, so the newest release is created last (sort splits vX.Y.Z on the dots and skips the "v").
  # Only names of the form vX.Y.Z count: the notes test enforces it, and the loop does not trust anything else.
  list=$(for f in releases/*.md; do [ -e "$f" ] && basename "$f" .md; done | sort -t. -k1.2,1n -k2,2n -k3,3n)
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    if ! printf '%s\n' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
      echo "Skipping releases/$tag.md: not named like a version tag."
      continue
    fi
    found=1
    tag_on_remote "$tag"
    case $? in
      0) ;;
      1) echo "Skipping $tag: the tag is not on the remote yet (a release would create it at the head of the default branch)."; continue ;;
      *) echo "ERROR: could not list the tags of the remote." >&2; echo "BACKFILL FAILED: could not list the tags of the remote." >&2; return 1 ;;
    esac
    release_one "$tag" dated || failed="$failed $tag"
  done <<EOF
$list
EOF
  [ "$found" = 1 ] || echo "No release notes files in releases/."
  if [ -n "$failed" ]; then
    echo "BACKFILL FAILED for:$failed. See the ERROR lines above. Nothing was changed for them; fix the cause and run the job again." >&2
    return 1
  fi
  return 0
}

case ${1:-} in
  --backfill) [ $# = 1 ] || usage; backfill ;;
  -*|"") usage ;;
  *) [ $# = 1 ] || usage; release_one "$1" ;;
esac
