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
# Stands in for the PostgreSQL cluster; see the `runuser` fixture below for what that does and
# does not prove.
database_file="$test_root/database"
off_host="$test_root/off-host"
recipient_key="$test_root/backup-recipient.pub"
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
# The database, as one file this drill can read and write, so that a restore proves something.
#
# `pg_dump` used to print a literal string and `pg_restore` was silence, so the whole database half
# of a backup was unpinned: a dump written to the wrong path, read before the drop instead of after
# it, or never read at all would have passed every case below with the same "ok". A backup nobody
# has restored is a hope, and this tree's own doctrine is that a check nobody watched fire is not a
# check. The stand-in is a single file: the dump is a copy of it, dropdb and createdb empty it, and
# pg_restore fills it from whatever it is fed on standard input.
#
# What that pins is the WIRING of the round trip - which file is written, which is read, and that
# the drop happens before the read. It pins nothing whatever about PostgreSQL: custom-format dumps,
# large objects, extensions and role grants are not in it and are not claimed. Proving those needs
# a real cluster, which is a separate rig and not this one.
make_fake runuser '
case "$*" in
  *"pg_dump"*) cat "$ATHANOR_TEST_DATABASE" ;;
  *"pg_restore"*) cat >"$ATHANOR_TEST_DATABASE" ;;
  *"dropdb"*|*"createdb"*) : >"$ATHANOR_TEST_DATABASE" ;;
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
  "$repository_root/scripts/athanor-office-convert" \
  "$repository_root/scripts/athanor-pdf-tables" \
  "$repository_root/scripts/athanor-document-proof" \
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
  "$repository_root/infra/native/athanor-auto-update-alert.service" \
  "$repository_root/infra/native/athanor-certificate-renew.service" \
  "$repository_root/infra/native/athanor-certificate-renew.timer" \
  "$repository_root/infra/native/athanor-certificate-alert.service" \
  "$repository_root/infra/native/athanor-backup.service" \
  "$repository_root/infra/native/athanor-backup.timer" \
  "$repository_root/infra/native/athanor-backup-alert.service" \
  "$repository_root/infra/native/athanor-motd" \
  "$repository_root/infra/native/nginx.conf" \
  "$repository_root/infra/native/nginx-security-headers.conf" \
  "$repository_root/infra/native/nginx-app-csp.conf" \
  "$seed/infra/native/"
# The readiness gate compares the schema the database reports against the highest migration in
# the checkout, so the checkout needs one to read.
printf 'export const migrations = [\n  {\n    version: 7,\n    name: "fixture",\n    sql: ``\n  }\n];\n' \
  >"$seed/packages/data/src/migrations.ts"
printf '#!/bin/sh\nexit 0\n' >"$seed/scripts/athanor-network-refresh"
chmod 0755 "$seed/scripts/athanor-network-refresh"
printf '#!/bin/sh\nexit 0\n' >"$seed/scripts/athanor-network-watch"
chmod 0755 "$seed/scripts/athanor-network-watch"
# The last act of install.sh is to exec this. The bootstrap cases below only need to know whether it
# was reached, and reaching it with an unverified source is the defect they are here for.
printf '#!/bin/sh\nprintf "the installer ran\\n" >>"$ATHANOR_TEST_COMMAND_LOG"\n' \
  >"$seed/scripts/install-native.sh"
chmod 0755 "$seed/scripts/install-native.sh"

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
printf 'database-before-update\n' >"$database_file"

