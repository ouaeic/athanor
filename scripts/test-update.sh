#!/bin/sh
# The single-quoted blocks below are literal fixture script bodies.
# shellcheck disable=SC2016
set -eu

repository_root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT INT TERM

remote="$test_root/remote.git"
seed="$test_root/seed"
checkout="$test_root/checkout"
fake_bin="$test_root/bin"
runtime="$test_root/runtime"
config="$test_root/etc/athanor"
state="$test_root/state"
home="$test_root/home"
backups="$test_root/backups"
command_log="$test_root/commands.log"
worker_busy="$test_root/worker-busy"
mkdir -p "$seed/scripts" "$seed/infra/native" "$seed/packages/data/src" \
  "$fake_bin" "$config" "$state" "$home" "$backups"

real_git=$(command -v git)

make_fake() {
  name="$1"
  shift
  {
    printf '#!/bin/sh\n'
    printf '%s\n' "$@"
  } >"$fake_bin/$name"
  chmod 0755 "$fake_bin/$name"
}

make_fake id '
if [ "${1:-}" = "-u" ]; then printf "0\n"; else printf "root\n"; fi'
make_fake systemctl '
printf "systemctl %s\n" "$*" >>"$ATHANOR_TEST_COMMAND_LOG"'
# Stands in for the running server. The readiness gate asks four separate questions, so the
# fixtures make it answer them the way a broken release would: FAIL_HEALTH is a build that boots
# and cannot serve, FAIL_MIGRATION is one whose schema never reached the version it expects. Both
# markers live in the checkout, so a rollback to the previous revision clears them exactly as a
# real rollback would.
make_fake curl '
requested=""
for argument in "$@"; do
  case "$argument" in http*) requested="$argument" ;; esac
done
if [ -f "$ATHANOR_TEST_CHECKOUT/FAIL_HEALTH" ]; then exit 22; fi
case "$requested" in
  # The worker metrics the backup reads to decide whether anybody is using the computer. Silence
  # means idle, which is what an unattended box normally is.
  */metrics)
    if [ -f "$ATHANOR_TEST_WORKER_BUSY" ]; then printf "athanor_worker_active 1\n"; fi
    ;;
  */v1/legal) printf "{\"applicationLicense\":\"AGPL-3.0-only\",\"accepted\":false}\n" ;;
esac
exit 0'
make_fake nginx 'exit 0'
make_fake chown 'exit 0'
# Ownership is accepted and ignored: this drill runs as an ordinary user, and what it is checking
# is which files an update puts where, not who ends up owning them.
make_fake install '
mode=""
directory_only=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d) directory_only=yes; shift ;;
    -D) shift ;;
    -m) mode="$2"; shift 2 ;;
    -o|-g) shift 2 ;;
    *) break ;;
  esac
done
if [ -z "$mode" ]; then
  printf "unexpected synthetic install arguments: %s\n" "$*" >&2
  exit 64
fi
if [ -n "$directory_only" ]; then
  for target in "$@"; do
    mkdir -p "$target"
    chmod "$mode" "$target"
  done
  exit 0
fi
if [ "$#" -ne 2 ]; then
  printf "unexpected synthetic install arguments: %s\n" "$*" >&2
  exit 64
fi
mkdir -p "$(dirname "$2")"
cp "$1" "$2"
chmod "$mode" "$2"'
make_fake sha256sum '
exec /usr/bin/shasum -a 256 "$@"'
make_fake runuser '
case "$*" in
  *"pg_dump"*) printf "synthetic-database\n" ;;
  *"schema_migrations"*)
    if [ -f "$ATHANOR_TEST_CHECKOUT/FAIL_MIGRATION" ]; then printf "6\n"; else printf "7\n"; fi
    ;;
esac
exit 0'
make_fake pnpm '
printf "pnpm %s at %s\n" "$*" "$PWD" >>"$ATHANOR_TEST_COMMAND_LOG"
if [ "$1" = "-r" ] && [ "${2:-}" = "build" ] && [ -f "$PWD/FAIL_BUILD" ]; then
  printf "intentional synthetic build failure\n" >&2
  exit 42
fi'
make_fake git '
exec "$ATHANOR_TEST_REAL_GIT" "$@"'

