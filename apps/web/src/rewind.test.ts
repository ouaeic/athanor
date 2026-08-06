import { describe, expect, it } from 'vitest';
import type { TaskRewindPreview } from './types.js';
import {
  NO_CHECKPOINT_REASON,
  offersStopSource,
  rewindDialogCopy,
  rewindOffer,
  rewindResultNotice,
  rewindScopeChoices,
  rewindScopeNote
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

  /* Stopping the source keeps two agents off one machine; only a fork creates a second one. */
  it('offers to stop the source only when a fork would race it', () => {
    expect(offersStopSource('conversation', true)).toBe(true);
    expect(offersStopSource('both', true)).toBe(true);
    expect(offersStopSource('computer', true)).toBe(false);
    expect(offersStopSource('conversation', false)).toBe(false);
  });
});
