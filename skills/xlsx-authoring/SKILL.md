---
name: xlsx-authoring
description: Build or edit .xlsx workbooks with live formulas rather than pasted values, correct number formats, named ranges and native charts using openpyxl, then force a real recalculation and assert zero error cells. Use when the deliverable is a spreadsheet, budget, financial model, tracker or Excel file, or when formulas in an existing workbook are wrong. Do not use when the deliverable is a CSV dump, a chart image, or a written report about data.
license: AGPL-3.0-or-later
compatibility: Every tool named here is installed on this computer by athanor - openpyxl and pandas through /usr/local/lib/athanor/python/bin/python3, plus athanor-office-convert for the recalculation.
allowed-tools: shell file_read file_write files_list document_read image_read publish_artifact
metadata:
  athanor.tier: 'builtin'
  athanor.version: '2.0.0'
  athanor.risk: 'workspace'
  athanor.domain: 'spreadsheets'
---

# Spreadsheet authoring

A workbook whose derived cells hold numbers instead of formulas is a screenshot. The owner changes
an input and nothing moves. Write formulas.

Run every script here with `/usr/local/lib/athanor/python/bin/python3`.

## Structure

Three-layer layout for anything with logic in it:

1. `Assumptions` — every input, one per row, each with a label, a unit, a value and a source note.
   Nothing anywhere else in the workbook is a typed number except raw data.
2. `Data` — imported records, untouched, one table.
3. Calculation and output sheets — formulas only, referencing the other two by named range.

Name the inputs:
`wb.defined_names.add(DefinedName('tax_rate', attr_text="Assumptions!$C$4"))`.
`=revenue*tax_rate` is reviewable; `=B12*$C$4` is not.

## Formula compatibility — non-negotiable

Verification recalculates through LibreOffice, so the formulas must be ones LibreOffice can
evaluate. This is not a preference; a formula it cannot evaluate becomes `#NAME?` and every cell
downstream of it becomes wrong while the file still opens.

- **Safe**: `SUM`, `SUMIFS`, `COUNTIFS`, `AVERAGEIFS`, `INDEX`, `MATCH`, `IFERROR`, `SUMPRODUCT`,
  `NPV`, `IRR`, `XNPV`, `XIRR`, `EOMONTH`, `EDATE`, `TEXT`, `ROUND`.
- **Needs the `_xlfn.` prefix when written by openpyxl**: `TEXTJOIN`, `CONCAT`, `IFS`, `SWITCH`,
  `MAXIFS`, `MINIFS`. Write `=_xlfn.TEXTJOIN(", ",TRUE,A1:A5)`; Excel displays it correctly.
- **Never emit**: `XLOOKUP`, `XMATCH`, `SORT`, `SORTBY`, `FILTER`, `UNIQUE`, `SEQUENCE`, `LET`,
  `LAMBDA`, `TEXTSPLIT`. Use `INDEX`/`MATCH` instead of `XLOOKUP`.
- Quote sheet names containing spaces: `='Cash Flow'!B4`.

Scan for the forbidden set before converting anything — it costs nothing and saves a round trip:

```python
FORBIDDEN = ('XLOOKUP','XMATCH','SORTBY','FILTER(','UNIQUE(','SEQUENCE(','LET(','LAMBDA(','TEXTSPLIT')
bad = [f'{s.title}!{c.coordinate}' for s in wb for r in s.iter_rows() for c in r
       if isinstance(c.value, str) and c.value.startswith('=')
       and any(f in c.value.upper() for f in FORBIDDEN)]
```

## Writing with openpyxl

```python
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment
from openpyxl.utils import get_column_letter

wb = Workbook(); ws = wb.active; ws.title = 'Assumptions'
ws['A1'] = 'Input'; ws['A1'].font = Font(bold=True)
ws.freeze_panes = 'A2'
```

- **Number formats carry the meaning.** `cell.number_format = '#,##0'` for counts, `'0.0%'` for
  rates, `'"R"#,##0.00'` for currency, `'yyyy-mm-dd'` for dates. A percentage stored as 0.185 with
  General format displays as 0.185 and reads as a bug.
- **Column widths**: `ws.column_dimensions['B'].width = max(12, longest_value_length + 2)`. A
  column too narrow renders as `#####` in the PDF proof.
- **Freeze the header row** on every sheet with a table, and add `ws.auto_filter.ref = ws.dimensions`.
- **Merged cells**: write only the top-left anchor. Writing to any other cell of a merged range
  raises or is discarded.
- **Bulk data**: load with pandas, then write with
  `for row in dataframe_to_rows(df, index=False, header=True): ws.append(row)`. Do not use
  `df.to_excel` when the sheet also needs formulas — it will overwrite them.
- **Charts**: `openpyxl.chart.BarChart()` + `Reference(ws, min_col=..., min_row=...)`, then
  `ws.add_chart(chart, 'F2')`. Set `chart.y_axis.title` and `chart.x_axis.title`; an unlabelled
  axis fails the proof.
- **Conditional formatting** for anything the owner is meant to scan: `ColorScaleRule` on variance
  columns, `CellIsRule` for thresholds.

## Editing an existing workbook

Two-pass read, because openpyxl gives you either formulas or values, never both:

```python
formulas = load_workbook(path)                 # .value is the formula string
values   = load_workbook(path, data_only=True) # .value is the last cached result
```

`data_only=True` returns `None` for every formula cell if the file was never opened by a
spreadsheet application — that is not an empty sheet, it is a missing cache. Recalculate first.

For `.xlsm`, pass `keep_vba=True` on load _and_ save, or the macros are stripped without warning.

## Recalculation and verification

openpyxl does not evaluate formulas. It writes the formula string and no cached value, so a
workbook straight out of openpyxl shows blanks in some viewers until it is recalculated. One
command does it, and converting a workbook to `.xlsx` is what makes it recalculate:

```
athanor-office-convert model.xlsx model.recalc.xlsx
/usr/local/lib/athanor/python/bin/python3 scripts/count_error_cells.py model.recalc.xlsx
```

`count_error_cells.py` ships with this skill. It exits non-zero when any cell holds an Excel
error value **or** when any cell still holds a formula string with no cached result, and prints
both counts as JSON.

Three things must hold:

1. `error_cells` is 0. `#REF!` is a deleted reference, `#VALUE!` a type mismatch, `#NAME?` an
   unrecognised function — that last one is how a forbidden modern function announces itself.
2. Every formula cell in the recalculated copy holds a value, not `None`. `None` everywhere means
   the recalculation did not happen and the owner will open the file to blanks.
3. At least one headline number — a grand total, a margin — matches the same arithmetic done
   independently in Python from the source data. A workbook that recalculates to the wrong answer
   passes checks 1 and 2.

Then run `render-proof` on the recalculated copy and inspect the pages for `#####` columns, tables
split across pages, and unlabelled charts.

Deliver the original formula workbook, not the recalculated copy — but only after the copy passed.

## Failure modes

- **Values instead of formulas.** Computing in pandas and writing the results. The workbook is dead
  on arrival. Compute in the sheet.
- **A missing recalculation.** Formulas present, no cached values, owner opens it and sees blanks
  until they press F9. Always round-trip through `athanor-office-convert`.
- **Dates as strings.** `'2026-01-31'` sorts and filters as text. Write `datetime.date` objects and
  set the number format.
- **Percentages doubled.** Storing 18.5 with format `0.0%` displays 1850%. Store 0.185.
- **A chart pointing at the wrong range** after rows were inserted. Re-check `Reference` bounds
  after any structural change.
- **Zero error cells taken as correct.** It means nothing broke, not that the model is right.
  Reconcile a number.