# Everything install_runtime_files installs has to exist in the checkout, otherwise the update
# fails partway through for a reason that has nothing to do with what is being tested.
cp "$repository_root/scripts/athanor" \
  "$repository_root/scripts/athanor-package-helper" \
  "$repository_root/scripts/athanor-sandbox" \
  "$repository_root/scripts/athanor-system-packages" \
  "$repository_root/scripts/athanor-service" \
  "$repository_root/scripts/athanor-network-refresh" \
  "$repository_root/scripts/athanor-network-watch" \
  "$repository_root/scripts/athanor-ddns" \
  "$repository_root/scripts/athanor-certificate" \
  "$repository_root/scripts/athanor-document" \
  "$repository_root/scripts/athanor-snapshot" \
  "$seed/scripts/"
cp "$repository_root/infra/native/start-desktop-session.sh" \
  "$repository_root/infra/native/athanor-desktop-bridge.py" \
  "$repository_root/infra/native/athanor@.service" \
  "$repository_root/infra/native/athanor-runner.service" \
  "$repository_root/infra/native/athanor.target" \
  "$repository_root/infra/native/athanor-network-refresh.service" \
  "$repository_root/infra/native/athanor-network-refresh.timer" \
  "$repository_root/infra/native/athanor-network-refresh.path" \
  "$repository_root/infra/native/athanor-network-watch.service" \
  "$repository_root/infra/native/athanor-auto-update.service" \
  "$repository_root/infra/native/athanor-auto-update.timer" \
  "$repository_root/infra/native/athanor-certificate-renew.service" \
  "$repository_root/infra/native/athanor-certificate-renew.timer" \
  "$repository_root/infra/native/athanor-certificate-alert.service" \
  "$repository_root/infra/native/athanor-backup.service" \
  "$repository_root/infra/native/athanor-backup.timer" \
  "$repository_root/infra/native/athanor-backup-alert.service" \
  "$repository_root/infra/native/athanor-motd" \
  "$repository_root/infra/native/nginx.conf" \
  "$seed/infra/native/"
# The readiness gate compares the schema the database reports against the highest migration in
# the checkout, so the checkout needs one to read.
printf 'export const migrations = [\n  {\n    version: 7,\n    name: "fixture",\n    sql: ``\n  }\n];\n' \
  >"$seed/packages/data/src/migrations.ts"
printf '#!/bin/sh\nexit 0\n' >"$seed/scripts/athanor-network-refresh"
chmod 0755 "$seed/scripts/athanor-network-refresh"
printf '#!/bin/sh\nexit 0\n' >"$seed/scripts/athanor-network-watch"
chmod 0755 "$seed/scripts/athanor-network-watch"

"$real_git" init --bare "$remote" >/dev/null
"$real_git" -C "$seed" init -b main >/dev/null
"$real_git" -C "$seed" config user.name "Athanor update drill"
"$real_git" -C "$seed" config user.email "update-drill@localhost"
"$real_git" -C "$seed" add .
"$real_git" -C "$seed" commit -m v1 >/dev/null
"$real_git" -C "$seed" remote add origin "$remote"
"$real_git" -C "$seed" push -u origin main >/dev/null
"$real_git" --git-dir="$remote" symbolic-ref HEAD refs/heads/main
"$real_git" clone "$remote" "$checkout" >/dev/null

printf 'postgres://athanor:synthetic-password@127.0.0.1:5432/athanor\n' |
  sed 's|^|DATABASE_URL=|' >"$config/control.env"
printf 'runner=true\n' >"$config/runner.env"
printf 'data-before-update\n' >"$home/persistent.txt"

run_athanor() {
  PATH="$fake_bin:$PATH" \
    ATHANOR_TEST_COMMAND_LOG="$command_log" \
    ATHANOR_TEST_REAL_GIT="$real_git" \
    ATHANOR_TEST_CHECKOUT="$checkout" \
    ATHANOR_ROOT="$checkout" \
    ATHANOR_CONFIG="$config" \
    ATHANOR_STATE="$state" \
    ATHANOR_HOME="$home" \
    ATHANOR_BACKUP_ROOT="$backups" \
    ATHANOR_BACKUP_KEEP="${ATHANOR_TEST_BACKUP_KEEP:-5}" \
    ATHANOR_BACKUP_IDLE_WAIT_SECONDS="${ATHANOR_TEST_BACKUP_IDLE_WAIT:-0}" \
    ATHANOR_TEST_WORKER_BUSY="$worker_busy" \
    ATHANOR_READY_TIMEOUT_SECONDS=3 \
    ATHANOR_RUNTIME_PREFIX="$runtime" \
    "$checkout/scripts/athanor" "$@"
}

