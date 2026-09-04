import { describe, expect, it } from 'vitest';
import {
  completionCard,
  computerChangeLine,
  harnessRun,
  turnComputerQuery,
  verificationReceiptLabel
} from './completion-card.js';
import type { TaskEvent, TaskRewindPreview } from './types.js';

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

  it('carries the command beside the label for a command check, and nothing for an artifact', () => {
    const run = harnessRun(
      status('Acceptance checks: 2 of 2 passed', {
        acceptance: [
          {
            id: 'check-1',
            label: 'The suite passes',
            passed: true,
            detail: 'exit 0',
            command: 'pytest -q'
          },
          { id: 'check-2', label: 'The report exists', passed: true, detail: '4213 bytes' }
        ]
      })
    )!;
    expect(run[0]).toEqual({
      id: 'check-1',
      label: 'The suite passes',
      passed: true,
      detail: 'exit 0',
      command: 'pytest -q'
    });
    expect(run[1]).not.toHaveProperty('command');
  });

  it('keeps the harness’s own lines out of what the agent says it checked', () => {
    const card = completionCard(
      completed('Task completed', {
        summary: 'Done.',
        verification: {
          status: 'verified',
          evidence: [
            { claim: 'Opened the report', source: 'tool_result' },
            {
              claim: 'check-1: The suite passes — ran pytest -q — exit 0',
              source: 'acceptance_check'
            }
          ],
          remainingRisks: []
        }
      }),
      ranTwoChecks
    );
    expect(card.evidence).toEqual(['Opened the report']);
    expect(card.verified).toBe(true);
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
   * Two fields, two places. A caveat the worker sends both ways is its own correction to its own
   * tick and belongs beside it; printing it under "caveats" alongside the agent's own risks buries
   * the one line that says this tick proves less than the last one.
   */
  it('lifts the harness caveat out of the agent’s caveats and shows it once', () => {
    const caveat =
      'These checks were already passing before this job started, so passing them says nothing about it.';
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

  /*
   * More than one of them, which is what the comment over `harnessCaveats` used to deny.
   *
   * `CAVEAT_BESIDE_THE_TICK` in `apps/worker/src/turn-bounds.ts` holds three sentences, and the
   * failure and could-not-run pair are the ones a reader who never opens the receipt most needs:
   * the card is headed "Result" with a tick on it. The behaviour was already right - nothing here
   * counts - and this pins it so the corrected comment stays true rather than being true by luck.
   * The two lines are the worker's own constants, quoted rather than imported because this package
   * does not depend on the worker.
   */
  it('shows every caveat the worker sent both ways, not the first', () => {
    const failedCaveat =
      'athanor ran the checks this turn declared and they did not pass, so nothing here is verified - read the failures below before relying on it.';
    const couldNotRun =
      'athanor could not run the checks this turn declared, so this result is unchecked - neither proved nor disproved.';
    const card = completionCard(
      completed('Task completed', {
        summary: 'Totalled the column.',
        acceptance: [failedCaveat, couldNotRun, 'check-1: The suite passes — exit 0'],
        verification: {
          status: 'checks_failed',
          evidence: [{ claim: 'Wrote total.txt', source: 'tool_result' }],
          remainingRisks: [failedCaveat, couldNotRun, 'The chart still uses last week’s figures']
        }
      }),
      ranTwoChecks
    );
    expect(card.harnessCaveats).toEqual([failedCaveat, couldNotRun]);
    expect(card.caveats).toEqual(['The chart still uses last week’s figures']);
  });

  /*
   * The other half of that protocol. Everything the worker sends only as a risk - how the checks
   * were made, where they came from - is detail behind the disclosure, and the summary line says
   * there is something in there to read rather than printing it over the tick.
   */
  it('leaves a caveat sent only as a risk behind the disclosure', () => {
    const caveat = 'These checks were written after the work, not before it.';
    const card = completionCard(
      completed('Task completed', {
        summary: 'Built it.',
        acceptance: ['check-1: The suite passes — exit 0'],
        verification: {
          status: 'verified',
          evidence: [{ claim: 'Ran the suite', source: 'tool_result' }],
          remainingRisks: [caveat]
        }
      }),
      ranTwoChecks
    );
    expect(card.harnessCaveats).toEqual([]);
    expect(card.caveats).toEqual([caveat]);
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

/*
 * The turn's effect on the computer, which the card could never say.
 *
 * Everything here is about not asking, and not answering, when the answer would belong to another
 * turn: the box measures the restore point against the tree as it stands, so the only completion
 * whose difference is its own is the newest one on a conversation that has stopped moving.
 */
const timeline = (entries: Array<[number, TaskEvent['kind']]>): TaskEvent[] =>
  entries.map(([sequence, kind]) => ({
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    taskId: '00000000-0000-4000-8000-000000000099',
    sequence,
    kind,
    summary: kind,
    createdAt: '2026-08-01T09:00:00.000Z'
  }));

const wroteFiles = timeline([
  [1, 'user_message'],
  [2, 'tool_started'],
  [3, 'tool_result'],
  [4, 'completed']
]);

const rewindPreview = (
  eventSequence: number | null,
  computer: Partial<TaskRewindPreview['computer'] & object> | null
): TaskRewindPreview =>
  ({
    taskId: '00000000-0000-4000-8000-000000000099',
    eventId: '00000000-0000-4000-8000-000000000004',
    droppedEventCount: 0,
    checkpoint: { id: '00000000-0000-4000-8000-000000000500', eventSequence },
    computer: computer && {
      addedCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
      added: [],
      modified: [],
      deleted: [],
      packagesInstalled: [],
      packagesRemoved: [],
      uncovered: [],
      truncated: false,
      ...computer
    }
  }) as TaskRewindPreview;

describe('what the finished turn did to the computer', () => {
  it('asks about the newest completion, from the message that opened its turn', () => {
    expect(turnComputerQuery(wroteFiles, 'completed')).toEqual({
      eventId: '00000000-0000-4000-8000-000000000004',
      fromSequence: 1
    });
  });

  it('never asks while the conversation is still moving', () => {
    for (const status of ['running', 'queued', 'planning'])
      expect(turnComputerQuery(wroteFiles, status)).toBeUndefined();
    // Parked is not moving: an approval, a question and a wait on the box all leave the tree alone.
    expect(turnComputerQuery(wroteFiles, 'awaiting_user')).toBeDefined();
  });

  it('never asks for a turn that made no call, because it took no restore point', () => {
    /*
     * The restore point is taken in front of the first call that could change anything, so a turn
     * that only talked has none - and the box would answer with the previous turn's, putting an
     * earlier turn's file changes under a conversational reply.
     */
    const talked = timeline([
      [1, 'user_message'],
      [2, 'assistant_message'],
      [3, 'completed']
    ]);
    expect(turnComputerQuery(talked, 'completed')).toBeUndefined();
  });

  it('never asks once something has run since that completion', () => {
    const thenFailed = [
      ...wroteFiles,
      ...timeline([
        [5, 'user_message'],
        [6, 'tool_started']
      ])
    ];
    expect(turnComputerQuery(thenFailed, 'failed')).toBeUndefined();
  });

  it('never asks when the message that opened the turn is older than this device holds', () => {
    // The transcript is paged. Without the turn's own starting point there is no way to tell
    // whether the restore point that comes back belongs to this turn or to one before it.
    expect(
      turnComputerQuery(
        timeline([
          [8, 'tool_started'],
          [9, 'completed']
        ]),
        'completed'
      )
    ).toBeUndefined();
    expect(turnComputerQuery(timeline([[1, 'user_message']]), 'completed')).toBeUndefined();
  });

  it('puts the counts in one line, with the noun said once', () => {
    expect(
      computerChangeLine(rewindPreview(1, { addedCount: 2, modifiedCount: 3, deletedCount: 1 }), 1)
    ).toBe('On the computer — 2 files added, 3 changed, 1 deleted');
    expect(computerChangeLine(rewindPreview(1, { modifiedCount: 1 }), 1)).toBe(
      'On the computer — 1 file changed'
    );
    /* A turn that only removed things is the one a reader most wants counted, and the noun still
       goes on the first clause that has anything in it. */
    expect(computerChangeLine(rewindPreview(1, { deletedCount: 3 }), 1)).toBe(
      'On the computer — 3 files deleted'
    );
  });

  /*
   * The counts are the box's own totals, not the length of the lists beside them: the preview caps
   * its paths at 200 and says so, and a turn that touched more than that must not be reported as
   * having touched exactly 200.
   */
  it('reports the whole total on a turn whose file list came back truncated', () => {
    expect(
      computerChangeLine(
        rewindPreview(1, { addedCount: 412, modifiedCount: 88, truncated: true }),
        1
      )
    ).toBe('On the computer — 412 files added, 88 changed');
  });

  it('says nothing at all when the turn changed nothing', () => {
    // "No files changed" under every conversational reply is the interface talking about itself.
    expect(computerChangeLine(rewindPreview(1, {}), 1)).toBe('');
    expect(computerChangeLine(undefined, 1)).toBe('');
    expect(computerChangeLine(rewindPreview(1, null), 1)).toBe('');
  });

  it('says nothing when the restore point that came back predates this turn', () => {
    // It is the previous turn's, and the difference it measures is the previous turn's work.
    expect(computerChangeLine(rewindPreview(1, { addedCount: 9 }), 5)).toBe('');
    expect(computerChangeLine(rewindPreview(null, { addedCount: 9 }), 5)).toBe('');
  });
});
