import { describe, expect, it } from 'vitest';
import type { TaskRewindPreview } from './types.js';
import {
  NO_CHECKPOINT_REASON,
  offersStopSource,
  rewindDialogCopy,
  rewindOffer,
  rewindResultNotice,
  rewindScopeChoices,
  rewindScopeNote,
  trajectoryModelFields,
  type TrajectoryDraft
} from './rewind.js';

const preview = (overrides: Partial<TaskRewindPreview> = {}): TaskRewindPreview => ({
  taskId: '00000000-0000-4000-8000-000000000001',
  eventId: '00000000-0000-4000-8000-000000000002',
  droppedEventCount: 12,
  checkpoint: {
    id: '00000000-0000-4000-8000-000000000003',
    workspaceId: '00000000-0000-4000-8000-000000000004',
    taskId: '00000000-0000-4000-8000-000000000001',
    turn: 2,
    eventSequence: 40,
    mechanism: 'content',
    fileCount: 120,
    totalBytes: 4_000,
    storedBytes: 900,
    durationMs: 40,
    createdAt: '2026-01-01T10:00:00.000Z'
  },
  computer: {
    id: '00000000-0000-4000-8000-000000000003',
    mechanism: 'content',
    createdAt: '2026-01-01T10:00:00.000Z',
    added: [],
    modified: [],
    deleted: [],
    addedCount: 2,
    modifiedCount: 1,
    deletedCount: 0,
    restoredBytes: 2_048,
    removedBytes: 512,
    packagesInstalled: [{ name: 'pandoc', version: '3.1' }],
    packagesRemoved: [],
    uncovered: [{ path: 'workspace/video.mov', sizeBytes: 900_000_000 }],
    truncated: false
  },
  ...overrides
});

describe('rewindOffer', () => {
  it('says what the rewind would do to the files, counting one file as one file', () => {
    const offer = rewindOffer(preview());
    expect(offer.computerAvailable).toBe(true);
    expect(offer.changes).toEqual([
      '1 file goes back to how they were',
      '2 files created since then are removed'
    ]);
    expect(offer.checkpointId).toBe('00000000-0000-4000-8000-000000000003');
    expect(offer.droppedEventCount).toBe(12);
  });

  it('says what it would leave alone, because that is what people get wrong', () => {
    const offer = rewindOffer(preview());
    expect(offer.caveats[0]).toContain('1 package installed since then stay');
    expect(offer.caveats[0]).toContain('does not uninstall');
    expect(offer.caveats[1]).toContain('too large for a restore point');
  });

  it('refuses the computer with the reason when no checkpoint covers the point', () => {
    const offer = rewindOffer(preview({ checkpoint: null, computer: null }));
    expect(offer.computerAvailable).toBe(false);
    expect(offer.computerReason).toBe(NO_CHECKPOINT_REASON);
    expect(offer.checkpointId).toBeUndefined();
  });

  /*
   * The incident this whole field exists for: a workspace holding two `node_modules` trees crosses
   * the runner's file ceiling, automatic checkpoints stop from that turn on, and the dialog told
   * the owner every turn afterwards had "changed nothing on the computer". The runner's own
   * sentence names the remedy, so it is shown as it arrived rather than reworded into a guess.
   */
  it('states the refusal the box carried instead of guessing why there is no undo point', () => {
    const refusal =
      'This workspace holds more than 250000 files, which is more than automatic checkpoints cover. Take a named recovery point instead.';
    const offer = rewindOffer({
      ...preview({ checkpoint: null, computer: null }),
      checkpointFailure: { code: 'checkpoint_workspace_too_large', message: refusal, owner: true }
    });
    expect(offer.computerAvailable).toBe(false);
    expect(offer.computerReason).toContain(refusal);
    expect(offer.computerReason).not.toContain('changed nothing on the computer');
  });

  /* With nothing carried it may not name a cause, but it may not invent a harmless one either. */
  it('names the possibility it used to leave out when the box said nothing', () => {
    const offer = rewindOffer(preview({ checkpoint: null, computer: null }));
    expect(offer.computerReason).toContain('automatic undo points may have stopped');
    expect(offer.computerReason).toContain('says so in a warning');
    expect(offer.computerReason).not.toContain('That turn changed nothing on the computer');
  });

  /* A checkpoint that exists is described by the preview; a carried refusal is old news then. */
  it('says what the rewind would do even when an earlier turn lost its undo point', () => {
    const offer = rewindOffer({
      ...preview(),
      checkpointFailure: { message: 'Host disk is too full to take an automatic checkpoint.' }
    });
    expect(offer.computerAvailable).toBe(true);
    expect(offer.computerReason).toBe('');
  });

  it('refuses rather than rolling back blind when the computer cannot describe the restore', () => {
    const offer = rewindOffer(preview({ computer: null }));
    expect(offer.computerAvailable).toBe(false);
    expect(offer.computerReason).toContain('could not be asked');
  });

  it('is honest while the preview is still in flight', () => {
    const offer = rewindOffer(undefined);
    expect(offer.computerAvailable).toBe(false);
    expect(offer.computerReason).toContain('Working out');
  });

  it('states plainly when a turn changed nothing on the computer', () => {
    const offer = rewindOffer(
      preview({
        computer: {
          ...preview().computer!,
          addedCount: 0,
          modifiedCount: 0,
          deletedCount: 0,
          packagesInstalled: [],
          uncovered: []
        }
      })
    );
    expect(offer.changes).toEqual(['Nothing on the computer has changed since that point.']);
    expect(offer.caveats).toEqual([]);
  });
});

