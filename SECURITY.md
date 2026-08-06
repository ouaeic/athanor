# Security policy

## Report a vulnerability

Use the repository host’s private vulnerability-reporting feature. Include affected revision, impact,
synthetic reproduction steps, and a proposed mitigation if available. Never put real credentials,
browser cookies, private files, database extracts, recovery material, or user prompts in a report.

Maintainers aim to acknowledge reports within three business days and provide an initial severity
assessment within seven. Security fixes target the current release line.

## Threat model

athanor is designed for one owner. The installer ships `REGISTRATION_MODE=first_user`, so the first
account claims the server and registration then closes; there is no sharing model, no roles and no
second party to authorize against. It is not a hardened hostile multi-tenant compute service.
Anyone with root access to the host, control of the configured operating-system package
repositories, live process memory, or an unencrypted backup can compromise the installation.

The relevant adversaries are:

- unauthenticated network clients;
- a stolen or revoked client session;
- prompt injection in webpages, repositories, documents, MCP results, or terminal output;
- a malicious or compromised external provider;
- a compromised agent subprocess;
- a relay operator, when the owner has enrolled with one: they control DNS for the relay domain, so
  they can point the relay hostname at a machine of their own and read everything a browser client
  sends over that path, though native clients pin the server identity key and are unaffected;
- accidental destructive actions; and
- credential or content leakage through logs, URLs, notifications, or previews.

## Security invariants

- The web app is the only public application surface. Runner, database, browser, desktop, and
  terminal services are never published directly.
- The first account claims the server; registration then closes by default.
- Passkeys, origin checks, secure cookies, revocable sessions, and recent-authentication checks guard
  owner settings.
- Workspace requests require capability tokens that are short-lived (60-120 seconds, and never more
  than 900 whatever a signer asks for), single-use, bound to one workspace, and scoped per route. A
  token that names the request it was minted for is refused against any other, so one observed on a
  file read cannot be turned against `exec`.
- Task content, plans, events, schedules, memory, skills, connector credentials, and provider keys are
  encrypted at rest.
- Application logs, metrics, notifications, and connector audits intentionally exclude prompts,
  replies, file contents, screenshots, browser text, terminal output, URLs with tokens, and secrets.
- Provider and connector credentials never enter a model prompt.
- Browser/desktop secure-input mode stops agent observation and actions until the user hands control
  back.
- External submissions, messages, purchases, public publishing, destructive operations, ambiguous
  coordinate clicks, subscription-agent missions, and every MCP tool execution pass approval policy.
- Untrusted content is labeled as data and cannot alter system policy, approval rules, or credential
  boundaries.
- Remote WebDAV and MCP endpoints require HTTPS on port 443 with no credentials in the URL, public
  DNS addresses only, a lookup pinned to the addresses that were checked, redirect denial, bounded
  request and response bodies, and timeouts. The host itself is allowed because the owner named it
  when connecting; `CONNECTOR_ALLOWED_HOST_SUFFIXES` narrows which mail and calendar hosts may be
  reached at all, and ships empty, which leaves the owner's own choice standing.
- No local model server, model weight, or inference GPU is installed by athanor.
- No secret is committed, baked into an image, or returned after initial token issuance.

## Native host boundary

The agent computer is the installed Linux host. Tools, Chromium, GUI programs, publisher CLIs, and
user-installed software run as `athanor-agent`, an unprivileged account with no login shell that is
separate from the `athanor` account the runner itself runs as. Commands reach it through a
root-owned helper that only ever hands back less privilege than it was called with, and that sets
`no_new_privs` — which is inherited by every descendant and cannot be removed, so a set-user-ID
binary confers nothing no matter which interpreter spelled the command.

They can intentionally read and change workspace files, which the two accounts share through a
group, and can communicate with networks reachable from the host. They cannot read the root-owned
control configuration, the database keys, or the runner's capability secret: that secret is removed
from the environment once the runner has read it, and the runner's `/proc` entry is not readable
from another account. The browser profile stays owner-only, so a command cannot read the cookie jar
for sites the owner signed into during a takeover. The installer verifies at install time that a
command really does land on the agent account, and stops rather than come up believing it confines
commands when it does not.

