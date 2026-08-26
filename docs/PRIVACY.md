# Privacy

## What athanor stores

Your installation stores:

- account/passkey/session records;
- encrypted task prompts, replies, agent state, plans, schedules, and events;
- encrypted memory and skills;
- workspace files, browser profile, cookies, installed programs, and publisher CLI logins;
- encrypted model-provider and connector credentials;
- artifacts, generated media, previews, and recovery points;
- content-free resource, status, timing, byte, token/cost, approval, security, and connector outcome
  records needed to operate the server.

Task and credential encryption uses the installation master key. Workspace files rely on host/volume
encryption unless the file format itself is encrypted.

## What athanor does not intentionally log

Application logs, metrics, notification labels, and connector audit summaries exclude:

- prompts and replies;
- file contents and filenames used inside tasks;
- screenshots, DOM/readable page text, and browser cookies;
- terminal input/output;
- provider, connector, session, and publisher OAuth credentials;
- media prompts and generated content;
- external request/response bodies.

Logging mistakes are security bugs. Releases should run synthetic content canaries through every
channel and scan all logs.

## “No logging” boundary

No content logging by athanor does not mean no observation anywhere.

- The model provider receives inference content.
- Codex and Claude Code send repository context and prompts under the owner’s publisher account.
- Websites receive browser requests and can fingerprint the server/browser.
- `web_search` sends the query text to DuckDuckGo's no-JavaScript results endpoint, which therefore
  sees every search the agent runs and the server's address. There is no account and no API key, so
  there is nothing for it to tie those queries to besides the address itself, and the request
  carries no profile or cookies: a search runs in an isolated browser launched for it and closed
  afterwards. Nothing else about the task is sent — not the prompt, not the page the agent is
  working on, not the results it then reads.
- GitHub, WebDAV, and MCP servers receive approved calls.
- The owner's own mail and calendar servers, when connected, receive IMAP, SMTP submission and
  CalDAV requests from this computer and keep their own copies and connection logs, exactly as they
  do for any other client the owner uses.
- The VPS/cloud operator can observe the host, disk, memory, and network depending on its service.
- DNS, certificate authorities, network operators, and push relays see delivery metadata.
- A connection relay, if the owner turned one on, sees the server's label, the address of the server
  and of every device that connects to it, byte counts and connection timings. It sees no traffic:
  TLS terminates on the server, so no URL, header, token or message is readable at the relay. It
  ships off, there is no default relay, and turning it on takes a hostname and an enrollment token
  from an operator the owner chose. See [relay.md](relay.md).

Review each external service’s current privacy and retention policy. `AI_REQUIRE_ZDR=true` is a routing
request where supported; it is not a cryptographic guarantee and does not eliminate account, abuse,
billing, or network metadata.

## Credentials

Provider and connector credentials are encrypted before database storage and are never returned after
save. API tokens are displayed once; athanor stores only a one-way digest, prefix, scopes, expiry, and
last-use time.

Codex/Claude OAuth state is controlled by the publisher CLI under the persistent workspace home, not
the athanor credential table. It is therefore included in full workspace backups.

Browser secure-input mode suspends agent observation and control while the user types a password,
payment detail, CAPTCHA, or other human-only value.

## Memory

Long-term memory is not automatically extracted behind the user’s back. The agent proposes a compact
entry, and the entries that are hardest to undo stop for the user to approve, edit, or deny:
every replacement, every removal, anything written into user memory rather than one computer's
memory, anything the credential scanner recognises, anything without an expiry or with one more than
a year out, and anything written on a turn that had read untrusted content — where the card names
the origin that put it there.

A dated, computer-scoped addition on a clean turn is saved without a card. That is a deliberate
boundary rather than an oversight: requiring a card for every write meant an agent keeping a nightly
journal woke the user at 3am, which teaches people to approve without reading and makes the floor
worth less than no floor. Everything saved either way is listed in the memory pane, is inspectable
with its provenance and validity window, and can be removed there. The review queue lists the
entries the computer itself has flagged — procedures that have gone stale or started failing, and
entries recorded as contradicting each other — and each can be confirmed as still right, retracted
so it stops being recalled while the record of it survives, or forgotten outright.

Exact old task content stays in encrypted task history and is retrieved only by explicit search.

Do not save credentials, private keys, recovery codes, transient medical/legal/financial details, or
third-party secrets as memory.

## Connected services and MCP

Connections have explicit scopes. Secrets do not enter prompts. Audit rows record only connector,
operation, outcome, status, timing, and byte counts — never the message, event or file involved.

Mail and calendar connect to the owner's own server over the open protocols, with a username and an
app password, rather than through a hosted provider's OAuth. Reading, marking and sending are three
separate scopes; sending carries the highest side-effect class the approval model has, so it stops
for the owner in every security mode. A message read out of a mailbox reaches the model inside an
untrusted-content envelope, because the contents of an inbox are data written by strangers.

Remote MCP tool schemas and results necessarily become task context. Tool execution always requires a
user approval. Remote MCP accepts no auth, a bearer token, or discovery/PKCE OAuth against the MCP
server's own authorization server; every stored credential is encrypted.

## Notifications

Push notifications carry the owner's own name for the conversation as the title, a sentence saying
what happened, and the task identifier to open. This is a deliberate change from the generic text
they used to carry: “Your cloud task is ready” was identical for a success, a failure and a
cancellation, said nothing about which conversation it belonged to, and owners turned the whole
feature off rather than keep it.

What that means for what leaves the machine, plainly. The title is the conversation title. For the
two kinds the agent raises, the body is the sentence the agent wrote — the notice the owner asked
for, or which site is blocking it. For an approval, the body names the class of action in the
owner's language (“run a command on your computer”) from the tool name and side-effect class, which
are plaintext columns; the exact command is inside the encrypted preview and stays there. For a
finished task, the body is its outcome and, when known, the duration and the settled cost. Prompts,
file contents, tool arguments, model output and page contents are never included.

The notification service itself holds no workspace key: the title and the agent's sentence are
decrypted by the data layer, which is the only place holding both the envelope and the key, and are
handed to the sender already in the clear. Payloads are encrypted to the subscribed device by Web
Push. The push service still sees endpoint and timing metadata, and the operating system may render
the text on a lock screen — an owner who does not want that should turn the kind off in Settings,
where every kind has its own switch, or set quiet hours. A switched-off kind is dropped by the
server, not merely hidden by the device.

## Export and deletion

Settings provides a recent-authentication-protected privacy export containing the owner’s application
records and decrypted task/plan/schedule content. Account and computer deletion paths remove database
records and request workspace deletion.

Host-data deletion and off-host backup deletion remain operator responsibilities. A copied backup
cannot be recalled by the application.

## Retention

Task history, files, memory, and media are user-controlled. Expired sessions, challenges, idempotency
records, notifications, and operational/security events have bounded cleanup paths. Operators should
choose and document backup retention separately.

## One-owner warning

The native server is a trusted-owner installation, not a hostile public multi-tenant service.
Registration closes once the first owner exists, and there is no sharing model to invite anyone
into. Anyone with server root can bypass application encryption at runtime, so the person who
administers the machine is the person the data belongs to.
