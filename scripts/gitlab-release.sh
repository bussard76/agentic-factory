#!/bin/sh
# Creates the GitLab release page for a tag from releases/<tag>.md. Run by .gitlab-ci.yml, from the project directory, with the
# `glab` CLI in the job's image. Plain POSIX sh: the CLI image is Alpine (busybox).
#
#   gitlab-release.sh <tag>      one tag (the tag pipeline)
#   gitlab-release.sh --backfill every releases/<tag>.md whose tag is on the remote and has no release yet (the manual job)
#
# Authentication is the job's own CI_JOB_TOKEN (GLAB_ENABLE_CI_AUTOLOGIN); no token variable is read or needed.
# A release that exists is never touched: not updated, not replaced.
set -u
GLAB_ENABLE_CI_AUTOLOGIN=true
export GLAB_ENABLE_CI_AUTOLOGIN

# 0: created or already there, 1: failed (the reason is on stderr)
release_one() {
  tag=$1
  notes="releases/$tag.md"
  if [ ! -s "$notes" ]; then
    echo "ERROR: no release notes for $tag: $notes is missing or empty. Add the file to the release commit; no release is created without it." >&2
    return 1
  fi
  if out=$(glab release view "$tag" 2>&1); then
    echo "Release $tag already exists, left as it is."
    return 0
  fi
  # glab says "release does not exist." for a missing release (HTTP 404, and also 403). Any other failure is not "missing".
  case $out in
    *"release does not exist"*) ;;
    *) echo "ERROR: could not look up the release for $tag: $out" >&2; return 1 ;;
  esac
  # --no-update: if a release appeared meanwhile, create fails instead of overwriting it.
  if out=$(glab release create "$tag" --name "$tag" --notes-file "$notes" --no-update 2>&1); then
    echo "$out"
    echo "Created the release $tag from $notes."
    return 0
  fi
  case $out in
    *"already exists"*) echo "Release $tag already exists, left as it is."; return 0 ;;
  esac
  echo "ERROR: could not create the release for $tag: $out" >&2
  return 1
}

# 0: the tag is on the remote, 1: it is not, 2: the remote could not be asked
tag_on_remote() {
  refs=$(git ls-remote --tags origin "refs/tags/$1") || return 2
  [ -n "$refs" ]
}

backfill() {
  failed=0
  found=0
  # Oldest version first, so the newest release is created last (sort splits vX.Y.Z on the dots and skips the "v").
  for tag in $(for f in releases/*.md; do [ -e "$f" ] && basename "$f" .md; done | sort -t. -k1.2n -k2n -k3n); do
    case $tag in
      v[0-9]*.[0-9]*.[0-9]*) ;;
      *) echo "Skipping releases/$tag.md: not named like a version tag."; continue ;;
    esac
    found=1
    tag_on_remote "$tag"
    case $? in
      0) ;;
      1) echo "Skipping $tag: the tag is not on the remote yet (a release would create it at the head of the default branch)."; continue ;;
      *) echo "ERROR: could not list the tags of the remote." >&2; return 1 ;;
    esac
    release_one "$tag" || failed=1
  done
  [ "$found" = 1 ] || echo "No release notes files in releases/."
  return $failed
}

case ${1:-} in
  --backfill) [ $# = 1 ] || { echo "usage: gitlab-release.sh <tag> | --backfill" >&2; exit 2; }; backfill ;;
  -*|"") echo "usage: gitlab-release.sh <tag> | --backfill" >&2; exit 2 ;;
  *) [ $# = 1 ] || { echo "usage: gitlab-release.sh <tag> | --backfill" >&2; exit 2; }; release_one "$1" ;;
esac
