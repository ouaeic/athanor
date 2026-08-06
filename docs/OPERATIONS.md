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
document toolchain, and disk headroom.

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

Monitor host disk/RAM, systemd restarts, PostgreSQL health, backup age, and failed scheduled tasks.
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

## Backup

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
packages from the host's configured APT repositories. Encrypt backups and copy them off-host.

## Restore

```bash
sudo athanor restore /path/to/backup --yes
```

Restore accepts only the fixed backup filenames, verifies strict checksums and archive paths,
reinstalls the recorded approved packages, replaces the current database, home, and identity
configuration, fixes ownership, restarts services, and waits for API health. It is destructive by
design: make a separate backup first and test fresh-host restore before relying on it.

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
the upstream revision, or when a task is still running after waiting up to 30 minutes for the worker
to go idle; the next weekly window retries. A worker that cannot be reached counts as idle.

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
  `journalctl -u athanor@notifications`.
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
