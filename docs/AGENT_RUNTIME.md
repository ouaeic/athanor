# Agent runtime

## Operating contract

The lead model is told that it operates a persistent remote Linux computer and that the user’s
current phone or desktop is only a client. It may inspect and modify the assigned filesystem, install
approved software, run long work, use Chromium and GUI applications, generate media, and host
previews. It must preserve useful files, verify results, and never report an external success without
tool evidence.

The contract also carries the craft guidance: how to approach code, the web, documents already on the
computer, documents it produces, data, applications and forms, media, previews, and installed GUI
applications. That guidance used to be chosen per request by keyword, and against the wording owners
actually use it was wrong on ten of twenty-four measured requests: five got no guidance at all,
including an application to a job posting, and five got a block pointed at the wrong tools, with
“tailor my CV and give me a PDF” read as a request to read documents rather than write one. It is
now a fixed part of the contract, sent whole on every request. It costs about 6 kB against a tool
catalogue an order of magnitude larger that is already unconditional, and because it never changes
during a task it stays inside the prompt prefix a provider caches.

Webpages, repositories, documents, model output, tool results, and terminal output are untrusted
data. They cannot grant authority, reveal credentials, disable policy, or replace the user’s goal.

## What reaches the model

Each request carries, in this order:

1. the operating contract, including the craft guidance and the safety floor;
2. a runtime block: computer name, the current time in the owner’s own time zone, the working root,
   what the document toolchain on this machine can actually do, the security mode, and the preview
   gateway;
3. `workspace/ATHANOR.md` when the owner keeps one, as the canonical project brief;
4. the curated knowledge block: active memory entries ranked against the recent turns, the index of
   skills saved for this workspace, and the index of the vetted built-in library;
5. the recalled memory pack, rendered once per task and re-emitted byte-for-byte on resume;
6. the user’s original request, then the running brief of anything already condensed, then the
   verbatim recent trajectory;
7. the newest live plan, appended as it changes.

Only skill _names_ and one-line catalog entries are resident. A full procedure loads when the model
opens it, and the binaries that procedure assumes are probed on the machine and reported with it, so
a step the computer cannot support is known before it is attempted rather than after.

The runtime block deliberately carries no live counters — a changing digit ahead of the trajectory
would invalidate the cached prefix on every step. The clock is rounded to the minute for the same
reason, and disk capacity is a `df -h` the model is told to run rather than a number interpolated
here.

## Tools

The whole catalogue is sent on every request — every tool, plus the compaction trigger. Nothing is
gated. Gating was measured and removed: the keyword rules that decided which tools to send matched
almost none of the requests owners actually make, so a request to read a contract arrived without a
document reader.

Its exact size is not written down here, because a byte count in prose goes stale the first time a
tool is added and then reads exactly like a measurement. It is enforced instead: `tools.test.ts`
holds the whole serialized catalogue under a ceiling and every individual tool description under
1,400 bytes. The ceiling is deliberately hard to move — it has been raised once, by roughly what one
new capability cost — and the rule it encodes is that it moves for a capability and never for prose.
Around that ceiling the catalogue is on the order of 15,000 tokens, under a tenth of a
160,000-token budget, and it sits at the very front of the request where a provider caches it once
and replays it for the rest of the task. That is why the answer to a large catalogue is to write the
descriptions tightly rather than to withhold them, and why schemas are not the place to save
tokens: a declared action variant is an interface fact the model would otherwise guess at and spend
a round trip discovering.

`tool_search` was removed for failing that test from the other direction: it ranked definitions the
model already had in front of it, billed a full pass over the window to do it, and admitted in its
own description that it unlocked nothing.

The catalogue covers plans, the acceptance record that defines what would prove the job done, shell
commands and background processes, files, conflict-detecting patches, repository search and
diagnostics, subscription coding specialists, private document extraction and lexical search,
encrypted task search, web search, browser and desktop control, parallel source reading, PDF
capture, media generation, connected services and MCP, schedules, reviewed memory and a question the
agent may ask it mid-task, skills, read-only delegation, a notice the agent may raise to the owner,
artifact and preview publication, and completion.