run_update() {
  run_athanor update
}

publish_fixture() {
  # Distinct seconds, because a backup directory is named for the second it was taken in.
  sleep 1
  "$real_git" -C "$seed" add -A
  "$real_git" -C "$seed" commit -m "$1" >/dev/null
  "$real_git" -C "$seed" push >/dev/null
}

backup_count() {
  find "$backups" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z' | wc -l | tr -d ' '
}

printf '\n# fixture-version=v2\n' >>"$seed/scripts/athanor-service"
# What an installation from before the helper was moved looks like, so the update is asked to
# remove it rather than merely to install the replacement somewhere else.
mkdir -p "$runtime/usr/local/bin"
printf '#!/bin/sh\nexit 0\n' >"$runtime/usr/local/bin/athanor-package-helper"
chmod 0755 "$runtime/usr/local/bin/athanor-package-helper"
# Stands in for the relay identity key an owner who turned the relay on already has.
mkdir -p "$runtime/etc/athanor/relay"
printf 'relay-identity\n' >"$runtime/etc/athanor/relay/identity-marker"
mkdir -p "$home/workspace/project/node_modules"
printf 'regenerable\n' >"$home/workspace/project/node_modules/dependency.js"
publish_fixture v2
expected_revision=$("$real_git" -C "$seed" rev-parse HEAD)

success_output=$(run_update 2>&1)
test "$("$real_git" -C "$checkout" rev-parse HEAD)" = "$expected_revision"
grep -q 'fixture-version=v2' "$runtime/usr/local/lib/athanor/athanor-service"
grep -q 'Update complete' <<EOF
$success_output
EOF
test "$(cat "$home/persistent.txt")" = "data-before-update"
printf 'ok  transactional update success path\n'

# The package helper reaches root with no capability scope and no approval card of its own. On
# the agent's PATH it was one command name away from a silent root package install, so an update
# has to both put it out of reach and take away the copy earlier releases left behind.
test -x "$runtime/usr/local/lib/athanor/athanor-package-helper"
test ! -e "$runtime/usr/local/bin/athanor-package-helper"
test -x "$runtime/usr/local/lib/athanor/athanor-sandbox"
printf 'ok  root helpers are installed off the agent PATH\n'

# The relay identity key is this server's address on every relay it has enrolled with: replacing it
# would silently change the hostname every paired client holds. An update has to leave what is in
# that directory alone, and to provision it on a server installed before the relay existed.
test "$(cat "$runtime/etc/athanor/relay/identity-marker")" = "relay-identity"
test -f "$runtime/etc/systemd/system/athanor-network-refresh.path"
printf 'ok  the relay identity survives an update\n'

# The backup runs with the server stopped, so its contents are outage time. Dependency trees are
# the bulk of a working agent computer and every one of them can be fetched again.
newest_backup=$(
  find "$backups" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z' | sort -r | sed -n '1p'
)
tar -tzf "$newest_backup/workspaces.tar.gz" >"$test_root/backup-listing"
grep -q 'persistent.txt' "$test_root/backup-listing"
if grep -q 'node_modules' "$test_root/backup-listing"; then
  printf 'the backup still archives regenerable dependency trees\n' >&2
  exit 1
fi
grep -q 'Dependency trees and package caches were skipped' <<EOF
$success_output
EOF
printf 'ok  backup excludes regenerable trees and says so\n'

printf '\n# fixture-version=v3\n' >>"$seed/scripts/athanor-service"
: >"$seed/FAIL_BUILD"
publish_fixture v3-fails

printf 'data-before-rollback\n' >"$home/persistent.txt"
if failure_output=$(run_update 2>&1); then
  printf 'synthetic failed update unexpectedly succeeded\n' >&2
  exit 1
