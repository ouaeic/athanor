import { describe, expect, it } from 'vitest';
import { redactObject, redactText } from './redaction.js';

describe('the last net before a secret reaches somewhere it can be read', () => {
  it('catches a bearer token written the way the header is actually written', () => {
    // `Bearer` sat in a character class with no space in it, so this - the only form anybody sends
    // - matched nothing, and the branch fired only on the malformed no-space version.
    expect(redactText('authorization: Bearer sk-live-abcdefghijklmnop')).toBe(
      'authorization: [REDACTED]'
    );
    expect(redactText('Basic am86cGFzc3dvcmQxMjM0NTY=')).toBe('[REDACTED]');
    expect(redactText('Bearer short')).toBe('Bearer short');
  });

  it('catches the credential shapes a self-hosted box actually handles', () => {
    // Assembled from pieces rather than written whole. These are invented values - the AWS one is
    // from Amazon's own documentation - but they are deliberately the exact shapes a credential
    // scanner hunts for, which is the point of the test and also what makes them a nuisance in a
    // public repository: GitHub opened an alert on the Google line the day this was published.
    // Splitting the prefix keeps the run-time value identical and leaves no literal to match.
    const shape = (...parts: string[]): string => parts.join('');
    for (const secret of [
      shape('sk-ant-', 'api03-abcdefghijklmnopqrstuv'),
      shape('gh', 'p_', 'abcdefghijklmnopqrstuvwxyz012345'),
      shape('github_pat_', '11ABCDEFG0abcdefghij'),
      shape('xoxb-', '1234567890-abcdefghijkl'),
      shape('glpat-', 'abcdefghijklmnopqrst'),
      shape('AK', 'IA', 'IOSFODNN7EXAMPLE'),
      shape('AIzaSy', 'A0123456789abcdefghijklmnopqrstuv'),
      shape('eyJhbGciOiJIUzI1NiJ9.', 'eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g')
    ]) {
      expect(redactText(`value=${secret} rest`), secret).toBe('value=[REDACTED] rest');
    }
  });

  it('catches a private key as a block rather than leaving most of it behind', () => {
    const pem = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU',
      'AAAAEc3NoLWVkMjU1MTkAAAAgAAAA',
      '-----END OPENSSH PRIVATE KEY-----'
    ].join('\n');
    expect(redactText(`key:\n${pem}\ndone`)).toBe('key:\n[REDACTED]\ndone');
  });

  it('takes the password out of a URL and keeps the host', () => {
    // A connector error naming the address it failed on, and an audit record of a refused
    // destination, both arrive here as ordinary text with a complete credential inside them.
    expect(redactText('PROPFIND https://jo:app-password@cloud.example/dav/ failed')).toBe(
      'PROPFIND https://[REDACTED]@cloud.example/dav/ failed'
    );
    expect(redactText('https://jo@cloud.example/dav/')).toBe(
      'https://[REDACTED]@cloud.example/dav/'
    );
    // An ordinary address is a fact worth keeping intact: it is the record of where something went.
    expect(redactText('GET https://elsewhere.example/c?d=payload')).toBe(
      'GET https://elsewhere.example/c?d=payload'
    );
  });

  it('leaves ordinary words alone, because a net that catches everything is not read', () => {
    for (const ordinary of [
      'workspace/report.md',
      'skipped 12 messages',
      'error code connector_unavailable',
      'user@example.com'
    ]) {
      expect(redactText(ordinary), ordinary).toBe(ordinary);
    }
  });

  it('still redacts by key, and still walks arrays and nesting to a bounded depth', () => {
    // Assembled for the reason the case above states: the run-time value is the same shape a
    // scanner hunts for, and no literal here is one.
    const shape = (...parts: string[]): string => parts.join('');
    const token = shape('gh', 'p_', 'abcdefghijklmnopqrstuvwxyz012345');
    const keyId = shape('AK', 'IA', 'IOSFODNN7EXAMPLE');
    expect(
      redactObject({
        code: 'refused',
        Authorization: 'anything',
        nested: { detail: `contact ${token}` },
        list: [keyId]
      })
    ).toEqual({
      code: 'refused',
      Authorization: '[REDACTED]',
      nested: { detail: 'contact [REDACTED]' },
      list: ['[REDACTED]']
    });
    let deep: unknown = token;
    for (let level = 0; level < 12; level += 1) deep = { deep };
    expect(JSON.stringify(redactObject(deep))).toContain('[MAX_DEPTH]');
    expect(JSON.stringify(redactObject(deep))).not.toContain('ghp_');
  });
});
