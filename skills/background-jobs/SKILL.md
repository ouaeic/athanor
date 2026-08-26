---
name: background-jobs
description: Run work that outlives a single turn — long builds, large batches, scheduled routines, watchers — with a manifest, checkpoints, idempotency keys on every external write, bounded output and a definite completion report. Use when a task will take many minutes or hours, processes many items, or must run again later on a schedule. Do not use for a command that finishes in seconds, and never replay a checkpointed job whose external writes are not idempotent.
license: AGPL-3.0-or-later
compatibility: No external binaries required beyond the job's own toolchain.
allowed-tools: shell process schedule notify file_read file_write files_list set_plan set_acceptance publish_artifact
metadata:
  athanor.tier: 'builtin'
  athanor.version: '1.3.0'
  athanor.risk: 'workspace'
  athanor.domain: 'long-running'
---

# Long-running and background work

## Starting a background process

```
shell executable=<cmd> args=[...] background=true timeoutSeconds=...
process action=poll  sessionId=<id>
process action=log   sessionId=<id>
process action=kill  sessionId=<id>
```

Rules:

- **Redirect the job's own output to a file** and keep the returned stream small. `maxOutputBytes`
  exists because a job that prints a progress bar will otherwise fill the context window with
  carriage returns and nothing else.
- **Record the session id immediately** in the manifest. A lost session id means a process you
  cannot stop.
- **Poll on a schedule proportional to the work**: every few seconds for a build, every minute for
  an hour-long batch. Between polls, do something useful or report progress; do not spin.
- **Know what ends it.** An unnamed background process stops at whichever comes first: its own
  `timeoutSeconds`, which is an hour at most; a `process action=kill`; or the next restart of the
  workspace runtime. Nothing restarts it afterwards.
- **Know when it should not end.** `shell background=true service=<name>` is the other primitive:
  the computer keeps that one running, with no timeout, restarts it with backoff if it dies, and
  brings it back after a reboot. It stops for good on `process action=kill`, and starting one raises
  an approval card saying exactly that, so it is the owner's decision rather than a side effect.
  Reach for it when the thing is a _server_ the owner will keep using. Work that is a _job_ — many
  items, a definite end, a report — still belongs in a schedule that resumes from the manifest, not
  in one long-lived process, because a job that restarts from the beginning is worse than one that
  stopped.
- **Never leave an unnamed process running at the end of a task.** Kill it, or hand over its session
  id and say plainly that it runs until the computer restarts. A named service is the exception: say
  that it is running, that it stays running, and how to stop it.

## The manifest is the design

Before starting any multi-item job, write `workspace/jobs/<job>/manifest.json`:

```json
{
  "job": "invoice-extract-2026-07",
  "started": "2026-07-31T09:00:00Z",
  "items": [{ "id": "inv-0001", "input": "in/inv-0001.pdf", "state": "pending" }],
  "checkpoint": "items.json",
  "idempotency_prefix": "invoice-extract-2026-07"
}
```

Per item, one of `pending`, `running`, `done`, `failed`, with the output path and the error text.
Update it after every item, not at the end. Then a crash at item 700 of 1,000 costs 1 item, not
700, and the report can say exactly what succeeded.

## Idempotency — the rule that prevents real damage

Checkpointing plus retries plus a tool that changes external state equals two emails sent, two
files uploaded, two records created.

Every external write in a batch carries an idempotency key **derived from the item, not from the
clock**: `sha256(job_name + item_id + operation)`. Never a timestamp, never a random value, never
an incrementing counter — a retry must produce the identical key.

Before writing, check whether the key already exists in the manifest as `done`. Where the target
system supports it (an `Idempotency-Key` header, a unique constraint, a deterministic file name),
use its mechanism as well; belt and braces.

Operations that cannot be made idempotent — sending a message, making a payment, submitting a form
— do not go in an unattended batch. They go in a list the owner approves and then runs once.

## Failure policy, decided up front

- **Retry**: transient only — network timeouts, 429, 5xx. Exponential backoff starting at a few
  seconds, at most three attempts, and never retry a write whose outcome is unknown without
  checking whether it landed first.
