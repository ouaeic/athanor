# Deployment

## Supported server

The production server supports four distribution families on `amd64` and `arm64`: Debian and
Ubuntu, Fedora/RHEL/Rocky/AlmaLinux, Arch, and openSUSE. The installer detects which it is on and
uses that family's package manager. It installs directly on the host. No Docker Engine, Compose, nested VM, machine image, PRoot guest, Tailscale, VPN, or SSH tunnel
is part of the architecture.

A small installation is comfortable with 4 vCPU, 8–16 GB RAM, and 40 GB free disk. Large builds,
bioinformatics, or several GUI programs benefit from more CPU, RAM, and mounted storage. A GPU is
needed only for the owner’s own compute workflows; model inference stays at the configured AI
provider.

The host needs:

- outbound internet access;
- inbound TCP 80 and 443 for off-site clients;
- SSH only for installation/recovery; and
- a router port-forward if it is behind NAT and must be reached off-site.

## One-command installation

Published release:

```bash
curl -fsSL https://raw.githubusercontent.com/ouaeic/athanor/v0.1.0/install.sh | sudo env ATHANOR_REF=v0.1.0 sh
```

Checked-out source:

```bash
sudo ./install.sh
```

The bootstrap clones or updates `/opt/athanor`; the native installer then:

1. validates the OS, CPU architecture, memory and free disk, and stops before doing any work if the
   host cannot finish;
2. installs apt dependencies, Node.js, pnpm, PostgreSQL, Nginx, Xvfb, Openbox, AT-SPI, LibreOffice,
   FFmpeg, OCR, and document utilities;
3. installs the pieces apt does not carry, each pinned to an exact version: the `typst` typesetting
   binary, checked against a SHA-256 recorded in the installer before it is unpacked; the document
   Python environment, installed with `--require-hashes` against a hash-locked requirement file;
   and Chromium, fetched by the lockfile-pinned Playwright dependency at the browser revision that
   version carries. On a release whose `imagemagick` package is ImageMagick 6 — Debian 12, Ubuntu
   22.04 and 24.04 — it also installs `/usr/local/bin/magick`, a small command dispatching to that
   release's `convert` and `identify`, because athanor names `magick` everywhere and ImageMagick 6
   has no such binary. It stands aside for a real ImageMagick 7, and uninstall removes it;
4. builds the source in place;
5. creates three service accounts — `athanor-control` for the control plane, `athanor` for the
   runner, and `athanor-agent` for the commands the agent runs — then proves the drop to the agent
   account actually takes effect and refuses to finish the install if it does not;
6. creates database, encryption, session, runner, Web Push, TLS identity, and pairing secrets,
   reusing any that already exist so a reinstall does not invalidate paired devices;
7. restricts PostgreSQL to the password in root-owned configuration, then verifies that neither the
   runner nor the agent account can reach the database over the local socket;
8. discovers usable DNS, IPv4, and IPv6 endpoints without asking the user for them;
9. binds internal services to `127.0.0.1` and the HTTPS gateway to 80/443;
10. enables native systemd services and the dynamic-address watcher, and installs the certificate
    renewal and unattended-update units without enabling them;
11. configures dynamic DNS when `ATHANOR_DDNS_TOKEN` was supplied, and otherwise says plainly that a
    server without a hostname cannot be signed into from a browser and how to fix that; and
12. prints a QR ticket and single-use first-owner code.

The apt and browser caches are ordinary dependencies, not an Athanor runtime image. Installed
applications and datasets live once on the host.

### Install from a client

The native client’s sign-in screen can install Athanor on a fresh server without making the owner
retype the shell command. The flow:

1. accepts an address, port, Linux login, and password or private-key path locally;
2. performs SSH key exchange before authentication and shows the server’s SHA-256 host-key
   fingerprint;
3. requires the owner to compare that **server host-key** fingerprint with the value obtained
   through the provider console (for ED25519:
   `sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`), explicitly distinguishing it
   from the fingerprint of the owner’s SSH login key;
4. reconnects and pins that exact SSH identity before sending credentials;
5. runs only the fixed public installer as root or through noninteractive passwordless sudo; and
6. extracts and imports the returned one-time Athanor connection ticket.

Passwords and key passphrases are zeroed from the client request object on completion and are never
stored in the server profile, sent to an Athanor API, placed in a process argument, or passed through
a hosted relay. The PWA cannot make arbitrary TCP/SSH connections and therefore only offers the
copyable install command. This is a deliberate browser security boundary, not a missing permission.