Order is fixed for the life of a task rather than assembled per step, because the tool block opens
the prompt prefix: a definition that moves position ends the shared prefix at that point.

The model must finish with verification evidence, and the evidence must post-date its last change. A
plain assistant message does not mark a task complete.

## The definition of done

Evidence that post-dates the last change is a check on ordering, not on the work. It is satisfied by
reading back a file you just wrote, which is how “the service starts and serves /health” came to be
accepted on the strength of a `file_read`. So the model also declares, in its own words and before
it starts, what would prove the job is done — and the harness runs that itself.

`set_acceptance` takes up to eight checks of two kinds: a **command**, which is an executable, its
arguments, and the exit code and stdout substring it must produce; and an **artifact**, which is a
workspace path that must exist and not be under a size. A check is a check rather than a second
chance to act, so the harness refuses the ones that reach the network or destroy data — `rm`, `mv`,
`curl`, `ssh`, `systemctl`, `apt`, `git push` and their neighbours — by the shape of the command
rather than by a blocklist that would grow forever.

Four properties make it mean something:

- **A definition of done that already passes is refused.** Declared before the turn has changed
  anything, the checks are run against the job as it then stands. If every one of them passes at
  that moment the record is rejected and the model is asked for one that fails now. That is what
  stops `true`, `echo ok` and an artifact check on a file already sitting there, as a property of
  the shape rather than a list of names to ban. An already-passing check is welcome alongside a
  failing one, because that is a regression guard.
- **Declaring is not passing.** `set_acceptance` succeeds by being well-formed, which would
  otherwise make it the cheapest successful call in any turn that declared one, so the declaration
  cannot be cited as the evidence that it was kept.
- **An inherited record does not prove a later turn.** A record from an earlier turn is kept — a
  follow-up must not be able to break what the previous turn was held to — but it was green before
  this turn began, so finishing is held until this turn says what would prove its own work.
- **A weaker tick says so where the owner reads it.** Checks written after the work had already
  changed something, a record taken at the already-passing ceiling, and one inherited from an
  earlier turn each attach their own caveat to the completion rather than only to the timeline entry
  for the step that declared them. Revising a record shows the owner both versions, because
  weakening your own test is a different act from passing it.

A finish is refused while any check fails, with the harness’s own observation — the exit code, the
first lines of stderr — returned as that call’s result so the model can act on it. Like every other
refusal in the loop it is bounded: past the fourth attempt the turn ends honestly, with the failures
carried into the completion’s remaining risks rather than spending the rest of the budget on the
same failure.

## Documents

Which route produces which deliverable is decided once, in the contract, rather than left to the
model to pick per task:

- something the owner will edit — a report, a deck, a workbook — is a real `.docx`, `.pptx` or
  `.xlsx`, built through the file’s own styles, layouts and live formulas;
- a PDF whose pagination matters — a CV, a letter, an invoice, a one-pager — is typeset with `typst`
  from a `.typ` source kept beside the PDF, because converting a word-processor file surrenders
  control of where the pages break;
- `print_pdf` captures a page the browser is showing — a posting, a receipt, a statement — and is not
  an authoring route.

Before publishing, a document is proved: converted with `athanor-office-convert IN OUT`, rendered to
page images with `pdftoppm`, and looked at with `image_read`. Overflowing text boxes, a CV that
spills onto a second page and `#REF!` cells are invisible in the source and obvious in a render.
Publishing an Office file also attaches a converted PDF review copy for the owner.