fi
test "$("$real_git" -C "$checkout" rev-parse HEAD)" = "$expected_revision"
test ! -e "$checkout/FAIL_BUILD"
grep -q 'fixture-version=v2' "$runtime/usr/local/lib/athanor/athanor-service"
test "$(cat "$home/persistent.txt")" = "data-before-rollback"
grep -q 'Rollback completed; the failed update was not activated' <<EOF
$failure_output
EOF
printf 'ok  failed update restored source, runtime, and user data\n'

# A release that builds and boots but cannot serve. The old gate polled /healthz, a route that
# answers from a static literal, so this case reported "Update complete" over a dead product.
rm -f "$seed/FAIL_BUILD"
printf '\n# fixture-version=v4\n' >>"$seed/scripts/athanor-service"
: >"$seed/FAIL_HEALTH"
publish_fixture v4-does-not-serve

if unserving_output=$(run_update 2>&1); then
  printf 'a release that never served was accepted as a completed update\n' >&2
  exit 1
fi
test "$("$real_git" -C "$checkout" rev-parse HEAD)" = "$expected_revision"
grep -q 'fixture-version=v2' "$runtime/usr/local/lib/athanor/athanor-service"
grep -q 'this release is not serving' <<EOF
$unserving_output
EOF
grep -q 'Rollback completed; the failed update was not activated' <<EOF
$unserving_output
EOF
printf 'ok  a release that boots but cannot serve is rolled back\n'

# And one whose migrations never reached the version the new code expects.
rm -f "$seed/FAIL_HEALTH"
printf '\n# fixture-version=v5\n' >>"$seed/scripts/athanor-service"
: >"$seed/FAIL_MIGRATION"
publish_fixture v5-schema-behind

if stale_schema_output=$(run_update 2>&1); then
  printf 'a release running against an unmigrated database was accepted\n' >&2
  exit 1
fi
test "$("$real_git" -C "$checkout" rev-parse HEAD)" = "$expected_revision"
grep -q 'schema version 6 but this release expects 7' <<EOF
$stale_schema_output
EOF
printf 'ok  a release whose migrations did not apply is rolled back\n'

# Four updates have now been taken, each leaving a full copy of the database and every workspace.
rm -f "$seed/FAIL_MIGRATION"
printf '\n# fixture-version=v6\n' >>"$seed/scripts/athanor-service"
publish_fixture v6
before_prune=$(backup_count)
test "$before_prune" -ge 2
ATHANOR_TEST_BACKUP_KEEP=2 run_update >/dev/null 2>&1
test "$(backup_count)" -eq 2
printf 'ok  superseded backups are pruned to the retention limit\n'

# The operator is told what the outage will cost before the server is taken away, and what it
# actually cost afterwards.
printf '\n# fixture-version=v7\n' >>"$seed/scripts/athanor-service"
publish_fixture v7
outage_output=$(run_update 2>&1)
grep -q 'stopping the server now' <<EOF
$outage_output
EOF
grep -q 'The previous update was offline for about' <<EOF
$outage_output
EOF
grep -q 'Update complete after' <<EOF
$outage_output
EOF
printf 'ok  the outage is announced beforehand and measured afterwards\n'

# The daily backup, and whether the box can say anything true about it.
#
# Settings asserted "A backup is taken daily, at a randomised hour, when nothing is running". Two
# ordinary paths made that false without leaving a mark anywhere: a run that stands down because
# the worker is busy exits zero and speaks only to the journal, and a run that fails leaves no
# directory at all, because a copy with no checksum manifest cannot restore anything and is pruned
# as wreckage. Both of them ended with the sentence still on the screen.
backup_status_file="$state/backup.status"
status_field() {
  sed -n "s/^$1=//p" "$backup_status_file" | sed -n '1p'
}

# Every route to a verified copy records itself, so the update just above already left one.
test "$(status_field outcome)" = ok
test -n "$(status_field copy_at)"
test "$(status_field copy_bytes)" -gt 0
test -d "$backups/$(status_field copy_at | tr -d ':-')"
printf 'ok  a completed backup records when it happened and how big it is\n'

