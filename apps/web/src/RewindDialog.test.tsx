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
import { isValidElement, type ReactNode } from 'react';
import { TaskRewindPreview as RewindPreviewShape } from '@athanor/contracts';
import { RewindChoice } from './RewindDialog.js';
import { NO_CHECKPOINT_REASON, type TrajectoryDraft } from './rewind.js';
import type { CatalogueModel, TaskRewindPreview } from './types.js';

/**
 * A preview shaped like one the box actually sends.
 *
 * Held to the contract by a test below rather than by a cast: everything this dialog gained reads
 * fields nothing in this client had ever read, and a fixture invented alongside the code that reads
 * it would agree with itself and with nothing else.
 */
const preview = (patch: Partial<TaskRewindPreview> = {}): TaskRewindPreview =>
  ({
    taskId: '00000000-0000-4000-8000-000000000001',
    eventId: '00000000-0000-4000-8000-000000000010',
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
      added: [{ path: 'workspace/notes/scratch.md', sizeBytes: 2_400 }],
      modified: [
        { path: 'workspace/src/server.ts', sizeBytes: 8_000, currentSizeBytes: 12_000 },
        { path: 'workspace/README.md', sizeBytes: 1_100, currentSizeBytes: 1_400 }
      ],
      deleted: [],
      addedCount: 2,
      modifiedCount: 1,
      deletedCount: 0,
      restoredBytes: 9_100,
      removedBytes: 2_400,
      packagesInstalled: [{ name: 'ripgrep', version: '14.1.0' }],
      packagesRemoved: [],
      uncovered: [],
      truncated: false
    },
    droppedEventCount: 3,
    ...patch
  }) as TaskRewindPreview;

/** The machine half on its own, so a case can move one field of it and leave the rest alone. */
const computerPreview = (
  patch: Partial<NonNullable<TaskRewindPreview['computer']>> = {}
): TaskRewindPreview => preview({ computer: { ...preview().computer!, ...patch } });

const catalogue: CatalogueModel[] = [
  {
    id: 'model-quick',
    providerModelId: 'quick-1',
    displayName: 'Quick',
    provider: 'athanor',
    availability: 'available',
    privacyRoute: 'provider_zdr'
  },
  {
    id: 'model-deep',
    providerModelId: 'deep-1',
    displayName: 'Deep thinker',
    provider: 'athanor',
    availability: 'available',
    privacyRoute: 'provider_zdr'
  },
  {
    id: 'model-elsewhere',
    providerModelId: 'elsewhere-1',
    displayName: 'Somewhere else entirely',
    provider: 'athanor',
    availability: 'available',
    privacyRoute: 'external'
  },
  {
    id: 'model-down',
    providerModelId: 'down-1',
    displayName: 'Currently down',
    provider: 'athanor',
    availability: 'unavailable',
    privacyRoute: 'provider_zdr'
  }
];

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

/**
 * One control out of the tree, with the handler it was given.
 *
 * There is no DOM in these tests and no event loop to dispatch into, so a control is reached by
 * calling the component as the function it is and walking what it returns. It is worth the twelve
 * lines: what a picker puts on the draft is the whole of whether the request that follows carries
 * the owner's choice, and asserting the markup would only prove the option was drawn.
 */
const controls = (node: ReactNode, tag: string): Array<Record<string, unknown>> => {
  // `Array.isArray` narrows to `any[]`, which would hand every child to this function as `any`.
  // A ReactNode may be an iterable of ReactNode, so the members really are nodes; saying so keeps
  // the recursion typed rather than letting one `any` through the whole walk.
  if (Array.isArray(node)) return (node as ReactNode[]).flatMap((child) => controls(child, tag));
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode };
  const nested = controls(props.children ?? null, tag);
  return node.type === tag ? [props as Record<string, unknown>, ...nested] : nested;
};

/** Hands a control the one field of an event it reads. */
const choose = (control: Record<string, unknown>, value: string): void =>
  (control.onChange as (event: { target: { value: string } }) => void)({ target: { value } });

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

/*
 * The counts were the whole of it: "3 files go back" was as much as anyone got before agreeing to
 * an act with no undo of its own. Everything below is already on the preview and was read by
 * nothing.
 */
