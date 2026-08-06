import { useEffect, useState } from 'react';
import { FileText, ImageOff, Paperclip, X } from 'lucide-react';
import { api } from './api.js';
import {
  attachmentDisplayName,
  imageMimeType,
  isImageAttachment,
  type Attachment
} from './attachments.js';
import { formatBytes } from './timeline-state.js';

/**
 * The files on the message being written: what they are, how far up they are, and how to take one
 * back.
 *
 * Before this the only evidence an attachment existed was a UUID path appended to the draft, so
 * removing one meant editing a UUID out of your own sentence and a 49 MiB upload showed nothing at
 * all while it ran.
 */
export function AttachmentTray({
  attachments,
  onRemove
}: {
  attachments: Attachment[];
  onRemove: (attachment: Attachment) => void;
}) {
  if (!attachments.length) return null;
  return (
    <ul className="attachment-tray" aria-label="Attachments on this message">
      {attachments.map((attachment) => (
        <li key={attachment.id} className={`attachment-chip ${attachment.status}`}>
          {attachment.previewUrl ? (
            <img className="attachment-thumb" src={attachment.previewUrl} alt="" />
          ) : (
            <span className="attachment-thumb glyph" aria-hidden="true">
              <FileText />
            </span>
          )}
          <span className="attachment-copy">
            <strong title={attachment.name}>{attachment.name}</strong>
            <small>
              {attachment.status === 'failed'
                ? (attachment.error ?? 'The upload did not finish')
                : attachment.status === 'uploading'
                  ? `${Math.round(attachment.progress * 100)}% of ${formatBytes(attachment.sizeBytes)}`
                  : formatBytes(attachment.sizeBytes)}
            </small>
            {attachment.status === 'uploading' && (
              <span
                className="attachment-progress"
                role="progressbar"
                aria-label={`Uploading ${attachment.name}`}
                aria-valuenow={Math.round(attachment.progress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <i style={{ width: `${Math.max(2, attachment.progress * 100)}%` }} />
              </span>
            )}
          </span>
          <button
            type="button"
            className="attachment-remove"
            aria-label={
              attachment.status === 'uploading'
                ? `Cancel uploading ${attachment.name}`
                : `Remove ${attachment.name}`
            }
            title={attachment.status === 'uploading' ? 'Cancel this upload' : 'Remove this file'}
            onClick={() => onRemove(attachment)}
          >
            <X />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * An image already on the agent computer, shown inline.
 *
 * The file route answers `application/octet-stream` and the deployment sends `nosniff`, so the
 * browser refuses to treat that response as an image; the bytes are fetched and re-typed from the
 * extension instead. A failure falls back to the same download row as any other file rather than
 * leaving a broken image in the transcript.
 */
function InlineImage({
  workspaceId,
  path,
  name
}: {
  workspaceId: string;
  path: string;
  name: string;
}) {
  const [source, setSource] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let objectUrl: string | undefined;
    let active = true;
    void api
      .file(workspaceId, path)
      .then((bytes) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: imageMimeType(path) }));
        setSource(objectUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [workspaceId, path]);
  if (failed)
    return (
      <span className="attachment-thumb glyph" aria-hidden="true">
        <ImageOff />
      </span>
    );
  if (!source) return <span className="attachment-thumb loading" aria-hidden="true" />;
  return <img className="attachment-thumb" src={source} alt={name} loading="lazy" />;
}

/** The same strip under a sent message, reconstructed from the paths the message carried. */
export function AttachmentStrip({
  workspaceId,
  paths
}: {
  workspaceId: string | undefined;
  paths: string[];
}) {
  if (!paths.length) return null;
  return (
    <ul className="attachment-tray sent" aria-label="Files sent with this message">
      {paths.map((path) => {
        const name = attachmentDisplayName(path);
        const href = workspaceId
          ? `/v1/workspaces/${workspaceId}/file?path=${encodeURIComponent(path)}`
          : '';
        return (
          <li key={path} className="attachment-chip ready">
            {workspaceId && isImageAttachment(path) ? (
              <InlineImage workspaceId={workspaceId} path={path} name={name} />
            ) : (
              <span className="attachment-thumb glyph" aria-hidden="true">
                <Paperclip />
              </span>
            )}
            <span className="attachment-copy">
              <strong title={path}>{name}</strong>
              {href && (
                <a href={href} download={name}>
                  Download
                </a>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