# The installer's database-password reuse, read out of the installer itself.
#
# One line decides whether re-running the installer on a working box keeps the PostgreSQL password
# that box already has or invents a new one, and it was written with doubled backslashes inside
# single quotes, so the capture group never matched and every re-install rotated the password.
# `doctor` tells the owner to re-run the installer for two ordinary conditions; `ALTER ROLE` runs
# hundreds of lines before `DATABASE_URL` is written back, with a dozen `fail` points in between,
# and any of them left the role holding a password nothing on the box knew. The two pieces are
# lifted out of the installer and run rather than restated here, because a second copy of the
# expression is a second thing free to drift away from the one that actually executes.
installer_source="$repository_root/scripts/install-native.sh"
{
  awk '
    /^existing_control_value\(\) \{$/ { emitting = 1 }
    emitting { print }
    emitting && /^\}$/ { exit }
  ' "$installer_source"
  awk '
    /^database_password=/ { emitting = 1 }
    emitting { print }
    emitting && /database_password=\$\(openssl/ { exit }
  ' "$installer_source"
  printf 'printf "%%s\\n" "$database_password"\n'
} >"$test_root/installer-password-reuse.sh"
reused_password=$(athanor_config="$config" sh "$test_root/installer-password-reuse.sh")
if [ "$reused_password" != synthetic-password ]; then
  printf 'the installer did not reuse the password in an existing control.env: %s\n' \
    "$reused_password" >&2
  exit 1
fi
# And the window between setting the role's password and writing it down is closed rather than
# merely narrowed: the write happens before the next step that can fail.
alter_role_line=$(grep -n 'ALTER ROLE athanor WITH LOGIN PASSWORD' "$installer_source" |
  sed -n '1s/:.*//p')
url_write_line=$(grep -n 'set_env_value "\$control_env" DATABASE_URL' "$installer_source" |
  sed -n '1s/:.*//p')
next_failure_line=$(grep -n 'the PostgreSQL client authentication file could not be located' \
  "$installer_source" | sed -n '1s/:.*//p')
if [ -z "$alter_role_line" ] || [ -z "$url_write_line" ] || [ -z "$next_failure_line" ] ||
  [ "$url_write_line" -lt "$alter_role_line" ] || [ "$url_write_line" -gt "$next_failure_line" ]; then
  printf 'the installer can abort between rotating the database password and writing it down\n' >&2
  exit 1
fi
printf 'ok  the installer reuses an existing database password and writes it back at once\n'

# The commit pin, on the box whose state is already unknown.
#
# `ATHANOR_EXPECTED_COMMIT` is how the packaged client pins the source it installs, and the fetch,
# the checkout and the whole verification block sat inside `if [ ! -f scripts/install-native.sh ]`.
# The arrangement that reaches the bootstrap a second time is not "the owner ran it twice" - the
# client asks a working box for a pairing code instead - it is a partial install, where the source
# is on disk and the `athanor` CLI never reached PATH. There the pin went unchecked and the
# installer ran against whatever revision happened to be lying in /opt/athanor.
bootstrap_root="$test_root/bootstrap-root"
"$real_git" clone "$remote" "$bootstrap_root" >/dev/null 2>&1
run_bootstrap() {
  PATH="$fake_bin:$PATH" \
    ATHANOR_TEST_COMMAND_LOG="$command_log" \
    ATHANOR_TEST_REAL_GIT="$real_git" \
    ATHANOR_ROOT="${2:-$bootstrap_root}" \
    ATHANOR_REPOSITORY="$remote" \
    ATHANOR_EXPECTED_COMMIT="$1" \
    /bin/sh "$repository_root/install.sh"
}
: >"$command_log"
if wrong_pin_output=$(run_bootstrap 0000000000000000000000000000000000000000 2>&1); then
  printf 'a partial install accepted a source that does not match the pinned commit\n' >&2
  exit 1
fi
grep -q 'does not match the client release commit' <<EOF
$wrong_pin_output
EOF
if grep -q 'the installer ran' "$command_log"; then
  printf 'the installer was handed an unverified source on a partial install\n' >&2
  exit 1
fi
# And the same arrangement with the right pin reaches the installer, at the revision it names.
: >"$command_log"
published_head=$("$real_git" --git-dir="$remote" rev-parse HEAD)
run_bootstrap "$published_head" >/dev/null 2>&1
grep -q 'the installer ran' "$command_log"
test "$("$real_git" -C "$bootstrap_root" rev-parse HEAD)" = "$published_head"
# The path that was already covered by the verification, kept covered: a box with nothing on it at
# all still clones, still lands on the update branch, and still checks the pin.
make_fake apt-get '
printf "apt-get %s\n" "$*" >>"$ATHANOR_TEST_COMMAND_LOG"'
: >"$command_log"
first_install_root="$test_root/first-install-root"
run_bootstrap "$published_head" "$first_install_root" >/dev/null 2>&1
rm -f "$fake_bin/apt-get"
grep -q 'apt-get install' "$command_log"
grep -q 'the installer ran' "$command_log"
test "$("$real_git" -C "$first_install_root" rev-parse HEAD)" = "$published_head"
test "$("$real_git" -C "$first_install_root" rev-parse --abbrev-ref HEAD)" = athanor
printf 'ok  the bootstrap checks the commit pin on a partial install and on a fresh one\n'

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
    ATHANOR_TEST_DATABASE="$database_file" \
    ATHANOR_TEST_OFF_HOST="$off_host" \
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
# The managed browser. Roughly 400 MB of already-compressed binaries that gzip cannot help, in a
# tree the runner knows how to fetch again, copied into every daily backup and every pre-update
# rollback copy while the printed line said package caches were skipped.
mkdir -p "$home/.cache/ms-playwright/chromium-1228/chrome-linux"
printf 'binary\n' >"$home/.cache/ms-playwright/chromium-1228/chrome-linux/chrome"
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

# What the installer places and the update did not. The backup units were one instance of it; these
# were the rest, and both were found by comparing the two lists rather than by anything failing. The
# document commands are named by absolute path in the shipped skills, so on a box that has only ever
# been updated the agent was reading this release's instructions and running install day's binary,
# or on a box older than they are, running nothing. The nginx snippets are included by the site file
# the update replaces, so the policy and the site that expects it moved apart at every release.
test -x "$runtime/usr/local/bin/athanor-office-convert"
test -x "$runtime/usr/local/bin/athanor-pdf-tables"
test -x "$runtime/usr/local/lib/athanor/athanor-document-proof"
test -f "$runtime/etc/nginx/snippets/athanor-security-headers.conf"
test -f "$runtime/etc/nginx/snippets/athanor-app-csp.conf"
printf 'ok  the update places every runtime file the installer does\n'

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
if grep -q 'ms-playwright' "$test_root/backup-listing"; then
  printf 'the backup still archives the managed browser\n' >&2
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

# A file added in a release has to land in that release.
#
# `athanor update` is /usr/local/bin/athanor, the previous release's copy of the script, and the
# running shell goes on executing it after the pull: the tree being installed from was the new one
# and the list of what to install from it was the old one. So anything a release added reached an
# existing box a release late, and nothing reported an error, because nothing had gone wrong. The
# server that showed this had the backup units in its checkout, no timer anywhere on disk, and an
# interface still describing a daily copy. The fixture is a unit the published revision installs and
# the revision performing the update has never heard of.
printf '[Unit]\nDescription=A unit the published release adds\n' \
  >"$seed/infra/native/athanor-late-addition.service"
awk '
  { print }
  /^install_runtime_files\(\) \{$/ {
    print "  install -D -m 0644 infra/native/athanor-late-addition.service \\"
    print "    \"$(runtime_path /etc/systemd/system/athanor-late-addition.service)\""
  }
' "$seed/scripts/athanor" >"$test_root/seed-athanor"
mv "$test_root/seed-athanor" "$seed/scripts/athanor"
chmod 0755 "$seed/scripts/athanor"
printf '\n# fixture-version=v8\n' >>"$seed/scripts/athanor-service"
publish_fixture v8-adds-a-unit
run_update >/dev/null 2>&1
test -f "$runtime/etc/systemd/system/athanor-late-addition.service"
grep -q 'fixture-version=v8' "$runtime/usr/local/lib/athanor/athanor-service"
printf 'ok  a file added in a release is installed by that release\n'

# And the phase is asked only of a revision that answers it.
#
# Handing it to one that does not is not a no-op: before this release `update` ignored anything
# after it and simply updated, so a checkout that mentions the phase without answering to it turns
# the install step into a whole second update, run from inside the first, against a server the
# first one has already stopped - and that second update asks the same question again. Drilled with
# a real checkout, that chain did not end; it was still forking full updates, each taking its own
# backup, ten minutes later. So what the run looks for is the dispatch arm rather than the name,
# which also appears in prose. The fixture keeps every mention and loses the arm, and answers an
# unrecognised argument the way releases before this one did: without failing.
cp "$seed/scripts/athanor" "$test_root/seed-athanor-answering"
sed \
  -e 's/^      install-runtime-files)$/      a-phase-under-some-other-name)/' \
  -e 's|^      \*) fail "usage: athanor update" ;;$|      *) printf "asked for the phase\\n" >>"$ATHANOR_TEST_COMMAND_LOG"; exit 0 ;;|' \
  "$test_root/seed-athanor-answering" >"$seed/scripts/athanor"
chmod 0755 "$seed/scripts/athanor"
grep -q 'install-runtime-files' "$seed/scripts/athanor"
if grep -q '^ *install-runtime-files)' "$seed/scripts/athanor"; then
  printf 'the fixture still answers to the phase, so it tests nothing\n' >&2
  exit 1
fi
printf '\n# fixture-version=v9\n' >>"$seed/scripts/athanor-service"
publish_fixture v9-mentions-the-phase-without-answering
: >"$command_log"
if run_update >/dev/null 2>&1; then unanswered_update=completed; else unanswered_update=""; fi
if grep -q 'asked for the phase' "$command_log"; then
  printf 'the install step was handed to a revision with no arm to answer it\n' >&2
  exit 1
fi
[ -n "$unanswered_update" ] || {
  printf 'the update did not complete against a revision that does not answer the phase\n' >&2
  exit 1
}
grep -q 'fixture-version=v9' "$runtime/usr/local/lib/athanor/athanor-service"
printf 'ok  the install phase is asked only of a revision that answers to it\n'

# And a generation that came from the phase does not start another.
#
# The marker above is a reading of a file, and the file is the one thing here nobody controls. This
# is the bound that does not depend on reading it right: the phase is entered once, and a child
# that finds itself already inside one places the files itself instead of passing the job on. The
# fixture is the mistake this is for - a revision whose arm calls the wrapper rather than the list -
# and it counts its own generations so that a regression fails the drill rather than forking until
# something else stops it.
awk '
  /^        install_runtime_files$/ {
    print "        printf \"phase generation\\\\n\" >>\"$ATHANOR_TEST_COMMAND_LOG\""
    print "        [ \"$(grep -c \"phase generation\" \"$ATHANOR_TEST_COMMAND_LOG\")\" -lt 4 ] ||"
    print "          fail \"the phase re-entered itself\""
    print "        install_checked_out_runtime_files"
    next
  }
  { print }
' "$test_root/seed-athanor-answering" >"$seed/scripts/athanor"
chmod 0755 "$seed/scripts/athanor"
printf '\n# fixture-version=v10\n' >>"$seed/scripts/athanor-service"
publish_fixture v10-the-phase-calls-the-wrapper
: >"$command_log"
run_update >/dev/null 2>&1 || true
phase_generations=$(grep -c 'phase generation' "$command_log")
if [ "$phase_generations" -ne 1 ]; then
  printf 'the install phase ran %s times in one update\n' "$phase_generations" >&2
  exit 1
fi
grep -q 'fixture-version=v10' "$runtime/usr/local/lib/athanor/athanor-service"
printf 'ok  the install phase does not start a second generation of itself\n'

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

# The database half of that restore, which nothing used to look at.
#
# Everything above proves the workspace tree comes back. The database was a literal string printed
# by a stand-in and swallowed by another, so the archive's dump could have been written from
# nowhere, read in the wrong order, or never read, and every case still said ok. Here the row goes
# in, a backup is taken, the row changes, the restore runs, and the row is read back out.
printf 'row-worth-recovering\n' >"$database_file"
printf 'files-worth-recovering\n' >"$home/persistent.txt"
sleep 1
run_athanor backup >/dev/null 2>&1
database_backup=$(
  find "$backups" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z' | sort -r | sed -n '1p'
)
# What went into the archive is the database as it stood, rather than something written once.
test "$(cat "$database_backup/database.dump")" = "row-worth-recovering"
printf 'row-written-since\n' >"$database_file"
printf 'files-written-since\n' >"$home/persistent.txt"
run_athanor restore "$database_backup" --yes >/dev/null 2>&1
test "$(cat "$database_file")" = "row-worth-recovering"
test "$(cat "$home/persistent.txt")" = "files-worth-recovering"
printf 'ok  a restore puts the database back, not only the files\n'

# Moving to a new computer, which was not merely undrilled but mechanically broken.
#
# A backup carries /etc/athanor verbatim, which is what has to happen: the data key, the session
# key and the pinned server identity all come back exactly or the box cannot open its own database.
# PUBLIC_APP_URL, WEBAUTHN_ORIGIN and WEBAUTHN_RP_ID came back with them, so a restored box served
# an origin nobody could reach and scoped browser sign-in to an address it no longer had. Nothing
# failed anywhere; the box simply could not be opened. `rollback` has called
# athanor-network-refresh since the day it was written and `restore` never did.
#
# The two fixtures are the whole of "what computer is this": the addresses `ip` reports, and what
# the resolver says the old origin's name points at.
make_fake ip '
case "$*" in
  *-6*) exit 0 ;;
esac
printf "2: eth0    inet %s/24 brd 203.0.113.255 scope global eth0\n" "$ATHANOR_TEST_HOST_ADDRESS"'
make_fake getent '
if [ "${1:-}" = ahosts ] && [ "${2:-}" = "$ATHANOR_TEST_RESOLVES_TO_HERE" ]; then
  printf "%s STREAM %s\n" "$ATHANOR_TEST_HOST_ADDRESS" "$2"
  exit 0
fi
exit 2'
network_refresh_binary="$runtime/usr/local/lib/athanor/athanor-network-refresh"
printf '#!/bin/sh\nprintf "network refresh\\n" >>"$ATHANOR_TEST_COMMAND_LOG"\n' \
  >"$network_refresh_binary"
chmod 0755 "$network_refresh_binary"

run_new_host() {
  ATHANOR_TEST_HOST_ADDRESS="${ATHANOR_TEST_HOST_ADDRESS:-203.0.113.9}" \
    ATHANOR_TEST_RESOLVES_TO_HERE="${ATHANOR_TEST_RESOLVES_TO_HERE:-nothing.invalid}" \
    run_athanor "$@"
}

# Replaces in place rather than appending, because the script under test replaces in place: a
# second PUBLIC_APP_URL line further down the file is one nothing reads, so a fixture that appends
# would be asserting against a line no production caller ever sees.
set_config_value() {
  awk -v key="$1" -v value="$2" '
    index($0, key "=") == 1 { if (!replaced) print key "=" value; replaced = 1; next }
    { print }
    END { if (!replaced) print key "=" value }
  ' "$config/control.env" >"$test_root/control.env.next"
  mv "$test_root/control.env.next" "$config/control.env"
}

# The old machine's configuration, as a backup taken there carries it.
set_config_value PUBLIC_APP_URL https://old-box.example
set_config_value PREVIEW_BASE_URL https://old-box.example/__athanor/preview
set_config_value PUBLIC_RUNNER_URL wss://old-box.example/runner
set_config_value WEBAUTHN_RP_ID old-box.example
set_config_value WEBAUTHN_ORIGIN https://old-box.example
sleep 1
run_athanor backup >/dev/null 2>&1
new_host_backup=$(
  find "$backups" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z' | sort -r | sed -n '1p'
)

# The counter-direction first, because it is the one a fix here could break: restoring onto the
# same computer must put the configuration back exactly as it was and change nothing about it.
: >"$command_log"
run_new_host restore "$new_host_backup" --yes >/dev/null 2>&1
test "$(sed -n 's/^PUBLIC_APP_URL=//p' "$config/control.env" | sed -n '1p')" = "https://old-box.example"
test "$(sed -n 's/^WEBAUTHN_RP_ID=//p' "$config/control.env" | sed -n '1p')" = "old-box.example"
grep -q 'network refresh' "$command_log"
printf 'ok  a plain restore puts the configuration back untouched, and refreshes the network\n'

# And on a new computer the old name no longer points at, the origin is re-derived from the
# address this machine actually has. All five settings move together: an origin that disagrees
# with the WebAuthn relying party is a page no browser will create a passkey on.
: >"$command_log"
new_host_output=$(run_new_host restore "$new_host_backup" --yes --new-host 2>&1)
test "$(sed -n 's/^PUBLIC_APP_URL=//p' "$config/control.env" | sed -n '1p')" = "https://203.0.113.9"
test "$(sed -n 's/^WEBAUTHN_ORIGIN=//p' "$config/control.env" | sed -n '1p')" = "https://203.0.113.9"
test "$(sed -n 's/^WEBAUTHN_RP_ID=//p' "$config/control.env" | sed -n '1p')" = "203.0.113.9"
test "$(sed -n 's/^PUBLIC_RUNNER_URL=//p' "$config/control.env" | sed -n '1p')" = "wss://203.0.113.9/runner"
test "$(sed -n 's/^PREVIEW_BASE_URL=//p' "$config/control.env" | sed -n '1p')" = \
  "https://203.0.113.9/__athanor/preview"
grep -q 'network refresh' "$command_log"
# The data still came back; re-deriving the origin is an addition to the restore, not a detour
# around it.
test "$(cat "$home/persistent.txt")" = "files-worth-recovering"
test "$(cat "$database_file")" = "row-worth-recovering"
grep -q 'Restore complete' <<EOF
$new_host_output
EOF
printf 'ok  a fresh-host restore re-derives the origin from the address this machine has\n'

# The planned move: the domain followed the machine. Rewriting a name that already points here
# would throw away every browser passkey bound to it, which is the opposite of the repair.
set_config_value PUBLIC_APP_URL https://ai.example.com
set_config_value WEBAUTHN_RP_ID ai.example.com
set_config_value WEBAUTHN_ORIGIN https://ai.example.com
sleep 1
run_athanor backup >/dev/null 2>&1
followed_backup=$(
  find "$backups" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z' | sort -r | sed -n '1p'
)
kept_name_output=$(
  ATHANOR_TEST_RESOLVES_TO_HERE=ai.example.com \
    run_new_host restore "$followed_backup" --yes --new-host 2>&1
)
test "$(sed -n 's/^PUBLIC_APP_URL=//p' "$config/control.env" | sed -n '1p')" = "https://ai.example.com"
grep -q 'already points at this computer' <<EOF
$kept_name_output
EOF
printf 'ok  a name that followed the machine is kept rather than replaced by an address\n'
rm -f "$fake_bin/ip" "$fake_bin/getent"

# An off-host copy, encrypted, on a disk this computer's own failure does not take.
#
# Every retained copy lives in /var/backups/athanor, on the same disk as the data it is a copy of,
# and both docs/OPERATIONS.md and the settings screen advised an off-host copy the product had no
# way to make. The stand-in for gpg is a real round trip - a marker line naming the recipient, then
# the plaintext - so what is pinned is that the encrypted file is what lands, that the recipient
# was used, and that decrypting the copy yields something `restore` accepts. It pins nothing about
# OpenPGP, which is gpg's claim and not this drill's.
make_fake gpg '
recipient=""
output=""
mode=""
subject=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --recipient-file|--output|--trust-model)
      case "$1" in
        --recipient-file) recipient="$2" ;;
        --output) output="$2" ;;
      esac
      shift 2
      ;;
    --encrypt) mode=encrypt; shift ;;
    --decrypt) mode=decrypt; shift ;;
    --show-keys) mode=show; shift ;;
    --*) shift ;;
    *) subject="$1"; shift ;;
  esac