describe('rewind wording', () => {
  it('never claims the computer was rewound when only the conversation was', () => {
    expect(rewindScopeNote('conversation')).toContain('stay exactly as they are now');
    expect(rewindScopeNote('conversation')).not.toContain('goes back to this point.');
  });

  it('says the conversation carries on when only the computer went back', () => {
    expect(rewindScopeNote('computer')).toContain('carries on where it is');
    expect(rewindResultNotice('retry', 'computer')).toContain('carries on from where it is');
  });

  it('adds the machine to the notice only when the machine actually moved', () => {
    expect(rewindResultNotice('edit', 'both')).toContain('put back to that point as well');
    expect(rewindResultNotice('edit', 'conversation')).not.toContain('computer');
    expect(rewindResultNotice('branch', 'conversation')).toContain('Branch created');
  });
});

describe('what the rewind dialog says it will do', () => {
  it('never heads a computer rewind as a new version, because nothing forks', () => {
    const copy = rewindDialogCopy('edit', 'computer');
    expect(copy.eyebrow).toBe('Take the computer back');
    expect(copy.title).toBe('Put the computer back');
    expect(copy.confirm).toBe('Put the computer back');
    expect(copy.explanation).toContain('left exactly as it is');
  });

  it('distinguishes editing a message from regenerating an answer', () => {
    expect(rewindDialogCopy('edit', 'conversation').title).toBe('Edit and resend');
    expect(rewindDialogCopy('retry', 'conversation').title).toBe('Regenerate this answer');
    expect(rewindDialogCopy('retry', 'both').confirm).toBe('Start new version');
  });

  it('reports the wait on the button that started it', () => {
    expect(rewindDialogCopy('edit', 'conversation', true).confirm).toBe('Working…');
  });

  it('offers every scope once, in the order they escalate', () => {
    expect(rewindScopeChoices.map((choice) => choice.scope)).toEqual([
      'conversation',
      'computer',
      'both'
    ]);
    for (const choice of rewindScopeChoices) {
      expect(choice.label).not.toBe('');
      expect(choice.hint).not.toBe('');
    }
  });

  /*
   * "That answer was weak, try the stronger model" is what the contract says this field is for, and
   * the empty string is what a `<select>` gives back for "the same one as before". Sending it would
   * name a model with no id, which the server answers with `model_unavailable`.
   */
  it('sends a named model and sends nothing at all for the same one', () => {
    const draft: TrajectoryDraft = {
      operation: 'retry',
      eventId: '00000000-0000-4000-8000-000000000010',
      stopSource: false,
      rewind: 'conversation'
    };
    expect(trajectoryModelFields({ ...draft, modelId: 'model-strong' })).toEqual({
      modelId: 'model-strong'
    });
    expect(trajectoryModelFields({ ...draft, modelId: '' })).toEqual({});
    expect(trajectoryModelFields(draft)).toEqual({});
  });

  /* Stopping the source keeps two agents off one machine; only a fork creates a second one. */
  it('offers to stop the source only when a fork would race it', () => {
    expect(offersStopSource('conversation', true)).toBe(true);
    expect(offersStopSource('both', true)).toBe(true);
    expect(offersStopSource('computer', true)).toBe(false);
    expect(offersStopSource('conversation', false)).toBe(false);
  });
});
