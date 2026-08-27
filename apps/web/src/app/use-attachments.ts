import { useCallback, useRef, useState } from 'react';
import { api } from '../api.js';
import { attachmentPath, planUploads, type Attachment } from '../attachments.js';
import { describeFailure } from '../failure-text.js';
import type { Workspace } from '../types.js';

/**
 * The tray above the composer: what is on it, what is still arriving, and how to take one off.
 *
 * Every route in — paperclip, drag-and-drop, paste, camera, share target, the packaged shell's
 * folder import — comes through `add`, so this is the one place that decides what an attachment is.
 * The cancel handles live beside the list because they are the same fact seen twice: a chip on the
 * tray with a request still in flight behind it.
 */
export const useAttachments = (input: {
  workspace: Workspace | undefined;
  onError: (message: string) => void;
}) => {
  const { workspace, onError } = input;
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const uploads = useRef(new Map<string, () => void>());

  /**
   * Uploads land in the tray above the composer, never in the draft.
   *
   * Uploads run in parallel and report their own progress, and the composer stays typeable
   * throughout: a 49 MiB file on a home link is minutes long and blocking the box for it was the
   * reason a large attachment felt like a hang.
   */
  const add = (files: File[]): void => {
    if (!workspace || files.length === 0) return;
    const { accepted, message } = planUploads(files);
    if (message) onError(message);
    for (const file of accepted) {
      const id = crypto.randomUUID();
      const path = attachmentPath(file.name, id);
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      setAttachments((current) => [
        ...current,
        {
          id,
          name: file.name,
          sizeBytes: file.size,
          mimeType: file.type || 'application/octet-stream',
          path: '',
          status: 'uploading',
          progress: 0,
          ...(previewUrl ? { previewUrl } : {})
        }
      ]);
      const settle = (patch: Partial<Attachment>) =>
        setAttachments((current) =>
          current.map((item) => (item.id === id ? { ...item, ...patch } : item))
        );
      void file
        .arrayBuffer()
        .then((buffer) => {
          const upload = api.uploadFile(workspace.id, path, new Uint8Array(buffer), (fraction) =>
            settle({ progress: fraction })
          );
          uploads.current.set(id, upload.cancel);
          return upload.done;
        })
        .then(() => settle({ status: 'ready', path, progress: 1 }))
        .catch((cause: unknown) => {
          // A cancelled upload has already been taken off the tray by the control that cancelled it.
          if (cause instanceof Error && cause.name === 'AbortError') return;
          settle({
            status: 'failed',
            error: describeFailure(cause, 'The upload did not finish')
          });
        })
        .finally(() => uploads.current.delete(id));
    }
  };

  const remove = (attachment: Attachment): void => {
    uploads.current.get(attachment.id)?.();
    uploads.current.delete(attachment.id);
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    // An upload that landed left a real file behind; taking the chip away has to take that too, or
    // the agent computer accumulates a copy of everything the owner changed their mind about.
    if (attachment.status === 'ready' && workspace)
      void api.deleteFile(workspace.id, attachment.path).catch(() => undefined);
  };

  /** Everything on the tray goes, and the object URLs it was holding go with it. */
  const clear = useCallback(() => {
    setAttachments((current) => {
      for (const item of current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return [];
    });
  }, []);

  return { attachments, setAttachments, add, remove, clear };
};
