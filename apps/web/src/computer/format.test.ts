import { expect, it } from 'vitest';
import { artifactRequest, decodeEditableText } from './format.js';

it('only offers lossless UTF-8 without binary NUL bytes to the text editor', () => {
  const text = 'A café in bloom 🌿\n';
  expect(decodeEditableText(new TextEncoder().encode(text))).toBe(text);
  expect(decodeEditableText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
  expect(decodeEditableText(new Uint8Array([0x41, 0, 0x42]))).toBeNull();
});

it('binds saved results to their originating work and keeps standalone files unbound', () => {
  const file = {
    path: 'workspace/note.txt',
    text: 'Saved text',
    original: 'Saved text',
    truncated: false
  };
  const taskId = '11111111-2222-4333-8444-555555555555';
  expect(artifactRequest(file, taskId)).toEqual({
    path: file.path,
    mimeType: 'text/plain',
    taskId
  });
  expect(artifactRequest(file, null)).toEqual({ path: file.path, mimeType: 'text/plain' });
});

it('refuses to publish old disk contents from a dirty or partial editor', () => {
  const file = {
    path: 'workspace/note.txt',
    text: 'Saved text',
    original: 'Saved text',
    truncated: false
  };
  expect(artifactRequest({ ...file, text: 'Unsaved changes' }, null)).toBeNull();
  expect(artifactRequest({ ...file, truncated: true }, null)).toBeNull();
});
