---
name: scientific-computing
description: Bring a toolchain this computer does not ship onto it, and run work whose data or width is larger than the workspace was sized for - a pipeline installed from a package index, a multi-gigabyte download, a command run across the box's cores. Use when the job needs a program that is not installed, a dataset of several gigabytes or more, or a run spread across many workers. Do not use for analysis the pinned interpreter already covers, which is data-analysis, and do not use for the mechanics of a run that outlives the turn, which is background-jobs; never install a toolchain into workspace/.
license: AGPL-3.0-or-later
compatibility: Needs python3 with the venv module, curl and the shell, all installed on every supported host. This computer has no compiler - gcc, cc, g++ and make are all absent - so a package with no wheel for this interpreter cannot be built without an approved install first. R, conda and JupyterLab are not installed either; nothing here assumes them.
allowed-tools: shell process file_read file_write files_list set_plan set_acceptance notify
metadata:
  athanor.tier: 'builtin'
  athanor.version: '1.0.0'
  athanor.risk: 'workspace'
  athanor.domain: 'science'
---

# Bringing a toolchain and a large dataset onto this computer

Four facts decide whether a large job finishes here: where a toolchain may be installed, how a
program installed there becomes runnable by name, what the memory figure in the Machine line
actually bounds, and which files the undo point does not cover. Not one of them produces an error
message at the moment the mistake is made, which is why they are written down.

## The environment goes under `$HOME`, never inside `workspace/`

A `--user` install is not the route, and discovering that costs a turn: this computer's system
interpreter carries no `pip` module at all, and it is marked `EXTERNALLY-MANAGED`, so PEP 668 would
refuse a `--user` install even where pip is present. The pinned document interpreter at
`/usr/local/lib/athanor/python/bin/python3` is root-owned and readable-and-executable only, so
installing into that is not a route either - it is for reading, not for extending.

The one route is `python3 -m venv`, which brings its own working pip, and it goes under `$HOME` -
`.home` at the container root, beside `workspace/`, which the sandbox grants write on precisely so
this works. A conda or micromamba prefix is not installed here, and if one is ever added it belongs
in the same place for the reason below.

`$HOME` and not `workspace/`, because `workspace/` is walked and hashed on every turn to take the
turn's undo point. Past 250,000 files - the default ceiling - the checkpoint is refused outright
with `checkpoint_workspace_too_large`, and the turn then has no rewind at all. A conda environment
is routinely 30,000 to 60,000 files and a Rust toolchain measured 88,021 on the machine this was
sized against. An environment installed inside `workspace/` therefore costs the owner the one thing
that could have undone installing it.

Say the price of the right answer out loud once, because it is real: `$HOME` is outside the undo
point, so a rewind will not put the environment back, and outside the per-workspace storage figure,
so nothing bounds its size but the host disk floor.

## Making what you installed runnable by name

`shell` performs no expansion, so `~/env/bin/tool` is not a path and never resolves, and the command
environment refuses a caller-supplied `PATH` by name rather than merging it. A program is therefore
reachable by a bare name only if it already sits in a directory on the search path.
`$HOME/.local/bin` and `$HOME/bin` are on it, ahead of the system directories. A virtual
environment's own `bin/` is not.

So the last step of an install is not the install: symlink the entry points into `$HOME/.local/bin`,
or decide to call everything by absolute path, and then keep to whichever one you chose for the
whole job. A half-linked environment is the state where the same command works from one script and
is not found by the next, and nothing about the second failure says the first script is why.

`pip` in a fresh environment falls back to building from source when a package publishes no wheel
for this interpreter, and there is no compiler here. That arrives as a page of build log whose last
lines are about a header file; the sentence that matters is near the top and says the compiler is
missing. A compiler is an ordinary approved system-package install, not a wall - but decide to
install one deliberately rather than after twenty minutes of reading a log.

## The memory figure is per process, and the ceiling above it kills without a word

The Machine line's memory number is what ONE process may commit. It is `RLIMIT_DATA`, and every
child inherits the whole of it, so `parallel -j 16` gets sixteen of those allowances rather than one
sixteenth each. What bounds the total instead is the runner's own cgroup, at `MemoryHigh=60%` and
`MemoryMax=80%` of the box.

Those two stops read nothing alike, and only one of them is legible. The per-process limit makes an
allocation fail, so the program says so in its own words - `MemoryError`, `std::bad_alloc`, "cannot
allocate" - on the stderr the result carries. The cgroup's stop is `SIGKILL`: no exit code, no
message, nothing on either stream, and from here it is indistinguishable from a crash worth
retrying. A wide job killed that way and retried unchanged is killed again the same way, and the
transcript shows two identical silences.

So size the run before starting it. Take the cores and the memory from the Machine line, multiply
the per-worker footprint by the width you are about to ask for, and choose the width from that
product rather than from the core count. `nproc` is not that number: it reports the CPUs the process
may be scheduled on and cannot see a CPU quota at all, while the Machine line is computed from the
cgroup the command will actually run in.

## Large files, and what the undo point does not cover

A file over 2 GiB - the default ceiling - is not in the checkpoint at all. It is recorded as
uncovered and walked past, so a rewind will not bring it back, and a delete that names one raises an
approval card instead of going through quietly. Treat every downloaded dataset as unrewindable.

So fetch it once, deliberately, and verify it before anything reads it: check the size and the
checksum the source publishes, in the same step that downloads it. A truncated download of a
compressed archive does not fail at the download - it fails hundreds of steps later, inside a parse,
as a message about the data rather than about the transfer. `curl -fL --retry 3 --continue-at -`
resumes a partial file rather than starting again, which is what makes a 40 GB fetch survive a
dropped connection.

`df -h /home/athanor` is the live capacity. The Machine line's free-disk figure is already reduced
by the host-disk floor the runner refuses writes under, so it is what you may actually use, not what
`df` prints.

Work that outlives the turn - the manifest, the resume, the idempotent external write - belongs to
`background-jobs`, and none of it is repeated here.
