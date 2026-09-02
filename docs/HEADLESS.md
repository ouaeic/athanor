# Driving athanor from a script

`athanor task` is the larger half of athanor's headless surface. It starts work, waits for it, and
answers with one JSON object and an exit code that says how the work ended. The one other command
here is `athanor tool-opens` at the end of this page, which reads back what the box has been doing
rather than making it do anything; it is on this page because it wants the same API token and the
same plumbing, not because it drives a run.

There is a third command on the same plumbing, and it is on its own page because its caller is not a
script the owner wrote: `athanor acp` speaks Agent Client Protocol on stdin and stdout, so an editor
or a desktop client somebody else wrote can drive this box. It creates the same tasks over the same
routes with the same token, under the same approval floor. See [ACP](ACP.md) - and read its approval
section before minting a token for it, because the scope you choose is what decides whether a client
can answer a card.

Both drive the same HTTP API a browser drives, with an API token in place of a passkey session. No
route either uses is new, and neither adds anything to what the model is sent: these are commands
an operator types, not tools the agent can see, so the tool catalogue is the same byte for byte
with them and without them.

## Getting a token, and why a script cannot get one for itself

A token is minted at a browser, by a person, with a passkey. `POST /v1/api-tokens` calls
`requireRecentStepUp` before it does anything else, so it needs a session cookie whose passkey
ceremony happened inside the step-up window. And `/v1/api-tokens` matches no entry in the scope
table in `apps/api/src/http/auth-hook.ts`, so the route falls through to `undefined` and a bearer
token is refused it outright.

That second fact is the load-bearing one: **a token cannot mint a second token**. A stolen token
buys exactly its own scopes until its own expiry, and no path widens either.

This is kept, not fixed. Two reasons:

- A server with no screen is still reached from the owner's own browser. `sudo athanor connect`
  prints the address to open and a QR code for a phone, a passkey is bound to that hostname, and
  `sudo athanor doctor` reports a box with no hostname as one where browser sign-in cannot work at
  all. Nothing needs a browser on the box itself, so "the operator only has SSH" is not the same
  claim as "no human can reach a browser pointed at this machine".
- What is genuinely not served is a first token with no human anywhere, on any device - a machine
  provisioning itself. That case is refused on purpose. A credential a machine can mint for itself
  unattended is a credential anything that reaches the machine can mint.

What was missing was not a way to mint a token but a place to keep one. `athanor task` looks for a
token in two places, in this order:

1. `ATHANOR_TOKEN` in the environment, for a caller on another machine.
2. `/etc/athanor/api-token`, for the box itself. Create it root-owned and mode `0600`, containing
   the token and nothing else. Then the token is not in a shell history, an environment, or a
   process list, and `sudo athanor task ...` is the ordinary invocation.

Override the file's location with `ATHANOR_TOKEN_FILE` and the server's address with `ATHANOR_API`,
which defaults to `http://127.0.0.1:4100`.

Nothing in athanor creates that file, sets its mode, or checks it. `doctor` does not mention it.
That is open work, and it is stated here rather than implied.

### Scopes

Mint the token with the least that will do. A run that starts work and reads the result needs
`tasks:write` and `tasks:read`. Add `approvals:read` and `approvals:write` only if something will
answer the questions the run stops to ask. Add `files:read` and `files:write` to seed inputs or read
artefacts back with `curl`.

Two refusals are deliberate and are not worked around here: no scope reaches
`/v1/workspaces/:id/{terminal,browser,desktop}-token`, and none reaches `/v1/notifications`.

## The commands

```bash
sudo athanor task run --workspace ID (--prompt TEXT | --prompt-file PATH)
sudo athanor task wait TASK_ID [--timeout SECONDS]
sudo athanor task show TASK_ID
sudo athanor task cancel TASK_ID
sudo athanor task approvals [TASK_ID]
sudo athanor task approve APPROVAL_ID
sudo athanor task deny APPROVAL_ID
```

`run` also takes `--model ID`, `--privacy-route ROUTE`, `--credits N`, `--spend-usd N`,
`--timeout SECONDS` and `--key IDEMPOTENCY-KEY`. `--prompt-file -` reads the prompt from standard
input.

