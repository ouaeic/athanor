import { useCallback, useEffect, useRef, useState } from 'react';
import type { Artifact, Task, TaskEvent, TaskPlan, TaskPresentation } from '@athanor/contracts';
import { get } from './client';
import { loadEventPage, subscribeTaskEvents } from './stream';
import type { EventPage, StreamConnection } from './stream';
import { presentationArtifacts } from './task-artifacts';

interface TaskRecordOptions {
  taskId: string;
  workspaceId: string;
  finished: boolean;
  onTask: (task: Task) => void;
  onRefresh: () => void;
}

export function useTaskRecord({
  taskId,
  workspaceId,
  finished,
  onTask,
  onRefresh
}: TaskRecordOptions) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [plan, setPlan] = useState<TaskPlan | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [storedPresentation, setPresentation] = useState<TaskPresentation | null>(null);
  const [initialPage, setInitialPage] = useState<EventPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [connection, setConnection] = useState<StreamConnection>('connecting');
  const lifetime = useRef<AbortController | null>(null);
  const pendingReload = useRef<{
    signal: AbortSignal;
    queued: boolean;
    promise: Promise<void>;
  } | null>(null);
  const onTaskRef = useRef(onTask);
  onTaskRef.current = onTask;
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const reload = useCallback(
    (requestedSignal?: AbortSignal): Promise<void> => {
      const signal = requestedSignal ?? lifetime.current?.signal;
      if (!signal || signal.aborted) return Promise.resolve();
      if (pendingReload.current?.signal === signal) {
        pendingReload.current.queued = true;
        return pendingReload.current.promise;
      }
      const read = async () => {
        const options = { signal };
        const results = await Promise.allSettled([
          get<Task>(`/v1/tasks/${taskId}`, options),
          get<TaskPlan | null>(`/v1/tasks/${taskId}/plan`, options),
          get<Artifact[]>(`/v1/workspaces/${workspaceId}/artifacts`, options),
          get<TaskPresentation>(`/v1/tasks/${taskId}/presentation`, options)
        ]);
        if (signal?.aborted) return;
        const [nextTask, nextPlan, nextArtifacts, nextPresentation] = results;
        if (nextTask.status === 'fulfilled') onTaskRef.current(nextTask.value);
        else setError(nextTask.reason);
        if (nextPlan.status === 'fulfilled') setPlan(nextPlan.value);
        else setError(nextPlan.reason);
        if (nextArtifacts.status === 'fulfilled')
          setArtifacts(
            nextPresentation.status === 'fulfilled'
              ? presentationArtifacts(nextPresentation.value, nextArtifacts.value)
              : nextArtifacts.value.filter((item) => item.taskId === taskId)
          );
        else {
          setError(nextArtifacts.reason);
          if (nextPresentation.status === 'fulfilled')
            setArtifacts(presentationArtifacts(nextPresentation.value, []));
        }
        if (nextPresentation.status === 'fulfilled') setPresentation(nextPresentation.value);
        else setError(nextPresentation.reason);
      };
      const pending = { signal, queued: false, promise: Promise.resolve() };
      pendingReload.current = pending;
      pending.promise = (async () => {
        do {
          pending.queued = false;
          await read();
        } while (pending.queued && !signal.aborted);
      })().finally(() => {
        if (pendingReload.current === pending) pendingReload.current = null;
      });
      return pending.promise;
    },
    [taskId, workspaceId]
  );
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    let unsubscribe: () => void = () => undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setError(null);
    void Promise.all([
      loadEventPage(taskId, {
        before: Number.MAX_SAFE_INTEGER,
        limit: 250,
        signal: controller.signal
      }),
      reload(controller.signal)
    ])
      .then(([page]) => {
        if (controller.signal.aborted) return;
        setEvents(page.events);
        setInitialPage(page);
        setLoading(false);
        unsubscribe = subscribeTaskEvents(taskId, {
          after: page.nextCursor,
          signal: controller.signal,
          onEvents: (incoming) => {
            setEvents((current) =>
              Array.from(
                new Map([...current, ...incoming].map((event) => [event.sequence, event])).values()
              )
                .sort((a, b) => a.sequence - b.sequence)
                .slice(-4000)
            );
            if (
              incoming.some((event) =>
                [
                  'completed',
                  'approval_requested',
                  'approval_resolved',
                  'question_asked',
                  'error',
                  'artifact',
                  'plan',
                  'status',
                  'cost',
                  'preview',
                  'tool_result'
                ].includes(event.kind)
              )
            ) {
              if (!refreshTimer)
                refreshTimer = setTimeout(() => {
                  refreshTimer = undefined;
                  if (document.visibilityState !== 'hidden') {
                    void reload(controller.signal);
                    onRefreshRef.current();
                  }
                }, 1000);
            }
          },
          onConnection: setConnection,
          onError: setError
        });
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setError(err);
          setLoading(false);
        }
      });
    const refreshVisible = () => {
      if (document.visibilityState !== 'hidden') void reload(controller.signal);
    };
    const timer = setInterval(refreshVisible, 15000);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      controller.abort();
      document.removeEventListener('visibilitychange', refreshVisible);
      unsubscribe();
      clearInterval(timer);
      clearTimeout(refreshTimer);
    };
  }, [taskId, reload, finished]);
  return {
    events,
    plan,
    setPlan,
    artifacts,
    storedPresentation,
    initialPage,
    loading,
    error,
    setError,
    connection,
    reload
  };
}
