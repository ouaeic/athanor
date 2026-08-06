---
name: citation-discipline
description: Attach a resolvable source and a verbatim quoted span to every factual claim, then re-fetch each source before delivery and confirm the quote still supports the claim. Use whenever research, a briefing, a vendor or market comparison, or any answer the owner might act on carries facts, numbers, dates or attributed statements. Do not use for the owner's own data, for arithmetic derived in the answer itself, or for clearly labelled opinion.
license: AGPL-3.0-or-later
compatibility: Requires the athanor browser runner for re-fetching; no other binaries.
allowed-tools: parallel_web_read web_search browser_snapshot browser_action document_read document_search file_write
metadata:
  athanor.tier: 'builtin'
  athanor.version: '1.1.0'
  athanor.risk: 'read_only'
  athanor.domain: 'research'
---

# Citation discipline

More searching does not make a report more accurate. Factual accuracy against cited sources
degrades sharply as tool-call count climbs, while link validity and topical relevance stay flat —
so the surface metrics look fine while the substance rots. The defence is not more sources; it is
verifying the ones you used.

## Two things to decide before searching

Both are cheap now and impossible later, because once you are in the material you will not set them
honestly.

- **What would change the conclusion.** Name the disconfirming evidence before the first search.
  Without it, searching becomes a hunt for support: the conclusion forms in the first few pages and
  every later source is read for whether it agrees.
- **When comparing options, the criteria and their weights.** Write them down before any score is
  filled in. Criteria chosen after the winner is known produce a table that looks like analysis and
  is a rationalisation.

## The unit of evidence

Every factual claim carries, from the moment it is written:

```
claim: "Typst 0.15 added simultaneous PDF/A and PDF/UA conformance."
source: https://typst.app/docs/changelog/  (fetched 2026-08-01)
quote:  "…simultaneous PDF/A and PDF/UA conformance…"       (≤25 words, verbatim)
locator: section "0.15.0" / page 3
```

Rules:

- The quote must be **verbatim** and must be found in the fetched text. If you cannot locate a
  span that entails the claim, the claim is not supported — weaken it or drop it.
- The quote must **entail** the claim on its own. "Revenue grew" does not support "revenue grew
  18%". This is where paraphrase drift happens.
- A locator is mandatory: page number for a PDF, section heading or anchor for a page, timestamp
  for a video, row identifier for a dataset.
- One source per claim minimum; two independent ones for anything contested, load-bearing, or
  surprising.

## Source quality

Rank and prefer, in this order: the primary artifact (the specification, the filing, the dataset,
the source code, the court document) → the organisation's own publication → a specialist outlet
that cites the primary → general reporting → aggregators. Never cite an aggregator or a search
snippet as the source of a fact; open the thing it points at.

Freshness bar: decide before searching how old a source may be for this question. Prices, versions,
personnel, regulations and availability go stale in months. Say the bar in the report, and record
the fetch date on every citation.

An organisation's claims about itself are evidence of what it says, not of what is true. Attribute:
"the vendor states". A benchmark published by the vendor of the winning product is a marketing
document; label it.

## Unsupported claims are labelled, not deleted

If something is probably true but you have no source, keep it and mark it. Silently deleting it
loses information; silently keeping it launders a guess into a fact.

```
[unverified] The migration is believed to have completed in Q1; no primary source located.
```

Distinguish four states explicitly: **verified** (source + quote checked), **reported** (a source
says it, attributed, not independently confirmed), **inferred** (derived by you from verified
facts, with the derivation shown), **unverified**.

## Verification pass before delivery

This is mandatory and it is where errors are actually caught. For every citation:

1. **Re-fetch** the URL now — with `parallel_web_read` for up to twelve at a time, or
   `document_read` for local files. A link that resolved during research may 404, redirect to a
   generic page, or have been edited.
2. **Locate the quote verbatim** in the freshly fetched text. Normalise typographic quotes,
   ligatures and hyphenation before matching; a failed match is often a formatting artefact rather
   than a missing quote, but you must confirm which.
3. **Re-read the claim against the quote** and ask whether the quote alone establishes it. Fix or
   downgrade every claim that fails.
4. **Check the fetch did not land on a login wall, cookie interstitial or paywall.** Those return
   200 with plausible text and none of the content.
5. Record the outcome per citation: `ok`, `moved` (new URL), `changed` (quote no longer present),
   `dead`. Report anything that is not `ok`. For a `dead` link, one `web_search` on the title or a
   distinctive phrase from the quote usually finds where the page went; verify the relocated page
   still carries the quote before repointing the citation at it.

Cap depth deliberately: a fixed number of sources per sub-question, decided up front. When the
budget is spent, verify what you have rather than searching more.

## Failure modes

- **A contradiction resolved by quietly picking one source.** Record both the moment you see it,
  and say in the answer which you relied on and why. This is the most damaging thing a researched
  answer can contain, because nothing in it looks wrong.
- **False precision.** "Roughly 20–30%, from two vendor estimates" is more useful and more honest
  than "24%". A number carried forward without its uncertainty is read as measured.
- **Citation drift.** The claim is edited during writing and the citation stays attached to the
  older, narrower statement. Re-check the pair, not just the link.
- **Quoting the abstract for a result in the paper.** Abstracts overstate. Cite the section.
- **Citing a page that cites a page.** Follow to the primary; the intermediate frequently
  misstates the number.
- **A number transcribed with the wrong unit or year.** Copy numbers from the quote, never from
  memory of the quote.
- **Treating a 200 response as a successful fetch.** Check the fetched text actually contains the
  article.
- **Dropping provenance through summarisation.** Every compaction pass erodes attributions. Write
  claims as reported speech so the attribution survives inside the sentence.
