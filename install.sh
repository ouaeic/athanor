#!/bin/sh
set -eu

athanor_root="${ATHANOR_ROOT:-/opt/athanor}"
repository="${ATHANOR_REPOSITORY:-https://github.com/ouaeic/athanor.git}"
revision="${ATHANOR_REF:-main}"
# The local branch the box lives on, and the upstream it follows for updates. A release is pinned by
# tag for reproducibility; updates arrive on the branch that tag was cut from.
athanor_branch="${ATHANOR_BRANCH:-athanor}"
athanor_track="${ATHANOR_TRACK:-main}"
expected_commit="${ATHANOR_EXPECTED_COMMIT:-}"

fail() {
  printf 'athanor bootstrap: %s\n' "$1" >&2
  exit 1
}

if [ -n "$expected_commit" ]; then
  case "$expected_commit" in
    *[!0-9a-fA-F]*) fail "ATHANOR_EXPECTED_COMMIT must be a Git commit hash" ;;
  esac
  case "${#expected_commit}" in
    40|64) ;;
    *) fail "ATHANOR_EXPECTED_COMMIT must be a full Git commit hash" ;;
  esac
fi

if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || fail "run this command as root"
  exec sudo -E /bin/sh "$0" "$@"
fi

if [ ! -f "$athanor_root/scripts/install-native.sh" ]; then
  # Only two packages are needed to reach the real installer, and the shape of that command is the
  # only thing this bootstrap has to know about the host. It used to test for apt-get and stop, so
  # an owner on Fedora, Rocky or Arch was refused before the repository was even cloned, by a
  # message naming two distributions and no reason.
  bootstrap_pm=""
  for candidate in apt-get dnf5 dnf zypper pacman; do
    if command -v "$candidate" >/dev/null 2>&1; then
      bootstrap_pm="$candidate"
      break
    fi
  done
  [ -n "$bootstrap_pm" ] ||
    fail "no supported package manager found: athanor installs with apt-get, dnf, zypper or pacman"
  case "$bootstrap_pm" in
  apt-get)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates git
    ;;
  dnf | dnf5)
    "$bootstrap_pm" install -y --setopt=install_weak_deps=False ca-certificates git
    ;;
  zypper)
    zypper --non-interactive install --no-recommends ca-certificates git
    ;;
  pacman)
    pacman -Sy --noconfirm --needed ca-certificates git
    ;;
  esac
  if [ -e "$athanor_root" ]; then
    [ -d "$athanor_root/.git" ] ||
      fail "$athanor_root already exists and is not an athanor Git checkout"
    git -C "$athanor_root" fetch --tags --prune origin
    git -C "$athanor_root" checkout "$revision"
  else
    # Not shallow. The update path rolls back by resetting to the revision it came from, and a
    # depth-1 clone has no revision to go back to.
    git clone --branch "$revision" "$repository" "$athanor_root"
  fi
  # Installed at a pinned revision, but on a branch that can move.
  #
  # Checking out a tag leaves a detached HEAD with no upstream, so `git pull --ff-only` answers
  # "Already up to date" for ever: the box never received another line of code while `doctor`
  # cheerfully reported that unattended updates were on. Since the documented install command pins a
  # tag, that was every installation. The tree still starts exactly at the pinned revision - that is
  # what the pin is for - and this only gives the update path somewhere to fast-forward to.
  git -C "$athanor_root" fetch --tags --prune origin
  git -C "$athanor_root" checkout -B "$athanor_branch" "$revision"
  git -C "$athanor_root" branch --set-upstream-to="origin/$athanor_track" "$athanor_branch" ||
    fail "could not follow origin/$athanor_track for updates"
  if [ -n "$expected_commit" ]; then
    installed_commit=$(git -C "$athanor_root" rev-parse --verify HEAD)
    [ "$installed_commit" = "$expected_commit" ] ||
      fail "the downloaded source does not match the client release commit"
  fi
fi

exec /bin/sh "$athanor_root/scripts/install-native.sh" "$@"