## Pairing and first owner

The connection ticket contains endpoints and a public-key fingerprint; the pairing code expires
after 24 hours and is consumed when the first owner is created. Registration then closes.

```bash
sudo athanor connect
sudo athanor pairing-code
```

`connect` shows the current ticket. If its embedded first-owner code has expired, the root-only
command rotates it and restarts only the API before printing a usable ticket. This also makes a
new-device import work long after an already claimed server was installed; registration itself
remains closed once the owner exists. `pairing-code` always invalidates the previous code and creates
a new 24-hour code explicitly.

Re-running the checked-out installer preserves unowned operator settings already present in
`/etc/athanor/control.env` and `runner.env`, including provider/privacy/connector and runtime limits,
while refreshing only the security-critical managed bindings and generated secrets that must stay
consistent. A stable custom HTTPS hostname is retained; a raw IP origin follows the currently
detected address. The server identity, data key, session key, runner secret, and database password
remain unchanged.

The TLS private key never enters the ticket. The stable identity is the SHA-256 fingerprint of its
public key. Clients must verify that identity before trusting a ticket endpoint or an address learned
later.

## Network and TLS

Nginx is the only public process:

| Port | Binding          | Purpose                                      |
| ---- | ---------------- | -------------------------------------------- |
| 80   | IPv4 and IPv6    | HTTPS redirect and ACME challenge path       |
| 443  | IPv4 and IPv6    | UI, API, WebSockets, previews, connection ID |
| 4100 | `127.0.0.1` only | API                                          |
| 4201 | `127.0.0.1` only | worker health and metrics                    |
| 4202 | `127.0.0.1` only | media service health and metrics             |
| 4203 | `127.0.0.1` only | notification service health and metrics      |
| 4300 | `127.0.0.1` only | authenticated computer runner                |
| 4400 | `127.0.0.1` only | preview gateway                              |
| 5432 | `127.0.0.1` only | PostgreSQL                                   |

The model registry has no listener at all: it refreshes the catalogue on a timer and writes to
PostgreSQL. The loopback rows above are also the exact set a published preview may not target: each
process derives the ports it already has settings for and is told the rest as
`RESERVED_PREVIEW_PORTS`, so “publish my demo on 5432” is refused rather than pointed at the
database.

The installer creates a self-signed certificate from the stable server key covering every current
address, so the server is usable immediately. That certificate is a bootstrap, not the destination:
a browser will not register a service worker on a certificate error, so on self-signed TLS there is
no installable app, no push notification and no share target.

```bash
sudo athanor certificate enable --agree-tos --email you@example.com
```

That command obtains a publicly trusted certificate and enables a renewal timer. It is a separate,
explicit step because requesting one accepts the certificate authority's subscriber agreement, and
athanor will not accept external legal terms on the operator's behalf without being asked.

**A domain is not required for TLS.** Let's Encrypt has issued certificates for bare IP addresses
since January 2026, so a server with no hostname at all is certified for its own IPv4 and IPv6
addresses and browsers trust it. Address certificates are only issued under the `shortlived`
profile, which lasts 160 hours, so the renewal timer runs every six hours and renews inside the
final 72. A server that does have a usable hostname keeps ordinary 90-day certificates and is not
renewed every few days for nothing; `--include-ips` covers both in one certificate.

**A hostname is required for browser sign-in.** This is a different question from TLS and trusted
TLS does not answer it. A passkey is scoped to a WebAuthn Relying Party ID, which must be a
registrable domain name; the specification does not permit an address literal. A server whose origin
is `https://203.0.113.9` therefore has valid TLS, a service worker, an installable app, and Web
Push — and still no way to register or use a passkey in a browser. Its owner can sign in from the
native clients only. See **Getting a hostname** below.

Renewal also reissues when the served certificate is missing a configured name, not only when it is
close to expiry. Acquiring a hostname after issuance is the normal case, and no expiry check would
ever notice it. `sudo athanor certificate status` prints which configured names the served
certificate covers. IPv6 address SANs are excluded from that comparison because OpenSSL prints them
fully expanded, and comparing that against the compact form would report a permanent mismatch and
reissue on every timer firing.

