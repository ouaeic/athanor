import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { describeFailure } from '../failure-text.js';
import { consumeSharedPayload } from '../share-target.js';
import type { Workspace } from '../types.js';

/**
 * Something shared into athanor from another application, collected once.
 *
 * The share target hands this window an id in the query and nothing else; the payload is picked up
 * from the store the service worker put it in. The id is taken out of the address bar before the
 * fetch, so a reload cannot import the same thing twice, and the guard is a ref rather than state
 * because the effect re-runs whenever the computer changes and importing is not idempotent.
 */
export const useShareTarget = (input: {
  workspace: Workspace | undefined;
  setPrompt: Dispatch<SetStateAction<string>>;
  uploadFiles: (files: File[]) => void;
  onError: (message: string) => void;
}) => {
  const { workspace, setPrompt, uploadFiles, onError } = input;
  const pendingShareId = useRef(new URLSearchParams(window.location.search).get('share'));
  const consuming = useRef(false);
  useEffect(() => {
    const shareId = pendingShareId.current;
    if (!workspace || !shareId || consuming.current) return;
    consuming.current = true;
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete('share');
    window.history.replaceState({}, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
    void consumeSharedPayload(shareId)
      .then((shared) => {
        if (!shared) throw new Error('The shared item expired before it could be imported');
        if (shared.text) setPrompt((current) => `${current}${current ? '\n\n' : ''}${shared.text}`);
        uploadFiles(shared.files);
      })
      .catch((cause: unknown) =>
        onError(describeFailure(cause, 'Could not import the shared item'))
      )
      .finally(() => {
        pendingShareId.current = null;
      });
  }, [workspace?.id]);
};
