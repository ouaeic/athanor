import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Syntax from './Syntax.js';

describe('untrusted source display', () => {
  it('escapes markup in both highlighted and unknown code languages', () => {
    const source = '<img src=x onerror="alert(1)"><script>fetch("/v1/tasks")</script>';
    for (const language of ['html', 'not-a-language']) {
      const html = renderToStaticMarkup(<Syntax language={language} code={source} />);
      expect(html).not.toContain('<img');
      expect(html).not.toContain('<script');
      expect(html).toContain('&lt;');
    }
  });
});