The database refuses local-socket connections for the application role, so a command cannot use
peer authentication to open the database as the owner of every encrypted row. Access needs the
password held in root-owned configuration.

Direct `sudo`, `su`, and `doas` execution is rejected. An approved `apt update` or
package-name-only `apt install` passes through a root-owned helper that rejects options, paths, hooks,
and shell syntax. Debian package maintainer scripts still execute as root, so approving a package
extends trust to the configured APT repositories and that package.

The API, worker, registry, media, and notification services run as a separate `athanor-control`
account under systemd hardening and cannot read `/home/athanor` directly. They reach the runner over a loopback-only
port using short-lived, task/workspace-bound capabilities. PostgreSQL and every application service
other than Nginx remain loopback-only; Nginx is the sole public application gateway.

`ISOLATE_AGENT_NETWORK=false` is the shipped default, and the reason is a trade rather than a
limitation: the sandbox helper can put a command in its own network namespace, and the installer
checks that the kernel allows it, but a command isolated that way also gets its own loopback, so
nothing outside it — the preview proxy included — can reach a port the command is listening on.
Turning it on therefore costs published previews. With it off, athanor records network intent and
applies approval policy, but an allowed process can use the host's ordinary network access.
Operators who want the stronger boundary can turn it on, or dedicate the machine and enforce
ingress and egress at their host or cloud firewall.

## External trust boundaries

- The configured model provider sees inference content and service metadata according to its terms.
- Codex CLI and Claude Code store publisher OAuth state inside the persistent workspace home and
  communicate directly with their publishers.
- MCP, GitHub, WebDAV, destination websites, DNS, certificate authorities, push relays, and network
  operators see the data required to perform their service.
- A connection relay, once enrolled, sees the server's label, the addresses of the server and of
  every device that connects to it, byte counts and connection timings. It sees no traffic: TLS
  terminates on the server, so no URL, header, token or message is readable there. It ships off,
  there is no default and no athanor-operated relay, and enrolling takes a hostname and a
  single-use token from an operator the owner chose. [docs/relay.md](docs/relay.md) sets out both
  halves in full.
- Browser logins and cookies live in the persistent browser profile.
- Generated files can contain sensitive model output or source content.

“No content logging by athanor” is not “no metadata anywhere.”

## Backups and recovery

`athanor backup` pauses mutating services, dumps PostgreSQL, archives `/home/athanor` and
`/etc/athanor`, records additional approved APT packages, and writes checksums. The backup contains
encryption keys, browser state, publisher logins, installed user tooling, and user files, so it is as
sensitive as the live server. Store it in an operator-provided encrypted destination and off-host,
then test `athanor restore` before depending on it.

Losing `DATA_MASTER_KEY` makes encrypted records unrecoverable. Rotating or replacing
`/etc/athanor/control.env` without a coordinated migration can cause permanent data loss.

## Hardening checklist

1. Patch the supported Ubuntu/Debian host and reboot when kernel/security updates require it.
2. Expose only SSH as needed and Nginx on 80/443; use `athanor doctor` to verify every private service
   remains loopback-only.
3. Restrict SSH, disable password login where practical, and protect the server provider account.
4. Keep `REGISTRATION_MODE=first_user`; rotate an unused pairing ticket after accidental disclosure.
5. Do not rewrite the passkey origin after owner registration. Native clients follow address changes
   by the pinned server identity.
6. Keep custom connector and MCP hosts to the minimum required.
7. Review model-provider retention and training settings; keep `AI_REQUIRE_ZDR=true` where supported.
8. Store backups encrypted and off-host, with access independent of the server being recovered.
9. Run `athanor doctor`, dependency/secret scans, content-log canaries, and restore drills after
   upgrades.
10. Do not install untrusted skills, MCP servers, coding agents, or packages merely because a webpage
    asks.
11. Leave the connection relay off unless inbound connections cannot arrive at all. If one is
    needed, run your own rather than someone else's, and prefer the native clients on that path:
    the operator controls DNS for the relay domain, which a browser cannot defend against.
    [docs/relay.md](docs/relay.md).

## Out of scope

Physical access to an unlocked client, deliberate host-root compromise, behavior of third-party
services, model-quality disagreements, CAPTCHA bypass, bot-defense evasion, and unauthorized testing
of other systems are not vulnerabilities in this repository.
