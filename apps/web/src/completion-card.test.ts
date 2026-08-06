import { describe, expect, it } from 'vitest';
import { completionCard, harnessRun, verificationReceiptLabel } from './completion-card.js';
import type { TaskEvent } from './types.js';

const completed = (summary: string, payload: unknown): TaskEvent => ({
  id: '00000000-0000-4000-8000-000000000001',
  taskId: '00000000-0000-4000-8000-000000000099',
  sequence: 12,
  kind: 'completed',
  summary,
  payload,
  createdAt: '2026-08-01T09:00:00.000Z'
});

const verified = completed('Task completed', {
  summary: 'The deck is in workspace/deck.pdf.',
  verification: {
    status: 'verified',
    evidence: [
      { claim: 'Opened deck.pdf and counted 14 slides', source: 'tool_result' },
      { claim: 'Published it into the conversation', source: 'published_artifact' }
    ],
    remainingRisks: ['The chart on slide 9 uses last week’s figures']
  }
});

/*
 * The step-limit handoff, exactly as the worker writes it: labelled, interrupted, verification
 * explicitly not applicable, and the plan steps it never reached in both list fields.
 */
const stopped = completed('Stopped at the step limit with work outstanding', {
  summary: 'Stopped after 120 steps. Everything produced so far is saved.',
  interrupted: true,
  outstanding: ['Write the summary section', 'Re-run the export'],
  verification: {
    status: 'not_applicable',
    evidence: [],
    remainingRisks: ['Write the summary section', 'Re-run the export']
  }
});

describe('the card that ends a turn', () => {
  it('keeps the box’s own label for a turn the harness stopped', () => {
    expect(completionCard(stopped)).toMatchObject({
      headline: 'Stopped at the step limit with work outstanding',
      interrupted: true,
      outstanding: ['Write the summary section', 'Re-run the export']
    });
    expect(completionCard(verified).headline).toBe('Result');
  });

  it('never calls an interrupted turn verified: it asserts the opposite itself', () => {
    expect(completionCard(stopped).verified).toBe(false);
    expect(verificationReceiptLabel(completionCard(stopped))).toBe('');
    expect(completionCard(verified).verified).toBe(true);
  });

  it('does not list the same outstanding work twice under two headings', () => {
    const card = completionCard(stopped);
    expect(card.caveats).toEqual([]);
    expect(card.outstanding).toHaveLength(2);
  });

  it('falls back to the risks when a stopped turn recorded no plan steps', () => {
    const card = completionCard(
      completed('Stopped at the step limit with work outstanding', {
        summary: 'Ran out of room.',
        interrupted: true,
        verification: { status: 'not_applicable', evidence: [], remainingRisks: ['Half the CSV'] }
      })
    );
    expect(card.outstanding).toEqual(['Half the CSV']);
  });

  it('says how many caveats there are, in the plural the number needs', () => {
    expect(verificationReceiptLabel(completionCard(verified))).toBe('Verified result · 1 caveat');
    const two = completionCard(
      completed('Task completed', {
        summary: 'Done',
        verification: {
          status: 'verified',
          evidence: [{ claim: 'Checked it', source: 'tool_result' }],
          remainingRisks: ['One', 'Two']
        }
      })
    );
    expect(verificationReceiptLabel(two)).toBe('Verified result · 2 caveats');
  });

  /*
   * `verified` with nothing behind it is a claim, not a receipt. The heading says what the
   * disclosure actually contains instead.
   */
  it('does not promise verification for a status with no evidence under it', () => {
    const card = completionCard(
      completed('Task completed', {
        summary: 'Done',
        verification: { status: 'verified', evidence: [], remainingRisks: ['Untested on Windows'] }
      })
    );
    expect(card.verified).toBe(false);
    expect(verificationReceiptLabel(card)).toBe('What the agent checked · 1 caveat');
  });

  it('reads a completion from a box that sent no verification at all', () => {
    const card = completionCard(completed('Task completed', { summary: 'All done' }));
    expect(card).toMatchObject({ headline: 'Result', summary: 'All done', verified: false });
    expect(verificationReceiptLabel(card)).toBe('');
  });

  it('says something rather than nothing when the summary is missing', () => {
    expect(completionCard(completed('Task completed', {})).summary).toBe(
      'All requested work is ready.'
    );
  });
});

/*
 * The harness's own run, as the worker publishes it: a status event carrying every result while
 * the turn is still going, and a completion carrying one flattened line per check afterwards.
 */
const status = (summary: string, payload: unknown): TaskEvent => ({
  id: '00000000-0000-4000-8000-000000000002',
  taskId: '00000000-0000-4000-8000-000000000099',
  sequence: 11,
  kind: 'status',
  summary,
  payload,
  createdAt: '2026-08-01T08:59:00.000Z'
});