done
# The header is a fixed 78 bytes - "encrypted-to:", a sha256 of the recipient file, and a newline -
# so decrypting is a byte count rather than a line count. Line-oriented would have been wrong:
# workspaces.tar.gz is binary, and a round trip that is not byte-exact fails the checksum manifest
# for a reason that has nothing to do with what is being tested.
case "$mode" in
  show) grep -q "PUBLIC KEY" "$subject" || exit 2 ;;
  encrypt)
    {
      printf "encrypted-to:%s\n" "$(sha256sum <"$recipient" | awk "{print \$1}")"
      cat "$subject"
    } >"$output"
    ;;
  decrypt) tail -c +79 "$subject" >"$output" ;;
  *) exit 64 ;;
esac
exit 0'
# A second filesystem, which is the whole of what an off-host destination is. The drill runs
# everything under one temporary directory, so `df` is what stands in for the second disk - the
# same fixture the full-disk cases above use, answering per path rather than everywhere.
make_fake df '
for df_argument in "$@"; do
  case "$df_argument" in
    "$ATHANOR_TEST_OFF_HOST"*)
      printf "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
      printf "/dev/second-disk 10485760 1024 10484736 1%% /mnt/second\n"
      exit 0
      ;;
  esac
done
exec /bin/df "$@"'
mkdir -p "$off_host"
printf -- '-----BEGIN PGP PUBLIC KEY BLOCK-----\nsynthetic\n' >"$recipient_key"