The conversion goes through that wrapper rather than through LibreOffice directly, and the skill
library names only the wrapper. Bare `libreoffice --headless --convert-to` exits 0 having written
nothing, decides the output name itself from the input stem, and corrupts concurrent runs that
share one user profile. The wrapper gives each run a throwaway profile, writes where the caller
asked, and fails loudly when the bytes are not there — so a non-zero exit genuinely means the
document did not convert.

## Long work

A turn is bounded by steps, by compute credits, and by the spend ceiling, whichever binds first.

The window is bounded by condensing rather than by cutting. When the live window passes 70% of the
input budget — or when the model itself calls `compact_context` because a phase is genuinely
finished — the superseded turns are summarised into a durable running brief and dropped. The brief
accumulates: each compaction appends one section and never rewrites an existing one, so the rendered
brief stays a byte-exact prefix of its own next version and the cached prompt prefix survives. The
tool-call IDs a completion has to cite are carried forward deterministically, because they live only
on the raw messages a compaction removes. If the summarising model is unavailable the deterministic
summary is used instead; compaction degrades, it does not fail the task.

A step is one model call, however many tools it uses, and the default ceiling is 120. Sixty was the
figure from when a turn was a conversation rather than a job: an application to a job posting is a
posting capture, a dossier read, two tailored documents, a render proof and twenty-five form fields
read back one at a time, and it cleared sixty on the first honest measurement. The ceiling is a
runaway guard; the compute budget and the owner's own spend caps are the limits that are meant to
bind first.

The budget is visible to the model. Once most of it is spent the turn is told how many steps remain
and asked to judge whether the rest of the job fits; in the last few it is told to stop starting new
work, save what is unfinished, and finish with an honest account of what remains.

A turn that reaches the ceiling anyway does not die on it. It spends one more model call on a
restricted handoff turn where only `set_plan` and `finish` are available, and lands `completed`:
the plan is preserved rather than closed, the outstanding steps become the turn's caveats, and the
completion is explicitly not marked verified, because a handoff asserts the opposite of a verified
result. A note is written into the saved window telling the next turn that the previous one was cut
off and to continue from the first incomplete step rather than restart. Only if that final call
itself fails does the owner see an error, and it names the step count and says the work is saved.
Replying resumes the same task, on the same computer, with a fresh budget.

Foreground commands have time and output bounds. Background processes return IDs that can be listed,
polled, tailed, written to, or terminated. A tool call that was in flight when a worker restarted is
never repeated automatically: the doubt is returned to the model as that call’s own result, and it
must establish what actually happened before acting.

Scheduled tasks persist in PostgreSQL and use the same policy, memory, pinned model and privacy
route, and computer while clients are offline. They can be edited, triggered immediately, paused,
resumed, or removed. The ordinary UI offers once, interval, daily, and weekly choices; an advanced
control accepts validated five-field cron with IANA time zones, including DST-aware calendar
behavior. A scheduled run cannot recursively create more scheduled work.

## Delegation

`delegate` runs up to three isolated read-only specialists at once, on independent questions the lead
would otherwise answer in sequence: comparing a set of sources, reading a document collection for the
clauses that bind, reviewing part of a repository. Each gets the workspace file tools, private
document search and extraction, encrypted task search, repository search, `web_search`, and
`parallel_web_read` — which opens its own isolated browser rather than steering the persistent
session the lead and the owner share. Search is safe to delegate now that a challenge stops one tab
and one site rather than the whole browser: a specialist that walks into one costs that search and
nothing else, and a specialist that cannot search can only read sources somebody else already found.
Each runs at most sixteen steps against its own share of the task’s compute budget, on the strongest
eligible model for the task’s privacy route, and is told the current date and its own reporting
standard. The harness re-reads two of every specialist’s cited sources and checks the quoted spans
are really there, so a span it did not copy from the page comes back to the lead marked as not to
be trusted. Specialists cannot change anything,
cannot reach the owner, and cannot see each other or the lead’s conversation, so each mission must
stand alone. The lead remains responsible for every decision, every change, and the answer.

