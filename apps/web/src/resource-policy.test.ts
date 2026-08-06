import { describe, expect, it } from 'vitest';
import {
  attributeVerdict,
  blockedResourceText,
  classifyResource,
  rehypeLocalResources,
  suppressionSummary,
  type BlockedReason,
  type BlockedResource
} from './resource-policy.js';

const BOX = 'https://box.example';

const refused = (host: string, reason: BlockedReason = 'remote'): BlockedResource => ({
  href: host ? `https://${host}/p.png` : '',
  host,
  followable: reason === 'remote',
  reason
});

/** Minimal hast, written by hand so the test does not depend on the markdown parser's shape. */
interface Node {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
  value?: string;
}

const element = (tagName: string, properties: Record<string, unknown>, children: Node[] = []) => ({
  type: 'element',
  tagName,
  properties,
  children
});

const tree = (...children: Node[]): Node => ({ type: 'root', children });

const run = (root: Node): Node => {
  rehypeLocalResources({ origin: BOX })(root);
  return root;
};

const only = (root: Node): Node => {
  const first = root.children?.[0];
  if (!first) throw new Error('the tree lost its only child');
  return first;
};

describe('what a message athanor wrote may load', () => {
  it('loads this box, its own blob handles, and inert data payloads', () => {
    expect(classifyResource('/v1/artifacts/abc/content', BOX).allowed).toBe(true);
    expect(classifyResource('artifacts/abc.png', BOX).allowed).toBe(true);
    expect(classifyResource(`${BOX}/brand/athanor-icon-192.png`, BOX).allowed).toBe(true);
    expect(classifyResource(`blob:${BOX}/6f0c-4c1a`, BOX).allowed).toBe(true);
    expect(classifyResource('data:image/png;base64,iVBORw0KGgo=', BOX).allowed).toBe(true);
    // `https:/host/p` reads as another host and resolves to a path on this one, which is what the
    // browser does with it. Resolving rather than pattern-matching is how the two agree.
    expect(classifyResource('https:/elsewhere.example/p.png', BOX).allowed).toBe(true);
  });

  it('refuses every other origin, whatever shape the address is written in', () => {
    for (const address of [
      'https://elsewhere.example/p.png?d=SECRET',
      'http://elsewhere.example/p.png',
      '//elsewhere.example/p.png',
      '\\\\elsewhere.example/p.png',
      `https://box.example.elsewhere.example/p.png`,
      `blob:https://elsewhere.example/6f0c`,
      'HTTPS://ELSEWHERE.EXAMPLE/p.png'
    ]) {
      expect(classifyResource(address, BOX).allowed, address).toBe(false);
    }
  });

  it('refuses a port or a scheme that only looks like this box', () => {
    expect(classifyResource('https://box.example:8443/p.png', BOX).allowed).toBe(false);
    expect(classifyResource('http://box.example/p.png', BOX).allowed).toBe(false);
  });

  it('reads the address the browser will read, not the one the characters spell', () => {
    // The HTML parser drops these before it resolves the attribute, so a check that does not is
    // looking at a different address from the one that gets fetched.
    expect(classifyResource('htt\nps://elsewhere.example/p.png', BOX).allowed).toBe(false);
    expect(classifyResource('\thttps://elsewhere.example/p.png', BOX).allowed).toBe(false);
    expect(classifyResource('https://elsewhere​.example/p.png', BOX).allowed).toBe(false);
  });

  it('refuses schemes that are not addresses at all', () => {
    for (const address of [
      'javascript:fetch("https://elsewhere.example")',
      'file:///etc/passwd',
      'about:blank',
      'filesystem:https://box.example/temporary/x'
    ]) {
      expect(classifyResource(address, BOX).allowed, address).toBe(false);
    }
  });

  it('has nothing to load when there is no address', () => {
    expect(classifyResource('', BOX).allowed).toBe(false);
    expect(classifyResource(undefined, BOX).allowed).toBe(false);
    expect(classifyResource({ src: 'x' }, BOX).allowed).toBe(false);
  });

  it('names the host so the owner is told where, not merely that', () => {
    const verdict = classifyResource('https://elsewhere.example/p.png?d=SECRET', BOX);
    expect(verdict).toMatchObject({
      allowed: false,
      host: 'elsewhere.example',
      followable: true
    });
    // www is part of the host: www.elsewhere.example is not elsewhere.example.
    expect(classifyResource('https://www.elsewhere.example/p.png', BOX)).toMatchObject({
      host: 'www.elsewhere.example'
    });
  });

  it('offers nothing to click when the address is not an ordinary web address', () => {
    expect(classifyResource('javascript:alert(1)', BOX)).toMatchObject({
      allowed: false,
      href: '',
      followable: false
    });
  });

  it('judges a candidate list by its worst member, and leaves single addresses whole', () => {
    expect(
      attributeVerdict('srcSet', `${BOX}/a.png 1x, https://elsewhere.example/b.png 2x`, BOX)
    ).toMatchObject({ allowed: false, host: 'elsewhere.example' });
    expect(attributeVerdict('srcSet', `${BOX}/a.png 1x, ${BOX}/b.png 2x`, BOX)).toBeUndefined();
    // A data: payload is full of commas and must not be taken apart into candidates.
    expect(
      attributeVerdict('src', 'data:image/svg+xml,<svg xmlns="x"><rect,/></svg>', BOX)
    ).toBeUndefined();
    expect(attributeVerdict('src', undefined, BOX)).toBeUndefined();
  });
});