# Configured while somebody is watching, and refused there rather than at three in the morning.
if same_disk_refusal=$(
  run_athanor backup destination "$backups" --recipient "$recipient_key" 2>&1
); then
  printf 'a destination on the same filesystem as the local copies was accepted\n' >&2
  exit 1
fi
grep -q 'same filesystem' <<EOF
$same_disk_refusal
EOF
# And a destination with nobody to open it: the archive carries the data key and the session key,
# so a copy of it that leaves the machine is a copy of everything this product protects.
if no_recipient_refusal=$(run_athanor backup destination "$off_host" 2>&1); then
  printf 'an off-host destination was accepted with no encryption recipient\n' >&2
  exit 1
fi
grep -q -- '--recipient' <<EOF
$no_recipient_refusal
EOF
run_athanor backup destination "$off_host" --recipient "$recipient_key" >/dev/null 2>&1
printf 'ok  an off-host destination is refused on the same disk, and refused unencrypted\n'

sleep 1
printf 'row-for-the-second-disk\n' >"$database_file"
printf 'files-for-the-second-disk\n' >"$home/persistent.txt"
off_host_output=$(run_athanor backup 2>&1)
off_host_copy=$(
  find "$off_host" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z' | sort -r | sed -n '1p'
)
test -n "$off_host_copy"
# What landed is ciphertext for the configured recipient, and the plaintext did not land at all.
test -f "$off_host_copy/configuration.tar.gz.gpg"
test ! -e "$off_host_copy/configuration.tar.gz"
# And it was encrypted to the recipient this box was configured with, rather than to nothing.
grep -q "encrypted-to:$("$fake_bin/sha256sum" <"$recipient_key" | awk '{print $1}')" \
  "$off_host_copy/database.dump.gpg"
