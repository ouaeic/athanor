---
name: code-change
description: Change an existing codebase at the point the behaviour is decided, with a test watched failing first and the project's own commands as the proof. Use when the request is to add a feature, fix a bug, refactor, or otherwise modify code that already exists. Do not use to start a brand-new project from a template, to deploy, or to answer a question about code without changing it.
license: AGPL-3.0-or-later
compatibility: Requires the project's own toolchain to be installed; no additional binaries.
allowed-tools: repo_overview code_search code_diagnostics file_read file_write file_patch set_acceptance shell
metadata:
  athanor.tier: 'builtin'
  athanor.version: '2.0.0'
  athanor.risk: 'workspace'
  athanor.domain: 'code'
---

# Changing code

The tools already say how to orient, search, patch and diagnose, and the operating contract already
says to do it in that order. This is the part they do not carry: where to cut, what proves it, and
the six ways a change passes every check and is still wrong.

## The commands come from CI, not from the README

Before writing a line, find what actually builds, tests and lints this project — and take it from
the CI workflow. That file is executable and therefore true; a README's build section is prose that
nobody re-runs, and it is stale in most repositories that have one. Read `CONTRIBUTING`, the agent
instruction files, and the package manifest's scripts for the conventions, but let CI settle the
commands.

Check the working tree is clean before you touch it. A change mixed into someone else's uncommitted
work cannot be reviewed or reverted separately.

## Cut where the behaviour is decided

Change the code at the point the behaviour is decided, not at the point the symptom appears. A null
check added where the null surfaced leaves whatever produced the null still producing it, and the
next caller finds it again.

Before changing any signature, find every caller with ``. A change that compiles is not
a change that is complete: call sites in a template, a configuration file, a serialized fixture or a
dynamically dispatched language are invisible to the compiler and fail in production instead.

Implement what was asked and nothing else. Adjacent problems get reported in your reply, not fixed
in the diff — an unrequested refactor mixed into a bug fix hides the real change, and the reviewer's
attention runs out long before the diff does. Never run a repository-wide formatter as part of a
feature change; it turns a six-line diff into an unreadable one.

## Watch the test fail

For a bug fix, the order is not negotiable:

1. Write a test that reproduces the reported failure.
2. **Run it and watch it fail**, with the failure matching the report.
3. Make the smallest change that makes it pass.
4. Run the whole suite.

A regression test never seen failing is not a regression test — it may be asserting something that
was already true, and it will keep passing after the bug comes back. This is also exactly what
`set_acceptance` is for: declare the project's test command as a `command` check before you make the
change. The harness runs it there and then, sees it fail, and holds you to it — and it refuses a
definition of done that already passes, which is the same discipline enforced from outside.

For a new feature the test goes in alongside, and it exercises the boundaries — empty input, the
maximum, the error path — not only the happy path.

Match the project's existing test style exactly: same framework, same file placement, same naming,
same fixtures. A test in an unfamiliar idiom is deleted by the next person who touches the file.

## What counts as verified

Run the full suite, not the file you touched, and run it after the change rather than before. If the
suite was already red, say which tests were red before you started and confirm you added none.

For anything with runtime behaviour, exercise it: start the process, call the endpoint, run the CLI
with real arguments, and read the output. A type check is not a test and a test is not a run.

Do not commit, branch, push, or open a pull request unless you were asked to. When you are asked,
follow the project's own message conventions and never rewrite shared history.

## Failure modes

- **Fixing the symptom.** Adding a null check where the null should never have been produced.
- **Inventing an API.** A plausible-looking method name is the single most common defect. Verify the
  real signature with ``, or by reading the installed source in `node_modules` or
  `site-packages` — not from memory of the library.
- **Testing the mock.** A test that asserts the mock was called proves the test wired the mock.
- **The green suite that never ran your code.** A misnamed file, a missing marker or a directory
  outside the collection root means the new test is silently skipped. Confirm the reported test
  count actually changed.
- **A change that only works with a warm cache.** Verify from a clean state when the build has one;
  incremental success hides a missing generated file or an uncommitted artifact.
- **Scope creep.** The reviewer's willingness to review shrinks with diff size, and the bug fix
  buried in a 900-line refactor is the one that gets missed.
