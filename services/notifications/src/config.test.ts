import { describe, expect, it } from 'vitest';
import { loadConfig, masterKeyBytes } from './config.js';

const base = {
  DATABASE_DRIVER: 'postgres',
  DATABASE_URL: 'postgres://athanor:athanor@localhost:5432/athanor'
};

const key = (bytes: number): string => Buffer.alloc(bytes, 7).toString('base64');

describe('the workspace decryption key', () => {
  it('is read from the same environment file every other service reads it from', () => {
    // Without this the sender asks the data layer for pending rows and gets every title back as
    // null, so every notification on every device reads "Untitled conversation". The key was not
    // merely unpassed before this: the schema had no field for it, so it was unobtainable.
    const config = loadConfig({ ...base, DATA_MASTER_KEY: key(32) });
    expect(config.DATA_MASTER_KEY).toBe(key(32));
    expect(masterKeyBytes(config)).toHaveLength(32);
  });

  it('is optional, because a box with no key still delivers untitled notifications', () => {
    const config = loadConfig(base);
    expect(config.DATA_MASTER_KEY).toBeUndefined();
    expect(masterKeyBytes(config)).toBeUndefined();
  });

  it('refuses a key of the wrong size rather than quietly sending untitled notifications', () => {
    // The failure this whole field exists to stop is a key that is present and does not reach the
    // decryption, and a malformed value that was tolerated would reproduce it exactly - the same
    // "Untitled conversation" on every device, with the key sitting right there in control.env.
    expect(() => loadConfig({ ...base, DATA_MASTER_KEY: key(16) })).toThrow();
    expect(() => loadConfig({ ...base, DATA_MASTER_KEY: 'not base64 at all !!' })).toThrow();
  });

  it('treats an empty or blank value as absent, which is how an unset line in control.env reads', () => {
    expect(loadConfig({ ...base, DATA_MASTER_KEY: '' }).DATA_MASTER_KEY).toBeUndefined();
    expect(loadConfig({ ...base, DATA_MASTER_KEY: '   ' }).DATA_MASTER_KEY).toBeUndefined();
  });
});
