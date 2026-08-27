---
name: data-analysis
description: Clean a messy dataset and analyse it with a saved, re-runnable script that states its assumptions, so the numbers can be reproduced and audited rather than asserted. Use when the request involves a CSV, TSV, parquet file, database extract or pasted table and the deliverable is an answer, a summary statistic, a comparison or a chart. Do not use when the deliverable is a formula workbook the owner will edit, which belongs to xlsx-authoring.
license: AGPL-3.0-or-later
compatibility: Every tool named here is installed on this computer by athanor - pandas, matplotlib, Pillow, scipy and statsmodels through /usr/local/lib/athanor/python/bin/python3.
allowed-tools: shell file_read file_write files_list document_read image_read set_acceptance publish_artifact
metadata:
  athanor.tier: 'builtin'
  athanor.version: '2.3.0'
  athanor.risk: 'workspace'
  athanor.domain: 'data'
---

# Data analysis

Profiling a file before trusting its dtypes, printing the row count after every transform, naming
what happened to the missing values, reporting `n` beside every rate — that is the work, and you do
it without being told. Three things here are about this computer rather than about analysis.

## The script is half the deliverable

Never analyse in the chat window. Write `workspace/analysis.py`, run it with the pinned interpreter,
and keep it: it is what makes the numbers checkable and re-runnable next month, and re-running it
from a clean interpreter for identical output is the natural `set_acceptance` command check — the
interpreter, the script, exit 0, and a control total the run must print.

## What the pinned interpreter already carries

`/usr/local/lib/athanor/python/bin/python3` has **pandas, matplotlib, Pillow, scipy and
statsmodels** installed. So a confidence interval, a p-value, a trend coefficient, a seasonal
decomposition and a multiple-comparison correction are computed by a library that is already here,
never by you from memory — `scipy.stats` and `statsmodels` between them cover every test worth
running on a dataset this size. A formula written from memory produces a number that looks exactly
like a correct one and arrives in the same confident sentence, and afterwards neither the owner nor
the script can tell the difference. State the test and its assumptions in the script beside the
number it produced; if nothing in those two libraries fits the question, say the question is not
answerable from this data rather than approximating one.

## Where the chart is going decides how it is drawn

There is one answer per destination, and it is the reason to decide before drawing anything:

- **A slide deck or a workbook** — a native chart built there, with `pptx-authoring` or
  `xlsx-authoring`. It stays editable, keeps the theme, and moves when the numbers do. Pasting a
  matplotlib PNG into a deck is the defect those skills exist to prevent, so hand the aggregated
  table over and let them draw it.
- **A document, a report, or a standalone image** — matplotlib, rendered to PNG at 150 dpi and then
  looked at with `image_read` before it is used anywhere.
