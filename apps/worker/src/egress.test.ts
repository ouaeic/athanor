import { describe, expect, it } from 'vitest';
import {
  chargeNovelty,
  classifyDestination,
  MAX_NOVEL_HOST_BYTES,
  MAX_NOVEL_URL_BYTES,
  MAX_TURN_NOVEL_BYTES,
  originOf,
  rememberAddress,
  rememberOrigin
} from './egress.js';

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

/*
 * Executing the shipped classifier, `https://<32 hex characters>.docs.example.com/` came back
 * `{sink: false, noveltyBytes: 0}` on a turn that had read docs.example.com: the tokeniser measured
 * the path, the query and the fragment, and the one part of an address that needs no cooperation
 * from the destination was the part nothing looked at.
 */
describe('what the name itself carries', () => {
  it('refuses a payload wearing a subdomain of a host the turn has read', () => {
    const verdict = classifyDestination(
      'https://4f8a2c9e17b3d05f6a1e8c2b7d4930fa.docs.example.com/',
      context()
    );
    expect(verdict.sink).toBe(true);
    expect(verdict.noveltyBytes).toBeGreaterThan(MAX_NOVEL_HOST_BYTES);
  });

  it('still follows a real subdomain, because a subdomain is a word', () => {
    for (const address of [
      'https://support.example.com/article/9912',
      'https://eu-west-1.api.example.com/status'
    ])
      expect(classifyDestination(address, context({ knownOrigins: ['example.com'] })).sink).toBe(
        false
      );
  });

  it('charges the name against the longest suffix it matches, not the shortest', () => {
    // Under `example.com` alone the `docs` label would be measured; under the exact host it adds
    // nothing, and both are on the list.
    const verdict = classifyDestination('https://docs.example.com/pricing', {
      knownOrigins: ['example.com', 'docs.example.com'],
      ownerText: 'compare the plans'
    });
    expect(verdict.sink).toBe(false);
  });
});

/*
 * The count was computed per address, printed on the card and added to nothing, so twenty-two
 * addresses that were each individually inside the bound carried 2,048 bytes out between them.
 */
describe('the running budget for a tainted turn', () => {
  const chunks = Array.from({ length: 22 }, (_, index) => `${'z'.repeat(90)}${index}`);

  it('lets each chunk through on its own and stops the twenty-two together', () => {
    let spent = 0;
    const sent = chunks.filter((chunk) => {
      const verdict = classifyDestination(`https://docs.example.com/${chunk}`, {
        ...context(),
        spentNoveltyBytes: spent
      });
      if (verdict.sink) return false;
      spent = chargeNovelty(spent, [verdict]);
      return true;
    });
    expect(sent.length).toBeLessThan(chunks.length);
    expect(spent).toBeLessThanOrEqual(MAX_TURN_NOVEL_BYTES);
  });

  it('names the budget in the reason, so the card says what has already gone', () => {
    const verdict = classifyDestination('https://docs.example.com/summary-of-the-inbox', {
      ...context(),
      spentNoveltyBytes: MAX_TURN_NOVEL_BYTES
    });
    expect(verdict.sink).toBe(true);
    expect(verdict.reason).toContain(String(MAX_TURN_NOVEL_BYTES));
  });

  /*
   * The budget is only worth having if ordinary work never reaches it. A research pass searches,
   * is handed addresses, and reads them - and the harness put those addresses in front of the
   * model itself, so following one is not novel material by any honest reading.
   */
  it('costs a normal research turn nothing', () => {
    const handed = [
      'https://www.ofcom.org.uk/phones-and-broadband/coverage-and-speeds/connected-nations-2026/',
      'https://www.ofcom.org.uk/phones-and-broadband/advice-for-consumers/costs-and-billing/',
      'https://commonslibrary.parliament.uk/research-briefings/cbp-8371/',
      'https://www.which.co.uk/reviews/broadband/article/best-broadband-providers-aXbQ2h8sK1mJ',
      'https://labs.thinkbroadband.com/local/reports/2026-06-availability-and-speed',
      'https://www.gov.uk/guidance/broadband-and-mobile-coverage-in-your-area'
    ];
    const searched = handed.reduce((known, url) => rememberAddress(known, url), [] as string[]);
    const knownOrigins = handed.map(originOf);
    let spent = 0;
    for (const url of handed) {
      const verdict = classifyDestination(url, {
        knownOrigins,
        knownAddresses: searched,
        ownerText: 'compare UK broadband providers on price and rural coverage this year',
        spentNoveltyBytes: spent
      });
      expect(verdict.sink).toBe(false);
      spent = chargeNovelty(spent, [verdict]);
    }
    expect(spent).toBe(0);
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

  it('keeps whole addresses once, and only ones that are addresses', () => {
    expect(rememberAddress([], 'https://a.example/x')).toEqual(['https://a.example/x']);
    expect(rememberAddress(['https://a.example/x'], 'https://a.example/x')).toEqual([
      'https://a.example/x'
    ]);
    expect(rememberAddress([], 'not a url')).toEqual([]);
  });
});
