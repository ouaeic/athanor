import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * react-markdown, remark, rehype and highlight.js together are the largest thing this client
 * loads, and the first screen — sign-in, or an empty conversation list — renders no markdown at
 * all. Behind `lazy` they cost nothing until a transcript actually exists.
 */
const MarkdownBody = lazy(() => import('./MarkdownBody.js'));

export const plainText = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(plainText).join('');
  if (typeof node === 'object' && 'props' in node)
    return plainText((node as { props: { children?: ReactNode } }).props.children);
  return '';
};

/** Copy state resets on its own so the button never sticks in a stale "Copied" pose. */
export const useCopy = (): [boolean, (value: string) => void] => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback((value: string) => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1_600);
      })
      .catch(() => setCopied(false));
  }, []);
  return [copied, copy];
};

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, copy] = useCopy();
  return (
    <button
      type="button"
      className="copy-button"
      onClick={() => copy(value)}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
    >
      {copied ? <Check /> : <Copy />}
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
}

/**
 * Rendering is memoised on the source string because a streaming turn re-renders the whole
 * timeline on every delta, and highlighting a long answer on each frame is what makes a chat
 * client feel slow.
 *
 * The fallback is the source text itself rather than a spinner: markdown degrades to readable
 * prose, so the reader sees the answer immediately and it reflows once the renderer arrives.
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <Suspense fallback={<div className="markdown markdown-plain">{children}</div>}>
      <MarkdownBody>{children}</MarkdownBody>
    </Suspense>
  );
});
