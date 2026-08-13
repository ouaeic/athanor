---
name: verification-evidence
description: Decide what counts as proof that a task is actually done, gather that proof with the tools that produce it, and refuse to report completion without it. Use before calling finish, whenever a deliverable file has been written, and whenever a command "succeeded" but nothing was inspected. Do not use as a substitute for the format-specific verification in render-proof, xlsx-authoring or code-change; this skill decides what evidence is required, those produce it.
license: AGPL-3.0-or-later
compatibility: No external binaries required.
allowed-tools: set_acceptance shell file_read files_list document_read image_read publish_artifact finish
metadata:
  athanor.tier: 'builtin'
  athanor.version: '1.3.0'
  athanor.risk: 'read_only'
  athanor.domain: 'discipline'
---

# Verification evidence

A task is finished when the requested outcome has been observed, not when the last tool call
returned without an error. Every claim in the final summary must be traceable to something that was
actually read back.

## The evidence ladder

Use the strongest rung the task allows. Anything below rung 3 is not evidence.

1. **Absent** — the tool call returned 200. Not evidence of anything except that the call ran.
2. **Asserted** — the model says the file was written correctly. Not evidence.
3. **Read back** — the artifact was re-opened after writing and its content inspected
   (`file_read`, `document_read`, `shell` with a checksum, a query against the row that was
   inserted).
4. **Executed** — the thing was run and its output examined: the test suite passed, the script
   produced the expected stdout, the HTTP endpoint returned the expected body.
5. **Rendered** — the artifact was converted to page images and the images were looked at with
   `image_read`. Required for every visual deliverable: .docx, .pptx, .xlsx, PDF, charts, slides.
6. **Independently confirmed** — a second, different mechanism agrees. A recalculation engine that
   did not write the file reports zero error cells; a fresh browser session shows the submitted
   record.

## Required evidence per outcome

| Outcome                     | Minimum rung | The specific check                                                                              |
| --------------------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| Text or Markdown file       | 3            | `file_read` the file; confirm length and that the last section exists                           |
| .docx / .pptx / PDF / .xlsx | 5            | run `render-proof`; declare the render clause, confirm no placeholder tokens and fonts embedded |
| .xlsx with formulas         | 6            | LibreOffice recalculation reports `error_cells == 0`                                            |
| Code change                 | 4            | the project's own test command exits 0, and it failed before the change                         |
| Data analysis               | 4            | the analysis script re-runs from a clean state and produces the same numbers                    |
| Web form submitted          | 6            | a confirmation page, reference number, or a re-fetch of the record                              |
| Deployment                  | 4            | a health check against the deployed URL returns the expected status and body                    |
| Research claim              | 6            | the cited source was re-fetched and the quoted span still supports the claim                    |
| Background job              | 4            | the job's own completion record plus a check of the output it was supposed to produce           |
| Conversational answer       | n/a          | `verification.status = not_applicable`; no external state changed                               |

## Procedure

1. **Before starting**, declare the checks with `set_acceptance`. The harness runs them itself when
   you call `finish` and refuses the finish while any fails, so they are the definition of done
   rather than a claim about it — which is why they are declared before the work, when you have no
   stake in what passes. A `command` check is an executable, its arguments and the exit code and
   stdout it must produce; an `artifact` check is a path that must exist, not be under a size, and
   — for a document — render to the pages the job asked for.
   Pick from the table above: "the budget workbook exists" is not a check, and
   `athanor-office-convert budget.xlsx proofs/budget.pdf` with `expectExit: 0` is.

   Three things to know about it.

   **A definition of done that already passes is refused.** When you declare checks before anything
   has changed, the harness runs them there and then. If every one of them passes at that moment it
   says what it saw and asks for one that fails now — so `test -f report.pdf` on a file already
   sitting there, or a bare `true`, is rejected rather than banked. Declare the check against the
   work that does not exist yet. An already-passing check is still welcome _alongside_ a failing
   one, because that is a regression guard.

   **Declare them before you change anything.** Checks declared after the turn has already written
   something are still accepted, but the harness never watched them fail, and the completion says so
   where the owner reads it. The same applies to a record inherited from an earlier turn: it was
   green before this turn began, so it shows that nothing broke rather than that this work is right,
   and finishing is held until this turn declares its own.

   **Calling it again is allowed and both versions are shown to the owner**, because weakening your
   own test is a different act from passing it. And the harness runs commands, looks at files, and
   measures the pages of a document — how many, whether any word was cut at an edge, whether any
   page is blank. What is left on rungs 5 and 6 is judgement: a rendered page read with `image_read`
   is evidence you gather, not a check you can declare, because no measurement can tell you the
   chart is mislabelled.

2. **Do the work.**
3. **Gather evidence in the same session.** Do not rely on a tool result from twenty steps ago; a
   later step may have overwritten the file. Re-read now.
4. **Compare against the request, not against your plan.** The most common silent failure is
   delivering the thing you decided to build rather than the thing that was asked for. Re-read the
   original request verbatim before finishing.
5. **Publish deliverables** with `publish_artifact` so the owner gets an immutable copy, and attach
   the proof images alongside them.
6. **Call `finish`** with one evidence entry per claim, each citing the `toolCallId` that produced
   it. If a claim has no evidence, either get it or state the claim as unverified in
   `remainingRisks` — never drop it silently.

## Failure modes

- **The empty success.** `shell` exits 0 because the script caught its own exception and printed a
  warning. Always check stdout, not only the exit code, when a script has its own error handling.
- **The stale read.** A file read before the last write shows the old content. Order matters:
  write, then read.
- **The partial write.** A process killed by a timeout leaves a truncated file that parses. Check
  the tail of the file, not the head.
- **The passing test that tests nothing.** A regression test must fail against the pre-change code.
  If it was never seen failing, it is not a regression test.
- **The confirmation page that is not one.** A form that returns to itself with the fields cleared
  looks like success. Confirm a reference number or re-fetch the record.
- **Verification by the same code path.** Asking the writer to read back its own in-memory model
  proves nothing. Verify with a different reader — the recalculation engine, a renderer, a fresh
  HTTP request.

## What to report

The final summary states, for each deliverable: what it is, where it is, what was checked, and what
was not checked. "Not checked" is an acceptable answer. "Checked" without saying how is not.
