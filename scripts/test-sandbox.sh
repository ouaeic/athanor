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

# The recorder, and the one thing in it that is more than a recorder.
#
# There is no Landlock here, so a recorder that swallows every flag and runs the command regardless
# can only ever prove which ruleset reached the exec line. That was enough until the `check` probe:
# the probe's whole question is whether the program it names is reachable UNDER its own rules, and a
# recorder that always succeeds answers `filesystem=landlock` on every host, for every rule list,
# including the /usr-only list that silently downgraded a perfectly capable box.
#
# So the one kernel behaviour the probe turns on is simulated, and only that one: a program beneath
# no rule carrying `execute` is refused instead of run. Coverage is decided by LITERAL path prefix,
# which is precisely a host where /bin is a real directory rather than a link into /usr - the host
# nobody working on this has, and the host the old probe was wrong on. On a merged host the kernel
# would follow `/bin -> usr/bin` and the old probe would have passed, which is why it survived.
# Nothing else about the ruleset is enforced: writes, renames and reads are not simulated and the
# assertions below make no claim about them.
#
# The rule paths come from the fixed lists in the helper and from a mktemp directory, so splitting
# the collected paths on whitespace is safe here in a way it would not be in production.
make_fake setpriv '
printf "%s\n" "$*" >"$ATHANOR_TEST_RECORDS/setpriv"
landlocked=""
granted=""
for word in "$@"; do
  case "$word" in
    --landlock-access) landlocked=yes ;;
    path-beneath:*)
      rule="${word#path-beneath:}"
      case "${rule%%:*}" in
        *execute*) granted="$granted ${rule#*:}" ;;
      esac
      ;;
  esac