# Sums of the encrypted files, in the clear, because that is the one question an owner can still
# answer at the destination without the private key: did the copy arrive whole.
test -f "$off_host_copy/SHA256SUMS.encrypted"
test "$(sed -n 's/^off_host=//p' "$backup_status_file" | sed -n '1p')" = ok
# One line, not two. The record is written pessimistically on the way in - the daily unit has a
# start timeout and a copy killed by it reaches no further line - and corrected on the way out. A
# field that appended would leave the pessimistic line permanently in front of the true one, and
# every reader here takes the first match, so the status could never say anything but "running".
test "$(grep -c '^off_host=' "$backup_status_file")" -eq 1
grep -q 'Encrypted copy written to' <<EOF
$off_host_output
EOF
printf 'ok  a backup is also encrypted to the recipient and copied to the second disk\n'

# The copy is a backup rather than a hope: decrypted by hand the way the command prints, it
# restores. This is the only end-to-end claim about the off-host copy worth making.
decrypted="$test_root/decrypted"
mkdir -p "$decrypted"
for encrypted_file in "$off_host_copy"/*.gpg; do
  plain_name=$(basename -- "$encrypted_file" .gpg)
  PATH="$fake_bin:$PATH" gpg --decrypt --output "$decrypted/$plain_name" "$encrypted_file"
done
printf 'row-written-after-the-copy\n' >"$database_file"
printf 'files-written-after-the-copy\n' >"$home/persistent.txt"
run_athanor restore "$decrypted" --yes >/dev/null 2>&1
test "$(cat "$database_file")" = "row-for-the-second-disk"
test "$(cat "$home/persistent.txt")" = "files-for-the-second-disk"
printf 'ok  the encrypted off-host copy decrypts and restores\n'

# A copy that cannot be written is not a failed backup: the local copy is complete and verified,
# and calling that a failure sends an owner hunting for a copy that is sitting right there.
rm -rf -- "$off_host"
sleep 1
if ! unreachable_output=$(run_athanor backup 2>&1); then
  printf 'a backup failed because its off-host destination was unmounted\n' >&2
  exit 1
fi
test "$(sed -n 's/^outcome=//p' "$backup_status_file" | sed -n '1p')" = ok
test "$(sed -n 's/^off_host=//p' "$backup_status_file" | sed -n '1p')" = failed
grep -q 'is not a directory this computer can see' <<EOF
$unreachable_output
EOF
# And `doctor` says which of the two happened rather than reporting a green backup that exists in
# exactly one place.
doctor_output=$(run_athanor doctor 2>&1 || true)
grep -q 'copied locally, not yet off-host' <<EOF
$doctor_output
EOF
printf 'ok  an unreachable destination fails the copy, not the backup, and doctor says so\n'

# The ordinary day that made that report false. `record_backup_status` rewrites backup.status from
# nothing on every run, so a run that stands down for a busy worker - the design, drilled above -
# carries the off-host field of the copy before it away with it. Reading the record alone then left
# `doctor` telling an owner who had already named a second disk that their backups are kept on this
# computer only, one line after `backup destination show` says where they go, and pointing them at
# the command they had already run.
: >"$worker_busy"
run_athanor backup auto run >/dev/null 2>&1
rm -f "$worker_busy"
test "$(status_field outcome)" = skipped
test -z "$(sed -n 's/^off_host=//p' "$backup_status_file" | sed -n '1p')"
configured_doctor=$(run_athanor doctor 2>&1 || true)
if grep -q 'kept on this computer only' <<EOF
$configured_doctor
EOF
then
  printf 'doctor called a box with a named off-host destination single-disk\n' >&2
  exit 1
fi
grep -q 'an off-host destination is named' <<EOF
$configured_doctor
EOF
rm -f "$fake_bin/gpg" "$fake_bin/df"
run_athanor backup destination off >/dev/null 2>&1
# The counter-direction, and the reason the branch cannot simply be deleted: a box that has never
# named a second place must still be told so, from the same arm and the same empty record.
unconfigured_doctor=$(run_athanor doctor 2>&1 || true)
grep -q 'kept on this computer only' <<EOF
$unconfigured_doctor
EOF
printf 'ok  a skipped run does not turn a configured destination into no destination\n'

# `athanor rollback` itself, which had no case of its own.
#
# The update's internal rollback is drilled three ways above, but the command an operator types
# after a release passes every automatic gate and is still wrong went through `restore_athanor`
# without anything watching it do so. That matters here because `restore` grew an argument parser
# in this change and `rollback` is one of its two callers - a parser that mishandled the positional
# would have left the command an owner reaches for on their worst day quietly restoring nothing.
sleep 1
printf 'row-before-the-rollback\n' >"$database_file"
printf 'files-before-the-rollback\n' >"$home/persistent.txt"
run_athanor backup >/dev/null 2>&1
printf 'row-after-the-rollback\n' >"$database_file"
printf 'files-after-the-rollback\n' >"$home/persistent.txt"
rollback_output=$(run_athanor rollback 2>&1)
test "$(cat "$database_file")" = "row-before-the-rollback"
test "$(cat "$home/persistent.txt")" = "files-before-the-rollback"
grep -q 'Rollback complete' <<EOF
$rollback_output
EOF
printf 'ok  rollback with no argument consumes the newest backup and puts both halves back\n'

# Uninstall, last, because it takes the runtime files every case above installed.
#
# On a self-hosted product "uninstall" is a promise about the owner's own machine, and the daily
# backup timer broke it silently: the installer enabled it with --now, the removal lists never named
# it, and it went on starting as root every day for ever. On a fully removed box it fails on a
# target whose unit file is gone and starts its alert companion, every day; on a partly removed one
# it stops and restarts the whole product and writes a fresh keys-bearing archive into
# /var/backups/athanor until the disk fills. The nginx site had the same shape on the conf.d
# layout - only the sites-enabled path was removed, so on rhel, arch and suse nginx went on serving
# a deleted application.
: >"$command_log"
run_athanor uninstall >/dev/null 2>&1
if ! grep -q 'systemctl disable --now .*athanor-backup\.timer' "$command_log"; then
  printf 'uninstall left the daily backup timer enabled\n' >&2
  exit 1
fi
backup_leftovers=$(find "$runtime" -name 'athanor-backup*' -print)
if [ -n "$backup_leftovers" ]; then
  printf 'uninstall left the backup units on disk:\n%s\n' "$backup_leftovers" >&2
  exit 1
fi
for removed in \
  /etc/systemd/system/athanor.target \
  /etc/systemd/system/athanor-runner.service \
  /etc/nginx/sites-available/athanor \
  /etc/nginx/conf.d/athanor.conf \
  /etc/nginx/snippets/athanor-security-headers.conf \
  /etc/nginx/snippets/athanor-app-csp.conf \
  /etc/update-motd.d/99-athanor; do
  if [ -e "$runtime$removed" ]; then
    printf 'uninstall left %s behind\n' "$removed" >&2
    exit 1
  fi
done
printf 'ok  uninstall disables the backup timer and removes what it installed\n'