describe('what the document tree is allowed to keep', () => {
  it('replaces a remote image with an inert link that names the host', () => {
    const root = run(
      tree(element('p', {}, [element('img', { src: 'https://elsewhere.example/p.png?d=SECRET' })]))
    );
    const replaced = only(root).children?.[0];
    expect(replaced?.tagName).toBe('a');
    expect(replaced?.properties?.href).toBe('https://elsewhere.example/p.png?d=SECRET');
    expect(replaced?.properties?.rel).toEqual(['noreferrer', 'noopener']);
    expect(replaced?.children?.[0]?.value).toContain('elsewhere.example');
    // The point of the whole exercise: nothing left in the tree makes a request.
    expect(JSON.stringify(root)).not.toContain('"img"');
  });

  it('keeps the alt text, because the reader still deserves to know what was meant', () => {
    const root = run(
      tree(
        element('img', { src: 'https://elsewhere.example/chart.png', alt: 'Revenue by quarter' })
      )
    );
    expect(only(root).children?.[0]?.value).toContain('Revenue by quarter');
  });

  it('leaves this box, blob handles and data payloads exactly as they were', () => {
    const root = run(
      tree(
        element('img', { src: '/v1/artifacts/abc/content' }),
        element('img', { src: `blob:${BOX}/6f0c` }),
        element('img', { src: 'data:image/png;base64,iVBORw0KGgo=' })
      )
    );
    expect(root.children?.map((child) => child.tagName)).toEqual(['img', 'img', 'img']);
  });

  it('covers every element that fetches, not only the one markdown can write today', () => {
    const remote = 'https://elsewhere.example/x';
    const elements = [
      element('video', { poster: remote }),
      element('iframe', { src: remote }),
      element('object', { data: remote }),
      element('script', { src: remote }),
      element('link', { href: remote }),
      element('td', { background: remote })
    ];
    const root = run(tree(...elements));
    expect(root.children?.slice(0, elements.length).every((child) => child.tagName === 'a')).toBe(
      true
    );
  });

  it('reads the xlink attribute by the name a real tree actually uses', () => {
    // `property-information` calls `xlink:href` `xLinkHref`, with a capital L. Spelled the way it
    // reads, the entry matched nothing, and an SVG `<image>` was the one fetching element the tree
    // pass could not see. Every spelling a tree might carry is covered now.
    for (const attribute of ['xLinkHref', 'xlinkHref', 'xlink:href', 'href']) {
      const root = run(
        tree(element('image', { [attribute]: 'https://elsewhere.example/p.png?d=SECRET' }))
      );
      expect(only(root).tagName, attribute).toBe('a');
    }
  });

  it('refuses a payload on the elements that would run it, and keeps it on the ones that draw it', () => {
    // `data:` is inert in an <img>: there is no request and an image cannot execute. In an iframe
    // the same string is a document with its own script and its own network, which no `img-src`
    // constrains — and this client sets no `frame-src`, so the tree pass is the whole defence.
    const payload = 'data:text/html;base64,PHNjcmlwdD5mZXRjaCgnLy9lbHNld2hlcmUnKTwvc2NyaXB0Pg==';
    for (const tagName of ['iframe', 'frame', 'embed', 'script', 'link', 'use']) {
      const root = run(tree(element(tagName, { src: payload, data: payload, href: payload })));
      expect(only(root).tagName, tagName).toBe('span');
      expect(only(root).children?.[0]?.value, tagName).toContain('written into this message');
    }
    for (const tagName of ['img', 'video', 'audio', 'source', 'track', 'td']) {
      const root = run(
        tree(element(tagName, { src: payload, poster: payload, background: payload }))
      );
      expect(only(root).tagName, tagName).toBe(tagName);
    }
  });

  it('offers nothing to click for a payload, because there is nowhere to go', () => {
    const root = run(
      tree(element('object', { data: 'data:text/html,<script>fetch("//elsewhere")</script>' }))
    );
    expect(only(root).properties?.href).toBeUndefined();
  });

  it('strips an inline style that fetches without writing url()', () => {
    // `image-set()` names its candidates as bare strings, so a rule looking only for `url(` leaves
    // an ordinary remote background loading.
    const root = run(
      tree(
        element('span', { style: 'background:image-set("https://elsewhere.example/p.png" 1x)' }),
        element('span', { style: 'background:-webkit-image-set("https://elsewhere.example/p" 1x)' })
      )
    );
    expect(root.children?.[0]?.properties?.style).toBeUndefined();
    expect(root.children?.[1]?.properties?.style).toBeUndefined();
  });

  it('says once, at the end, that the message asked for something it did not get', () => {
    const root = run(
      tree(
        element('p', {}, [{ type: 'text', value: 'Here is the summary you asked for.' }]),
        element('img', { src: 'https://tracker.example/p.png?d=SECRET' })
      )
    );
    const summary = root.children?.[root.children.length - 1];
    expect(summary?.properties?.className).toEqual(['blocked-resource-summary']);
    expect(JSON.stringify(summary)).toContain('tracker.example');
    expect(JSON.stringify(summary)).toContain('1 address');
  });

  it('adds nothing at all to a message that asked for nothing remote', () => {
    const root = run(tree(element('img', { src: '/v1/artifacts/abc/content' })));
    expect(root.children).toHaveLength(1);
    expect(JSON.stringify(root)).not.toContain('blocked-resource-summary');
  });

  it('counts each refusal once and each host once', () => {
    const root = run(
      tree(
        element('img', { src: 'https://tracker.example/1.png' }),
        element('img', { src: 'https://tracker.example/2.png' }),
        element('img', { src: 'https://other.example/3.png' })
      )
    );
    const summary = JSON.stringify(root.children?.[3]);
    expect(summary).toContain('3 addresses on tracker.example and other.example');
  });

  it('does not nest a link inside a link', () => {
    const root = run(
      tree(
        element('a', { href: 'https://elsewhere.example/page' }, [
          element('img', { src: 'https://elsewhere.example/p.png' })
        ])
      )
    );
    const outer = only(root);
    expect(outer.tagName).toBe('a');
    expect(outer.children?.[0]?.tagName).toBe('span');
  });

  it('strips the two attributes that fetch without being a resource', () => {
    const root = run(
      tree(
        element('a', { href: '/local', ping: 'https://elsewhere.example/track' }),
        element('span', { style: 'background-image:url(https://elsewhere.example/p.png)' }),
        element('span', { style: 'height:0.8em' })
      )
    );
    expect(root.children?.[0]?.properties?.ping).toBeUndefined();
    expect(root.children?.[1]?.properties?.style).toBeUndefined();
    // KaTeX and highlight.js set inline styles constantly; only the ones that fetch are touched.
    expect(root.children?.[2]?.properties?.style).toBe('height:0.8em');
  });

  it('takes the target off a link that is not a link', () => {
    const root = run(
      tree(
        element('a', { href: 'javascript:fetch("https://elsewhere.example")' }),
        element('a', { href: 'mailto:someone@example.com' }),
        element('a', { href: 'https://elsewhere.example/page' })
      )
    );
    expect(root.children?.[0]?.properties?.href).toBeUndefined();
    // An ordinary link stays an ordinary link: this rule is about fetching, not about leaving.
    expect(root.children?.[1]?.properties?.href).toBe('mailto:someone@example.com');
    expect(root.children?.[2]?.properties?.href).toBe('https://elsewhere.example/page');
  });

  it('reaches elements a plugin added several levels down', () => {
    const root = run(
      tree(
        element('div', {}, [
          element('section', {}, [
            element('p', {}, [element('img', { src: 'https://elsewhere.example/deep.png' })])
          ])
        ])
      )
    );
    const rendered = JSON.stringify(root);
    // Nothing that fetches is left, but the address survives as something the owner may follow.
    expect(rendered).not.toContain('"img"');
    expect(rendered).not.toContain('"src"');
    expect(rendered).toContain('elsewhere.example/deep.png');
  });

  it('survives a tree with nothing in it', () => {
    expect(() => run(tree())).not.toThrow();
    expect(() => rehypeLocalResources({ origin: BOX })(undefined)).not.toThrow();
  });
});