- **Skip and continue**: item-level data errors. Record the error text against the item.
- **Stop the whole job**: authentication failure, disk full, or a failure rate above a threshold
  you set before starting (10% is a reasonable default). A batch that fails on every item and
  cheerfully continues to the end wastes hours and produces a report full of the same error.

## Scheduled work

`schedule action=create` with a self-contained prompt — the scheduled run has none of this
conversation's context, so the prompt must carry every path, every credential reference and every
success criterion. Include in the prompt: what to do, what counts as success, what to do on
failure, and the condition under which the run should interrupt the owner.

Set `maxComputeCredits` deliberately. Check an existing schedule with `action=list` before creating
a near-duplicate. Every schedule change requires owner approval; present the spec in plain words
("every weekday at 07:00 Johannesburg time") rather than a cron expression.

## Telling the owner, and not telling them

A scheduled run sends nothing. Its runtime context says so, and silence is the correct outcome for
most of them: a page monitor that runs every fifteen minutes and finds no change should leave no
trace on anyone's phone.

`notify headline=<one line> detail=<optional>` is the only thing that reaches them while they are
away. Call it when this run found something they would act on now — the watched page changed, the
nightly build broke, the deadline moved, the batch stopped and needs a decision. Do not call it to
say a run finished, to report progress, or to repeat what the last run already said.

Write the condition into the scheduled prompt itself, as a comparison against saved state rather
than as a judgement:

```
Read workspace/watch/<name>/previous.json. Fetch the page and extract the same fields.
If any field differs, write the new snapshot and call notify with the field, the old value
and the new value in the headline. If nothing differs, write nothing and do not notify.
```

That is what makes a watcher a watcher. Without the saved previous state the run has nothing to
compare against and will either notify every time or never.

## The running record

A job that repeats needs somewhere to say what happened last time. That place is
`workspace/ATHANOR.md` — a plain file the owner reads and edits, loaded ahead of every later task,
and appending to it interrupts nobody. Keep it short: dated lines, newest first, one line per run
that changed something, and nothing at all for a run that did not.

Do not use `memory` for this. Durable memory is for stable preferences and conventions; a permanent
entry per night is both a growing prompt and, for anything permanent or user-level, an approval
card at three in the morning.

## Progress and completion

- Keep the plan current with `set_plan`: the owner watching a two-hour job sees only this.
- Report progress in item counts and elapsed time, not percentages you cannot compute.
- The completion report states: items attempted, done, failed, skipped; the failure reasons grouped
  by kind; where the outputs are; how long it took; and what the owner must do next.
- **Count those states out of the manifest, never out of the loop.** The loop counts what it tried;
  the manifest records what landed, and the two differ exactly when it matters:
  ```
  shell executable=/usr/local/lib/athanor/python/bin/python3 args=["-c", "import json,sys,collections; print(collections.Counter(i['state'] for i in json.load(open(sys.argv[1]))['items']))", "jobs/<job>/manifest.json"]
  ```
  One argument per array entry, because `shell` runs the executable directly and expands nothing.
  Nothing may still read `pending` or `running` once the job reports complete — which is the check
  to hand `set_acceptance` before the batch starts, because it fails on an unfinished manifest and
  the harness runs it itself when you claim the job is done.
- Verify the outputs, not the exit code — spot-check at least three produced artifacts, including
  the first and the last.

## Failure modes

- **A retry loop against a permanent error.** 401 does not become 200 on the fourth attempt.
- **Timestamp-based idempotency keys**, which are not idempotency keys.
- **Unbounded output** filling the context and hiding the actual error at the top.
- **A manifest written at the end**, which is exactly when the crash makes it unwritable.
- **Reporting the count of items processed as the count of items that succeeded.**
- **A scheduled prompt that says "continue what we discussed".** The next run has no idea what that
  was.
- **A watcher with no saved previous state**, which can only notify every run or never.
- **Notifying that a scheduled run finished.** That is not news; the change it found is.
- **Leaving an orphan process** holding a port or a lock after the task ends.
