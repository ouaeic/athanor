/**
 * The undo dialog, rendered.
 *
 * It is the only control in athanor where a click can put files back, and the thing that makes it
 * safe is that it says what it would do before it does it. `rewind.ts` is already held to its
 * wording; this holds the dialog to using it — that an unavailable scope is offered as a reason
 * rather than as an option, that the effects appear only where they apply, and that the heading
 * over the button agrees with the button.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RewindChoice } from './RewindDialog.js';
import { NO_CHECKPOINT_REASON, type TrajectoryDraft } from './rewind.js';
import type { TaskRewindPreview } from './types.js';

const preview = (patch: Partial<TaskRewindPreview> = {}): TaskRewindPreview =>
  ({
    checkpoint: {
      id: '00000000-0000-4000-8000-000000000003',
      workspaceId: '00000000-0000-4000-8000-000000000002',
      taskId: '00000000-0000-4000-8000-000000000001',
      turn: 1,
      eventSequence: 4,
      mechanism: 'content',
      fileCount: 12,
      totalBytes: 4096,
      storedBytes: 4096,
      durationMs: 30,
      createdAt: '2026-08-01T09:00:00.000Z'
    },
    computer: {
      id: '00000000-0000-4000-8000-000000000003',
      mechanism: 'content',
      createdAt: '2026-08-01T09:00:00.000Z',
      added: [],
      modified: [],
      deleted: [],
      addedCount: 2,
      modifiedCount: 1,
      deletedCount: 0,
      packagesInstalled: [{ name: 'ripgrep', version: '14.1.0' }],
      uncovered: [],
      truncated: false
    },
    droppedEventCount: 3,
    ...patch
  }) as TaskRewindPreview;

const draft = (patch: Partial<TrajectoryDraft> = {}): TrajectoryDraft =>
  ({
    operation: 'edit',
    eventId: '00000000-0000-4000-8000-000000000010',
    prompt: 'Rewrite the summary',
    stopSource: false,
    rewind: 'conversation',
    ...patch
  }) as TrajectoryDraft;

const render = (
  trajectory: TrajectoryDraft,
  patch: Partial<Parameters<typeof RewindChoice>[0]> = {}
): string =>
  renderToStaticMarkup(
    <RewindChoice
      trajectory={trajectory}
      onChange={() => undefined}
      preview={preview()}
      taskIsActive={false}
      busy={false}
      onConfirm={() => undefined}
      onCancel={() => undefined}
      onOpenRecoveryPoints={() => undefined}
      {...patch}
    />
  );

/** The confirm button on its own, so "disabled" cannot be satisfied by some other control. */
const confirmButton = (markup: string): string =>
  markup.slice(markup.lastIndexOf('<button', markup.length));

describe('the dialog that can put files back', () => {
  it('offers all three scopes when the computer can go back', () => {
    const markup = render(draft());
    expect(markup).toContain('The conversation');
    expect(markup).toContain('The computer');
    expect(markup).toContain('Both');
    expect(markup).not.toContain('disabled');
  });

  /*
   * A choice that would fail is not a choice: the server refuses a computer rewind with no
   * checkpoint, so the dialog says so where the hint would be rather than offering the option.
   */
  it('refuses the two computer scopes with a reason when no restore point covers the turn', () => {
    const markup = render(draft(), { preview: preview({ checkpoint: null, computer: null }) });
    expect(markup).toContain(NO_CHECKPOINT_REASON);
    expect((markup.match(/type="radio" disabled/g) ?? []).length).toBe(2);
  });

  it('says the computer is being asked rather than showing an empty choice', () => {
    expect(render(draft(), { preview: undefined })).toContain('Working out what this would change');
  });

  it('lists what a computer rewind would change only once that scope is chosen', () => {
    expect(render(draft())).not.toContain('files go back to how they were');
    const chosen = render(draft({ rewind: 'both' }));
    expect(chosen).toContain('1 file goes back to how they were');
    expect(chosen).toContain('2 files created since then are removed');
  });

  /* The part owners get wrong when nobody tells them: a rewind uninstalls nothing. */
  it('warns that packages installed since then stay installed', () => {
    expect(render(draft({ rewind: 'computer' }))).toContain('1 package installed since then stay');
  });

  it('names the computer-only rewind as what it is, over a button that does the same thing', () => {
    const markup = render(draft({ rewind: 'computer' }));
    expect(markup).toContain('Put the computer back');
    expect(markup).not.toContain('New version');
    expect(markup).toContain('This conversation is left exactly as it is');
  });

  it('calls a conversation rewind a new version, on both operations', () => {
    expect(render(draft())).toContain('Edit and resend');
    expect(render(draft({ operation: 'retry' } as Partial<TrajectoryDraft>))).toContain(
      'Regenerate this answer'
    );
    expect(render(draft())).toContain('Start new version');
  });

  it('offers the message box only for an edit', () => {
    expect(render(draft())).toContain('<textarea');
    expect(render(draft({ operation: 'retry' } as Partial<TrajectoryDraft>))).not.toContain(
      '<textarea'
    );
  });

  it('holds the confirm inert while an edit has emptied its message', () => {
    const emptied = confirmButton(render(draft({ prompt: '   ' } as Partial<TrajectoryDraft>)));
    expect(emptied).toContain('Start new version');
    expect(emptied).toContain('disabled');
    expect(confirmButton(render(draft()))).not.toContain('disabled');
  });

  /* Working means working: the button says so rather than looking ready to be pressed again. */
  it('says it is working while the request is in flight', () => {
    const working = confirmButton(render(draft(), { busy: true }));
    expect(working).toContain('Working…');
    expect(working).toContain('disabled');
  });

  /*
   * Nothing forks when only the computer goes back, so there is no second agent to keep off the
   * same machine — offering to stop the conversation there would be offering to stop the one the
   * owner is reading, for no reason.
   */
  it('offers to stop the source only when a fork is actually being taken', () => {
    expect(render(draft(), { taskIsActive: true })).toContain(
      'Stop this conversation so two agents do not change the same computer'
    );
    expect(render(draft({ rewind: 'computer' }), { taskIsActive: true })).not.toContain(
      'Stop this conversation'
    );
    expect(render(draft(), { taskIsActive: false })).not.toContain('Stop this conversation');
  });

  it('says what the chosen scope leaves behind, before it is chosen', () => {
    expect(render(draft())).toContain('Files and apps on the agent computer stay exactly as they');
    expect(render(draft({ rewind: 'both' }))).toContain('Anything installed since then stays');
  });
});
