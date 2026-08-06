import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { WrapText } from 'lucide-react';
import { CopyButton, plainText } from './Markdown.js';
import { containsMath } from './markdown-math.js';
import {
  blockedResourceText,
  classifyResource,
  rehypeLocalResources,
  type BlockedResource
} from './resource-policy.js';
import type { MathPlugins } from './katex-plugins.js';
import 'highlight.js/styles/github-dark.css';

type PluginList = NonNullable<ComponentProps<typeof ReactMarkdown>['rehypePlugins']>;

/**
 * Auto-detection scores a block against every registered grammar, which is wasted work on every
 * streaming re-render. Scoping detection to the languages an agent actually emits keeps it cheap;
 * a fenced block that names its language is still highlighted with that language directly.
 */
const detectionSubset = [
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'diff',
  'dockerfile',
  'go',
  'ini',
  'java',
  'javascript',
  'json',
  'markdown',
  'php',
  'python',
  'ruby',
  'rust',
  'shell',
  'sql',
  'typescript',
  'xml',
  'yaml'
];

/**
 * Raw HTML is deliberately not enabled. Model output and fetched page text are untrusted, and
 * react-markdown escapes HTML unless `rehype-raw` is added, so this stays the safe default.
 *
 * `rehypeLocalResources` is last on purpose. Every plugin before it may add elements, and the rule
 * it enforces — that a message athanor wrote can only make this browser fetch from this box — has
 * to hold over the tree that is actually rendered rather than the one markdown produced.
 */
const remarkPlugins: PluginList = [remarkGfm];
const highlightPlugin = [
  rehypeHighlight,
  { detect: true, ignoreMissing: true, subset: detectionSubset }
];
const rehypePlugins: PluginList = [highlightPlugin, rehypeLocalResources] as PluginList;
const rehypePluginsWithMath = (math: MathPlugins): PluginList =>
  [highlightPlugin, math.rehype, rehypeLocalResources] as PluginList;

/** The maths module is fetched once per session and then shared by every message that needs it. */
let mathModule: MathPlugins | undefined;
let mathRequest: Promise<MathPlugins> | undefined;

const loadMath = (): Promise<MathPlugins> => {
  mathRequest ??= import('./katex-plugins.js').then(({ mathPlugins }) => {
    mathModule = mathPlugins;
    return mathPlugins;
  });
  return mathRequest;
};

/**
 * Maths support arrives a frame late on the first message that needs it, which is the whole point:
 * until then the delimiters render as literal text rather than as a blocked first paint.
 */
const useMathPlugins = (source: string): MathPlugins | undefined => {
  const wanted = containsMath(source);
  const [loaded, setLoaded] = useState<MathPlugins | undefined>(mathModule);
  useEffect(() => {
    if (!wanted || loaded) return;
    let live = true;
    void loadMath().then((plugins) => {
      if (live) setLoaded(() => plugins);
    });
    return () => {
      live = false;
    };
  }, [wanted, loaded]);
  return wanted ? loaded : undefined;
};

function CodeBlock({ language, children }: { language: string; children: ReactNode }) {
  const [wrapped, setWrapped] = useState(false);
  const source = plainText(children).replace(/\n$/, '');
  return (
    <figure className={`code-block ${wrapped ? 'wrapped' : ''}`}>
      <figcaption>
        <span className="code-language">{language || 'text'}</span>
        <span className="code-actions">
          <button
            type="button"
            className="copy-button"
            onClick={() => setWrapped((current) => !current)}
            aria-pressed={wrapped}
            aria-label={wrapped ? 'Disable line wrapping' : 'Wrap long lines'}
            title={wrapped ? 'Disable line wrapping' : 'Wrap long lines'}
          >
            <WrapText />
          </button>
          <CopyButton value={source} />
        </span>
      </figcaption>
      <pre>
        <code className={language ? `language-${language}` : undefined}>{children}</code>
      </pre>
    </figure>
  );
}

/**
 * What stands where a suppressed resource was, when the component map is what caught it.
 *
 * The tree pass above normally gets there first, so this is the layer that still holds if that pass
 * is ever removed, reordered, or bypassed by a renderer that stops honouring rehype plugins. Both
 * produce the same sentence, from the same function, so the owner sees one thing and not two.
 */
function BlockedResourceMark({
  tagName,
  alt,
  resource
}: {
  tagName: string;
  alt: string;
  resource: BlockedResource;
}) {
  const label = blockedResourceText(tagName, alt, resource);
  if (!resource.followable || !resource.href)
    return <span className="blocked-resource">{label}</span>;
  return (
    <a
      className="blocked-resource"
      href={resource.href}
      target="_blank"
      rel="noreferrer noopener"
      referrerPolicy="no-referrer"
      title={`athanor did not load this. Opening it sends a request to ${resource.host}.`}
    >
      {label}
    </a>
  );
}

const components: Components = {
  code({ node, className, children, ...rest }) {
    const language = /language-(\w[\w+-]*)/.exec(className ?? '')?.[1] ?? '';
    // react-markdown only wraps fenced blocks in <pre>, so an inline span has no language class
    // and no newline. Both checks are needed: a fenced block can lack an info string.
    const source = plainText(children);
    if (!language && !source.includes('\n'))
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    return <CodeBlock language={language}>{children}</CodeBlock>;
  },
  pre({ children }) {
    // The code renderer already emits its own <pre>; this avoids nesting two of them.
    return <>{children}</>;
  },
  a({ href, children, className, title }) {
    return (
      <a
        {...(typeof href === 'string' ? { href } : {})}
        {...(className ? { className } : {})}
        {...(title ? { title } : {})}
        target="_blank"
        rel="noreferrer noopener"
        referrerPolicy="no-referrer"
      >
        {children}
      </a>
    );
  },
  table({ node, children, ...rest }) {
    return (
      <div className="table-scroll">
        <table {...rest}>{children}</table>
      </div>
    );
  },
  /**
   * The second of the three places the resource policy is applied.
   *
   * `src` is re-judged here rather than trusted from the tree, and the props are named rather than
   * spread: `...rest` carried react-markdown's own `node` object straight onto the element, which
   * is how `node="[object Object]"` was reaching the DOM.
   */
  img({ src, alt, title, width, height }) {
    const verdict = classifyResource(src);
    if (!verdict.allowed)
      return <BlockedResourceMark tagName="img" alt={alt ?? ''} resource={verdict} />;
    return (
      <img
        src={typeof src === 'string' ? src : undefined}
        alt={alt ?? ''}
        loading="lazy"
        {...(title ? { title } : {})}
        {...(width === undefined ? {} : { width })}
        {...(height === undefined ? {} : { height })}
      />
    );
  }
};

export default function MarkdownBody({ children }: { children: string }) {
  const math = useMathPlugins(children);
  // A fresh plugin array is a fresh processor, so the arrays have to stay referentially stable
  // across the re-render that every streamed delta causes.
  const plugins = useMemo(
    () =>
      math
        ? {
            remark: [remarkGfm, math.remark] as PluginList,
            rehype: rehypePluginsWithMath(math)
          }
        : { remark: remarkPlugins, rehype: rehypePlugins },
    [math]
  );
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={plugins.remark}
        rehypePlugins={plugins.rehype}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
