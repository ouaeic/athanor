# Operations

The `athanor` command is the supported operator surface.

## Routine

```bash
sudo athanor doctor
sudo athanor status
sudo athanor logs
```

`doctor` checks root-only configuration, service state (including push delivery), API and PostgreSQL
health, Nginx syntax, loopback-only private ports, served-certificate expiry, dynamic-DNS state,
whether browser sign-in is possible at all, outbound agent connectivity, managed Chromium, the
document toolchain, backup age, whether the newest backup exists anywhere but on this disk, and disk
headroom.

Lines are prefixed `ok`, `note`, `warn`, or `fail`. Only `fail` makes the command exit non-zero.

Dynamic DNS reports one of three things: `note dynamic DNS is not configured`; `ok dynamic DNS:
NAME published through PROVIDER`; or `fail dynamic DNS has not published for two days` when the
recorded publish is older than twice the 24-hour re-publish interval. When the last publish
attempt failed, the recorded reason is repeated as a `note`.

Browser sign-in is checked from `WEBAUTHN_RP_ID`. A WebAuthn Relying Party ID must be a registrable
domain name and the specification does not allow an address literal, so a server whose origin is a
bare IPv4 or IPv6 address gets two `warn` lines: that browser sign-in cannot work, and the shortest
way to fix it (`sudo athanor ddns configure`, or `sudo athanor set-hostname NAME` when dynamic DNS
already publishes a name that is not yet the origin). This is a warning rather than a failure
because such a server is fully usable from the native clients; only the browser and the installable
app are out of reach.

