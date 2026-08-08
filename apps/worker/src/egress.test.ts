import { describe, expect, it } from 'vitest';
import { classifyDestination, MAX_NOVEL_URL_BYTES, originOf, rememberOrigin } from './egress.js';

const context = (overrides: Partial<Parameters<typeof classifyDestination>[1]> = {}) => ({
  knownOrigins: ['docs.example.com'],
  ownerText: 'read the pricing page on docs.example.com',
  ...overrides
});

describe('where a tainted turn may send a request', () => {
  it('refuses a host nobody named, which is the channel this exists to close', () => {
    const verdict = classifyDestination('https://collector.invalid/log?q=secret', context());
    expect(verdict.sink).toBe(true);
    expect(verdict.host).toBe('collector.invalid');
  });

  it('refuses a known host carrying more novel material than a real link needs', () => {
    const payload = 'a'.repeat(MAX_NOVEL_URL_BYTES + 20);
    const verdict = classifyDestination(`https://docs.example.com/${payload}`, context());
    expect(verdict.sink).toBe(true);
    expect(verdict.noveltyBytes).toBeGreaterThan(MAX_NOVEL_URL_BYTES);
  });

  it('allows a deep link on a host the owner named', () => {
    expect(classifyDestination('https://docs.example.com/pricing', context()).sink).toBe(false);
  });

  /*
   * The owner asked for a page to be built and served. It raised ten approval cards and every one
   * of them was athanor talking to itself - four to its own web server on loopback, three to its
   * own preview URL on its own domain. Nothing left the machine in any of them. Cards like that are
   * worse than no card, because they are what teaches someone to approve without reading.
   */
  it('does not ask about the machine talking to itself', () => {
    for (const address of [
      'http://localhost:8080/world-clock.html',
      'http://127.0.0.1:8080/status',
      'http://[::1]:3000/health',
      'http://192.168.1.10/thing',
      'http://box.local/page'
    ])
      expect(classifyDestination(address, context()).sink).toBe(false);
  });

  it('does not ask about this installation reading its own published preview', () => {
    const verdict = classifyDestination(
      'https://vps-5099.example-host.one/__athanor/preview/5f4e5aece4af2436e54eabe2',
      context({ selfOrigins: ['vps-5099.example-host.one'] })
    );
    expect(verdict.sink).toBe(false);
  });

  it('still refuses a lookalike of this installation’s own address', () => {
    // Only the address the box actually answers on is itself; a neighbouring name is a third party.
    const verdict = classifyDestination(
      'https://vps-5099.example-host.one.evil.invalid/steal',
      context({ selfOrigins: ['vps-5099.example-host.one'] })
    );
    expect(verdict.sink).toBe(true);
  });

  it('refuses a scheme that is not a web read, and an address it cannot parse', () => {
    expect(classifyDestination('file:///etc/passwd', context()).sink).toBe(true);
    expect(classifyDestination('not a url', context()).sink).toBe(true);
  });
});

describe('remembering where a turn has already been', () => {
  it('keeps hosts once and reads the host out of an address', () => {
    expect(originOf('https://Docs.Example.com/a')).toBe('docs.example.com');
    expect(originOf('mailto:someone@example.com')).toBe('');
    expect(rememberOrigin(['a.example'], 'https://a.example/x')).toEqual(['a.example']);
    expect(rememberOrigin(['a.example'], 'https://b.example/x')).toEqual([
      'a.example',
      'b.example'
    ]);
  });
});