## Native persistent computer

There is one Linux userland: the host itself. The runner executes as the dedicated `athanor` account
with `HOME=/home/athanor`; commands the agent runs get their own `athanor-agent` account, so a
command cannot read the runner’s process, its capability signing secret, or the browser profile the
owner’s logins live in. Files, installed programs, browser state, CLI publisher credentials, and
long-running outputs persist across service and client restarts.

Private runner, database, API, registry, media, and preview ports bind only to loopback. The public
gateway is Nginx on 443. The runner’s shared secret is root-readable configuration and is never sent
to a model.

System packages are the only narrow privilege boundary. Approved apt operations pass through a
fixed root helper that validates package names and action shape. The agent cannot run arbitrary
`sudo`, `su`, `doas`, apt options, shell substitutions, or background privilege escalation.

`shell` runs one executable with an argument vector and performs no expansion at all: no pipe, glob
or redirect unless the model explicitly runs an interpreter and passes the script as an argument.

## Web search

`web_search` is one call that returns a page of ranked results — rank, title, url, site and snippet —
rather than a procedure the model has to improvise by driving a browser at a search engine.

The engine is DuckDuckGo’s no-JavaScript results endpoint. Every search API in this category wants
an account and a key, which a fresh box does not have and which would put a third party on the path
of every question the owner asks. Of the engines that answer without one, this is the only one that
both permits it — `html.duckduckgo.com` serves `Allow: /` to every user agent, where the engines
with richer results disallow their search paths outright — and renders title, link and snippet into
plain HTML, so reading a results page needs no more of the browser than reading any other page.

A search runs in an isolated browser with no profile, no cookies and no shared state, launched for
the search and closed after it, exactly as `parallel_web_read` does. It used to run in the session
browser, and that was wrong three ways with one shape: a challenge on the engine closed that host
for the rest of the session, taking the whole web capability off the task and leaving the tool’s own
advice — carry on elsewhere — with no elsewhere to point at; a search required the agent to be
holding the browser, so research stopped dead whenever the owner was using their own Chromium, which
athanor actively encourages; and three delegated specialists contended on that one session, so one
wall took down the lead and every specialist at once.

The session browser remains a second attempt and only a second attempt, because the original
argument for it survives in that narrower form: its profile persists, so a challenge the owner
cleared there stays cleared, and a search the isolated browser could not get is worth trying once
through the door the owner already opened. Ten results is one page; there is no second page, and the
model is told to re-query in different words rather than ask again for more.

## Browser and GUI

Chromium uses a persistent profile under the agent account. A snapshot returns the page URL and
title, readable text, a screenshot, every open tab with a stable tab id, images, recent console
errors, pending dialogs, recently saved downloads, and the interactive elements of the page and its
frames. Each element carries its selector, accessible name, submitted field name, current value,
checked state, whether it is required, disabled or currently invalid, the hint or error text beside
it, and every option of a select — so “what does this form hold now” is answered by reading, not by
guessing. `read_elements` returns that same list scoped to one container without the screenshot or
the page text, which is what makes checking a form cheap.

Actions are tab-scoped: every page action takes an optional tab id and every result says which tab it
acted on, so a background tab can be driven without disturbing what the owner is watching, and
`inspect_tab` reads a tab in place without bringing it to the front. A whole form goes in one batch
of up to twenty-four ordered actions that stops at the first failure and reports per step. Typing
picks between setting the value and sending real keystrokes, because a one-shot fill leaves a
typeahead or a keydown validator unopened. Waiting is condition-based rather than a sleep. Downloads
are saved into the workspace and their paths returned.

When a site raises an anti-bot challenge, the stop is scoped to what the challenge is actually about:
that tab, and that site. The runner refuses every further agent action on the stopped tab and every
navigation to that host for thirty minutes — so the retry the challenge is asking for cannot be made
by opening the same page in a fresh tab — and leaves every other tab and every other site working.
It is a hard stop in the runner, not advice to the model: no reload, no re-navigation, no touching
the widget. The message the model receives says what is still open to it and tells it to carry on
with the rest of the task elsewhere, because a stop that read as "the browser is gone" was what
turned one interstitial into a failed task.

