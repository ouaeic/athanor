# athanor

**One private AI computer, available from every device.**

athanor is free, open-source software that turns a Linux computer into a persistent AI
agent. The user works in a polished chat interface; the agent can use the machine’s files, terminal,
browser, installed GUI applications, long-running processes, and hosted previews. The computer view
stays out of the way until the user or agent needs it.

athanor has no hosted account, paid tier, VPS marketplace, telemetry service, model server, or local
inference fallback. Model access belongs to the owner: use OpenRouter, Ollama Cloud, another
OpenAI-compatible endpoint, Codex with a ChatGPT subscription, Claude Code with a Claude
subscription, or OpenCode with a publisher login it officially supports.

## Install

On a fresh Debian, Ubuntu, Fedora, RHEL, Rocky, AlmaLinux, Arch or openSUSE computer:

```bash
curl -fsSL https://raw.githubusercontent.com/ouaeic/athanor/v0.1.1/install.sh | sudo env ATHANOR_REF=v0.1.1 sh
```

The command is pinned to a tag rather than a branch. The install action in the native client goes
further: it passes the exact commit its own build was made from, and the installer refuses to
continue if the source it checked out is not that commit.

From a checked-out source tree:

```bash
sudo ./install.sh
```

The installer refuses to start unless the host has enough RAM, disk, and a supported architecture,
so a machine that cannot finish is told before packages are installed rather than half-way through.

The native client also has a quiet **Install on a cloud server** action on the sign-in
screen. It connects directly from the client to SSH, shows the server’s SHA-256 host-key fingerprint
for confirmation, keeps the password or key passphrase only in client memory, runs the same fixed
installer, and imports the returned connection ticket. No Athanor website or relay receives the SSH
secret. Browsers cannot safely open raw SSH, so the PWA shows the command instead.

The installer gathers the computer’s usable addresses, installs its dependencies as ordinary host
packages — plus the three pinned pieces apt does not carry: the `typst` typesetter against a
recorded SHA-256, a hash-locked document Python environment, and Chromium at the revision the
lockfile’s Playwright carries — builds athanor, creates isolated service accounts and keys, starts
systemd services, opens the existing HTTPS gateway on ports 80/443, and prints the address of the
computer, a QR code that opens it on a phone, and an expiring, single-use owner code. It does not
ask for a domain, unpack a machine image, start a container, create a VM, or install a VPN.

SSH is needed only to run the install command and for recovery. Normal clients connect directly to
athanor over HTTPS.

## Connect

Open the address the installer printed in a browser, or scan its QR code with a phone — the code is
an ordinary `https://` link to the computer, so any camera opens it and the owner code travels in
the fragment. The installer also prints a connection ticket for the native client, containing:

- every useful endpoint detected at install time;
- the server’s stable cryptographic identity;
- local mDNS discovery information; and
- the expiring first-owner code.

The identity is independent of an IP address. The native client probes saved addresses concurrently,
pins the server public key, refreshes the address set from `/.well-known/athanor`, retries safe
requests after an address change, and falls back to `_athanor._tcp.local` discovery on the LAN. A
newly discovered address is accepted only after it proves the same pinned identity.

