# Capability and design audit

This is an engineering audit of what athanor actually does, written against the source rather than
against intentions. It records the deliberate boundaries too, because a boundary that is not written
down gets mistaken for an oversight — or for a promise.

## Scope

athanor is built for one owner and one computer. It covers chat, a persistent Linux machine,
terminal, browser, web search, GUI applications, human takeover, files, rich artifacts, durable
history, reviewed memory, skills, schedules, model selection, coding-specialist handoff, previews,
device clients, the owner's own mailbox and calendar over open protocols, MCP, and a single approval
model.

It deliberately leaves out messaging-channel bots, hosted-provider resale, multi-tenant enterprise
administration, and a plugin marketplace. Those belong to a different product with a different
support burden.

There is no paid tier and no metering of the owner against a plan. The owner holds the
model-provider account and pays it directly. Four ceilings bound a run, and none of them is an
allowance:

- the **pre-flight price ceiling** (`sudo athanor spend-ceiling`), a maximum rate in dollars per
  million tokens that athanor will not select a model above. It is the only one that acts before
  any money is spent, and the only one that works while the owner is asleep; a model the owner
  names explicitly is never constrained by it;
- the **daily, monthly and per-task spending caps** in Settings, which watch what a task has
  already spent and halt it;
- a **per-turn compute budget**, which stops one runaway loop from spending the afternoon; and
- a **two-hour wall clock per leased execution**, because the other three compose rather than cap
  and a turn that is cheap per step and never stops is invisible to all of them.

All four stop work rather than throttle it, and a stopped turn hands over what it did with a reply
that resumes it.

A turn may hand itself another step budget rather than stopping to be spoken to, but only while the
harness has just run the turn's own acceptance checks and found them failing, only while it is still
changing things, and at most twice. It buys steps, not money: the compute budget above is sized once
when the task is created and nothing raises it, so a self-continuing turn spends the remainder a
stopped one would have left behind.

## Deliberate design decisions

### Reviewed memory rather than automatic capture

Automatic fact extraction preserves wrong and sensitive claims with equal confidence. athanor lets
the agent propose a compact memory, and pauses for review where review is worth having: every
replacement and every removal, because both destroy something the owner already approved; and an
addition that would reach user memory, that carries anything the credential scanner recognises, that
has no expiry or one more than a year out, or that was written on a turn which had read untrusted
content. A dated, workspace-scoped addition on a clean turn is saved without a card. That boundary
is deliberate and was moved: a card on every write read as a strict floor and behaved as the
opposite, because an agent keeping a nightly journal woke the owner at 3am and taught them to
approve without reading. What remains behind the card is what is hard to undo or is loaded into
every future task.

Judgement that does not belong on the write path is served by a review queue instead: the stale and
failing procedures, and the items recorded as contradicting one another, are listed together, and
each can be verified as still right, retracted — kept, but no longer recalled, with the record that
it stopped being true — or forgotten outright. Exact conversation evidence stays searchable without
promoting every message into long-term memory.

Each accepted fact records owner/agent provenance, optional source task, update lineage, and
`validFrom`/`validUntil`. Expired and future facts remain inspectable but are excluded from model
context. Active facts are ranked locally against recent user turns using lexical overlap, recency,
and a durable user-preference boost, within a fixed prompt budget. No content leaves the server to
perform recall.

That ranking happens once per task, from the opening request, so the cached prompt prefix survives —
which is right for what a task starts with and wrong for what it turns out to need. The agent can
therefore also ask its memory a question mid-task, and get back what the frozen pack did not already
print.

The cost of this choice is real: a fact the owner never reviews is a fact the agent will not have.
That is preferred here over a memory store that quietly accumulates whatever passed through it.

Memory recall is lexical throughout, and the semantic channel was removed rather than left dormant.
An earlier migration had created vector columns, two HNSW indexes and an embed-state enum; nothing
ever wrote a vector and no query ever read one, so it amounted to an index of nothing plus a
capability flag reporting a channel the retrieval query had no branch for. That is worse than the
absence, because it reads as a component the main path depends on. It is dropped. Finishing it would
have meant storing an embedding of every memory body unencrypted beside its ciphertext — a dense
derivative of the plaintext that the plaintext can be reconstructed from — which defeats the
encryption the memory store is built on, and does so whether the vector comes from an API or from a
model running on this computer. Lexical recall cannot reach a row from a paraphrase sharing none of
its words, and that cost is carried openly: the committed memory eval holds a probe that misses for
this reason and asserts that it still does.

### A definition of done the harness can run

Completion used to be checked for provenance: that a cited tool call existed, succeeded, and came
after the last change. Every one of those is a check on identity and ordering, none of them reads
the result, and the harness executed nothing of its own — so reading back a file you had just
written satisfied it, and "the service starts and serves /health" was accepted on the strength of a
`file_read`.

