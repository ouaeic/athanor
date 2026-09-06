import { lazy, Suspense } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
const Syntax = lazy(() => import('./Syntax'));

export default function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          code: ({ node: _node, children, className, ...props }) => {
            const language = /language-([\w+-]+)/.exec(className ?? '')?.[1];
            const code = (typeof children === 'string' ? children : '').replace(/\n$/, '');
            return language ? (
              <Suspense
                fallback={
                  <code {...props} className={className}>
                    {children}
                  </code>
                }
              >
                <Syntax code={code} language={language} />
              </Suspense>
            ) : (
              <code {...props} className={className}>
                {children}
              </code>
            );
          },
          a: ({ node: _node, children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ node: _node, src, alt, ...props }) =>
            src?.startsWith('/') || src?.startsWith('blob:') ? (
              <img {...props} src={src} alt={alt ?? ''} loading="lazy" />
            ) : (
              <a href={src} target="_blank" rel="noopener noreferrer">
                {alt || 'Open image'}
              </a>
            )
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
