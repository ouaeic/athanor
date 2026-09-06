import { describe, expect, it } from 'vitest';
import { issuePreviewAccess, previewAccessExpiry, verifyPreviewAccess } from './preview-access.js';

const key = Buffer.alloc(32, 8);
const preview = { id: 'preview', workspaceId: 'workspace', accessTokenHash: 'original-epoch' };
const now = Date.parse('2026-09-06T12:00:00Z');

describe('independent signed preview grants', () => {
  it('allows independent bounded grants for one preview without changing its legacy token', () => {
    const first = issuePreviewAccess(preview, key, now);
    const second = issuePreviewAccess(preview, key, now);
    expect(first).not.toBe(second);
    expect(verifyPreviewAccess(first, preview, key, now)).toBe(true);
    expect(verifyPreviewAccess(second, preview, key, now)).toBe(true);
    expect(preview.accessTokenHash).toBe('original-epoch');
    expect(previewAccessExpiry(first)).toBeGreaterThan(now);
    expect(previewAccessExpiry(first)).toBeLessThanOrEqual(now + 7 * 24 * 60 * 60 * 1000);
  });
  it('rejects expiry, scope changes, key changes and signature tampering', () => {
    const token = issuePreviewAccess(preview, key, now);
    expect(verifyPreviewAccess(token, preview, key, previewAccessExpiry(token)!)).toBe(false);
    expect(verifyPreviewAccess(token, { ...preview, id: 'other' }, key, now)).toBe(false);
    expect(verifyPreviewAccess(token, { ...preview, workspaceId: 'other' }, key, now)).toBe(false);
    expect(verifyPreviewAccess(token, { ...preview, accessTokenHash: 'rotated' }, key, now)).toBe(
      false
    );
    expect(verifyPreviewAccess(token, preview, Buffer.alloc(32, 9), now)).toBe(false);
    const separator = token.lastIndexOf('.') + 1;
    const tampered =
      token.slice(0, separator) +
      (token[separator] === 'A' ? 'B' : 'A') +
      token.slice(separator + 1);
    expect(verifyPreviewAccess(tampered, preview, key, now)).toBe(false);
    expect(verifyPreviewAccess('g1.invalid', preview, key, now)).toBe(false);
  });
});