describe('the line shown instead', () => {
  it('says what was suppressed and where it lives', () => {
    expect(blockedResourceText('img', '', refused('elsewhere.example'))).toBe(
      'Image not loaded, from elsewhere.example'
    );
    expect(blockedResourceText('img', 'Revenue', refused('elsewhere.example'))).toBe(
      'Revenue — image not loaded, from elsewhere.example'
    );
    expect(blockedResourceText('iframe', '', refused('elsewhere.example'))).toContain(
      'Embedded page'
    );
    expect(blockedResourceText('img', '', refused('', 'unreadable'))).toContain('could not read');
  });

  it('does not call a payload it read perfectly well an address it could not read', () => {
    // The two used to collapse into one sentence, and the resulting one was false.
    expect(blockedResourceText('iframe', '', refused('', 'inline'))).toBe(
      'Embedded page not loaded, from a document written into this message'
    );
  });
});

describe('the sentence at the foot of the message', () => {
  it('stays silent when the message asked for nothing it was refused', () => {
    expect(suppressionSummary({ total: 0, hosts: [] })).toBeUndefined();
  });

  it('counts what was refused and names where it was going', () => {
    expect(suppressionSummary({ total: 1, hosts: ['elsewhere.example'] })?.detail).toContain(
      '1 address on elsewhere.example'
    );
    expect(suppressionSummary({ total: 2, hosts: ['a.example', 'b.example'] })?.detail).toContain(
      '2 addresses on a.example and b.example'
    );
    expect(
      suppressionSummary({ total: 9, hosts: ['a.example', 'b.example', 'c.example', 'd.example'] })
        ?.detail
    ).toContain('9 addresses on a.example, b.example and 2 more');
  });

  it('says where a payload with no host came from instead of naming nowhere', () => {
    expect(suppressionSummary({ total: 1, hosts: [] })?.detail).toContain(
      '1 address written into the message itself'
    );
  });
});