`--key` is the one worth understanding. Every write on this API needs an `Idempotency-Key`, and
`run` generates a fresh one per invocation - so re-running the same command starts a **second**
task and pays for it twice. A caller that retries should pass its own `--key` and keep it across
attempts.

## The outcome

`run`, `wait`, `show` and `cancel` print one JSON object on standard output. Progress and errors go
to standard error, so `athanor task run ... > outcome.json` is a complete result.

```json
{
  "contract": "athanor.task.outcome/1",
  "outcome": "completed",
  "exitCode": 0,
  "taskId": "…",
  "workspaceId": "…",
  "status": "completed",
  "securityMode": "balanced",
  "modelId": "…",
  "spentUsd": 0.0125,
  "computeCredits": { "used": 12, "max": 200 },
  "waitedSeconds": 94,
  "transcript": "read",
  "answer": "I wrote report.pdf and checked it opens.",
  "verification": { "…": "the completion contract the turn declared" },
  "outstanding": ["what the turn left open"],
  "reason": null,
  "reasonCode": null,
  "pendingApprovals": [],
  "lastEventSequence": 42
}
```

`answer`, `verification` and `outstanding` are read out of the `completed` event's payload, which is
where the worker writes the model's own account of the turn.

`reason` and `reasonCode` come from the last event the worker addressed to the owner - the one whose
payload carries `owner: true` - and they are filled only on an ending that has a reason, which is
`failed` and `blocked`. Two things make that narrower and wider than "the last `error` event":

- a run that died of anything the provider did is recorded as a `warning`, not an `error`
  (`apps/worker/src/agent.ts`), and it still ends `failed` unless the code is one of the three
  provider walls that park a task instead. Reading only `error` events left the commonest class of
  failure with no reason at all.
- a tool call that throws and is recovered from writes an `error` event mid-run
  (`apps/worker/src/tool-recording.ts`). On a run that then finished, reporting it would put
  `reason: "shell failed"` beside a successful answer.

So on `completed` both fields are `null` by construction, not because nothing went wrong along the
way. The transcript is where the mid-run failures are.

Before this existed a caller recovered the result by filtering the event list for
`kind === "completed"` and then searching the JSON for a string; `scripts/live-drill.mjs` still
does, and looks for `exit 0`.

`status` is athanor's own word for the task and `outcome` is this contract's. They are not the same
vocabulary and both are given.

`transcript` is `read` or `unavailable`. Without it an `answer` of `null` on a completed task means
either that the turn wrote nothing or that the transcript could not be fetched, and a caller scoring
on the answer could not tell those apart.

### Exit codes

| Code | Outcome             | Meaning                                                            |
| ---- | ------------------- | ------------------------------------------------------------------ |
| 0    | `completed`         | The task finished.                                                 |
| 1    | -                   | The command could not do its job: no token, bad option, no answer. |
| 2    | `failed`            | The task failed. `reason` and `reasonCode` say what happened.      |
| 3    | `awaiting_approval` | The task stopped to ask. `pendingApprovals` holds the questions.   |
| 4    | `timed_out`         | The wait ran out. The task is still running and still spending.    |
| 5    | `cancelled`         | The task was cancelled.                                            |
| 6    | `blocked`           | Stopped and needing a resume: `paused` or `awaiting_resource`.     |
| 7    | `running`           | `show` only: the task has not stopped.                             |
| 64   | -                   | No such subcommand.                                                |

Exit 4 does not stop anything. The task keeps running and keeps spending; `athanor task cancel`
is how it is stopped, and `athanor task wait` picks the same task back up.

Exit 6 is the one worth reading twice. `awaiting_resource` sounds like a wait that clears on its
own and is not: it is where a provider wall, a disconnected provider or an unreachable model parks
a task, and nothing leases it again without a resume.

`approvals`, `approve` and `deny` describe a request about work that is still going rather than an
ending, so they exit 0 or 1 and print what they did.

## Approvals, and the mode they follow from

**`athanor task` never answers an approval.** A run that reaches one stops, exits 3, and hands back
what was asked as data. There is no `--yes` and there is deliberately no `--security-mode`: how much
a run stops to ask is the workspace's setting, and a flag on the command that started the work could
quietly answer questions the owner had asked to be shown. The mode is reported in every outcome
instead, so a result always carries the terms it was produced under.