done
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
if [ -n "$landlocked" ]; then
  covered=""
  for rule_path in $granted; do
    case "$1" in
      "$rule_path"/*) covered=yes ;;
    esac
  done
  if [ -z "$covered" ]; then
    printf "setpriv: %s is beneath no rule that grants execute\n" "$1" >&2
    exit 126
  fi
fi
exec "$@"'

make_fake unshare '
printf "%s\n" "$*" >"$ATHANOR_TEST_RECORDS/unshare"
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
exec "$@"'

# The helper calls these by absolute path so that a search path it does not control cannot
# choose them. The copy under test has those paths pointed at the recorders instead.
#
# `workspace_parent` is redirected the same way and for the same reason: the confinement rules name
# a real directory, setpriv refuses a rule it cannot open, and this harness deliberately runs
# without the privilege that would let it create anything under /home/athanor. Pointing it at the
# temporary tree is what lets the rules the helper builds be asserted at all.
sandbox="$test_root/athanor-sandbox"
workspaces="$test_root/workspaces"
workspace_id="0f4b0c2e-7a1d-4b3f-9c2a-6d5e4f3a2b1c"
mkdir -p "$workspaces/$workspace_id/workspace"
sed \
  -e "s|/usr/bin/setpriv|$fake_bin/setpriv|g" \
  -e "s|/usr/bin/unshare|$fake_bin/unshare|g" \
  -e "s|^workspace_parent=\"/home/athanor\"$|workspace_parent=\"$workspaces\"|" \
  "$repository_root/scripts/athanor-sandbox" >"$sandbox"
chmod 0755 "$sandbox"
grep -q "^workspace_parent=\"$workspaces\"$" "$sandbox" ||
  { printf 'the harness could not redirect workspace_parent; the assertions below would be vacuous\n' >&2; exit 1; }

run_sandbox() {
  rm -f "$records/setpriv" "$records/unshare"
  PATH="$fake_bin:$PATH" ATHANOR_TEST_RECORDS="$records" "$sandbox" "$@"
}

# A command that was granted the network keeps the host's, and is still handed to the agent
# account with privilege escalation permanently disabled for it and everything it starts.
output=$(run_sandbox run network open - GREETING=hello /bin/sh -c 'printf "%s" "$GREETING"')
test "$output" = hello
test ! -e "$records/unshare"
grep -q -- '--reuid 4321' "$records/setpriv"
grep -q -- '--regid 4322' "$records/setpriv"
grep -q -- '--clear-groups' "$records/setpriv"
grep -q -- '--no-new-privs' "$records/setpriv"
printf 'ok  a command runs as the agent account with no route back to a higher one\n'

# The environment is carried in arguments because sudo resets it, so the whole point is that it
# survives - and that nothing the caller did not pass survives with it.
output=$(ATHANOR_LEAK=must-not-arrive run_sandbox run network open - PATH=/usr/bin:/bin \
  /bin/sh -c 'printf "%s|%s" "$PATH" "${ATHANOR_LEAK-unset}"')
test "$output" = '/usr/bin:/bin|unset'
printf 'ok  the command gets exactly the environment it was given\n'

output=$(run_sandbox run isolated open - /bin/sh -c 'printf isolated')
test "$output" = isolated
grep -q -- '--net' "$records/unshare"
grep -q -- '--no-new-privs' "$records/setpriv"
printf 'ok  an ungranted command is put in a network namespace before it is dropped\n'

# ── The filesystem boundary ───────────────────────────────────────────────────────────────────
#
# Landlock is a kernel facility and there is no kernel here: the recorder swallows every flag and
# runs the command regardless, so what this half of the harness can prove is that the right ruleset
# reaches the exec line, and nothing about what the kernel then does with it. The other half of that
# proof is a drill run against a real kernel, recorded in the wave's report; a flags-only assertion
# passing while the ruleset granted everything is exactly the shape it exists to catch, which is why
# the negative assertions below matter more than the positive ones.
root="$workspaces/$workspace_id"
# Shaped like a workspace the runner has prepared - `ensureWorkspace` in files.ts makes all three -
# because `confine_to` skips a directory that is not there. Without `.athanor` on disk, adding it to
# the helper's write loop granted nothing and every assertion below stayed green while the ruleset
# said something new; that is the saturation this harness exists to avoid.
mkdir -p "$root/.home" "$root/.athanor/artifacts"
output=$(run_sandbox run network confine "$root" /bin/sh -c 'printf confined')
test "$output" = confined
grep -q -- '--landlock-access fs' "$records/setpriv"
grep -q -- "path-beneath:execute,read-file,read-dir:/usr" "$records/setpriv"
grep -q -- "path-beneath:execute,read-file,read-dir:/etc" "$records/setpriv"
grep -q -- "refer,truncate:$root/workspace" "$records/setpriv"
# The agent's $HOME, which is `.home` at the container root rather than under `workspace/`
# (execution.ts `agentHome`) and therefore needs a grant of its own: without this rule a confined
# `pip install`, `cargo build` or coding-CLI sign-in writes nothing. Asserted with the write verbs
# spelled out, because a rule that named it with the read list would look present and refuse them
# all the same.
grep -q -- "refer,truncate:$root/.home" "$records/setpriv"
grep -q -- 'make-sym:/dev ' "$records/setpriv"
# Kept, because the next `run_sandbox` overwrites the record and the `check` assertions below
# compare the probe's rules against exactly this: the read hierarchies a confined command gets.
cp "$records/setpriv" "$test_root/confined-rules"
printf 'ok  a confined command carries the workspace grant, the home grant and the /dev grant\n'

# The other half of that, and the reason the home is a second rule instead of a grant on $ROOT:
# $ROOT/.athanor is the checkpoints, the browser profile's parent and the artifact store, and a
# command that could rename it could take the undo point away from the turn that is running it.
# Named literally as well as caught by the closed-ruleset check below, so this one fact can be
# watched failing on its own rather than only as "a directory nobody wrote down".
if grep -Eq -- "path-beneath:[a-z,-]+:$root(/\.athanor)?( |\$)" "$records/setpriv"; then
  printf 'the ruleset granted the container root or its .athanor, which is the undo point\n' >&2
  exit 1
fi
printf 'ok  the container root and its .athanor are granted nowhere\n'

# /home is the omission the whole boundary rests on: every workspace on the box shares the agent
# account's primary group, so any grant at or above /home hands one task every other task's files.
# Asserted as the absence of a rule rather than as the presence of one, because the failure being
# guarded against is a directory somebody adds to the read list without noticing what it contains.
if grep -Eq -- "path-beneath:[a-z,-]+:($workspaces|$(dirname "$workspaces"))( |\$)" \
  "$records/setpriv"; then
  printf 'the ruleset granted the directory that holds every other workspace\n' >&2
  exit 1
fi
# And the same fact spelled the way the shipped helper spells it, because the line above is asked
# against the redirected parent this harness installed. A `/home` or `/home/athanor` written
# literally into the read list would satisfy that check and hand every workspace away on the box.
if grep -Eq -- 'path-beneath:[a-z,-]+:/home(/athanor)?( |$)' "$records/setpriv"; then
  printf 'the ruleset named /home, which is every workspace on the installed host\n' >&2
  exit 1
fi
printf 'ok  the parent of every workspace is granted nowhere in the ruleset\n'

# And the same question asked the other way round, because the two checks above name two paths and
# the failure they guard against is a directory somebody ADDS to one of the lists. Measured against
# this file as it was first written: putting `/` at the head of the read loop, and `$confine_root`
# at the head of the write loop, each granted the whole disk and the whole container respectively
# and left all eleven assertions green. So the ruleset is closed instead: every rule it carries has
# to name a directory written down here, or the `workspace` or `.home` of the one container the
# command belongs to - never the container root itself, which is what holds `.athanor`.
#
# The list is spelled out in this file rather than read back out of the helper, because a list
# derived from the thing under test cannot disagree with it. A directory this harness's host does
# not have is simply absent from the ruleset, which is fine - the positive assertions above are what
# require the ones that must be there.
#
# THE VERBS ARE PART OF THE RULE and are checked with the directory rather than stripped off it.
# This check used to discard them, and that left the property SECURITY.md states - that what a
# confined command may write is its own workspace, its home and the three scratch directories -
# unpinned in the direction that matters: measured against this file, giving /var the full write
# list while leaving every directory name alone kept all fourteen assertions green. Ten of the
# twelve read directories could be upgraded that way in silence, because only /usr and /etc have
# their verbs named in a positive assertion above. A rule is a verb list and a path, so both halves
# are written down here.
harness_read="execute,read-file,read-dir"
harness_write="execute,write-file,read-file,read-dir,remove-dir,remove-file,make-char,make-dir,make-reg,make-sock,make-fifo,make-block,make-sym,refer,truncate"
harness_device="write-file,read-file,make-char,make-dir,make-reg,make-sock,make-fifo,make-block,make-sym"
tr ' ' '\n' <"$records/setpriv" | sed -n 's/^path-beneath://p' |
  while IFS= read -r granted; do
    case "$granted" in
      "$harness_read:/usr" | "$harness_read:/bin" | "$harness_read:/lib") ;;
      "$harness_read:/lib64" | "$harness_read:/sbin" | "$harness_read:/opt") ;;
      "$harness_read:/etc" | "$harness_read:/var" | "$harness_read:/srv") ;;
      "$harness_read:/run" | "$harness_read:/proc" | "$harness_read:/sys") ;;
      "$harness_write:/tmp" | "$harness_write:/var/tmp" | "$harness_write:/dev/shm") ;;
      "$harness_write:$root/workspace" | "$harness_write:$root/.home") ;;
      "$harness_device:/dev") ;;
      *)
        printf 'the ruleset carries a rule nothing in this harness wrote down: %s\n' \
          "$granted" >&2
        exit 1
        ;;
    esac
  done || exit 1
printf 'ok  the ruleset carries no rule but the ones this file names, verbs included\n'

# The other direction, because a boundary is only worth having if ordinary work still runs. A
# workspace made before the runner started creating `.home` has none, and setpriv refuses the whole
# command when a rule names a path it cannot open - so a missing home must be skipped rather than
# refused, and the command must still get its workspace.
legacy_id="5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c83"
mkdir -p "$workspaces/$legacy_id/workspace"
output=$(run_sandbox run network confine "$workspaces/$legacy_id" /bin/sh -c 'printf legacy')
test "$output" = legacy
grep -q -- "refer,truncate:$workspaces/$legacy_id/workspace" "$records/setpriv"
if grep -q -- "$workspaces/$legacy_id/.home" "$records/setpriv"; then
  printf 'the ruleset named a .home that does not exist; setpriv would refuse the command\n' >&2
  exit 1
fi
printf 'ok  a workspace with no home yet is confined rather than refused\n'

# A root the helper cannot vouch for is refused rather than confined to the wrong tree. The two
# lies worth telling it are a name that is not a workspace id and a real workspace id somewhere
# else on the disk, and both are refused before setpriv is reached at all.
nested_id="1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
linked_id="2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60"
swapped_id="3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6071"
homed_id="4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b72"
mkdir -p "$test_root/elsewhere/$workspace_id/workspace" "$workspaces/not-a-workspace/workspace" \
  "$workspaces/$workspace_id/$nested_id/workspace" "$workspaces/$nested_id" \
  "$workspaces/$swapped_id" "$workspaces/$homed_id/workspace"
# The three swaps the agent account could actually perform on the installed host, where the
# workspace root is group-writable by it: the whole root replaced by a link, `workspace` replaced by
# one, and `.home` replaced by one. All three would make setpriv open the link's target and write a
# rule for that instead - and `.home` is the newest of them, because it only became a rule path when
# the agent's HOME moved to the container root.
ln -s / "$workspaces/$linked_id"
ln -s / "$workspaces/$swapped_id/workspace"
ln -s / "$workspaces/$homed_id/.home"
for lie in \
  "$workspaces/not-a-workspace" \
  "$test_root/elsewhere/$workspace_id" \
  "$workspaces/$workspace_id/workspace" \
  "$workspaces/../workspaces/$workspace_id" \
  "$workspaces/$(printf '%s' "$workspace_id" | tr 'b' 'z')" \
  "$workspaces/$workspace_id/$nested_id" \
  "$workspaces/$nested_id" \
  "$workspaces/$linked_id" \
  "$workspaces/$swapped_id" \
  "$workspaces/$homed_id"
do
  if run_sandbox run network confine "$lie" /bin/sh -c : >/dev/null 2>&1; then
    printf 'the sandbox confined a command to a root it should have refused: %s\n' "$lie" >&2
    exit 1
  fi
done
printf 'ok  a root that is not a workspace under the workspace parent is refused\n'

# `open` is the mode the workspace delete path and the owner's shell take, and it must reach the
# exec line with no ruleset at all - a stray rule there would refuse the delete it exists to do.
run_sandbox run network open - /bin/sh -c :
if grep -q -- '--landlock' "$records/setpriv"; then
  printf 'an open command carried a filesystem ruleset\n' >&2
  exit 1
fi
printf 'ok  an open command carries no ruleset\n'

# The terminal takes a separate mode only so the sudoers policy can give it a pseudo-terminal.
output=$(run_sandbox shell TERM=xterm /bin/sh -c 'printf "%s" "$TERM"')
test "$output" = xterm
test ! -e "$records/unshare"
grep -q -- '--reuid 4321' "$records/setpriv"
# The owner sitting at their own computer is not confined, and that is a decision rather than an
# omission: a ruleset here would stop them reading their own files from their own terminal while
# the file browser hands them the same files anyway.
if grep -q -- '--landlock' "$records/setpriv"; then
  printf 'the owner terminal was given a filesystem ruleset\n' >&2
  exit 1
fi
printf 'ok  the interactive shell is dropped to the same account and is not confined\n'

report=$(run_sandbox check)
test "$(printf '%s' "$report" | sed -n 's/^user=//p')" = "$(id -un)"
# The third line of the ladder, asserted as the OUTCOME the installer reads rather than as the flags
# the probe carried.
#
# This used to be `landlock | none` - either answer accepted - beside a grep for one rule in the
# probe's recorded arguments. Both were saturated. The recorder always succeeded, so `landlock` was
# what CI saw no matter what the probe asked for; and the grep pins a rule list, which is not what
# went wrong. What went wrong is a probe whose rules did not reach the program it ran: it granted
# /usr alone and then executed a program under /bin, so on a host where /bin is a real directory the
# probe failed for want of a rule rather than for want of Landlock, the installer took the `*)` arm,
# warned about the kernel and wrote CONFINE_AGENT_FILESYSTEM=false on a box that could have enforced
# it. A silent downgrade reported as a kernel limitation.
#
# With the recorder refusing an exec beneath no rule, `landlock` is now an answer the probe has to
# earn. It earns it the way a non-merged host would make it earn it: coverage is decided by literal
# prefix, so /bin/sh is reachable here only because the shipped list grants /bin in its own right,
# and not because a /bin symlink happens to land inside /usr. A merged host grants /bin too, so the
# shipped probe passes on both; it is the OLD probe the two hosts disagree about, which is why the
# narrowed copy below is the assertion that carries the argument.
test "$(printf '%s' "$report" | sed -n 's/^filesystem=//p')" = landlock
# Read back before the narrowed probe below overwrites the record. The rung is the outcome; this is
# the reason it is the right outcome. The probe has to ask for the same read hierarchies a confined
# command gets, not merely for enough of them to run its own program - otherwise a read directory
# dropped from the shipped list would go on being reported as enforceable at install time. Compared
# against the rules recorded from the confined run above rather than against a list written here,
# because the point is that the two agree.
probe_rules=$(tr ' ' '\n' <"$records/setpriv" | sed -n 's/^path-beneath://p' | sort)
confined_read_rules=$(tr ' ' '\n' <"$test_root/confined-rules" |
  sed -n "s/^path-beneath:$harness_read:/$harness_read:/p" | sort)
if [ "$probe_rules" != "$confined_read_rules" ]; then
  printf 'the check probe and a confined command do not carry the same read rules\n' >&2
  exit 1
fi
# And the same probe under the grant list it used to have, which is the case no one running this has
# a host for. A copy of the helper with the read loop narrowed back to /usr has to answer `none` -
# if it answers `landlock`, the simulation above is not simulating anything and the assertion above
# is worth nothing.
narrowed="$test_root/athanor-sandbox-usr-only"
sed -e 's|^  for confine_directory in /usr /bin .*; do$|  for confine_directory in /usr; do|' \
  "$sandbox" >"$narrowed"
chmod 0755 "$narrowed"
grep -q '^  for confine_directory in /usr; do$' "$narrowed" ||
  { printf 'the harness could not narrow the read list; the assertion below would be vacuous\n' >&2; exit 1; }
narrowed_report=$(rm -f "$records/setpriv"; PATH="$fake_bin:$PATH" ATHANOR_TEST_RECORDS="$records" \
  "$narrowed" check)
if [ "$(printf '%s' "$narrowed_report" | sed -n 's/^filesystem=//p')" != none ]; then
  printf 'the old /usr-only probe still reported a filesystem rung; the harness proves nothing\n' >&2
  exit 1
fi
printf 'ok  check reports the account a command would run as, and earns the filesystem rung\n'

for refused in \
  "run" \
  "run somewhere-else open - /bin/sh" \
  "run network" \
  "run network open" \
  "run network open -" \
  "run network somewhere-else - /bin/sh" \
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
if run_sandbox run network open - /bin/sh -c : >/dev/null 2>&1; then
  printf 'the sandbox ran without the privilege it needs to drop\n' >&2
  exit 1
fi
printf 'ok  the sandbox refuses to run without the privilege it drops\n'