The model now declares what would prove the job done, before it does the work, and the harness runs
those checks itself and refuses the finish while any fails. The division of labour is the whole
design and is what keeps it from becoming a task mould: the model writes the checks, in its own
words, for whatever the job turns out to be; the harness only insists that "done" means something it
can execute, and executes it. A definition of done that already passes before the work starts is
refused, which is a property of the shape rather than a list of banned commands.

### Files are the knowledge source

`document_search` ranks supported formats locally with BM25 plus phrase, title, coverage, and
per-file diversity bonuses; `document_read` extracts grounded content or PDF page ranges. Results
keep their source path and page provenance, so a claim can always be traced back.

This is a deliberate trade, not a free win. Lexical search cannot retrieve a passage that shares no
wording with the query, which a vector index can. In exchange there is no embedding model, no second
copy of the owner's documents, no index that silently goes stale when a file changes or is deleted,
and no upload of private material to compute embeddings. The agent compensates by reformulating
queries, which it is good at. A semantic index would be a different product with its own retention
story, not a hidden component needed to make the main path work.

### One approval boundary

Browser, desktop, shell, files, media spend, external services, MCP, and coding specialists all feed
the same Review, Balanced, or Autonomous policy. Autonomous removes ordinary interruptions but
cannot lower the safety floor: credentials, CAPTCHAs, payments, submissions, publishing, destructive
operations, and ambiguous coordinate actions still transfer to the owner or require confirmation.

An approved action is bound to what the owner saw. The approval row stores an HMAC over the tool
arguments, and the resume path recomputes it before executing, so an approval cannot be spent on
different arguments than the ones it was granted for.

### Specialist runtimes, not competing histories

Codex, Claude Code, and OpenCode run as bounded coding specialists invoked by the lead model.
Compact progress and resumable session IDs return into the same task, so there is one history rather
than several. A task routed through a provider's zero-retention route cannot silently cross into a
subscription CLI, because those retention policies are separate and are not represented as
equivalent.

### An honest browser

The browser uses a stable, persistent profile on the owner's own server. `navigator.webdriver` is
left truthful: masking it is bot-defence evasion, the owner is the party who would be exposed for
it, and the security policy places it out of scope. A site that refuses automation stops the agent
on that tab and that host, and nowhere else — the rest of the browser keeps working, the agent is
told to carry on with the rest of the task, and the owner is told about the one page, with taking
control a single button that brings that tab to the front. Handing the browser back clears the stop.

CAPTCHAs, identity checks, credentials, and payments always transfer to the owner. athanor does not
claim to bypass site controls, and does not ship proxy or fingerprint-rotation services.

### No channel or plugin sprawl

Every additional messaging channel and community plugin multiplies credentials, retention
disclosures, unreviewed code, formatting limits, and approval ambiguity. The web, PWA, and native
clients already expose the complete task surface. Narrow external capability goes through reviewed
built-in connectors or MCP, and stays in advanced settings.

## How this was audited

- **Capability:** every claim in the README maps to a tool, API route, or client surface.
- **Reliability:** terminal work is bounded and resumable, schedules lease atomically, model calls
  retry with backoff and a deadline, task leases renew while long tools run, and updates roll back
  code and data together.
- **Security:** passkeys, exact server-key pinning, encrypted state, an unprivileged runner, narrow
  package elevation, a shared approval floor, and human takeover guard consequential work.
- **Privacy:** zero-retention routing is enforced per request, each provider is labelled by its own
  policy, and no invented privacy promise is attached to a custom endpoint.
- **Recovery:** tickets carry multiple endpoints plus identity, mDNS covers LAN changes, backups
  include publisher sessions, and restore verifies identity continuity.
- **Performance:** the GUI and desktop stream only when open, skill bodies load only when a
  procedure is opened, prompt prefixes are cached and deliberately kept byte-stable, superseded
  turns are condensed into a running brief instead of being cut out of the window, networking is
  event-driven, and execution is native rather than inside a guest VM.

## Release gates

These are open items, not hidden claims:

1. Build, sign, and attach desktop and mobile binaries. Source targets exist; store releases do not.
2. Complete packaged-client first-owner passkey, secure-cookie, and QR pairing drills, and a
   fresh-host restore.
3. Exercise real Claude Pro/Max and officially supported OpenCode publisher logins on the release
   build. Codex persistence has been exercised on a test server.
4. Run a fresh end-to-end install on a clean host against the published tag.
5. Complete packaged-client screen-reader, signed-update, long-reconnect, and no-content logging
   drills against release artifacts.

Passing compilation and tests is not production proof.
