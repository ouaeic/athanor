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
  it('says what it is and how long it lasts, without printing the ordinary status', () => {
    expect(previewSummary(preview())).toBe('Private preview · stays available');
    expect(previewSummary(preview({ status: 'expired' }))).toBe(
      'Private preview · expired · stays available'
    );
  });

  /*
   * The row once claimed a published site held the computer awake. Nothing does that, and the row
   * is the last place that sentence lived — so this pins the absence rather than trusting a grep.
   */
  it('never claims a published site keeps the computer awake', () => {
    expect(previewSummary(preview({ visibility: 'public' }))).toBe('Public link · stays available');
    expect(previewSummary(preview({ visibility: 'public' }))).not.toContain('awake');
  });

  it('reports an idle deadline as the deadline it is', () => {
    expect(previewSummary(preview({ expiresAt: '2026-09-03T09:00:00.000Z' }))).toContain(
      'closes if unused by'
    );
  });
});
