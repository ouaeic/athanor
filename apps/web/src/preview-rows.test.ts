import { describe, expect, it } from 'vitest';
import { previewPortProblem, previewSummary } from './preview-rows.js';
import type { WorkspacePreview } from './types.js';

const preview = (overrides: Partial<WorkspacePreview> = {}): WorkspacePreview => ({
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  label: 'App preview',
  port: 3000,
  visibility: 'private',
  status: 'active',
  url: 'https://box.example/__athanor/preview/abc',
  expiresAt: null,
  lastAccessedAt: null,
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
  ...overrides
});

describe('what a port will not be accepted for', () => {
  it('accepts an ordinary application port', () => {
    expect(previewPortProblem(3000)).toBe('');
    expect(previewPortProblem(8080)).toBe('');
  });

  it('names the runtime port rather than going quietly dead on it', () => {
    expect(previewPortProblem(4300)).toContain('4300');
  });

  it('refuses a port outside the range the box will publish', () => {
    expect(previewPortProblem(80)).toContain('1024');
    expect(previewPortProblem(70_000)).toContain('65535');
    expect(previewPortProblem(Number.NaN)).toContain('1024');
  });
});

describe('what a preview row says about itself', () => {
  /* Read once, so a row and its assertion cannot disagree about what "now" is. */
  const now = Date.parse('2026-08-10T09:00:00.000Z');

  it('says what it is, which port it publishes, how long it lasts and whether anyone uses it', () => {
    expect(previewSummary(preview(), now)).toBe(
      'Private preview · port 3000 · stays available · never opened'
    );
    expect(previewSummary(preview({ status: 'expired' }), now)).toBe(
      'Private preview · expired · port 3000 · stays available · never opened'
    );
  });

  /*
   * A computer may hold a hundred of these and "App preview" is the default name for every one of
   * them, so without the port two rows for two different services are the same row - and revoking
   * one of them is a guess. The port is the only thing on a preview that is certainly distinct.
   */
  it('names the port, so two previews of two services are two rows', () => {
    expect(previewSummary(preview({ port: 3000 }), now)).toContain('port 3000');
    expect(previewSummary(preview({ port: 8080 }), now)).toContain('port 8080');
    expect(previewSummary(preview({ port: 3000 }), now)).not.toBe(
      previewSummary(preview({ port: 8080 }), now)
    );
  });

  /*
   * The idle expiry is driven by the last visit, so a row reporting the deadline and not whether
   * anything is using the link was reporting half of one rule. "Never opened" is the row that can
   * be revoked without asking anybody.
   */
  it('says when the link was last opened, and says so plainly when it never was', () => {
    expect(previewSummary(preview({ lastAccessedAt: null }), now)).toContain('never opened');
    expect(previewSummary(preview({ lastAccessedAt: '2026-08-10T08:00:00.000Z' }), now)).toContain(
      'opened today'
    );
    expect(previewSummary(preview({ lastAccessedAt: '2026-08-09T08:00:00.000Z' }), now)).toContain(
      'opened yesterday'
    );
    expect(previewSummary(preview({ lastAccessedAt: '2026-08-01T09:00:00.000Z' }), now)).toContain(
      'opened 9 days ago'
    );
  });

  /*
   * The row once claimed a published site held the computer awake. Nothing does that, and the row
   * is the last place that sentence lived — so this pins the absence rather than trusting a grep.
   */
  it('never claims a published site keeps the computer awake', () => {
    expect(previewSummary(preview({ visibility: 'public' }), now)).toBe(
      'Public link · port 3000 · stays available · never opened'
    );
    expect(previewSummary(preview({ visibility: 'public' }), now)).not.toContain('awake');
  });

  it('reports an idle deadline as the deadline it is', () => {
    expect(previewSummary(preview({ expiresAt: '2026-09-03T09:00:00.000Z' }), now)).toContain(
      'closes if unused by'
    );
  });
});
