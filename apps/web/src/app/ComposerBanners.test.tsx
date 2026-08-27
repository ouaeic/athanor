/**
 * The one thing allowed above the composer, drawn.
 *
 * `composer-strip.ts` already tests which kind wins; this tests that the kind that won draws
 * something, and that it draws only itself. Both halves matter: seven conditions used to render
 * there independently, so a box near its disk ceiling that also lost its connection painted storage,
 * offline and an error in three alarm colours over a 176px composer. The failure the ranking cannot
 * catch on its own is a kind that ranks and then renders nothing — that blanks the shelf and
 * silences everything under it, which is worse than the stack it replaced.
 *
 * `renderToStaticMarkup` costs no dependency and no DOM: effects do not run, so nothing is fetched,
 * and what comes back is the markup a reader sees.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRef } from 'react';
import { ComposerBanners } from './ComposerBanners.js';
import type { ComposerStripKind } from '../composer-strip.js';

const draw = (kind: ComposerStripKind | undefined, patch: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <ComposerBanners
      kind={kind}
      approvals={[]}
      workspaceId="desk"
      openTaskId={undefined}
      taskTitles={{}}
      openTaskEvents={[]}
      approvalFailure={undefined}
      cardRef={createRef<HTMLDivElement>()}
      onOpenTask={() => undefined}
      onOpenComputer={() => undefined}
      onOpenFiles={() => undefined}
      onAnnounce={() => undefined}
      onResolve={async () => undefined}
      block={{
        code: 'provider_missing',
        message: 'This box has no provider key.',
        actionLabel: 'Open Settings'
      }}
      onOpenSettings={() => undefined}
      onRetryConnection={() => undefined}
      diskFreeBytes={2_000_000_000}
      error="That request did not go through"
      onDismissError={() => undefined}
      notice="Stopped. The work so far is kept."
      onDismissNotice={() => undefined}
      {...patch}
    />
  );

describe('the shelf above the composer', () => {
  it('draws something for every kind the ranking can return', () => {
    // The list is written out rather than imported so that adding a kind to `composerStrip` without
    // a body here is a failing test rather than a silently blank shelf.
    for (const kind of ['block', 'offline', 'storage', 'error', 'degraded', 'notice'] as const)
      expect(draw(kind), kind).not.toBe('');
  });

  it('draws nothing at all when nothing has been ranked', () => {
    expect(draw(undefined)).toBe('');
  });

  it('says only the kind that won, and never two of them at once', () => {
    const offline = draw('offline');
    expect(offline).toContain('Can’t reach your athanor');
    expect(offline).not.toContain('That request did not go through');
    expect(offline).not.toContain('of disk left');
    expect(offline).not.toContain('Stopped. The work so far is kept.');
  });

  it('reports a failure as an alert and a status as a status', () => {
    // A screen reader is interrupted by one and not by the other, and the difference is the whole
    // reason the two are separate kinds rather than one string.
    expect(draw('error')).toContain('role="alert"');
    expect(draw('notice')).toContain('role="status"');
    expect(draw('degraded')).toContain('role="status"');
  });

  it('gives the free space and nothing else when the disk is refusing writes', () => {
    const storage = draw('storage');
    expect(storage).toContain('the computer has stopped writing files');
    expect(storage).toContain('2.0 GB');
    // Not a percentage: on a large disk ninety percent full is hundreds of gigabytes free and
    // nothing to do about it, which is why this banner is a floor in bytes.
    expect(storage).not.toContain('%');
  });

  it('says nothing about storage when the box never reported how much is left', () => {
    // `hostStorageBlocksWork` cannot rank `storage` without a figure, so this is unreachable — and
    // it stays drawn as nothing rather than as an empty sentence if that ever stops being true.
    expect(draw('storage', { diskFreeBytes: undefined })).toBe('');
  });

  it('offers the repair the block actually needs', () => {
    expect(draw('block')).toContain('Open Settings');
    expect(draw('block', { block: undefined })).toBe('');
  });
});