const ranTwoChecks = harnessRun(
  status('Acceptance checks: 2 of 2 passed', {
    acceptance: [
      { id: 'check-1', label: 'The suite passes', passed: true, detail: 'exit 0' },
      { id: 'check-2', label: 'The report exists', passed: true, detail: '4213 bytes (needs 1)' }
    ]
  })
)!;

describe('what the harness ran', () => {
  it('reads the run the harness published, with the exit code it saw', () => {
    expect(ranTwoChecks).toEqual([
      { id: 'check-1', label: 'The suite passes', passed: true, detail: 'exit 0' },
      { id: 'check-2', label: 'The report exists', passed: true, detail: '4213 bytes (needs 1)' }
    ]);
  });

  /*
   * The baseline runs before the work, to refuse a record that already passes. Carrying it onto the
   * card would put a second tick there that says nothing about the job.
   */
  it('ignores the baseline run, and anything that is not a run at all', () => {
    expect(
      harnessRun(
        status('Acceptance baseline: 2 of 2 already pass before the work', {
          baseline: true,
          acceptance: [{ id: 'check-1', label: 'The suite passes', passed: true, detail: 'exit 0' }]
        })
      )
    ).toBeUndefined();
    expect(harnessRun(status('Step 4 completed', {}))).toBeUndefined();
    // The completion's own flattened lines are strings, and are not a run.
    expect(
      harnessRun(completed('Task completed', { acceptance: ['check-1: it built — exit 0'] }))
    ).toBeUndefined();
  });

  it('leads the receipt with the harness, because the agent did not write it', () => {
    const card = completionCard(
      completed('Task completed', {
        summary: 'The report is in workspace/report.pdf.',
        acceptance: ['check-1: The suite passes — exit 0'],
        verification: {
          status: 'verified',
          evidence: [{ claim: 'Opened the report', source: 'tool_result' }],
          remainingRisks: []
        }
      }),
      ranTwoChecks
    );
    expect(card.harness).toHaveLength(2);
    expect(verificationReceiptLabel(card)).toBe('The harness ran 2 checks · all passed');
  });

  it('names a failed check in the line that is read without opening anything', () => {
    const card = completionCard(
      completed('Task completed', {
        summary: 'Done what I could.',
        verification: { status: 'partial', evidence: [], remainingRisks: [] }
      }),
      [
        { id: 'check-1', label: 'The suite passes', passed: false, detail: 'exit 1: 3 failed' },
        { id: 'check-2', label: 'The report exists', passed: true, detail: '4213 bytes' }
      ]
    );
    expect(verificationReceiptLabel(card)).toBe('The harness ran 2 checks · 1 failed');
  });

  it('counts one check in the singular', () => {
    const card = completionCard(completed('Task completed', { summary: 'Done' }), [
      { id: 'check-1', label: 'It builds', passed: true, detail: 'exit 0' }
    ]);
    expect(verificationReceiptLabel(card)).toBe('The harness ran 1 check · all passed');
  });

  /*
   * The caveat is the harness's sentence about the worth of its own tick, and the worker writes it
   * into both fields. Printing it under "caveats" alongside the agent's own risks buries the one
   * line that says this tick proves less than the last one.
   */
  it('lifts the harness caveat out of the agent’s caveats and shows it once', () => {
    const caveat =
      'These acceptance checks were declared by an earlier turn and were already passing before this one started.';
    const card = completionCard(
      completed('Task completed', {
        summary: 'Tidied the folder.',
        acceptance: [caveat, 'check-1: The suite passes — exit 0'],
        verification: {
          status: 'verified',
          evidence: [{ claim: 'Listed the folder', source: 'tool_result' }],
          remainingRisks: ['The chart still uses last week’s figures', caveat]
        }
      }),
      ranTwoChecks
    );
    expect(card.harnessCaveats).toEqual([caveat]);
    expect(card.caveats).toEqual(['The chart still uses last week’s figures']);
    expect(verificationReceiptLabel(card)).toBe('The harness ran 2 checks · all passed · 1 caveat');
  });

  it('opens a receipt for a turn whose only evidence is the harness run', () => {
    const card = completionCard(
      completed('Task completed', {
        summary: 'Done',
        verification: { status: 'partial', evidence: [], remainingRisks: [] }
      }),
      ranTwoChecks
    );
    expect(verificationReceiptLabel(card)).toBe('The harness ran 2 checks · all passed');
    expect(completionCard(completed('Task completed', { summary: 'Done' })).harness).toEqual([]);
  });
});