The browser is not taken away from the agent, and the owner is not made to fix it. They are told:
the pane names the vendor and the host, and the agent raises a takeover notification so a phone
learns about it too. Taking control is one button, and it brings the stopped tab to the front;
handing the browser back clears every wall in the session, because a person having been there is the
best evidence there is that the page is passable. Owner actions are never gated by a wall.
`parallel_web_read` is unaffected either way — it opens its own isolated browser rather than
steering the shared session.

Linux GUI programs run in Xvfb/Openbox with a private D-Bus and AT-SPI accessibility bus. Semantic
actions are preferred; coordinate actions remain approval-sensitive. Passwords, CAPTCHAs, payment
details, and other secure input transfer control to the user and suspend agent observation.

## Coding specialists

`coding_agent` supports status, setup, and bounded missions:

- the official publisher CLI installs under the persistent agent home;
- login happens directly with the publisher in a user-visible terminal;
- Codex runs with JSON events and its own workspace sandbox;
- Claude Code runs with streaming JSON, bounded turns, and project MCP disabled for the delegated
  mission;
- OpenCode runs in non-sharing JSON mode with a fail-closed permission policy and uses only publisher
  logins that OpenCode officially supports;
- all three run from the selected repository, preserve resumable session IDs when the publisher
  exposes one, emit compact progress, and stop with the Athanor task;
- a task routed through provider ZDR cannot silently cross into a subscription CLI because publisher
  retention is a separate policy; and
- the lead model remains responsible for review, verification, and the user-facing result.

## Previews

User-started services stay on loopback and are published through an unguessable 32-hex-character path
under `/__athanor/preview/`, which Nginx matches exactly. The agent receives the current public base in its runtime block and returns
preview links in chat. Path-based proxying avoids a wildcard-domain requirement; applications that
hard-code root-relative assets may need an explicit base path.

A private preview has no lifetime the agent can choose and no clock counting down. What bounds it is
use: every visit pushes an idle deadline thirty days out, so an app the owner actually opens still
answers next month, and one they have forgotten closes itself rather than leaving a bearer token
sitting in a chat history. A port that a preview publishes cannot be one of athanor's own — the
runner is told the full set and refuses it. Nothing may publish the API or the database.

## Model continuity and vision

The selected lead owns the plan and final answer. Routing reads the live registry rather than the
snapshot taken when the task was leased, and a model advertised as vision-capable is only sent an
image when its current modalities still accept one and its route satisfies the task’s privacy
setting. When the lead cannot inspect a required image, Athanor selects an eligible vision route,
asks a bounded observation question, and returns that evidence to the lead; when no eligible
specialist exists, or the specialist call fails, the lead is told so explicitly and works from the
semantic tool output alone. The UI explains the handoff before execution.

## Memory and skills

Encrypted task history is searchable. Durable memory is separate:

- user memory follows the owner;
- computer memory records project/environment conventions;
- adds, replacements, and removals pause for review;
- each fact can carry its source owner or agent, source task, preceding update time, and
  `validFrom`/`validUntil` window;
- only currently active facts enter model context, while expired and upcoming facts remain
  inspectable instead of being silently deleted;
- credentials and sensitive ephemeral content are forbidden; and
- size limits force consolidation instead of unbounded prompt growth.

Recall is lexical throughout, and the semantic channel was removed rather than finished. Migration
35 had created `halfvec(1024)` columns on `mem.item` and `mem.source`, two partial HNSW indexes over
them, and an `embed_state` enum to sequence a queue that did not exist. Nothing ever wrote a vector
and no query ever read one, so what shipped was an index of nothing and a capability flag reporting
a channel the retrieval query had no branch for — which is worse than not having it, because it
reads as a component the main path depends on. Migration 54 drops the columns, the indexes and the
enum. The `vector` extension itself is left alone: that migration removes what athanor put in the
database, and an extension the owner may be using elsewhere is not athanor's to withdraw.

