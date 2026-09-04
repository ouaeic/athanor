import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ShareBlob, ShareSnapshot } from '@athanor/contracts';
import { rehypeLocalResources } from '../resource-policy.js';
import {
  ShareKeyError,
  openArtifact,
  openSnapshot,
  sha256Hex,
  type EnvelopeMeta
} from './share-crypto.js';
import {
  artifactPresentation,
  downloadName,
  formatBytes,
  isProseKind,
  kindLabel,
  snapshotMarkdown
} from './share-render.js';

type PluginList = NonNullable<ComponentProps<typeof ReactMarkdown>['rehypePlugins']>;

/**
 * Raw HTML is escaped, never rendered: this is the same renderer the owner's app uses, without the
 * maths and highlighting it pays for there, and without `rehype-raw` for the same reason it is
 * absent there. `rehypeLocalResources` runs last so that a markdown image is a fetch to this box
 * or to nothing. Links open elsewhere with no referrer and no opener, and are marked `nofollow`,
 * because a shared page is a page a crawler may one day read.
 */
const remarkPlugins = [remarkGfm];
const rehypePlugins: PluginList = [rehypeLocalResources] as PluginList;

const components: ComponentProps<typeof ReactMarkdown>['components'] = {
  a: ({ node, children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  )
};

function Prose({ children }: { children: string }) {
  return (
    <div className="share-prose">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** What was opened, under the presentation its declared type earns. */
export interface OpenedArtifact {
  url: string;
  name: string;
  mimeType: string;
  /** Only for `text`: the bytes as a string, drawn in a `<pre>` rather than handed to the browser. */
  text?: string | undefined;
}

/**
 * One artifact after decryption. Pure over its props, so a test can ask what an HTML file becomes
 * without a browser: a frame with `sandbox="allow-scripts"` and nothing more, from a blob URL, so
 * whatever the file does it does on an opaque origin with no way to this page or this box.
 */
export function ArtifactView({ artifact }: { artifact: OpenedArtifact }) {
  const presentation = artifactPresentation(artifact.mimeType);
  switch (presentation) {
    case 'image':
      return <img className="share-artifact-media" src={artifact.url} alt={artifact.name} />;
    case 'audio':
      // eslint-disable-next-line jsx-a11y/media-has-caption
      return <audio className="share-artifact-media" controls src={artifact.url} />;
    case 'video':
      // eslint-disable-next-line jsx-a11y/media-has-caption
      return <video className="share-artifact-media" controls src={artifact.url} />;
    case 'text':
      return <pre className="share-artifact-text">{artifact.text ?? ''}</pre>;
    case 'frame':
      return (
        <iframe
          className="share-artifact-frame"
          sandbox="allow-scripts"
          src={artifact.url}
          title={artifact.name}
        />
      );
    case 'pdf':
      return (
        <p className="share-artifact-actions">
          <a href={artifact.url} target="_blank" rel="noopener noreferrer">
            Open {artifact.name}
          </a>
          <a href={artifact.url} download={artifact.name}>
            Save
          </a>
        </p>
      );
    case 'download':
      return (
        <p className="share-artifact-actions">
          <a href={artifact.url} download={artifact.name}>
            Save {artifact.name}
          </a>
        </p>
      );
  }
}

type State =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'incomplete'; message: string }
  | { phase: 'insecure' }
  | { phase: 'open'; snapshot: ShareSnapshot; blob: ShareBlob };

/** The one fetch the viewer makes without a click. No cookie travels with it, whoever is signed in. */
const fetchBlob = async (token: string): Promise<ShareBlob | null> => {
  const response = await fetch(`/v1/shares/${token}/blob`, {
    credentials: 'omit',
    cache: 'no-store'
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`blob ${response.status}`);
  return (await response.json()) as ShareBlob;
};

const fetchArtifact = async (token: string, n: number): Promise<Uint8Array> => {
  const response = await fetch(`/v1/shares/${token}/artifacts/${n}`, {
    credentials: 'omit',
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`artifact ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

export function ShareViewer(props: {
  token: string | null;
  fragmentKey: Uint8Array | null;
  /** True when the page was reached over plain HTTP somewhere other than the developer's own machine. */
  insecure: boolean;
}) {
  const { token, fragmentKey, insecure } = props;
  const [state, setState] = useState<State>(() =>
    insecure
      ? { phase: 'insecure' }
      : !token
        ? { phase: 'missing' }
        : !fragmentKey
          ? {
              phase: 'incomplete',
              message:
                'The part of the link after the # is missing. It is the key that opens this conversation, and it never reaches the server - ask whoever sent the link to send the whole of it.'
            }
          : { phase: 'loading' }
  );
  const [opened, setOpened] = useState<Record<number, OpenedArtifact | 'opening' | 'failed'>>({});

  useEffect(() => {
    if (state.phase !== 'loading' || !token || !fragmentKey) return;
    let live = true;
    void fetchBlob(token)
      .then(async (blob) => {
        if (!blob) return { phase: 'missing' } as const;
        const snapshot = await openSnapshot(blob, token, fragmentKey);
        return { phase: 'open', snapshot, blob } as const;
      })
      .then((next) => {
        if (live) setState(next);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setState(
          cause instanceof ShareKeyError
            ? {
                phase: 'incomplete',
                message:
                  'The key after the # in this link does not open this conversation. Check that the whole link was copied.'
              }
            : { phase: 'incomplete', message: 'This conversation could not be opened right now.' }
        );
      });
    return () => {
      live = false;
    };
  }, [state.phase, token, fragmentKey]);

  const downloads = useMemo(() => {
    if (state.phase !== 'open') return undefined;
    const markdown = new Blob([snapshotMarkdown(state.snapshot)], { type: 'text/markdown' });
    const json = new Blob([JSON.stringify(state.snapshot, null, 2)], { type: 'application/json' });
    return {
      markdown: URL.createObjectURL(markdown),
      json: URL.createObjectURL(json)
    };
  }, [state]);

  const open = async (n: number) => {
    if (state.phase !== 'open' || !token || !fragmentKey) return;
    const entry = state.snapshot.artifacts.find((artifact) => artifact.n === n);
    const meta = state.blob.manifest.find((artifact) => artifact.n === n)?.envelope as
      | EnvelopeMeta
      | undefined;
    if (!entry || !meta) return;
    setOpened((current) => ({ ...current, [n]: 'opening' }));
    try {
      const bytes = await openArtifact(meta, await fetchArtifact(token, n), token, fragmentKey, n);
      // The snapshot pinned the digest at share time; bytes that do not match it are not shown.
      if ((await sha256Hex(bytes)) !== entry.sha256) throw new ShareKeyError();
      const presentation = artifactPresentation(entry.mimeType);
      const type = presentation === 'download' ? 'application/octet-stream' : entry.mimeType;
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
      setOpened((current) => ({
        ...current,
        [n]: {
          url,
          name: entry.name,
          mimeType: entry.mimeType,
          text: presentation === 'text' ? new TextDecoder().decode(bytes) : undefined
        }
      }));
    } catch {
      setOpened((current) => ({ ...current, [n]: 'failed' }));
    }
  };

  if (state.phase === 'loading') return <p className="share-loading">Opening…</p>;
  if (state.phase === 'insecure')
    return (
      <section className="share-notice">
        <h1>Open this link over HTTPS</h1>
        <p>
          The key that opens this conversation is in the link, and it must not travel unencrypted.
        </p>
      </section>
    );
  if (state.phase === 'missing')
    return (
      <section className="share-notice">
        <h1>Not found</h1>
        <p>There is nothing at this address.</p>
      </section>
    );
  if (state.phase === 'incomplete')
    return (
      <section className="share-notice">
        <h1>This link is incomplete</h1>
        <p>{state.message}</p>
      </section>
    );

  const { snapshot } = state;
  return (
    <article className="share">
      <header className="share-header">
        <h1>{snapshot.title}</h1>
        <p className="share-meta">
          Shared from an athanor computer on{' '}
          <time dateTime={snapshot.createdAt}>{new Date(snapshot.createdAt).toLocaleString()}</time>
          . The content is user-generated and was decrypted in this browser.
        </p>
      </header>
      <ol className="share-events">
        {snapshot.events.map((event, index) => (
          <li key={index} className={`share-event share-event-${event.kind}`}>
            <span className="share-event-label">{kindLabel(event.kind)}</span>
            {isProseKind(event.kind) ? (
              <Prose>{event.text}</Prose>
            ) : (
              <p className="share-event-line">{event.text}</p>
            )}
          </li>
        ))}
      </ol>
      {snapshot.artifacts.length > 0 && (
        <section className="share-artifacts">
          <h2>Files</h2>
          <ul>
            {snapshot.artifacts.map((artifact) => {
              const current = opened[artifact.n];
              return (
                <li key={artifact.n} className="share-artifact">
                  <div className="share-artifact-row">
                    <span className="share-artifact-name">{artifact.name}</span>
                    <span className="share-artifact-size">
                      {artifact.mimeType} · {formatBytes(artifact.sizeBytes)}
                    </span>
                    {(current === undefined || current === 'failed') && (
                      <button type="button" onClick={() => void open(artifact.n)}>
                        {current === 'failed' ? 'Try again' : 'Open'}
                      </button>
                    )}
                    {current === 'opening' && <span className="share-artifact-size">Opening…</span>}
                  </div>
                  {current === 'failed' && (
                    <p className="share-artifact-size">This file could not be opened.</p>
                  )}
                  {current !== undefined && current !== 'opening' && current !== 'failed' && (
                    <ArtifactView artifact={current} />
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <footer className="share-footer">
        {downloads && (
          <p className="share-artifact-actions">
            <a href={downloads.markdown} download={downloadName(snapshot.title, 'md')}>
              Download as Markdown
            </a>
            <a href={downloads.json} download={downloadName(snapshot.title, 'json')}>
              Download as JSON
            </a>
          </p>
        )}
        <p className="share-meta">
          This page holds no cookie and sends nothing about you anywhere. Whoever made this link can
          close it at any time.
        </p>
      </footer>
    </article>
  );
}
