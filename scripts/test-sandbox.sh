#!/bin/sh
set -eu

# Exercises scripts/athanor-sandbox without root. The tools that need privilege - setpriv,
# unshare - are replaced by recorders, so what is asserted here is the chain the helper builds:
# which account a command is dropped to, whether it asks for a network namespace, and that the
# command and its environment arrive on the other side intact. Those are the parts that would
# silently run every agent command as the runner if they were wrong.

repository_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT INT TERM

fake_bin="$test_root/bin"
records="$test_root/records"
mkdir -p "$fake_bin" "$records"

make_fake() {
  printf '#!/bin/sh\n%s\n' "$2" >"$fake_bin/$1"
  chmod 0755 "$fake_bin/$1"
}

# The helper asks for the agent account's numeric identity and refuses to run unless it is root.
make_fake id '
case "$*" in
  "-u") printf "0\n" ;;
  "-u athanor-agent") printf "4321\n" ;;
  "-g athanor-agent") printf "4322\n" ;;
  *) printf "unexpected id arguments: %s\n" "$*" >&2; exit 1 ;;
esac'

make_fake setpriv '
printf "%s\n" "$*" >"$ATHANOR_TEST_RECORDS/setpriv"
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
exec "$@"'

make_fake unshare '
printf "%s\n" "$*" >"$ATHANOR_TEST_RECORDS/unshare"
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
exec "$@"'

# The helper calls these by absolute path so that a search path it does not control cannot
# choose them. The copy under test has those paths pointed at the recorders instead.
sandbox="$test_root/athanor-sandbox"
sed \
  -e "s|/usr/bin/setpriv|$fake_bin/setpriv|g" \
  -e "s|/usr/bin/unshare|$fake_bin/unshare|g" \
  "$repository_root/scripts/athanor-sandbox" >"$sandbox"
chmod 0755 "$sandbox"

run_sandbox() {
  rm -f "$records/setpriv" "$records/unshare"
  PATH="$fake_bin:$PATH" ATHANOR_TEST_RECORDS="$records" "$sandbox" "$@"
}

# A command that was granted the network keeps the host's, and is still handed to the agent
# account with privilege escalation permanently disabled for it and everything it starts.
output=$(run_sandbox run network GREETING=hello /bin/sh -c 'printf "%s" "$GREETING"')
test "$output" = hello
test ! -e "$records/unshare"
grep -q -- '--reuid 4321' "$records/setpriv"
grep -q -- '--regid 4322' "$records/setpriv"
grep -q -- '--clear-groups' "$records/setpriv"
grep -q -- '--no-new-privs' "$records/setpriv"
printf 'ok  a command runs as the agent account with no route back to a higher one\n'

# The environment is carried in arguments because sudo resets it, so the whole point is that it
# survives - and that nothing the caller did not pass survives with it.
output=$(ATHANOR_LEAK=must-not-arrive run_sandbox run network PATH=/usr/bin:/bin \
  /bin/sh -c 'printf "%s|%s" "$PATH" "${ATHANOR_LEAK-unset}"')
test "$output" = '/usr/bin:/bin|unset'
printf 'ok  the command gets exactly the environment it was given\n'

output=$(run_sandbox run isolated /bin/sh -c 'printf isolated')
test "$output" = isolated
grep -q -- '--net' "$records/unshare"
grep -q -- '--no-new-privs' "$records/setpriv"
printf 'ok  an ungranted command is put in a network namespace before it is dropped\n'

# The terminal takes a separate mode only so the sudoers policy can give it a pseudo-terminal.
output=$(run_sandbox shell TERM=xterm /bin/sh -c 'printf "%s" "$TERM"')
test "$output" = xterm
test ! -e "$records/unshare"
grep -q -- '--reuid 4321' "$records/setpriv"
printf 'ok  the interactive shell is dropped to the same account\n'

test "$(run_sandbox check | sed -n 's/^user=//p')" = "$(id -un)"
printf 'ok  check reports the account a command would actually run as\n'

for refused in \
  "run" \
  "run somewhere-else /bin/true" \
  "run network" \
  "shell" \
  "install openssh-server"
do
  # shellcheck disable=SC2086
  if run_sandbox $refused >/dev/null 2>&1; then
    printf 'the sandbox accepted arguments it should have refused: %s\n' "$refused" >&2
    exit 1
  fi
done
printf 'ok  a malformed request is refused rather than guessed at\n'

# Without root the helper cannot drop privilege at all, so it must not pretend to have.
make_fake id 'case "$*" in "-u") printf "1000\n" ;; *) printf "4321\n" ;; esac'
if run_sandbox run network /bin/true >/dev/null 2>&1; then
  printf 'the sandbox ran without the privilege it needs to drop\n' >&2
  exit 1
fi
printf 'ok  the sandbox refuses to run without the privilege it drops\n'
