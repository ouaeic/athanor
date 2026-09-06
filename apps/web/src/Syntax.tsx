import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import 'highlight.js/styles/github-dark.css';
for (const [name, grammar] of Object.entries({
  bash,
  cpp,
  css,
  diff,
  javascript,
  json,
  markdown,
  python,
  r,
  rust,
  sql,
  typescript,
  xml,
  yaml
}))
  hljs.registerLanguage(name, grammar);
const aliases: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  js: 'javascript',
  ts: 'typescript',
  jsx: 'javascript',
  tsx: 'typescript',
  html: 'xml',
  svg: 'xml',
  py: 'python',
  yml: 'yaml',
  c: 'cpp'
};
export default function Syntax({ code, language }: { code: string; language: string }) {
  const name = aliases[language] ?? language;
  if (!hljs.getLanguage(name) || code.length > 200_000)
    return <code className={`language-${language}`}>{code}</code>;
  // The highlighter escapes source text before adding its own span markup.
  return (
    <code
      className={`hljs language-${language}`}
      dangerouslySetInnerHTML={{
        __html: hljs.highlight(code, { language: name, ignoreIllegals: true }).value
      }}
    />
  );
}