describe('what the dialog says a rewind would cost', () => {
  /* The fixture below is the whole evidence for every case in here, so it is held to the wire. */
  it('is drawn from a preview the box could actually have sent', () => {
    expect(() => RewindPreviewShape.parse(preview())).not.toThrow();
    expect(() => RewindPreviewShape.parse(computerPreview({ mechanism: 'zfs' }))).not.toThrow();
  });

  it('says how many bytes move, not only how many files', () => {
    const markup = render(draft({ rewind: 'computer' }));
    expect(markup).toContain('9.1 KB written back');
    expect(markup).toContain('2.4 KB deleted');
  });

  /* A rewind that only deletes writes nothing back, and "0 B written back" is noise, not a fact. */
  it('names only the half of the byte total that has anything in it', () => {
    const markup = render(draft({ rewind: 'computer' }), {
      preview: computerPreview({ restoredBytes: 0, modified: [] })
    });
    expect(markup).toContain('2.4 KB deleted');
    expect(markup).not.toContain('written back');
  });

  it('lists the paths behind the counts, with the size each file would become', () => {
    const markup = render(draft({ rewind: 'computer' }));
    expect(markup).toContain('Which files');
    expect(markup).toContain('workspace/src/server.ts');
    expect(markup).toContain('12 KB → 8.0 KB');
    expect(markup).toContain('workspace/notes/scratch.md');
  });

  /* An empty disclosure would promise a list the box did not send. */
  it('offers no list when the box sent counts and no paths', () => {
    const markup = render(draft({ rewind: 'computer' }), {
      preview: computerPreview({ added: [], modified: [], deleted: [], uncovered: [] })
    });
    expect(markup).not.toContain('Which files');
    expect(markup).toContain('1 file goes back to how they were');
  });

  it('names the files a copied point could not hold, which are the ones it will not move', () => {
    const markup = render(draft({ rewind: 'computer' }), {
      preview: computerPreview({
        uncovered: [{ path: 'workspace/render/take-4.mov', sizeBytes: 900_000_000 }]
      })
    });
    expect(markup).toContain('workspace/render/take-4.mov');
    expect(markup).toContain('too large to be held');
  });

  /* The other direction of the caveat: a rewind restores files, and an install is not a file. */
  it('says that packages removed since then stay removed, and which they were', () => {
    const markup = render(draft({ rewind: 'both' }), {
      preview: computerPreview({ packagesRemoved: [{ name: 'ffmpeg', version: '7.1' }] })
    });
    expect(markup).toContain('1 package removed since then stays removed');
    expect(markup).toContain('does not reinstall anything');
    expect(markup).toContain('ffmpeg');
  });

  /* "This is exact" and "this is what was covered" are different promises. */
  it('says which kind of point this is, because the two cover different things', () => {
    expect(render(draft({ rewind: 'computer' }))).toContain('taken by copying files');
    expect(
      render(draft({ rewind: 'computer' }), { preview: computerPreview({ mechanism: 'zfs' }) })
    ).toContain('filesystem snapshot');
  });
});

describe('choosing a different model for the new version', () => {
  /*
   * No catalogue means the caller does not send `modelId` either, and a picker whose choice is
   * dropped on the way to the server is worse than no picker: the owner stops asking for the thing
   * they believe they already asked for.
   */
  it('offers no model row at all until the caller passes the catalogue', () => {
    expect(render(draft())).not.toContain('<select');
    expect(render(draft(), { models: catalogue, currentModelId: 'model-quick' })).toContain(
      '<select'
    );
  });

  it('names the model this conversation is already on as the default', () => {
    const markup = render(draft(), { models: catalogue, currentModelId: 'model-quick' });
    expect(markup).toContain('The same model — Quick');
    expect(markup).toContain('Deep thinker');
  });

  /*
   * The server matches a named model against the fork's privacy route and refuses the pair with
   * `model_unavailable`, so a model on the other route is not a choice — it is a refusal met after
   * the button. An unavailable one is refused by the same check.
   */
  it('offers only models the fork could actually run on', () => {
    const markup = render(draft(), { models: catalogue, currentModelId: 'model-quick' });
    expect(markup).not.toContain('Somewhere else entirely');
    expect(markup).not.toContain('Currently down');
  });

  it('offers no model when nothing runs, because only the computer is going back', () => {
    expect(
      render(draft({ rewind: 'computer' }), { models: catalogue, currentModelId: 'model-quick' })
    ).not.toContain('<select');
  });

  it('puts the chosen model on the draft the request is built from', () => {
    const drafts: TrajectoryDraft[] = [];
    const tree = RewindChoice({
      trajectory: draft(),
      onChange: (next) => drafts.push(next),
      preview: preview(),
      taskIsActive: false,
      busy: false,
      models: catalogue,
      currentModelId: 'model-quick',
      onConfirm: () => undefined,
      onCancel: () => undefined,
      onOpenRecoveryPoints: () => undefined
    });
    choose(controls(tree, 'select')[0]!, 'model-deep');
    expect(drafts.at(-1)).toMatchObject({ modelId: 'model-deep' });
  });

  /*
   * A model named for a rewind that then only puts the files back is parsed by the server, dropped
   * before it is read, and never mentioned — which is the same lie in the other direction.
   */
  it('drops the chosen model when the scope stops running anything', () => {
    const drafts: TrajectoryDraft[] = [];
    const tree = RewindChoice({
      trajectory: { ...draft(), modelId: 'model-deep' },
      onChange: (next) => drafts.push(next),
      preview: preview(),
      taskIsActive: false,
      busy: false,
      models: catalogue,
      currentModelId: 'model-quick',
      onConfirm: () => undefined,
      onCancel: () => undefined,
      onOpenRecoveryPoints: () => undefined
    });
    const radios = controls(tree, 'input').filter((input) => input.type === 'radio');
    (radios[1]!.onChange as () => void)();
    expect(drafts.at(-1)).toMatchObject({ rewind: 'computer', modelId: '' });
    (radios[2]!.onChange as () => void)();
    expect(drafts.at(-1)).toMatchObject({ rewind: 'both', modelId: 'model-deep' });
  });
});