Dynamic addresses work automatically on the same LAN through mDNS and off-site when the host has a
stable provider hostname or dynamic-DNS name. There is no protocol trick that lets an offline,
off-site client discover an unknown new public IP without some stable name or rendezvous service.
If every saved route fails, the native client asks once whether the address might be dynamic. It can
remember that the address is fixed and never ask again, or show a short dynamic-DNS recovery path.
athanor does not silently add a relay, VPN, or tracking directory; see
[Deployment](docs/DEPLOYMENT.md#dynamic-addresses).

## What is built in

### Agent computer

- Native execution as a dedicated unprivileged `athanor` Linux user.
- Persistent home, files, Chromium profile, installed programs, and publisher CLI logins.
- Foreground and background commands with timeouts, output bounds, polling, cancellation, and
  explicit network intent.
- Approval-gated host package installation through a narrow root helper; arbitrary `sudo`, `su`,
  `doas`, and package-manager injection are rejected.
- Repository map, fast search, symbols, diagnostics, conflict-checked patches, and verification.
- Chromium control using semantic elements and screenshots.
- Xvfb/Openbox Linux desktop with AT-SPI accessibility control and visual fallback.
- Human takeover for login, CAPTCHA, secure input, ambiguous controls, or any action the agent should
  not complete alone.
- Files, screenshots, images, audio, video, documents, code, tables, Markdown, and private app
  previews returned directly in chat.
- Private, bounded extraction and source-linked BM25 search for PDF, Word, PowerPoint, spreadsheet,
  OpenDocument, HTML, CSV, and text collections already on the computer—with phrase, title,
  coverage, and result-diversity ranking, without uploading or duplicating them into a vector
  database.

### Agent behavior

- Compact live plans and activity that collapse to a result after completion.
- Prompt editing as a new trajectory, retry, branches, replay-safe events, cancellation, and
  reconnection across devices.
- Review, Balanced, and Autonomous security modes with a non-bypassable safety floor.
- Encrypted task history plus reviewed, compact durable memory with provenance and validity windows,
  so superseded or time-sensitive facts do not silently remain active forever.
- Reviewed, versioned skills: the vetted built-in library and the procedures saved for this
  computer are both resident as one indexed line each, and a full procedure is loaded when the
  agent opens it.
- One-time, interval, daily, weekly, and advanced five-field cron schedules with IANA time zones.
  Schedules can be edited, paused, resumed, run now, or removed and keep working while clients are
  offline.
- A hidden runtime block naming this computer, the time in the owner’s own time zone, the working
  root, what the document toolchain on this machine can do, the security mode, and the preview
  gateway — followed by the active memory entries, the index of saved and built-in skills, the
  running brief of anything already condensed, and the current plan.
- Capability-aware model routing: a lead model without vision receives bounded observations from the
  best eligible vision model and remains responsible for the result.
- Notifications to the owner's own devices for an approval, a finished task, a paused spend, a
  notice the agent decided to raise, and a page only a person can get past. Browsers and installed
  web apps receive them over Web Push; the packaged desktop and mobile clients, which have no push
  subscription, raise them through the operating system themselves. Every kind has its own switch
  and a switched-off kind is dropped by the server rather than hidden by the phone; quiet hours
  still let an approval through, and everything the agent has said is kept in one list across
  conversations.

### Models and specialist tools

- Every chat model the owner's own provider account can reach, so a model released after this build
  appears without an athanor update. `MODEL_CATALOG_SCOPE=reviewed_open_weight` narrows selection to
  models carrying a current independent open-weight licence review.
- Provider prompt caching, so the operating contract, tool catalogue, and trajectory that an agent
  turn re-sends on every step are billed once rather than on each step.
- Bounded retry with backoff on transient provider failures, and a request deadline, so one 429 or a
  hung provider does not end a long task.
- Live OpenRouter model metadata, modalities, context windows, price estimates, route privacy, and
  zero-data-retention eligibility.
- Ollama Cloud and generic OpenAI-compatible provider support without local model hosting.
- Codex CLI, Claude Code, and OpenCode as bounded coding specialists using the owner’s publisher
  login. Publisher sessions persist in the same backed-up agent home.
- Zero-retention provider mode fails closed for model inference and voice transcription; publisher
  CLI retention remains a separate policy and is never mislabeled as the provider’s ZDR route.
- Provider-backed image and speech generation. Video is refused: the asynchronous route that would
  produce it keeps the output at the provider for retrieval, so there is no zero-retention way to
  make one, and the catalogue says so rather than offering a job that fails at the end.
- Voice-note transcription through a current OpenRouter transcription route with ZDR required.
- Scoped GitHub and WebDAV connections, the owner’s own mailbox over IMAP with SMTP submission, and
  their own calendar over CalDAV — open protocols against their own server, with reading, marking
  and sending as separate scopes and every send stopping for approval.
- Remote MCP Streamable HTTP with no-auth, bearer, or standards-based OAuth discovery,
  protected-resource metadata, PKCE S256, resource binding, rotating encrypted tokens, SSRF/DNS
  protections, response limits, and user confirmation.

## One computer, not a workspace manager

The interface presents one persistent computer. An internal workspace ID remains as an authorization
and encryption boundary, but the owner does not create, price, or resize a collection of cloud
machines. Storage is the host’s storage; compute is the host’s compute; model inference remains at the
chosen provider.

## Server commands

```text
sudo athanor doctor
sudo athanor connect
sudo athanor pairing-code
sudo athanor start
sudo athanor stop
sudo athanor restart
sudo athanor status
sudo athanor logs
sudo athanor backup [directory]
sudo athanor restore DIRECTORY --yes
sudo athanor update
sudo athanor rollback [directory]
sudo athanor auto-update {status|on|off}
sudo athanor certificate
sudo athanor ddns
sudo athanor set-hostname NAME
sudo athanor relay {status|on|off}
sudo athanor uninstall
```

`certificate` requests a publicly trusted certificate for the existing server identity key, so the
pinned client identity is unchanged. It is a separate command rather than part of install because
issuing one accepts a certificate authority's subscriber agreement, which athanor will not do on
the operator's behalf without being asked. `ddns` keeps a chosen hostname pointed at a changing
public address, and `set-hostname` moves the public origin onto a name that is already published.

`auto-update` is off by default; turning it on runs the same transactional update weekly, with the
same backup and automatic rollback. `relay` reports and switches a connection relay, which ships off
and is only for a server no inbound connection can reach. Enrolling with one happens in Settings,
because only the running server can redeem an enrollment token. See
[Operations](docs/OPERATIONS.md) for the full surface.

`uninstall` disables athanor but preserves `/home/athanor`, `/etc/athanor`, PostgreSQL data, and
backups. See [Deployment](docs/DEPLOYMENT.md) and [Operations](docs/OPERATIONS.md).

Backups contain the database encryption keys, server identity, browser profile, publisher logins,
and user files. They also record additional approved APT packages so a clean host can reinstall
them. Store backups in an operator-provided encrypted destination and copy them off-host; Athanor
never uploads them.

## Architecture

```text
web / PWA / native clients
                 |
       direct HTTPS on 443
                 |
          nginx + API
            /       \
   encrypted DB     worker
                       |
             native Linux runner
           /        |        |       \
        files   Chromium   desktop   terminal
                       |
            owner-selected AI services
```

Private services listen only on loopback. Nginx is the sole public application gateway. The runner is
authenticated, is never exposed directly, and does not contain an inference server.

## Privacy

athanor does not intentionally put prompts, replies, screenshots, browser text, terminal output, file
contents, credentials, or generated assets in application logs. That is not the same as zero
observation: the machine host, model provider, destination websites, connected tools, certificate
authority, DNS, and network operators receive the content or metadata required to provide their
services.

Read [Security](SECURITY.md), [Privacy](docs/PRIVACY.md), and the
[capability audit](docs/CAPABILITIES.md) before exposing a computer to the internet.

## Development

Node 24 and pnpm 11 are required — the pinned pnpm refuses to start on anything older, and the
server installer provisions Node 24 for the same reason.

```bash
cp .env.example .env
# .env ships with placeholders that the services refuse to start on. Three need real values:
printf 'DATA_MASTER_KEY=%s\n' "$(openssl rand -base64 32)" >>.env
printf 'SESSION_SIGNING_KEY=%s\n' "$(openssl rand -base64 32)" >>.env
printf 'RUNNER_SHARED_SECRET=%s\n' "$(openssl rand -base64 32)" >>.env
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` starts the web client, the API, the worker and the workspace runner together, and each
service reads `.env` from the repository root. A development database is not required: with
`DATABASE_DRIVER=pglite`, which `.env.example` sets, the stack keeps its data in `.athanor/postgres`
under the repository.

Open `http://localhost:5173` and run the full source verification with:

```bash
CI=true pnpm check
pnpm license:rust
pnpm release:check
```

The production installer and native services are Linux-only today. The open-source Tauri client
targets Linux, macOS, Windows, Android, and iOS. A tag-driven workflow builds desktop packages, a
universal Android APK/AAB, and an iOS IPA into one checksum-manifested draft release. It fails closed
unless protected macOS, Windows, Android, and iOS signing credentials are configured and every
platform artifact passes its post-build audit. No release is claimed as published here; see
[Releasing clients](docs/RELEASING.md).

## Independent implementation

athanor is an independent implementation. Its code, prompts, and interface are its own, and it is
not affiliated with or endorsed by any provider it can connect to. Product names appear only to
identify services the owner may choose to use. See
[Third-party notices](THIRD_PARTY_NOTICES.md).

## License

GNU Affero General Public License v3.0. See [LICENSE](LICENSE).
