import { describe, expect, it } from 'vitest';
import { ownerMessageContent } from './owner-message.js';

describe('owner message attachment context', () => {
  it('leaves unattached messages byte-for-byte unchanged', () => {
    const prompt = '  Keep my words.\n';
    expect(ownerMessageContent({ prompt })).toBe(prompt);
    expect(ownerMessageContent({ prompt, attachments: [] })).toBe(prompt);
  });

  it('quotes filenames as data while preserving the original message separately', () => {
    const message = { prompt: 'Read this.', attachments: ['workspace/a\n"quoted".txt'] };
    const rendered = ownerMessageContent(message);
    expect(rendered.startsWith(message.prompt)).toBe(true);
    expect(JSON.parse(rendered.split('\n').at(-1)!)).toEqual(message.attachments);
    expect(message.prompt).toBe('Read this.');
    expect(rendered).not.toContain('a\n"quoted"');
  });

  it('refuses malformed or oversized attachment metadata', () => {
    expect(() =>
      ownerMessageContent({ prompt: 'Read', attachments: Array(21).fill('a') })
    ).toThrow();
    expect(() => ownerMessageContent({ prompt: 'Read', attachments: ['a'.repeat(401)] })).toThrow();
  });
});
