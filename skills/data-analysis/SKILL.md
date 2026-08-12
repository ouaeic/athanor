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

Never analyse in the chat window. Write `workspace/analysis.py`, run it with
`/usr/local/lib/athanor/python/bin/python3`, and keep it. The script is half the deliverable: it is
what makes the numbers checkable and re-runnable next month.

## Profile before touching anything

```python
import pandas as pd
df = pd.read_csv(path, dtype=str, keep_default_na=False)   # read everything as text first
print(df.shape); print(df.head(20).to_string()); print(df.dtypes)
for c in df.columns:
    print(c, df[c].nunique(), df[c].isin(['', 'NA', 'N/A', 'null', '-']).sum())
```

Reading as text first is deliberate. pandas' type inference silently turns `007` into `7`, a
column of mixed dates into objects, and an ID column with one alphabetic value into a string while
the rest of the file is float — after which the join fails and the row count is wrong.

Record, in the script as comments: the row count, the column count, and the file's own claim about
what it contains. Then check whether the header is actually on row 1; exported spreadsheets often
carry two title rows and a blank one.

## Clean explicitly, one transform per step

Each step is a line in the script with a comment saying why, and each step prints the row count
after it. A row count that drops from 12,004 to 9,812 across a "cleaning" step must be explained
before the analysis continues.

- Trim whitespace and normalise case on join keys before joining, not after.
- Parse dates with an explicit format: `pd.to_datetime(s, format='%d/%m/%Y', errors='coerce')`,
  then count the `NaT`s. Never let pandas guess; `01/02/2026` is ambiguous and it will pick one.
- Strip currency symbols and thousands separators before `astype(float)`; check for negatives
  written as `(1,234)`.
- Deduplicate on a stated key: `df.duplicated(subset=key).sum()` first, then decide whether
  duplicates are errors or legitimate repeats. Do not drop them by reflex.
- Handle missing values by naming the choice: dropped, zero-filled, forward-filled, or left as NA
  and excluded from that statistic. Write which, per column.

## Analyse

- State the question the numbers answer, in the script, above the code that answers it.
- Use `groupby(...).agg(...)` with named aggregations so column names describe the statistic.
- Report `n` alongside every mean, rate or percentage. A 100% conversion rate on n=2 is noise.
- When comparing groups, check the base rates first; a difference in composition explains most
  apparent differences in outcome.
- Round only at presentation time, never in intermediate steps.
- For a file too large to hold in memory, read it in chunks and aggregate as you go — pandas holds
  the whole of this on its own:
  ```python
  totals = None
  for chunk in pd.read_csv(path, dtype=str, keep_default_na=False, chunksize=250_000):
      part = clean(chunk).groupby('region', dropna=False)['amount'].agg(['sum', 'count'])
      totals = part if totals is None else totals.add(part, fill_value=0)
  ```
  Apply exactly the same cleaning function to every chunk, and print the running row count per
  chunk so a partial read cannot pass as a whole one.

## Never compute a statistic in your head

A confidence interval, a p-value, a trend coefficient and a seasonal adjustment are computed by a
library on this computer, never by you. A formula written from memory produces a number that looks
exactly like a correct one and arrives in the same confident sentence, and afterwards neither the
owner nor the script can tell the difference.

- Two groups' means: `scipy.stats.ttest_ind(a, b, equal_var=False)`. Report the interval, not only
  the p-value, and give n for each group.
- Two rates or proportions: `statsmodels.stats.proportion.proportions_ztest`, with
  `proportion_confint` for the interval on each.
- "Is this month genuinely up on last?" — one month against one month is two numbers and supports
  no test. Say so, then fit the trend over the whole series with `statsmodels.formula.api.ols` and
  report the slope with `.conf_int()`.
- A monthly or weekly series with a repeating shape: `statsmodels.tsa.seasonal.seasonal_decompose`
  before reading any month-on-month change, because the season is usually the whole of the change.
- Correlation: `scipy.stats.pearsonr` or `spearmanr`, which return the p-value with the
  coefficient. Never report a correlation without n.
- Many comparisons at once: `statsmodels.stats.multitest.multipletests`. Twenty columns tested at
  p < 0.05 yield one false finding by construction.

State the test used and its assumptions in the script, beside the number it produced. If no test in
these two libraries fits the question, say the question is not answerable from this data rather
than approximating one.

## Charts

Where the chart is going decides how it is drawn, and there is one answer per destination:

- **A slide deck or a workbook** — a native chart built there, with `pptx-authoring` or
  `xlsx-authoring`. It stays editable, keeps the theme, and moves when the numbers do. Pasting a
  matplotlib PNG into a deck is the defect those skills exist to prevent, so hand the aggregated
  table over and let them draw it.
- **A document, a report, or a standalone image** — matplotlib, below.

Render with matplotlib to PNG at 150 dpi and look at the result with `image_read` before using it.

```python
fig, ax = plt.subplots(figsize=(8, 4.5), dpi=150)
ax.set_xlabel('Month'); ax.set_ylabel('Revenue (ZAR)'); ax.set_title('...')
fig.tight_layout(); fig.savefig('charts/revenue.png')
```

Always label both axes and state units. Start a bar chart's value axis at zero. Do not use a second
y-axis; produce two charts. Sort categorical bars by value, not alphabetically, unless the category
has a natural order.

## Verify

1. Re-run the whole script from a clean interpreter and confirm identical output. An analysis that
   depends on cell execution order is not reproducible. This is the natural `set_acceptance`
   command check for an analysis: the interpreter, the script, exit 0, and a control total the run
   must print.
2. Reconcile one number by an independent route — a `SELECT count(*)` against the source, a
   spot-check of five raw rows, or a total that must equal a known control figure.
3. Sanity-check the direction: does the biggest category make sense? Are there negative durations,
   future dates, ages above 120?
4. State assumptions and exclusions in the answer, with the row counts they affected.

## Failure modes

- **Silent row loss in a join.** An inner join on a dirty key drops rows without complaint. Always
  print the row count before and after, and check `how='left'` with an indicator column.
- **Aggregating over a filtered frame you forgot you filtered.** Name intermediate frames
  descriptively (`orders_2026`, not `df2`).
- **Mixed encodings.** A `UnicodeDecodeError` on read means the file is probably cp1252; read with
  `encoding='cp1252'` rather than `errors='ignore'`, which corrupts names.
- **Reporting a percentage without a denominator.** Always say what it is a percentage of.
- **Believing an outlier.** A single 10,000x value is usually a unit error or a test record. Check
  the raw row before it drives a conclusion.
