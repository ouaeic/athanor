import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * The open conversation, read from the address bar on the very first render.
 *
 * First render rather than after bootstrap resolves, so the composer restores that conversation's
 * own draft instead of the new-chat one. Held apart from the effect below because the address bar
 * cannot be kept in step until the box has answered, and the cell has to exist before that.
 */
export const useTaskId = (): [string | undefined, Dispatch<SetStateAction<string | undefined>>] =>
  useState<string | undefined>(
    () => new URLSearchParams(window.location.search).get('task') ?? undefined
  );

/**
 * The address bar, kept in step with the open conversation.
 *
 * Back, forward and reload behave the way they do in every other web app: `replaceState` on the
 * first render avoids pushing a duplicate entry for the conversation the bootstrap just restored,
 * and `popstate` puts the walk back into this state rather than reloading the document.
 */
export const useTaskAddressBar = (input: {
  auth: 'loading' | 'required' | 'ready';
  taskId: string | undefined;
  workspaceId: string | undefined;
  setTaskId: Dispatch<SetStateAction<string | undefined>>;
}) => {
  const { auth, taskId, workspaceId, setTaskId } = input;
  const routed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (auth !== 'ready') return;
    if (routed.current === taskId) return;
    const first = routed.current === undefined;
    routed.current = taskId;
    const url = new URL(window.location.href);
    if (taskId) url.searchParams.set('task', taskId);
    else url.searchParams.delete('task');
    if (workspaceId) url.searchParams.set('workspace', workspaceId);
    const next = `${url.pathname}${url.search}`;
    if (first) window.history.replaceState({ taskId }, '', next);
    else window.history.pushState({ taskId }, '', next);
  }, [auth, taskId, workspaceId]);
  useEffect(() => {
    const onPop = () => {
      const requested = new URLSearchParams(window.location.search).get('task') ?? undefined;
      routed.current = requested;
      setTaskId(requested);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
};
