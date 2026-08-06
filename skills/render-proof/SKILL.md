---
name: render-proof
description: Prove that a generated .docx, .pptx, .xlsx or PDF actually looks right by validating its structure, rendering every page to an image, running mechanical checks for overflow, blank pages, placeholder text and missing fonts, then looking at the images. Use after producing any visual deliverable and before showing it to the owner. Do not use for plain text, Markdown, JSON or source code, which have no rendered form.
license: AGPL-3.0-or-later
compatibility: Every tool named here is installed on this computer by athanor - athanor-office-convert, typst, poppler-utils, qpdf, and the interpreter at /usr/local/lib/athanor/python/bin/python3.
allowed-tools: shell file_read files_list document_read image_read publish_artifact
metadata:
  athanor.tier: 'builtin'
  athanor.version: '2.2.0'
  athanor.risk: 'workspace'
  athanor.domain: 'output-quality'
---

# Render proof

A file that was written without an error is not a file that is correct. Text-box overflow,
truncated table columns, blank pages, substituted fonts and `#REF!` cells all produce structurally
valid documents. This is the one pipeline that catches them, and every visual deliverable goes
through it before the owner sees it.

Two names are used throughout and there is no alternative to either:

- **`athanor-office-convert IN OUT`** converts a Word, PowerPoint or Excel file. The target format
  comes from the output extension. It exits non-zero when the bytes are not there, which bare
  LibreOffice does not.
- **`/usr/local/lib/athanor/python/bin/python3`** is the Python that has python-pptx, python-docx,
  openpyxl, pandas, matplotlib, Pillow and pypdf. Plain `python3` does not have pypdf. Write the
  path out in full every time.

Work in `workspace/proofs/<artifact-stem>/`. Delete that directory at the start of every run, or
you will grade last run's pages. Keep the images; they are attached to the reply.

## Stage 1 — structural validation

| Artifact          | Command                                                                                                                                                                 | Failure                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| PDF               | `qpdf --check out.pdf`                                                                                                                                                  | any error line, or exit 2      |
| .docx/.pptx/.xlsx | `/usr/local/lib/athanor/python/bin/python3 -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip(), '[Content_Types].xml' in z.namelist())" out.docx` | non-`None` testzip, or `False` |
| .xlsx             | reopen with `openpyxl.load_workbook(path)` and with `load_workbook(path, data_only=True)`                                                                               | either raises                  |
| Typst source      | `typst compile in.typ out.pdf`                                                                                                                                          | non-zero exit, or any warning  |

A convergence warning from Typst means the layout never stabilised. Treat it as a failure, not a
warning: the page you get is not the page the source describes.

## Stage 2 — render to images

Everything goes down one path: to a PDF first, then to JPEGs.

```
athanor-office-convert out.docx proofs/out.pdf     # .docx, .pptx and .xlsx all go this way
typst compile report.typ proofs/out.pdf            # Typst source
pdftoppm -jpeg -r 120 proofs/out.pdf proofs/p
```

`pdftoppm` writes `p-01.jpg`, `p-02.jpg`, … Render at 120 dpi: high enough to read 8pt type, low
enough that a 40-page document stays inspectable.

Do not author through HTML. `print_pdf` exists and captures whatever the browser is showing, which
is the right tool for keeping a page that already exists and the wrong one for producing a
document: nothing in it controls where the pages break. A deliverable that has to be a PDF is
authored in Typst (`typst-pdf`); a deliverable that is a web page stays a web page.

## Stage 3 — mechanical checks

Run all of these. They are fast and they catch most real defects without a model.

1. **Page or slide count.** `pdfinfo proofs/out.pdf | grep Pages`. Compare against what the task
   asked for. A 12-slide deck that renders 9 pages lost content. A CV asked for as one page that
   renders two is not finished.
2. **Blank page detection.** A page whose JPEG is under ~6 KB at 120 dpi is almost certainly blank.
   `find proofs -name 'p-*.jpg' -size -6k` — investigate every hit.
3. **Overflow detection — the single most valuable check.** Extract the text back out of the
   rendered PDF and compare it against the text you placed:
   `pdftotext -layout proofs/out.pdf proofs/out.txt`
   A word-count deficit above ~2% means content fell off a page or out of a text box. PowerPoint
   text boxes do not grow; they clip, silently, with no error anywhere.
4. **Placeholder scan.**
   `grep -n -E '\bTODO\b|\bLorem\b|\{\{|\bXXX\b|\bundefined\b|\bNaN\b|\bnan\b|\bNone\b|#REF!|#VALUE!|#N/A' proofs/out.txt`
   Any hit is a failure. `None` and `nan` catch Python values that leaked into a template. The word
   boundaries are load-bearing: an unbounded `nan` matches "finance", "maintenance" and
   "governance", so it fires on essentially every business document, and a check that always fires
   is a check that gets skipped.
5. **Embedded fonts.** `pdffonts proofs/out.pdf` — every row must show `yes` in the `emb` column.
   A `no` means the owner's machine substitutes and every line moves.
6. **Image resolution.** `pdfimages -list proofs/out.pdf` — flag any image whose x-ppi or y-ppi is
   below 110. Screenshots pasted at 72 dpi look soft in print.
7. **Spreadsheet recalculation.** For .xlsx only, recalculate and count error cells; the procedure
   is in `xlsx-authoring`. `error_cells` must be 0.
8. **Reading order, when a machine reads it before a human does.** For anything that will be parsed
   before it is read — a CV going into an applicant tracking system, an invoice going into a
   procurement system — `proofs/out.txt` from check 3 must contain the name, every date range and
   every heading in the order a person would read them. A multi-column layout looks best on screen and
   extracts as interleaved mush, which is what the parser stores and what a human is later shown.
   Rebuild it single-column; there is no fixing it downstream.

## Stage 4 — look at the pages

Call `image_read` on every rendered page, or at least the first, the last, and every page a
mechanical check flagged. Grade each against this fixed rubric and report pass/fail with one line
of reason, not prose:

- text overlapping other text, an image, or the page edge;
- text truncated with an ellipsis or cut mid-word;
- a table whose right-hand columns are missing, or whose rows split across a page break mid-record;
- a chart with unlabelled axes, an unreadable legend, or overlapping category labels;
- body text below roughly 9pt, or contrast too low to read;
- inconsistent typography between sections, which is what template drift looks like;
- a page that is blank or contains only a heading.

## Stage 5 — attach the proof

Publish the deliverable with `publish_artifact`, then attach the page images. The owner should be
able to see what the file looks like without opening it. `verification-evidence` treats a visual
deliverable with no proof set as incomplete.

## Failure modes

- **Grading only the first page.** Overflow accumulates: page 1 is usually fine and page 7 is where
  the table breaks.
- **Accepting a deficit as rounding.** A 15% word-count deficit is not rounding; it is a lost
  section. Find it.
- **Rendering the wrong file.** A stale PDF from a previous run passes every check and describes
  nothing. Delete `proofs/` first, every time.
- **Reading `pdffonts` too quickly.** `emb` is the third column, and a font can be Type 1 and still
  not embedded.
- **Treating the structural check as the proof.** A .pptx whose zip is intact and whose slide count
  is right can still have every bullet clipped in half.
