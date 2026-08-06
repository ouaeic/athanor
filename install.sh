#!/bin/sh
set -eu

athanor_root="${ATHANOR_ROOT:-/opt/athanor}"
repository="${ATHANOR_REPOSITORY:-https://github.com/ouaeic/athanor.git}"
revision="${ATHANOR_REF:-main}"
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
    git -C "$athanor_root" pull --ff-only origin "$revision"
  else
    git clone --depth 1 --branch "$revision" "$repository" "$athanor_root"
  fi
  if [ -n "$expected_commit" ]; then
    installed_commit=$(git -C "$athanor_root" rev-parse --verify HEAD)
    [ "$installed_commit" = "$expected_commit" ] ||
      fail "the downloaded source does not match the client release commit"
  fi
fi

exec /bin/sh "$athanor_root/scripts/install-native.sh" "$@"