# The first silent path. The run stands down for a task that is still going, which is the design,
# and the exit status says nothing happened wrong - so a box that is busy every time the window
# comes round stands down every night behind an unchanged promise.
: >"$worker_busy"
skipped_output=$(run_athanor backup auto run 2>&1)
grep -q 'the next window will take the backup' <<EOF
$skipped_output
EOF
test "$(status_field outcome)" = skipped
test "$(status_field reason)" = "a task was still running when the window came round"
# And the copy it did not take is still described, because how far back the owner can restore to is
# a different question from what last night's run did.
test -n "$(status_field copy_at)"
printf 'ok  a run that stands down for a busy worker says so and says why\n'
rm -f "$worker_busy"

# The second. A full disk is the ordinary way a backup fails, and it is exactly when every retained
# copy is already there - so nothing new is written, nothing is left behind, and the box carries on
# serving perfectly.
make_fake df '
printf "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
printf "/dev/synthetic 1024 1000 24 98%% /\n"'
if failed_backup_output=$(run_athanor backup auto run 2>&1); then
  printf 'a backup that could not fit reported success\n' >&2
  exit 1
fi
rm -f "$fake_bin/df"
grep -q 'not enough room for a backup' <<EOF
$failed_backup_output
EOF
test "$(status_field outcome)" = failed
case "$(status_field reason)" in
  'not enough room for a backup'*) ;;
  *)
    printf 'the failure was not written down in words the owner can read: %s\n' \
      "$(status_field reason)" >&2
    exit 1
    ;;
esac
printf 'ok  a backup that could not be taken is written down with its reason\n'

# What OnFailure= is for: a run stopped by its own ninety-minute limit never reaches a line that
# could write anything, so the pessimistic record it left on the way in is the one that stands.
printf 'at=2026-08-10T03:00:00Z\noutcome=running\nreason=\n' >"$backup_status_file"
run_athanor backup auto alert >/dev/null 2>&1
test "$(status_field outcome)" = failed
test "$(status_field reason)" = "the run was stopped before it finished"
# And it leaves a finished run alone, because it fires after those too.
printf 'at=2026-08-10T03:00:00Z\noutcome=ok\nreason=\n' >"$backup_status_file"
run_athanor backup auto alert >/dev/null 2>&1
test "$(status_field outcome)" = ok
printf 'ok  a run killed before it finished is recorded, and a finished one is left alone\n'

# Restore is the command the owner reaches for on their worst day, and it empties the workspace
# tree before it extracts into it. The backup path has refused before stopping anything since the
# day a full disk cost somebody an outage; restore checked nothing at all, so a destination too
# small to hold the archive was discovered with the data already deleted and the copy half unpacked
# - the exact loss this command exists to undo, caused by the command itself.
printf 'data-worth-recovering\n' >"$home/persistent.txt"
run_athanor backup >/dev/null 2>&1
recovery_backup=$(
  find "$backups" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z' | sort -r | sed -n '1p'
)
sleep 1
printf 'data-written-since\n' >"$home/persistent.txt"
run_athanor backup >/dev/null 2>&1
: >"$command_log"
make_fake df '
printf "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
printf "/dev/synthetic 1024 1000 24 98%% /\n"'
# Retaining one copy while restoring from the older of two: the prune that makes room would
# otherwise take the very directory being read from, which is how a recovery becomes a loss.
if refused_restore=$(
  ATHANOR_TEST_BACKUP_KEEP=1 run_athanor restore "$recovery_backup" --yes 2>&1
); then
  printf 'a restore that could not fit reported success\n' >&2
  exit 1
fi
rm -f "$fake_bin/df"
grep -q 'not enough room to restore' <<REFUSAL
$refused_restore
REFUSAL
# The three things that make the refusal worth having: nothing was stopped, the data that was about
# to be deleted is still there, and the copy being restored from survived the prune.
if grep -q 'systemctl stop' "$command_log"; then
  printf 'the restore stopped the server before finding out it could not fit\n' >&2
  exit 1
fi
test "$(cat "$home/persistent.txt")" = "data-written-since"
test -f "$recovery_backup/SHA256SUMS"
printf 'ok  a restore that would not fit refuses before it stops or wipes anything\n'

# And it is a check rather than a wall: with room on the disk the same restore puts the data back.
run_athanor restore "$recovery_backup" --yes >/dev/null 2>&1
test "$(cat "$home/persistent.txt")" = "data-worth-recovering"
printf 'ok  a restore that fits still restores\n'
