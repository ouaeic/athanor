import { describe, expect, it } from 'vitest';
import { recoveryFile } from './account-recovery.js';

describe('recoveryFile', () => {
  it('carries the code and explains itself without the screen that produced it', () => {
    const file = recoveryFile('ATHANOR-TEST-CODE-0001');
    expect(file.name).toBe('athanor-recovery-code.txt');
    expect(file.type).toBe('text/plain');
    expect(file.text).toContain('ATHANOR-TEST-CODE-0001');
    expect(file.text).toContain('replaces every passkey');
  });

  it('puts the code on a line of its own so it can be copied cleanly', () => {
    expect(recoveryFile('CODE-123').text.split('\n')[1]).toBe('CODE-123');
  });

  it('dates itself and says a newer code retires it, because two files now look alike', () => {
    const file = recoveryFile('CODE-123', new Date('2026-07-31T09:14:00Z'));
    expect(file.text).toContain('Issued 2026-07-31.');
    expect(file.text).toContain('retires this one');
  });
});
