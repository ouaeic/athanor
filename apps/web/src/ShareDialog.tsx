import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { CreateShareRequest, ShareRecord, ShareSnapshot } from '@athanor/contracts';
import { Dialog } from './Dialog.js';
import { CopyButton, Markdown } from './Markdown.js';
import { withStepUp } from './account-security.js';
import { api } from './api.js';
import { describeFailure } from './failure-text.js';
import { absoluteShareUrl, isLiveShare, shareApi } from './share-api.js';
import { formatBytes } from './timeline-state.js';
import type { Artifact, Task } from './types.js';
import './share.css';

/**
 * Making a link, and seeing exactly what it will show before it exists.
 *
 * The preview is not an approximation drawn on the client: it is the snapshot the box would seal,
 * fetched from the same builder the link route uses, re-fetched whenever a switch changes. What
 * the owner reads here is byte for byte what a reader will decrypt. Every switch starts off, so a
 * link made without reading the form carries the least; the list at the foot is every link this
 * conversation has, with the one way to close each.
 */

type Expiry = 1 | 7 | 30 | null;

const EXPIRIES: Array<{ value: Expiry; label: string }> = [
  { value: 1, label: 'One day' },
  { value: 7, label: 'One week' },
  { value: 30, label: '30 days' },
  { value: null, label: 'Never' }
];

const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : '—');

/** What the reader sees for one event, drawn the way the viewer draws it. */
function PreviewEvent({ event }: { event: ShareSnapshot['events'][number] }) {
  const prose =
    event.kind === 'user_message' ||
    event.kind === 'assistant_message' ||
    event.kind === 'assistant_reasoning' ||
    event.kind === 'completed' ||
    event.kind === 'plan';
  return (
    <li className={`share-preview-event share-preview-${event.kind}`}>
      <span className="share-preview-kind">{event.kind.replaceAll('_', ' ')}</span>
      {prose ? (
        <Markdown>{event.text}</Markdown>
      ) : (
        <span className="share-preview-line">{event.text}</span>
      )}
    </li>
  );
}

