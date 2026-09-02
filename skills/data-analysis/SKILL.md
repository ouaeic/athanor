---
name: data-analysis
description: Clean a messy dataset and analyse it with a saved, re-runnable script that states its assumptions, so the numbers can be reproduced and audited rather than asserted. Use when the request involves a CSV, TSV, parquet file, database extract or pasted table and the deliverable is an answer, a summary statistic, a comparison or a chart. Do not use when the deliverable is a formula workbook the owner will edit, which belongs to xlsx-authoring.
license: AGPL-3.0-or-later
compatibility: pandas, matplotlib, Pillow, scipy and statsmodels are installed on every supported host, through /usr/local/lib/athanor/python/bin/python3. Reading a parquet file needs pyarrow on top of pandas; a fresh install of this computer places the host's pyarrow package and a box that has only been updated may not have it, so import it before promising anything about a .parquet file. scikit-learn is not installed anywhere and is not part of this skill.
allowed-tools: shell file_read file_write files_list document_read image_read set_acceptance publish_artifact
metadata:
  athanor.tier: 'builtin'
  athanor.version: '2.4.0'
  athanor.risk: 'workspace'
  athanor.domain: 'data'
---

# Data analysis

Profiling a file before trusting its dtypes, printing the row count after every transform, naming
what happened to the missing values, reporting `n` beside every rate — that is the work, and you do
it without being told. Four things here are about this computer rather than about analysis.

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

## Parquet is the one format that needs an import checked first

`pandas.read_parquet` carries no reader of its own. Without pyarrow it raises `ImportError` naming
pyarrow and fastparquet, and it raises it inside the read rather than at import time - so a script
that profiles three CSVs and reaches the parquet file on the fourth step fails a minute into a run
the owner is watching. Run `import pyarrow` once, first, before any promise about a `.parquet` file.

Where it is absent the recovery is one operating-system package - `python3-pyarrow` on a Debian,
Ubuntu, Fedora or openSUSE host and `python-pyarrow` on an Arch one - installed through the shell as
an approval the owner sees, never through `pip`, which would stack a second compiled Arrow beside
the distribution's own inside an interpreter built with `--system-site-packages`. Converting the
file to CSV is not the recovery: parquet carries dtypes and CSV does not, so the conversion is where
a decimal becomes a float, a category becomes a string, and `007` becomes `7` on the way back in.

scikit-learn is not on this computer and is not planned. A household or research dataset gets an
answer with a stated confidence from scipy and statsmodels; if a question genuinely needs a fitted
model rather than a statistic, say that plainly and ask, because it is one approved install and not
an impossibility.

## Where the chart is going decides how it is drawn

There is one answer per destination, and it is the reason to decide before drawing anything:

- **A slide deck or a workbook** — a native chart built there, with `pptx-authoring` or
  `xlsx-authoring`. It stays editable, keeps the theme, and moves when the numbers do. Pasting a
  matplotlib PNG into a deck is the defect those skills exist to prevent, so hand the aggregated
  table over and let them draw it.
- **A document, a report, or a standalone image** — matplotlib, rendered to PNG at 150 dpi and then
  looked at with `image_read` before it is used anywhere.