The certificate always carries the server's existing identity key, so the fingerprint that native
clients pinned at first pairing is unchanged by issuance or renewal. Trusted TLS and pinned identity
are not alternatives here — the same key satisfies both.

The ACME client is lego, installed on demand as a single static binary at a pinned version and
verified against a checksum recorded in `scripts/athanor-certificate`. It is used rather than
certbot because certbot refuses an address identifier when the request supplies its own key, which
is exactly what preserving the pinned identity requires.

## Getting a hostname

The installer prints this when it finds no usable hostname, and `sudo athanor doctor` repeats it as
a warning for as long as it is true. Warnings do not fail `doctor`: an address-only server works,
it just cannot be signed into from a browser.

```bash
sudo athanor ddns configure
```

With no arguments on a terminal that asks which provider to use — DuckDNS (`NAME.duckdns.org`),
deSEC (`NAME.dedyn.io`), or Cloudflare for a domain already on Cloudflare DNS — then for the
hostname, then for the provider token with the input hidden. It then:

1. publishes this computer's current address under that name;
2. waits up to a minute for the name to resolve;
3. runs `athanor set-hostname`, which moves `PUBLIC_APP_URL`, `PREVIEW_BASE_URL`,
   `PUBLIC_RUNNER_URL`, `WEBAUTHN_ORIGIN`, and `WEBAUTHN_RP_ID` onto the name;
4. reissues the certificate for the new name when automatic issuance is already on; and
5. refreshes the connection manifest and restarts the services.

Step 3 is what makes browser sign-in work. Publishing DNS alone does not: `--keep-origin` stops
after step 1 for a server that sits behind a separate reverse proxy, and `ddns status` and `doctor`
both point out that the published name is not the origin.

Unattended installs pass `ATHANOR_DDNS_PROVIDER`, `ATHANOR_DDNS_HOSTNAME`, optionally
`ATHANOR_DDNS_ZONE_ID`, and `ATHANOR_DDNS_TOKEN` to the installer, which runs the same path without
prompting. The token stays in the environment and is never placed in a command argument.

Passkeys already registered against the old address origin do not carry over, because they were
scoped to it. Native-client passkeys are unaffected, and the pinned server identity does not change.