export function ShareDialog(props: {
  task: Task;
  onClose: () => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  /** How many live links the conversation now has, so the badge on it can follow. */
  onShareCount: (count: number) => void;
}) {
  const { task, onClose, onNotice, onError, onShareCount } = props;
  const [includeReasoning, setIncludeReasoning] = useState(false);
  const [includeToolResults, setIncludeToolResults] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState<Expiry>(30);
  const [publicTitle, setPublicTitle] = useState('');
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<ShareSnapshot>();
  const [previewError, setPreviewError] = useState('');
  const [links, setLinks] = useState<ShareRecord[]>([]);
  const [created, setCreated] = useState<string>();
  const [busy, setBusy] = useState(false);
  const previewRequest = useRef(0);

  const body = (): CreateShareRequest => ({
    expiresInDays,
    includeReasoning,
    includeToolResults,
    artifactIds: [...ticked],
    ...(publicTitle.trim() ? { publicTitle: publicTitle.trim() } : {})
  });

  const publish = (next: ShareRecord[]) => {
    setLinks(next);
    onShareCount(next.filter((share) => isLiveShare(share)).length);
  };

  const reloadLinks = async () => {
    try {
      publish(await shareApi.list(task.id));
    } catch (cause) {
      onError(describeFailure(cause, 'The links could not be listed'));
    }
  };

  useEffect(() => {
    void reloadLinks();
    void api
      .artifacts(task.workspaceId)
      .then((all) => setArtifacts(all.filter((artifact) => artifact.taskId === task.id)))
      .catch(() => setArtifacts([]));
    // Once, for the conversation this dialog opened on.
  }, [task.id]);

  useEffect(() => {
    const requested = (previewRequest.current += 1);
    setPreviewError('');
    void shareApi
      .preview(task.id, body())
      .then((snapshot) => {
        if (previewRequest.current === requested) setPreview(snapshot);
      })
      .catch((cause: unknown) => {
        if (previewRequest.current === requested)
          setPreviewError(describeFailure(cause, 'The preview could not be built'));
      });
    // The body is derived from exactly these cells.
  }, [task.id, includeReasoning, includeToolResults, publicTitle, ticked]);

  const create = async () => {
    setBusy(true);
    try {
      let url = '';
      await withStepUp(async () => {
        url = (await shareApi.create(task.id, body())).url;
      }, api.stepUp);
      setCreated(absoluteShareUrl(url));
      await reloadLinks();
    } catch (cause) {
      onError(describeFailure(cause, 'The link could not be made'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (share: ShareRecord) => {
    setBusy(true);
    try {
      await shareApi.revoke(share.id);
      onNotice('The link is closed. Anyone opening it now sees nothing.');
      await reloadLinks();
    } catch (cause) {
      onError(describeFailure(cause, 'The link could not be closed'));
    } finally {
      setBusy(false);
    }
  };

  const revokeAll = async () => {
    setBusy(true);
    try {
      const { revoked } = await shareApi.revokeAll(task.id);
      onNotice(revoked === 1 ? 'The link is closed.' : `${revoked} links are closed.`);
      await reloadLinks();
    } catch (cause) {
      onError(describeFailure(cause, 'The links could not be closed'));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (share: ShareRecord) => {
    setBusy(true);
    try {
      let url = '';
      await withStepUp(async () => {
        url = (await shareApi.refresh(share.id, body())).url;
      }, api.stepUp);
      setCreated(absoluteShareUrl(url));
      onNotice('A new link was made with the conversation as it is now; the old one is closed.');
      await reloadLinks();
    } catch (cause) {
      onError(describeFailure(cause, 'The link could not be remade'));
    } finally {
      setBusy(false);
    }
  };

  const toggleArtifact = (id: string) =>
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const live = links.filter((share) => isLiveShare(share));
  const expiryDate =
    expiresInDays === null ? null : new Date(Date.now() + expiresInDays * 86_400_000);

  return (
    <Dialog className="modal share-dialog" labelledBy="share-dialog-title" onClose={onClose}>
      <button className="modal-close" onClick={onClose} aria-label="Close">
        <X />
      </button>
      <h2 id="share-dialog-title">Share this conversation</h2>
      <p className="subtle">
        A link is a frozen copy of the conversation as it is right now, encrypted with a key that
        lives only in the link. Anyone holding the whole link can read the copy
        {expiryDate ? ` until ${expiryDate.toLocaleDateString()}` : ' until you close it'}; this
        computer keeps only ciphertext it cannot open.
      </p>

      {created && (
        <div className="share-created" role="status">
          <p>
            <strong>Your link is ready.</strong> It is shown once; copy it now.
          </p>
          <div className="share-created-url">
            <code>{created}</code>
            <CopyButton value={created} label="Copy link" />
          </div>
          <p className="subtle">
            Sending it through a URL shortener, or into a chat that previews links, may expose it.
            The part after # is the key: without it the link opens to nothing.
          </p>
        </div>
      )}

      <section className="share-options">
        <h3>What the link shows</h3>
        <p className="subtle">
          Your messages, the replies, the plan and one line per step are always included. What the
          agent read, ran and was given is not.
        </p>
        <label className="share-toggle">
          <input
            type="checkbox"
            checked={includeReasoning}
            onChange={(event) => setIncludeReasoning(event.target.checked)}
          />
          Include how the agent reasoned
        </label>
        <label className="share-toggle">
          <input
            type="checkbox"
            checked={includeToolResults}
            onChange={(event) => setIncludeToolResults(event.target.checked)}
          />
          Include what each tool returned
        </label>
        <label className="share-field">
          Title on the shared page
          <input
            type="text"
            value={publicTitle}
            placeholder={task.title}
            maxLength={160}
            onChange={(event) => setPublicTitle(event.target.value)}
          />
        </label>
        <label className="share-field">
          Link expires
          <select
            value={expiresInDays === null ? 'never' : String(expiresInDays)}
            onChange={(event) =>
              setExpiresInDays(
                event.target.value === 'never' ? null : (Number(event.target.value) as Expiry)
              )
            }
          >
            {EXPIRIES.map((option) => (
              <option
                key={option.label}
                value={option.value === null ? 'never' : String(option.value)}
              >
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {artifacts.length > 0 && (
          <fieldset className="share-artifacts">
            <legend>Files to include</legend>
            {artifacts.map((artifact) => (
              <label key={artifact.id} className="share-toggle">
                <input
                  type="checkbox"
                  checked={ticked.has(artifact.id)}
                  onChange={() => toggleArtifact(artifact.id)}
                />
                {artifact.name}
                <span className="subtle"> · {formatBytes(artifact.sizeBytes)}</span>
              </label>
            ))}
          </fieldset>
        )}
      </section>

      <section className="share-preview">
        <h3>Exactly what a reader will see</h3>
        {previewError && <p className="share-preview-error">{previewError}</p>}
        {!preview && !previewError && <p className="subtle">Building the preview…</p>}
        {preview && (
          <>
            <p className="share-preview-title">{preview.title}</p>
            <ol className="share-preview-events">
              {preview.events.map((event, index) => (
                <PreviewEvent key={index} event={event} />
              ))}
            </ol>
            {preview.artifacts.length > 0 && (
              <ul className="share-preview-files">
                {preview.artifacts.map((artifact) => (
                  <li key={artifact.n}>
                    {artifact.name} · {artifact.mimeType} · {formatBytes(artifact.sizeBytes)}
                  </li>
                ))}
              </ul>
            )}
            {JSON.stringify(preview).includes('[REDACTED]') && (
              <p className="share-preview-redacted">
                Something that looked like a credential was replaced with [REDACTED]. Read the
                preview for anything the net did not recognise.
              </p>
            )}
          </>
        )}
      </section>

      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>
          Close
        </button>
        <button className="primary" disabled={busy || !preview} onClick={() => void create()}>
          Make a link
        </button>
      </div>

      <section className="share-links">
        <h3>Links to this conversation</h3>
        {links.length === 0 && <p className="subtle">None yet.</p>}
        {links.length > 0 && (
          <ul>
            {links.map((share) => (
              <li key={share.id} className={isLiveShare(share) ? 'live' : 'closed'}>
                <span className="share-link-facts">
                  Made {when(share.createdAt)} · expires{' '}
                  {share.expiresAt ? when(share.expiresAt) : 'never'} · opened {share.viewCount}{' '}
                  {share.viewCount === 1 ? 'time' : 'times'}
                  {share.lastViewedAt ? `, last ${when(share.lastViewedAt)}` : ''}
                  {share.revokedAt ? ` · closed ${when(share.revokedAt)}` : ''}
                </span>
                {isLiveShare(share) && (
                  <span className="share-link-actions">
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void refresh(share)}
                    >
                      Remake with the conversation as it is now
                    </button>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void revoke(share)}
                    >
                      Close link
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {live.length > 1 && (
          <button className="secondary" disabled={busy} onClick={() => void revokeAll()}>
            Close every link
          </button>
        )}
      </section>
    </Dialog>
  );
}