The document toolchain is checked by name — the pinned Python environment and its modules, `typst`,
`soffice`, `qpdf`, `ocrmypdf`, the poppler tools, `magick`, `dot`, `ffmpeg`, and the metric-compatible
fonts — because the skill library prescribes each of them, so a gap here is a job that fails in front
of the owner instead of here. On a release that packages ImageMagick 6 the installer supplies
`magick` itself; see [Deployment](DEPLOYMENT.md#one-command-installation).

The relay gets a line of its own. `note relay: off, and that is fine` is the shipped state and the
right one for most servers, which are reached directly; it is a note rather than a warning because
nothing is missing. When the relay is on, `doctor` reports the address, the connection state, the
bytes used against the operator's allowance, and a `fail` if the operator revoked this server.
`sudo athanor relay {status|on|off}` is the operator surface; enrolling needs a hostname and a
single-use token and happens in Settings, because only the running server can redeem one. See
[relay.md](relay.md).

`doctor` also reports whether unattended updates are on; that line is informational and never fails
the run.

Monitor host disk/RAM, systemd restarts, PostgreSQL health, and failed scheduled tasks; `doctor`
reports backup age itself, and says `copied locally, not yet off-host` when a configured second copy
did not get written.
Do not put prompt or file bodies into observability.

## Install preflight

The installer refuses to start on a host with less than about 2 GB of RAM, less than 15 GiB free on
the checkout, `/var`, or `/home`, or an architecture other than amd64/arm64. It warns, without
stopping, about a small-memory host with no swap and about less than 25 GiB free.

After the services start it opens inbound 80/443 in ufw or firewalld when either is active, warns
when a hand-written nftables or iptables ruleset drops input by default, warns when nothing listens
on 80 or 443, warns when this computer has only private addresses, and warns when it has no
hostname, because browser sign-in cannot work without one. Warnings are repeated with
the connection ticket, and the closing banner says "installed, but these need attention first"
instead of "ready". None of these checks can prove that a request from the internet arrives; that
cannot be tested from the host itself.

## Services

`athanor-runner.service` runs the agent computer as the `athanor` user, and the commands that agent
asks for run as `athanor-agent`, a third account with less privilege than the runner's own. The
install refuses to finish if that drop does not take effect, because a box that believes it confines
agent commands and does not is worse than one that never claimed to. `athanor@api`, `@worker`,
`@registry`, and `@notifications` run the private services as `athanor-control`, all bound to
loopback and reached through Nginx. `athanor@notifications` delivers Web Push; its VAPID key pair
is generated once at install into `/etc/athanor/control.env` and reused on every later run, because
regenerating it would invalidate every browser subscription. Its health port is 4203, fixed in code
rather than configurable, and `doctor` fails if that port is missing or reachable from anywhere but
loopback.

## Network refresh

```bash
systemctl status athanor-network-refresh.timer
sudo /usr/local/lib/athanor/athanor-network-refresh
curl -k https://127.0.0.1/.well-known/athanor
```

The timer refreshes endpoint metadata and certificate SANs when addresses change while retaining the
same private identity key. It never rewrites a hostname and never contacts a relay: it reads
`/etc/athanor/relay/settings.json` and, only while the relay is switched on, appends the relay
address to the endpoint list after every direct one. `athanor-network-refresh.path` watches that
file, so switching the relay off drops the address immediately rather than at the next timer
firing. It rebuilds the
self-signed certificate in its final month, and it leaves a certificate issued by a public
certificate authority alone: when names or addresses change it prints a line saying the renewal
timer will reissue, rather than replacing a trusted certificate with a self-signed one.

## Dynamic DNS

A hostname is not cosmetic. A WebAuthn Relying Party ID must be a registrable domain name, so a
server reached only by an IP address cannot register or use a passkey in a browser however good its
TLS is. Dynamic DNS is how a server without a domain gets one.

```bash
sudo athanor ddns configure
sudo athanor ddns configure --provider duckdns --hostname my-athanor.duckdns.org
sudo athanor ddns status
sudo athanor ddns test
sudo athanor ddns disable
```

With no arguments on a terminal, `configure` asks which provider to use, then for the hostname, then
for the token with the input hidden. With `--provider`/`--hostname` it is non-interactive and reads
the token from standard input. Automation may instead set `ATHANOR_DDNS_PROVIDER`,
`ATHANOR_DDNS_HOSTNAME`, `ATHANOR_DDNS_ZONE_ID`, and `ATHANOR_DDNS_TOKEN`; the installer passes the
same variables straight through.

| Provider   | Name you get       | Notes                                                           |
| ---------- | ------------------ | --------------------------------------------------------------- |
| DuckDNS    | `NAME.duckdns.org` | Works behind NAT; the update learns the router's public address |
| deSEC      | `NAME.dedyn.io`    | Works behind NAT the same way; non-profit, no account fee       |
| Cloudflare | a domain you own   | Needs a public address on the host itself, plus an API token    |

The Cloudflare token needs `Zone:DNS:Edit` on the zone. `--zone-id` is optional: with `Zone:Read`
as well, the zone is looked up by matching the longest zone name that is a suffix of the hostname,
and the result is cached in `DDNS_ZONE_ID`. Records are written with a 60-second TTL and
`proxied: false`, because a proxied record would terminate TLS at Cloudflare and break the pinned
server identity. A record is only rewritten when its name matches exactly, so an unrelated record of
the same type in the same zone is never overwritten.

Credentials never reach an argument list or a log. The token is read from the terminal, a pipe, or
the environment; it is stored in `/etc/athanor/control.env` at mode 0600; it is written there through
awk's environment rather than `awk -v`, because a process argument list is world-readable through
`/proc`; it is passed to the provider through a curl configuration on standard input; and curl's own
diagnostics are filtered so a DuckDNS URL cannot print its token into the journal.

`configure` publishes immediately, waits up to a minute for the name to resolve, and then makes it
the public origin by running `athanor set-hostname` — which is the step that moves `PUBLIC_APP_URL`,
`PREVIEW_BASE_URL`, `PUBLIC_RUNNER_URL`, `WEBAUTHN_ORIGIN`, and `WEBAUTHN_RP_ID` onto the name and
therefore the step that turns browser sign-in on. Pass `--keep-origin` to publish the record and leave the origin alone, which is what a
server behind a separate reverse proxy wants.

Once a provider is configured, the network refresh publishes on every netlink address event and on
its 6-hour timer. An unchanged address is re-sent once a day, so an account that lost the record
recovers by itself. A host behind NAT re-asserts every 30 minutes instead: the address it publishes
is the one the provider read from the request, so a change to it produces no local netlink event and
nothing here would otherwise notice for up to a day. Thirty minutes is still far below what any of
these providers ask for, and the state file keeps a busy netlink host from publishing per event.

The configured hostname is carried into the connection manifest endpoints and the certificate SANs.
A provider that cannot be reached is reported on stderr, recorded in `/var/lib/athanor/ddns.error`
for `ddns status` and `doctor` to show, and does not stop the endpoint and certificate refresh.

Address handling follows what each provider actually does:

- A host with a public address of its own publishes exactly that address.
- A host behind NAT has no public IPv4 to publish, so the request is forced over IPv4 with no
  address parameter and the provider records the connection address, which is the router's.
- DuckDNS stops detecting the caller's IPv4 as soon as an `ipv6` parameter is present, so a host
  that is behind NAT for IPv4 but holds a public IPv6 is published in two requests, one per family.
- deSEC deletes the record of any family it is given neither a parameter nor a matching connection
  address for, so `myipv6=preserve` is sent when this host has no public IPv6, and `myipv4=preserve`
  when it turns out to have no IPv4 path at all.
- Cloudflare has no address detection, so a host behind NAT is told plainly to use DuckDNS or deSEC
  instead of failing obscurely.
- Temporary (RFC 4941) IPv6 addresses are never published: they are deprecated within a day.

`ddns test` forces a publish, prints what the provider echoed back, resolves the hostname, and says
whether the answer already includes this computer's address or is still cached.

## Price ceiling

```bash
sudo athanor price-ceiling show
sudo athanor price-ceiling set 2 10
sudo athanor price-ceiling set none 10
sudo athanor price-ceiling clear
```

`spend-ceiling` was the old name for this and still answers, printing the new one. It is not the
same command as `spend-cap`, which is the money cap the old name sounded like.

The pre-flight half of the spending brake, and the half that works while nobody is watching. The
daily, monthly and per-task caps in Settings watch what a task has already spent and halt it once it
is over; this refuses to _pick_ a model priced above the rates named here in the first place. Both
rates are dollars per million tokens — `set 2 10` means at most $2 per million in and $10 per million
out — and either may be the word `none`.

Every place athanor selects a model for the owner ranks against it: the lead when a task is created,
the vision specialist, the model the picker recommends, and the support picker behind titling and the
subscription flows. When the ceiling leaves nothing eligible, selection is refused with the cheapest
route that could have done the work and what it costs, rather than quietly substituting something
weaker or reporting the model as unavailable. A model the owner names explicitly is never
constrained: the ceiling governs what athanor chooses for them, not what they choose for themselves.

`show` prints the ceiling currently stored. Changes take effect on the next selection; a task
already running keeps the model it was given. On a server whose database predates the column, both
`show` and `set` say so and change nothing rather than validating a number and storing it nowhere —
a control wearing a brake's name while wired to nothing is the exact failure this command exists not
to be.

## Backup

A daily backup is enabled by the installer and needs no attention:

```bash
sudo athanor backup auto status
sudo athanor backup auto off
```

It runs at a randomised hour and waits a few minutes for the worker to go idle before starting,
because the archive stops the services for its duration. A run that finds work in progress stands
down and leaves the next window to take the copy. `doctor` reports the age of the newest one.

To take one immediately, or to write it somewhere specific:

```bash
sudo athanor backup
sudo athanor backup /mnt/encrypted-backups/athanor-2026-07-30
```

Mutating Athanor services pause under a restart trap. A backup contains:

- `database.dump`;
- `workspaces.tar.gz` for `/home/athanor`;
- `configuration.tar.gz` for `/etc/athanor`;
- `packages.txt` for additional operating-system packages installed through Athanor; and
- `SHA256SUMS`.

The configuration archive contains the keys required to decrypt the database; the workspace archive
contains files, browser state, installed user-scoped tooling, and publisher logins. Package binaries
are not duplicated into the archive: a clean restore validates `packages.txt` and reinstalls those
packages from the host's own configured repositories.

### An off-host copy

Everything above lands in `/var/backups/athanor`, on the same disk as the data it is a copy of. That
survives a mistake and it does not survive the disk, which is the commonest way a one-box server is
lost outright. Name a second place, on a disk this one failing does not take:

```bash
sudo athanor backup destination /mnt/backup-disk --recipient /root/backup-key.pub
sudo athanor backup destination show
sudo athanor backup destination off
```

Every backup is then encrypted to that recipient with `gpg` and copied there, after the services are
back, so the copy costs no downtime. A copy that fails does not fail the backup: the verified local
copy is complete either way, and `sudo athanor doctor` says which of the two happened rather than
reporting a green backup that exists in exactly one place.

The recipient is not optional. `configuration.tar.gz` carries this server's data key and session
signing key, so a copy of a backup is a copy of everything the product protects; the reason that is
tolerable in `/var/backups` is that the disk it sits on already holds those keys, and a copy that
leaves the machine has no such excuse. **Keep the private half of that key somewhere this computer is
not.** Without it nobody can open the off-host copies, including you.

The destination is a path this computer can already write to: a removable disk, a NAS mount, anything
mounted. It does not speak ssh, rsync, S3 or any provider's API, and that is a decision rather than a
gap - a credential on this box that can write to the destination can also delete what is already
there, so a server that is broken into loses every copy at once. If that trade is wrong for you,
`sudo athanor backup /path` has always written a copy wherever you say, and `cron` and `rsync` are
yours to point at it.

A destination on the same filesystem as `/var/backups/athanor` is refused when it is configured,
rather than discovered to have been pointless after a disk failure.

## Restore

```bash
sudo athanor restore /path/to/backup --yes
```

Restore accepts only the fixed backup filenames, verifies strict checksums and archive paths,
reinstalls the recorded approved packages, replaces the current database, home, and identity
configuration, fixes ownership, restarts services, waits for API health, and refreshes the connection
manifest and certificate names. It is destructive by design: make a separate backup first.

To restore an off-host copy, decrypt it first with the private half of the key it was encrypted to,
then restore the decrypted directory:

```bash
cd /mnt/backup-disk/20260901T030000Z
for encrypted in *.gpg; do gpg --decrypt --output "${encrypted%.gpg}" "$encrypted"; done
sudo athanor restore . --yes
```

`SHA256SUMS.encrypted` beside them lists the checksums of the encrypted files, so you can confirm the
copy arrived whole without holding the key. `SHA256SUMS`, decrypted with the rest, is what the
restore itself verifies.

## Moving to a new computer

The backup carries `/etc/athanor` verbatim, which is what has to happen: the data key, the session
signing key and the pinned server identity all come back exactly, or the restored server cannot open
its own database and no paired client trusts it. `PUBLIC_APP_URL`, `WEBAUTHN_ORIGIN` and
`WEBAUTHN_RP_ID` come back with them - and on a different computer those three name the old one. Tell
the restore that the computer has changed:

```bash
sudo athanor restore /path/to/backup --yes --new-host
```

Without a name of its own, that re-derives the origin from the address the new machine actually has,
refreshes the connection manifest and the certificate's addresses, and restarts. If the domain
followed the machine - the record already points at the new box - the name is kept rather than
replaced by an address, because replacing it would throw away every browser passkey bound to it.

With a name that does not point here yet, or a new one:

```bash
sudo athanor restore /path/to/backup --yes --hostname ai.example.com
```

The whole move, on a machine that has just been built:

1. Run the one-command installer on the new machine - the exact line is in `docs/DEPLOYMENT.md`
   under "One-command installation" - so it has PostgreSQL, Nginx, the units and the checkout.
   Passing `ATHANOR_HOSTNAME` here is wasted: step 3 replaces the whole of `/etc/athanor` with the
   backup's copy, so the name has to be set after the restore rather than before it.
2. Copy the backup directory onto it, decrypting it first if it came from an off-host copy.
3. `sudo athanor restore /path/to/backup --yes --new-host` - add `--hostname NAME` if this machine
   should answer to a domain.
4. `sudo athanor connect` for a ticket and QR carrying the new addresses. Paired clients hold the old
   ones; the server identity survived in the backup, so they still trust this server and their
   passkeys still work.
5. A passkey made in a browser is bound to the origin it was made on. If the origin changed, add
   those again from a client that still signs in.
6. `sudo athanor doctor`.

Nothing in step 3 is fatal after the data is back: a name that does not resolve yet from a machine
plugged in ten minutes ago prints what to run and leaves the restored server serving.

## Update

```bash
sudo athanor update
```

Update refuses a dirty managed checkout, pauses mutating services, makes a checksum backup,
fast-forwards the Git checkout, installs the locked dependencies, builds source, updates native
helpers/systemd/Nginx definitions, refreshes network metadata, and waits for health. If any step
fails, it resets the managed checkout to the previous revision, reinstalls that runtime, and restores
the pre-update backup before returning a failure. Keep the backup until login, history, files,
browser, GUI, and one model call pass.

Re-running the one-command installer against an existing checkout is also merge-safe: optional
operator/provider/privacy settings in `/etc/athanor` are retained, generated identity and encryption
secrets are reused, and a configured stable hostname is not replaced by address discovery.

## Unattended updates

```bash
sudo athanor auto-update status
sudo athanor auto-update on
sudo athanor auto-update off
```

Off by default. `on` enables `athanor-auto-update.timer`, which runs weekly at a randomised time and
catches up after downtime. Each run is the same transactional `athanor update` described above,
including the backup and the automatic rollback.

The run stops early and changes nothing when the timer is disabled, when the checkout is already at
the upstream revision, when a task is still running after waiting up to 30 minutes for the worker
to go idle, or when the runner reports unfinished background commands; the next weekly window
retries. A worker that cannot be reached counts as idle.

### What an update stops, and what comes back

An update stops the whole server for the backup and the rebuild, which stops the workspace runner,
which stops every command it is holding. Three different things happen to them:

- A **declared service** comes back. Its record lives in the workspace's `.athanor/services.json`,
  and the runner relaunches it as it comes up.
- A **foreground command** belongs to a task, and a task in flight already holds the update off.
- An **ordinary background command** - what an agent starts for a long analysis - does not come
  back and is not written down anywhere. It is killed, and the agent that polls its session id
  afterwards is told the process was not found.

That last case is why an unattended run now stands down for background work. The idle gate above
counts tasks, and a background command deliberately outlives the task that started it, so before
this a twenty-hour job could be killed at three in the morning by a timer with nothing to say for
itself. `athanor update` by hand refuses for the same reason and names what is running; set
`ATHANOR_UPDATE_OVER_BACKGROUND_WORK=1` to update anyway.

A runner from before this existed does not report the count. The update then says it could not tell
and goes ahead, rather than treating silence as an all-clear or refusing to update for ever.

**Nothing resumes a background command across a restart.** A job that must survive one has to write
its own progress to a file in the workspace and be startable from where it left off; the computer
cannot do that for it.

The unit files are installed on every install and update but are never enabled by them, so the
choice survives updates.

## Uninstall

```bash
sudo athanor uninstall
```

Uninstall disables Athanor services, the network watcher, the unattended-update timer, the
certificate renewal timer, and its Nginx site, and removes the `/etc/sudoers.d/athanor-packages` rule that let the agent account install
system packages as root, the Avahi advertisement at `/etc/avahi/services/athanor.service`, and the
`magick` compatibility command if the installer had to supply one. It preserves `/home/athanor`, `/etc/athanor`, PostgreSQL data,
and backups. Removal of preserved data is a separate, explicit operator action.

## Schedules that stop running

Two bounds make a schedule go quiet on purpose. Both write a code the schedule row carries, so read
`lastErrorCode` before assuming anything is broken.

- **`previous_run_active`.** The occurrence was skipped because the schedule's own previous run had
  not finished. A schedule does not run beside itself: before this policy, an interval watcher
  slower than its own interval started a second copy, then a third, each holding a compute
  reservation and each spending the provider account on the same instruction, with the row reading
  healthy throughout. The skip retries five minutes later - the same defer delay `workspace_starting`
  uses - and is not a failure. It is not fifteen seconds: the scheduler polls every
  `SCHEDULER_POLL_MS`, which defaults to fifteen seconds, but a deferred schedule sets its own next
  occurrence five minutes out, so a schedule carrying this code is waiting rather than stuck. It
  becomes a failure only when the blocking run has been untouched for more than a day, at which
  point the schedule is paused and an owner-visible notice is written on the conversation that is
  blocking it. Finish or cancel that conversation and turn the schedule back on.
- **Run now is refused rather than skipped.** The rule above is for a clock. An owner pressing Run
  on a schedule whose previous run is still open is answered `409 previous_run_active` at the button,
  naming the run that is in the way - not deferred, and not recorded as a failure on the row. The
  owner is not exempted from the overlap policy, because an exemption is the same duplicate spend
  the policy exists to prevent and the button gives no way to see that a run is already open. To
  start a second run deliberately, end the first - open it and let it finish, or cancel it - and
  press Run again. Pause and resume are not affected: pausing a schedule whose run is open is
  exactly what an owner does about it.
- **`model_unavailable`.** Three consecutive runs could not start because the model the schedule
  names is no longer available. Choose another model - a schedule keeps the model it was created
  with, so this means a new schedule - and turn it back on.

## Inbound triggers

A schedule may carry a webhook, which is the only way something other than the owner or a clock
starts a turn on this box. `docs/HEADLESS.md` has the request shape. Operationally:

- The URL is `POST /v1/hooks/<43-character segment>` and it is unauthenticated in the sense that it
  carries no session and no bearer token. What authorises it is an HMAC-SHA256 signature over its
  own timestamp and body, keyed with a per-schedule secret this box generated and keeps only sealed
  under the workspace key. A request without a valid signature inside a five-minute window is
  refused before anything is written.
- **There is no way to recover a lost signing secret.** It is served once, in the reply that created
  the schedule. Revoking one and rotating one are the same operation: delete the schedule and make
  another.
- Deliveries are rate-bounded twice. `minGapMinutes` - fifteen by default, the same floor
  `interval` uses - bounds how often a trigger may start a run, and a burst inside one gap produces
  one run that reads all of it. Sixty deliveries an hour and sixteen unread deliveries are the
  bounds on rows and workspace files; past either, the sender is answered `429`.
- Payloads land in `workspace/downloads/inbound/<scheduleId>/`, which is inside the download
  quarantine, so an agent reading one is treated as having read untrusted content. **Nothing prunes
  that directory.** A busy trigger grows the workspace over time; it is ordinary workspace storage
  and is deleted like any other file.
- `journalctl -u athanor@api | grep schedule.trigger_delivery` reports every delivery and its
  outcome - `accepted`, `duplicate`, `rate_limited`, `too_many_pending` or `not_armed`. It records
  no payload and no signature. The size of the backlog is not in the journal; it is in the `429`
  the sender is answered with, which says how many deliveries are unread and how many bytes they
  come to.
- A trigger run's payload files are written into the workspace before the run is queued, and a
  restart in between is finished by the maintenance sweep - which writes exactly the deliveries that
  run's instruction already named, not whatever has arrived since. Grep the journal for
  `schedule.dispatch_recovered` to see that sweep doing it. Deliveries that arrived while the box was
  down are untouched and stay pending for the next occurrence.

## Incident priorities

1. Stop access with the firewall or `sudo athanor stop`.
2. Preserve existing logs without enabling content collection.
3. Snapshot affected storage only when policy permits.
4. Rotate model, connector, session, publisher, runner, and host credentials according to scope.
5. Restore onto a clean host when compromise is plausible.
6. State what was exposed and what remains uncertain.

## Common failures

- **API unavailable:** inspect `journalctl -u athanor@api` and PostgreSQL.
- **Runner unavailable:** inspect `athanor-runner`; history should remain readable.
- **GUI unavailable:** verify Xvfb, Openbox, D-Bus, AT-SPI, and screenshot paths.
- **Codex/Claude unauthenticated:** use Terminal and the publisher status/login command.
- **Provider setup required:** save a key/model in Settings.
- **Preview unavailable:** verify the user process, loopback port, preview state, and path base.
- **Passkey origin mismatch:** restore the original public origin; do not repeatedly rewrite it.
- **Push notifications missing:** run `sudo athanor doctor`, which distinguishes a service that is
  not answering from one that is running with no Web Push signing keys. A missing key pair does not
  stop the unit — it disables delivery and says so, because a crash-looping unit hides its own
  reason. Confirm the `PUSH_VAPID_*` values in `/etc/athanor/control.env` and inspect
  `journalctl -u athanor@notifications`. This covers browsers and installed web apps only: the
  packaged desktop and mobile clients hold no push subscription and raise notices through the
  operating system themselves, so a phone that is quiet while a browser is not is a client-side
  permission rather than a server fault.
- **A quiet iPhone:** check the phone before checking the box. Safari on iOS has no `PushManager`
  in an ordinary tab, so there is nothing to subscribe and nothing the server can send to. The
  repair is on the phone and takes one gesture: Share, then Add to Home Screen, then open athanor
  from there. Settings says so on an iPhone rather than reporting the browser as incapable. Below
  iOS 16.4 there is no Web Push even on the Home Screen, and there is no repair on that phone: the
  packaged client holds no push subscription either and raises its notices from a poll inside the
  page, which a suspended app does not run.
- **Nothing reached the owner at all:** Web Push is the only transport this box has. Every
  notification candidate is selected through a registered push subscription, so an owner with no
  subscribed device is offered nothing, of any kind, however much is waiting for them. Three
  ordinary situations produce that owner: an iPhone that was never added to the Home Screen, a
  browser that refused a self-signed certificate and therefore runs no service worker, and a device
  whose endpoint refused every notification for a day and was retired by the notifier, which
  deletes the subscription. All three leave the standing record intact: what the agent raised is in
  Settings and in each conversation, and `journalctl -u athanor@notifications` records a retirement
  when one happens. None of them is reported to the owner by any channel that does not need the
  device that has stopped working, and neither is a box that is down, because the notifier that
  would say so is on it. A second transport is an open item, not a hidden claim.
- **Changed address:** inspect `/.well-known/athanor`, timer state, mDNS, provider DNS, and firewall.
- **Dynamic DNS stale:** run `sudo athanor ddns status`, which prints the last recorded provider
  error, then `sudo athanor ddns test` to force a publish and see the provider's answer.
- **Browser sign-in impossible:** `doctor` warns when the origin is an IP address. Run
  `sudo athanor ddns configure`, or `sudo athanor set-hostname NAME` when a name is already
  published. Native clients are unaffected either way.
- **Certificate missing a new name:** `sudo athanor certificate status` prints
  `Configured names:` and names anything the served certificate does not cover. The renewal timer
  reissues within six hours; `sudo athanor certificate issue` does it now.
- **Low disk:** stop long jobs, back up, expand/mount storage, and restart.
