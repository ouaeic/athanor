---
name: deployment
description: Get a built application running and reachable, on this computer or the owner's own host, with the two facts about this machine that decide whether it works — bind 0.0.0.0, and nothing here survives a restart — stated plainly to the owner along with the rollback command. Use when the owner asks to run, preview, publish or deploy an application. Do not use to publish anything publicly without explicit approval, do not use for third-party paid hosting platforms, and never claim a systemd service was installed, because the agent account cannot install one.
license: AGPL-3.0-or-later
compatibility: Requires the application's own runtime. systemctl and journalctl exist on this computer but the agent account has no root, so a unit file is written for the owner to install rather than installed here.
allowed-tools: shell process publish_preview publish_site file_read file_write files_list browser_snapshot browser_action
metadata:
  athanor.tier: 'builtin'
  athanor.version: '2.0.0'
  athanor.risk: 'external'
  athanor.domain: 'code'
---

# Deployment

Never deploy something that has not been run. The rollback command is written down before the
switch, not after it fails.

## The two facts about this computer

Both are invisible until they bite, and between them they cause most failed demos here.

**Bind to `0.0.0.0`, never `127.0.0.1`.** The preview proxy cannot reach a loopback-bound socket.
The app is fine, the port is listening, and the link answers with a proxy error.

**Nothing you start survives a restart.** A `shell background=true` process is supervised by the
workspace runtime and ends at whichever comes first: its own `timeoutSeconds`, which is an hour at
most; a `process action=kill`; or the next restart of that runtime — a reboot, an update, an
`athanor restart`. Nothing brings it back, and you cannot arrange for anything to: `sudo` and every
other escalation is refused by the runtime, and `systemctl daemon-reload` run as the agent's own
unprivileged account fails, so a unit file you write is a file and nothing more.

So say which of two things the owner is getting, in words, every time:

- **A demonstration** — the normal case. Start it in the background, publish a preview, and tell
  them plainly that it runs until the computer restarts or the timeout expires, and that asking you
  again brings it straight back.
- **Something that must survive a reboot** — their action, not yours. Write the unit file into the
  workspace with `Restart=on-failure`, a `RestartSec`, an explicit `WorkingDirectory` and an
  `EnvironmentFile` pointing at a root-readable secrets file, then hand them the three commands to
  run as root: `systemctl daemon-reload`, `systemctl enable --now <unit>`, and
  `journalctl -u <unit> -n 100 --no-pager`. Never say the service is installed; say the unit is
  written and waiting for them.

## Proving it runs, before anyone else sees it

Build from a clean state — dependencies installed from the lockfile, then the project's own build
command — and check the output actually contains something. An empty `dist/` from a build that
"succeeded" is common when the entry point moved.

Read the startup logs before touching the port. Most failures announce themselves there and then the
process exits, and a health check against a dead port produces a confusing connection error instead
of the real message.

Then exercise it from `shell`, with `curl`, not from the browser — **the browser reaches the public
internet and nothing else, so a request to this computer's own port is refused**. Check the health
endpoint returns the expected status _and body_: a 200 serving an error page passes a status check.
Walk the primary user path end to end, carrying the session cookie between requests if it needs one.
Read the logs again afterwards; errors often appear only on the first real request.

Check configuration explicitly. Every environment variable the app reads must be present and correct
for the environment being deployed to — a missing one usually surfaces as a runtime 500 on the first
request rather than at startup. Never put a secret in a command line, a log, or a file that gets
published. Confirm any database migration ran and is reversible, or that the owner accepted that it
is not.

Once it is published, the preview URL _is_ a public address, so `browser_action` to navigate there
and `browser_snapshot` to check what the page renders and whether the console is clean.

## Preview, then publish

`publish_preview` gives the owner a private link with an Open button in chat, reachable from their
devices and nobody else's. It keeps working as long as they keep using it, closes on its own after a
month with no visits, and they can revoke it at any time. That is the right answer for everything
they should look at.

`publish_site` makes it publicly reachable and stops for explicit approval every time. Ask with the
specifics: what URL, what is exposed, and who will be able to reach it.

Both publish a **port**, not a running program. The link lives in athanor's database; what it
proxies to is whatever is still listening. That is why the lifetime above has to be said out loud —
it is the single most common way a demo is broken by the time the owner opens it.

For a remote host the owner controls and has given you access to: deploy to a new directory or a new
unit instance, health check it, switch the symlink or the proxy target, and leave the previous
release in place. Rollback is then switching the symlink back — one command, prepared before the
switch.

## Failure modes

- **Bound to localhost.** The single most common preview failure; the app is fine and unreachable.
- **A health check that only checks the status code.** Check the body.
- **The passing check on a crash-looping service.** Check twice, a minute apart.
- **Config drift.** Works here, fails there, because a variable exists in this shell and not in the
  unit's environment. Diff the actual environments.
- **Publishing without asking.** Public exposure is irreversible in the sense that matters: the URL
  has been seen.
- **A link handed over as if it were permanent.** The link outlives the process behind it, so a
  preview the owner opens tomorrow answers with a proxy error unless someone restarted the app.
- **No rollback path.** Write the rollback command in the report _before_ switching.
- **Migrations without a plan.** A schema change the previous release cannot read makes rollback
  impossible; deploy backward-compatible migrations in two steps.
