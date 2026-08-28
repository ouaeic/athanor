import { describe, expect, it } from 'vitest';
import {
  chargeNovelty,
  classifyDestination,
  MAX_CREDITED_TOKEN_CHARS,
  MAX_NOVEL_HOST_BYTES,
  MAX_NOVEL_URL_BYTES,
  MAX_TURN_NOVEL_BYTES,
  MIN_TOKEN_BYTES,
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

/*
 * The charge, and the reason it is a charge per piece rather than a filter.
 *
 * Measured against the shipped classifier before this: 65,536 path segments of one corpus character
 * each - 24 KiB of material at three bits a segment - left a tainted turn through a host it had
 * legitimately read, were charged 0 and raised no card. Every bound in the file was in force and
 * none of them was reached, because `novelBytes` kept only the tokens whose exact string was absent
 * from up to forty kilobytes of the owner's words, and a single character is absent from almost
 * nothing. The filter could be emptied, so the quantity it bounded was not bounded at all.
 */
describe('what an address is charged', () => {
  const owner = 'summarise my inbox and check the docs for the rate';
  const corpusCharacters = [...new Set(owner.toLowerCase().match(/[a-z0-9]/g) ?? [])];

  const spendUntilCarded = (
    address: (index: number) => string,
    limit = 4_000
  ): { requests: number; spent: number; reason: string } => {
    let spent = 0;
    for (let index = 0; index < limit; index += 1) {
      const verdict = classifyDestination(address(index), {
        knownOrigins: ['docs.example.com'],
        ownerText: owner,
        spentNoveltyBytes: spent
      });
      if (verdict.sink) return { requests: index, spent, reason: verdict.reason };
      spent = chargeNovelty(spent, [verdict]);
    }
    return { requests: limit, spent, reason: 'never carded' };
  };

  it('charges a path segment the owner happens to contain, because a corpus says which pieces exist and not in what order', () => {
    // Thirteen characters of the owner's own words are still 3.7 bits of the owner's data each.
    const free = classifyDestination('https://docs.example.com/s/u/m/a/r/i/e', {
      knownOrigins: ['docs.example.com'],
      ownerText: owner
    });
    expect(free.noveltyBytes).toBe(7 * MIN_TOKEN_BYTES);
  });

  /*
   * The other end of the same reasoning, and the one that survived the first fix.
   *
   * Pricing a piece as a choice rather than as material assumes the piece is an index into the
   * corpus. That assumption fails when the piece IS the corpus: the whole owner context in one path
   * segment is trivially a substring of itself, and was charged two bytes and carded nowhere. The
   * recipient has never seen the corpus, so nothing about the piece indexed anything it held.
   */
  it('charges a segment that carries the corpus rather than pointing into it', () => {
    const secrets = [
      owner,
      'AKIA7SAMPLEKEYID0000',
      'staging-db-password-4f2c9a',
      'terms: 40% net 30'
    ];
    const wholeCorpus = secrets
      .join('-')
      .repeat(64)
      .replace(/[^a-z0-9-]/gi, '');
    const verdict = classifyDestination(`https://docs.example.com/${wholeCorpus}`, {
      knownOrigins: ['docs.example.com'],
      ownerText: [owner, ...secrets].join(' ')
    });
    // Charged as material, not as a choice: it is far past the length a composed piece of a real
    // address reaches, so the corpus buys it nothing.
    expect(verdict.noveltyBytes).toBeGreaterThan(MAX_CREDITED_TOKEN_CHARS);
    expect(verdict.sink).toBe(true);
  });

  it('still lets a piece short enough to be an index into the corpus be one', () => {
    const segment = 'a'.repeat(MAX_CREDITED_TOKEN_CHARS);
    const verdict = classifyDestination(`https://docs.example.com/${segment}`, {
      knownOrigins: ['docs.example.com'],
      ownerText: `${owner} ${segment}`
    });
    expect(verdict.noveltyBytes).toBe(MIN_TOKEN_BYTES);
  });

  it('stops a payload spelled one corpus character at a time, which used to leave unmeasured', () => {
    const segments = 512;
    const path = Array.from(
      { length: segments },
      (_, index) => corpusCharacters[index % corpusCharacters.length]
    ).join('/');
    const verdict = classifyDestination(`https://docs.example.com/${path}`, {
      knownOrigins: ['docs.example.com'],
      ownerText: owner
    });
    expect(verdict.sink).toBe(true);
    expect(verdict.noveltyBytes).toBe(segments * MIN_TOKEN_BYTES);
  });

  it('bounds the same payload spread over as many requests as the attacker likes', () => {
    // One segment per request is the shape that costs the least per byte, so it is the one the
    // bound has to hold against. 512 requests at the floor is the whole turn budget.
    const out = spendUntilCarded(
      (index) => `https://docs.example.com/${corpusCharacters[index % corpusCharacters.length]}`
    );
    expect(out.requests).toBe(MAX_TURN_NOVEL_BYTES / MIN_TOKEN_BYTES);
    expect(out.spent).toBeLessThanOrEqual(MAX_TURN_NOVEL_BYTES);
  });

  it('charges a request that carries nothing at all, because which host is asked next is a choice', () => {
    const verdict = classifyDestination('https://docs.example.com/', {
      knownOrigins: ['docs.example.com'],
      ownerText: owner
    });
    expect(verdict.noveltyBytes).toBe(MIN_TOKEN_BYTES);
  });

  it('names the charge and the budget in the refusal, so the owner is told the number', () => {
    const out = spendUntilCarded((index) => `https://docs.example.com/${100000 + index}`);
    expect(out.reason).toContain(String(out.spent));
    expect(out.reason).toContain(String(MAX_TURN_NOVEL_BYTES));
  });
});

/*
 * The other direction, on traffic nobody wrote for this test.
 *
 * Eight real `web_search` calls were run on 2026-08-28 and the real in-site links read off three of
 * the pages they returned: 136 addresses, of which the turn below is the most expensive. It is the
 * one that decides whether this bound can be left switched on, so it is the one pinned here.
 */
describe('a recorded research turn', () => {
  const handed = [
    'https://react.dev/reference/react/useEffect',
    'https://medium.com/@vishalkalia.er/what-is-the-useeffect-cleanup-function-and-how-it-works-83d8c67a1a10',
    'https://blog.logrocket.com/understanding-react-useeffect-cleanup-function/',
    'https://dev.to/edriso/useeffect-cleanup-function-1j8i',
    'https://refine.dev/blog/useeffect-cleanup/',
    'https://opyjo2.hashnode.dev/cleanup-in-reacts-useeffect',
    'https://dev.to/logrocket/understanding-reacts-useeffect-cleanup-function-1ek5',
    'https://dev.to/dailydevtips1/react-useeffect-cleanup-4ha8?comments_sort=latest'
  ];
  const followed = [
    'https://react.dev/learn/synchronizing-with-effects',
    'https://react.dev/learn/render-and-commit#step-3-react-commits-changes-to-the-dom',
    'https://react.dev/learn/you-might-not-need-an-effect',
    'https://react.dev/reference/react/useLayoutEffect',
    'https://react.dev/learn/synchronizing-with-effects#step-3-add-cleanup-if-needed',
    'https://react.dev/learn/synchronizing-with-effects#how-to-handle-the-effect-firing-twice-in-development',
    'https://react.dev/learn/lifecycle-of-reactive-effects#each-effect-represents-a-separate-synchronization-process',
    'https://react.dev/learn/lifecycle-of-reactive-effects#thinking-from-the-effects-perspective',
    'https://react.dev/learn/reusing-logic-with-custom-hooks',
    'https://react.dev/learn/reusing-logic-with-custom-hooks#when-to-use-custom-hooks',
    'https://react.dev/learn/removing-effect-dependencies',
    'https://react.dev/learn/removing-effect-dependencies#removing-unnecessary-dependencies',
    'https://react.dev/learn/removing-effect-dependencies#does-some-reactive-value-change-unintentionally',
    'https://react.dev/reference/react/useState#updating-state-based-on-the-previous-state',
    'https://react.dev/learn/removing-effect-dependencies#are-you-reading-some-state-to-calculate-the-next-state',
    'https://react.dev/reference/react/useEffectEvent',
    'https://react.dev/learn/separating-events-from-effects#declaring-an-effect-event',
    'https://react.dev/learn/separating-events-from-effects#reading-latest-props-and-state-with-effect-events',
    'https://react.dev/reference/react-dom/server',
    'https://react.dev/learn/creating-a-react-app#full-stack-frameworks',
    'https://react.dev/reference/react-dom/client/hydrateRoot#hydrating-server-rendered-html',
    'https://react.dev/learn/lifecycle-of-reactive-effects#the-lifecycle-of-an-effect'
  ];

  /** The turn as the harness records it: what a search handed back, then what was read. */
  const replay = (): { cards: number; spent: number; worstAddress: number } => {
    let knownOrigins: string[] = [];
    let knownAddresses: string[] = [];
    for (const url of handed) {
      knownOrigins = rememberOrigin(knownOrigins, url);
      knownAddresses = rememberAddress(knownAddresses, url);
    }
    let spent = 0;
    let cards = 0;
    let worstAddress = 0;
    for (const url of [...handed, ...followed]) {
      const verdict = classifyDestination(url, {
        knownOrigins,
        knownAddresses,
        ownerText:
          'Explain when React runs the useEffect cleanup function, with the official docs as the source.',
        spentNoveltyBytes: spent
      });
      if (verdict.sink) cards += 1;
      worstAddress = Math.max(worstAddress, verdict.noveltyBytes);
      spent = chargeNovelty(spent, [verdict]);
      knownOrigins = rememberOrigin(knownOrigins, url);
      knownAddresses = rememberAddress(knownAddresses, url);
    }
    return { cards, spent, worstAddress };
  };

  it('asks the owner about none of its thirty reads', () => {
    expect(replay().cards).toBe(0);
  });

  /*
   * Pinned rather than bounded, because the headroom is the whole argument for leaving this bound
   * switched on and a silent slide into it is what turns a guard off. 915 of 1,024 is 89.4%: this
   * turn followed twenty-two links, and one that followed forty would ask. The dial to turn if that
   * happens is `MAX_TURN_NOVEL_BYTES`, and the price of turning it is stated where it is declared.
   */
  it('leaves 109 bytes of the turn budget unspent, which is the whole margin this bound has', () => {
    const { spent, worstAddress } = replay();
    expect(spent).toBe(915);
    expect(MAX_TURN_NOVEL_BYTES - spent).toBe(109);
    expect(worstAddress).toBeLessThanOrEqual(MAX_NOVEL_URL_BYTES);
  });

  it('charges nothing at all for the eight addresses the search handed it', () => {
    let knownOrigins: string[] = [];
    let knownAddresses: string[] = [];
    for (const url of handed) {
      knownOrigins = rememberOrigin(knownOrigins, url);
      knownAddresses = rememberAddress(knownAddresses, url);
    }
    for (const url of handed)
      expect(
        classifyDestination(url, { knownOrigins, knownAddresses, ownerText: 'read the docs' })
          .noveltyBytes
      ).toBe(0);
  });

  /*
   * A real 301-character NHS disclosure-log URL that a search had just returned. Under a 256-byte
   * memory of what the turn was handed it came back truncated, lost its credit, and was charged 94
   * of the 96 a single address may carry - two bytes from asking the owner to approve reading a page
   * their own search had put in front of them.
   */
  it('still recognises an address the search handed it when the address is 301 characters long', () => {
    const long =
      'https://lincolnshire.icb.nhs.uk/documents/freedom-of-information-disclosure-log/freedom-of-information-disclosure-log-march-2024/foi-response-72679-nhs-lincolnshire-icb-locally-enhanced-service-incentive-schemes/foi-72679-anticoagulation-guidance-for-non-valvular-atrial-fibrillation-nvaf/?layout=file';
    expect(long.length).toBe(301);
    const verdict = classifyDestination(long, {
      knownOrigins: [originOf(long)],
      knownAddresses: rememberAddress([], long),
      ownerText: 'What does NICE currently recommend about anticoagulation in atrial fibrillation?'
    });
    expect(verdict.sink).toBe(false);
    expect(verdict.noveltyBytes).toBe(0);
  });

  /*
   * Found by attack against the credit itself, which is the part of this that had to be got right:
   * a credit is only safe if the thing it credits could not have been chosen. Comparing addresses
   * case-insensitively made `/GuIDe/PrIciNG-and-plans-for-teams` the same address as the one the
   * search handed over - a free bit per letter, 4,096 requests charged 0 - and trimming trailing
   * slashes was the same defect a few bits smaller. A server can tell all of those apart, so they
   * are different requests and the model chose which one to make.
   */
  it('does not credit an address whose letters were re-cased, because the server can tell', () => {
    const handedAddress = 'https://docs.example.com/guide/pricing-and-plans-for-teams';
    const verdict = classifyDestination(
      'https://docs.example.com/GuIDe/PrIciNG-and-plans-for-teams',
      {
        knownOrigins: ['docs.example.com'],
        knownAddresses: [handedAddress],
        ownerText: 'read the pricing guide'
      }
    );
    expect(verdict.noveltyBytes).toBeGreaterThanOrEqual(MIN_TOKEN_BYTES);
  });

  it('does not credit an address given extra trailing slashes, for the same reason', () => {
    const handedAddress = 'https://docs.example.com/guide/pricing';
    const verdict = classifyDestination(`${handedAddress}//`, {
      knownOrigins: ['docs.example.com'],
      knownAddresses: [handedAddress],
      ownerText: 'read the pricing guide'
    });
    expect(verdict.noveltyBytes).toBeGreaterThanOrEqual(MIN_TOKEN_BYTES);
  });

  it('does credit the one difference a server cannot see, which is the host’s own case', () => {
    const handedAddress = 'https://docs.example.com/guide/pricing';
    const verdict = classifyDestination('https://DOCS.Example.COM/guide/pricing', {
      knownOrigins: ['docs.example.com'],
      knownAddresses: [handedAddress],
      ownerText: 'read the pricing guide'
    });
    expect(verdict.noveltyBytes).toBe(0);
  });

  it('does not let a handed address vouch for one the model extended', () => {
    const handedAddress = 'https://docs.example.com/guide/pricing';
    const verdict = classifyDestination(`${handedAddress}/463820-551933-778411`, {
      knownOrigins: ['docs.example.com'],
      knownAddresses: [handedAddress],
      ownerText: 'read the pricing guide'
    });
    // The payload at its own length, and the two segments the handed address already held at the
    // price of naming them - not the free pass a prefix match would have been.
    expect(verdict.noveltyBytes).toBe('463820-551933-778411'.length + 2 * MIN_TOKEN_BYTES);
  });
});