Finishing it is not a question of where to get vectors. Memory bodies are sealed before they reach
PostgreSQL and are searchable only through a keyed blind index, so the database never holds the
plaintext; an embedding is a dense derivative of that same plaintext, close enough that the text can
be reconstructed from the vector, and it would have to sit unencrypted beside the ciphertext to be
searchable at all — handing anything with read access on the database a recoverable copy of exactly
the text the encryption is there to hide. That is true whatever produced the vector, including a
model running on this computer, which is why it is the reason of record. The other costs are real
and secondary: an embedding API puts a second vendor on the write path for the most private text on
the box, which the no-third-party-SaaS rule forbids on a core path, and a local model is a new
runtime dependency for a corpus of a few thousand rows.

What a vector index would buy here is reaching a stored row from a paraphrase sharing none of its
words, and that is narrowed rather than closed by letting the agent ask its own memory a question.
The recalled pack is chosen once, from the opening request, and frozen so the cached prefix survives
the task — right for what a task opens with and wrong for what it turns out to need. `memory_recall`
runs the same fusion query again mid-task, in the agent's own words, landing after the last cache
breakpoint so it costs the question and its answer rather than the window behind them. It excludes
what the pack already printed and says which entries those were, so an empty result means there is
nothing further rather than nothing at all; and `asOf` retrieves what was believed true at an
earlier instant, which is how a question about what changed gets an answer. That is the same
reformulation an embedding approximates, made by something that understands the paraphrase — and
asking again differently is a move the model already has. What it cannot reach is the opening pack,
which is built before the agent has said anything, so the gap survives: the committed memory eval
carries a probe that misses for exactly this reason and asserts that it still misses, which keeps
the price of the encryption measured rather than talked out of existence.

Skills are reviewed, versioned procedures with an index description, status, use count, pin state,
and full Markdown body loaded only when relevant. Two tiers reach the model by name: the vetted
built-in library that ships in the repository, and the procedures saved for this workspace. Built-in
skills are read-only; reusing a built-in name is reviewed as an explicit owner override that shadows
it for this workspace rather than replacing it.

## Files as knowledge

The computer’s files are the source of truth. `document_search` performs bounded, source-linked BM25
retrieval across supported local formats, with phrase/title/coverage bonuses and per-file result
diversity; `document_read` extracts grounded content and PDF page ranges. The lead can expand queries
with synonyms and inspect multiple documents agentically.

This deliberately avoids a second vector database, automatic document upload, opaque embeddings, and
silent permanent ingestion. The trade is explicit: lexical search cannot retrieve a passage that
shares no wording with the query. In exchange there is no embedding model, no duplicate copy of the
owner's documents, and no index that goes stale when a file changes. Source-linked private search is
the boundary, not a stepping stone to another index.

## Approval policy

| Mode       | Ordinary files/code | Network/package install | External side effect |
| ---------- | ------------------- | ----------------------- | -------------------- |
| Review     | Confirm             | Confirm                 | Confirm              |
| Balanced   | Allow               | Confirm                 | Confirm              |
| Autonomous | Allow               | Allow                   | Confirm at floor     |

All modes still protect credentials, submissions, messages, purchases, public publishing,
destructive system/filesystem actions, ambiguous coordinates, connected-service writes/deletes,
subscription coding missions, and remote MCP execution. Autonomous still confirms network access for
an executable outside the read-only and package-install allowlists.

An approved action is bound to the arguments the owner saw: the approval row stores an HMAC over
them, and the resume path recomputes it before executing, so an approval cannot be spent on a
different call than the one it was granted for.