The three modes, and what each still stops for, are in `apps/worker/src/approval-policy.ts`:

- **Review** asks before every command, every file written, and every browser or desktop action.
- **Balanced** asks before reaching an address on the internet and before installing software.
- **Autonomous** asks only about what the computer cannot take back: publishing, sending, spending,
  destroying data, signing or accepting terms, anything it would go on running by itself, and a
  control on a screen that nothing could identify.

Autonomous is a floor, not an off switch. An unattended run in any mode can still stop.

A task inherits its mode from its workspace when it is created. Change the workspace's default with
one call, using a token carrying `workspaces:write`:

```bash
curl -fsS -X PATCH "$ATHANOR_API/v1/workspaces/$WORKSPACE/security-mode" \
  -H "Authorization: Bearer $ATHANOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: mode-$(date +%s)" \
  -d '{"securityMode":"autonomous"}'
```

An unattended caller that answers its own questions writes that loop itself:

```bash
athanor task run --workspace "$WORKSPACE" --prompt-file brief.txt >outcome.json
task=$(jq -r .taskId outcome.json)
while [ "$(jq -r .outcome outcome.json)" = awaiting_approval ]; do
  for id in $(jq -r '.pendingApprovals[].id' outcome.json); do
    athanor task approve "$id"
  done
  athanor task wait "$task" >outcome.json
done
exit "$(jq -r .exitCode outcome.json)"
```

That loop is four lines and it is meant to be. Answering approvals automatically is a real decision
about what may happen with nobody watching, and a caller that has made it should have it written
down in its own source, where it can be read, counted and disclosed - not folded into a flag.

## What the box has been reaching for

```bash
sudo athanor tool-opens [DAYS] [--json]
```

The one command on this page that is not about a run. It reports the share of this box's turns over
the last `DAYS` - seven by default - that reached each tool at least once. Turns, not calls: a tool
used five times inside one turn was opened once. It reads `GET /v1/usage/tool-opens`, needs
`usage:read` and nothing else, calls no provider, and is billed nothing.

It refuses to divide by a small sample. Under 33 turns in the window it prints no share at all and
says why: at 33 a tool nobody called once has a 95% upper bound below the 9.2% threshold the
tool-deferral decision uses, and below 33 the rule of three that decision is quoted in does not
clear it. Thirty-three is the floor of that shorthand and not of the tighter bound the table
actually prints, which clears at 32; the two are held together on purpose, and
`MIN_TURNS_TO_ANSWER` in `apps/api/src/routes/usage.ts` carries the working and the cost of that
choice. `docs/design/organs/PREAMBLE.md` is the decision it feeds - and that file is excluded by
`.gitignore`, so it is not in a clone of this repository and the working in `usage.ts` is the copy
you have.

`--json` prints the object the route returned instead of the table. Both arguments are optional and
independent: `tool-opens`, `tool-opens 30`, `tool-opens --json` and `tool-opens 30 --json` are all
accepted, and the day count defaults to 7 whether or not `--json` is given.

## What this does not do

- It does not mint tokens, rotate them, or check the permissions on the file it reads one from.
- It does not create workspaces, upload inputs, or download artefacts. Those are `curl` against
  `/v1/workspaces` and `/v1/workspaces/:id/file`, with `files:read` and `files:write`.
- It does not stream. `run` polls every two seconds (`ATHANOR_TASK_POLL_SECONDS`). The live
  transcript is `GET /v1/tasks/:taskId/events/stream`, which reconnects with `Last-Event-ID`.
- It does not read the transcript. The outcome carries the ending; `GET /v1/tasks/:taskId/events`
  carries the whole trajectory, and `athanor task` deliberately does not wrap it.
- It does not resume. `paused` and `awaiting_resource` are reported, not cleared;
  `POST /v1/tasks/:taskId/resume` is the call.

`scripts/test-task-cli.mjs` runs the real subcommand against a stand-in API and checks each of the
exit codes above, the shape of the outcome, and that nothing answers an approval. It costs nothing
and runs inside `node scripts/check-repository.mjs`. What it cannot prove is that the API still
sends the shapes it stands in for - that is `scripts/live-drill.mjs`, against a real box and a real
model, and it costs money to run.