Operational detail, including the per-provider address handling and the credential rules, is in
[OPERATIONS.md](OPERATIONS.md#dynamic-dns).

## Dynamic addresses

`athanor-network-watch.service` listens to Linux netlink events from the kernel. It refreshes
immediately after a route, link, or interface-address change, without polling an IP service. A
low-frequency `athanor-network-refresh.timer` runs every six hours (with jitter) only to reconcile a
missed event or manual file change. The refresh operation:

1. keeps the existing private identity key;
2. regenerates the address SAN list;
3. reloads Nginx only when the network set actually changed;
4. refreshes `/var/lib/athanor/connection.json`; and
5. leaves user data, sessions, provider credentials, and the pairing identity unchanged.

The same non-secret manifest is available at `/.well-known/athanor`. Avahi advertises
`_athanor._tcp.local` with the pinned identity and follows LAN address changes.

The native client stores the identity and the non-secret endpoint set, but never persists the
first-owner code. On each cold connection it races the saved endpoints, verifies the TLS public key,
and replaces stale addresses with the signed-in server's current manifest. If they all fail, it
browses mDNS for the expected identity on the current LAN and still requires the pinned TLS proof
before accepting the discovered address. Safe/idempotent HTTP requests receive one transparent
reconnect attempt; uploads, command streams, and other non-replayable requests are never duplicated.
After total reconnect failure, the client asks once whether the public address may be dynamic. “My
address is fixed” is stored locally and suppresses that suggestion permanently. The dynamic choice
shows concise hostname/DDNS instructions and how to issue a fresh QR ticket.

Discovery behavior:

| Situation                                      | Result                                                        |
| ---------------------------------------------- | ------------------------------------------------------------- |
| LAN address changes                            | Client rediscovers through mDNS and verifies the pinned key   |
| Public IP changes; provider hostname follows   | Client resolves the same hostname and verifies the pinned key |
| Public IP changes; user has dynamic DNS        | Same as above                                                 |
| Client stayed connected while routes changed   | It learns the refreshed manifest before reconnecting          |
| Offline client, unknown new public IP, no name | Cannot be discovered globally without a directory/relay/DNS   |

The final row is a property of internet routing, not an Athanor limitation that can be hidden with
code. A remote client needs at least one stable discovery signal. Athanor deliberately does not add a
central directory, VPN, or relay by default because those would change the account-free privacy
boundary and disclose connection metadata. The UI explains this plainly instead of pretending that
“broadcasting to the internet” exists.

A relay is available for the one case the direct paths cannot cover — a server behind carrier-grade
NAT, where no inbound connection can arrive at all. It ships off, there is no default and no
Athanor-operated relay, and turning it on takes a hostname and a single-use enrollment token from
the operator of a relay the owner chose. TLS terminates on the server, so a relay operator sees
connection metadata and byte counts and no traffic. [relay.md](relay.md) opens by saying that most
owners do not need one, and recommends running your own over using someone else's.

A hosted locator is deliberately not part of Athanor. Even a content-blind directory would expose
connection metadata, create an operator and availability dependency, and contradict the
account-free deployment boundary. Owners who need off-site recovery after an unknown public-IP
change should use a provider hostname or a dynamic-DNS service they choose; the client still pins
the Athanor server key, so DNS cannot silently substitute another server.

If a server has no useful hostname, Athanor uses its raw IPv4/IPv6 addresses and never invents a
domain for it. It does say plainly, at install and in `doctor`, that browser sign-in is unavailable
until the server has a name, and offers `sudo athanor ddns configure` as the shortest way to get
one; the choice of provider and whether to have a name at all stays with the operator. LAN changes
remain automatic. If an address-only server's public address changes while every client is offline
and away from the LAN, run `sudo athanor connect` through the operator's existing recovery access
and paste the refreshed ticket. Pairing the new route cannot change the already pinned server
identity.

## AI access

### Provider API

Save an OpenRouter or compatible key in **Settings → AI**. It is encrypted before PostgreSQL storage
and is never returned. `AI_REQUIRE_ZDR=true` asks eligible routes to deny content retention; it is a
provider routing/contract property, not proof of zero billing, abuse, or network metadata.

### Codex, Claude Code, and OpenCode

Install the official CLI from **Settings → AI**, then use the visible terminal:

```bash
codex login
# or
claude
# or
opencode auth login
```

The owner completes the publisher’s device/browser flow. Athanor does not ask for the account
password. Publisher credentials live in `/home/athanor` and are therefore included in a full backup.
OpenCode supports the publisher logins described in its own documentation; Claude Pro/Max remains on
the official Claude Code integration rather than an unofficial OpenCode auth plugin.

## Installing software

Commands the agent runs execute as `athanor-agent`, an unprivileged account separate from the
`athanor` account the runner itself uses, so a command cannot read the runner's process, its
capability signing secret, or the browser profile the owner's logins live in. The two share a group,
which is how the runner still reads back what a command wrote. A fixed root helper permits only
approved `apt-get update` and package-name-only `apt-get install` requests. Review and Balanced modes
pause for approval. The runner rejects arbitrary privilege escalation and shell/package-manager
injection.

Programs installed this way are real host packages and survive Athanor restarts. GUI programs run in
the private Xvfb/Openbox session; the user opens the computer panel only when useful.

## Storage

`/home/athanor` is the persistent computer. Mount large block, network, or object-backed filesystems
using ordinary Linux administration and grant only the required paths to the `athanor` account and
the `athanor-agent` group it shares with the commands the agent runs. Athanor imposes no storage
tier and does not copy a second guest filesystem.

Recovery points normally preserve the greater of 2 GB or 2% of the filesystem (capped at 20 GB) as
free staging headroom. A trusted administrator of a deliberately small host may set
`ATHANOR_SNAPSHOT_RESERVE_BYTES` in `/etc/athanor/runner.env` to a whole number from 67,108,864 bytes
(64 MiB) through 1,099,511,627,776 bytes (1 TiB), then run
`sudo systemctl restart athanor-runner`. The create and restore paths enforce the same setting; an
invalid or dangerously low value fails closed.

## Failure rules

- Provider unavailable: tasks wait or fail; Athanor never falls back to a local model.
- Runner unavailable: history stays readable; computer actions fail closed.
- Browser/GUI unavailable: terminal and file tools remain available, but visual completion is not
  claimed.
- Public address changed without any discovery signal: local mDNS still works; off-site users need a
  stable hostname or the new address.
- Lost encryption key: encrypted database content cannot be recovered.
- Lost only passkey/device: use another paired device or the recovery process; there is no password
  backdoor.
