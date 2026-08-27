import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from '../api.js';
import { describeFailure } from '../failure-text.js';
import {
  rewindOffer,
  rewindResultNotice,
  trajectoryModelFields,
  type TrajectoryDraft
} from '../rewind.js';
import { upsertTask } from '../task-list.js';
import { isTerminalTask } from '../task-status.js';
import type { Bootstrap, Task, TaskEvent, TaskRewindPreview } from '../types.js';

/** The markdown a user message carries, read off an event whose payload is untyped on the wire. */
const messageBody = (event: TaskEvent): string => {
  const body =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : {};
  return typeof body.markdown === 'string' ? body.markdown : '';
};

/**
 * Taking a turn back: the draft of what would replace it, and what that would cost.
 *
 * The dialog has always let the owner rewind files as well as conversation, and has always said so
 * in one generic sentence — including for turns where no restore point exists, where choosing it
 * would simply fail. The server can describe the restore; the preview here is that description,
 * fetched as soon as there is a draft to describe.
 */
export const useTrajectory = (input: {
  task: Task | undefined;
  taskId: string | undefined;
  taskIsActive: boolean;
  setData: Dispatch<SetStateAction<Bootstrap | undefined>>;
  setWorkspaceId: Dispatch<SetStateAction<string | undefined>>;
  setTaskId: Dispatch<SetStateAction<string | undefined>>;
  clearEvents: () => void;
  setBusy: (busy: boolean) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) => {
  const { task, taskId, taskIsActive, setData, setWorkspaceId, setTaskId, clearEvents, setBusy } =
    input;
  const [draft, setDraft] = useState<TrajectoryDraft>();
  const [preview, setPreview] = useState<TaskRewindPreview>();
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (draft?.operation !== 'edit') return;
    const frame = window.requestAnimationFrame(() => promptRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [draft?.operation]);

  useEffect(() => {
    setPreview(undefined);
    if (!draft || !taskId) return;
    let active = true;
    void api
      .taskRewindPreview(taskId, draft.eventId)
      .then((answer) => {
        if (active) setPreview(answer);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [taskId, draft?.eventId]);

  /** Reopening a message to say it differently, from the transcript or from ⌘↑. */
  const edit = (event: TaskEvent) =>
    setDraft({
      rewind: 'conversation',
      operation: 'edit',
      eventId: event.id,
      prompt: messageBody(event),
      stopSource: taskIsActive
    });

  const retry = (event: TaskEvent) =>
    setDraft({
      rewind: 'conversation',
      operation: 'retry',
      eventId: event.id,
      stopSource: taskIsActive
    });

  /** The editor's own reflex for "that came out wrong": reopen the last thing you sent. */
  const editLast = (events: TaskEvent[]) => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const candidate = events[index]!;
      if (candidate.kind !== 'user_message') continue;
      edit(candidate);
      return;
    }
  };

  const branchFrom = async (eventId: string) => {
    if (!task) return;
    setBusy(true);
    input.onError('');
    try {
      // A branch takes only the conversation. Taking the computer back as well would rewrite the
      // machine underneath the original conversation, which is still live and still true.
      const branch = await api.createTaskTrajectory(task.id, {
        operation: 'branch',
        eventId,
        rewind: 'conversation'
      });
      setData((current) => (current ? { ...current, tasks: [branch, ...current.tasks] } : current));
      setWorkspaceId(branch.workspaceId);
      setTaskId(branch.id);
      input.onNotice('Branched. The original conversation is untouched.');
    } catch (cause) {
      input.onError(describeFailure(cause, 'Could not branch this conversation'));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!task || !draft) return;
    const sourceTask = task;
    const scope = draft.rewind;
    const checkpointId = rewindOffer(preview).checkpointId;
    setBusy(true);
    input.onError('');
    try {
      // The previewed checkpoint is named rather than re-resolved, so what comes back is what the
      // dialog described.
      const machine =
        scope !== 'conversation' && checkpointId
          ? { rewind: scope, checkpointId }
          : { rewind: scope };
      const fork = await api.createTaskTrajectory(
        sourceTask.id,
        draft.operation === 'edit'
          ? {
              operation: 'edit',
              eventId: draft.eventId,
              prompt: draft.prompt.trim(),
              maxComputeCredits: 5,
              stopSource: draft.stopSource,
              ...machine,
              ...trajectoryModelFields(draft)
            }
          : {
              operation: 'retry',
              eventId: draft.eventId,
              maxComputeCredits: 5,
              stopSource: draft.stopSource,
              ...machine,
              ...trajectoryModelFields(draft)
            }
      );
      setDraft(undefined);
      input.onNotice(rewindResultNotice(draft.operation, scope));
      /*
       * Taking only the computer back forks nothing: the server returns this same conversation with
       * a line in it saying what happened to the files. Treating that as a new version used to
       * replace the transcript being read with a copy of itself.
       */
      if (scope === 'computer') {
        setData((current) =>
          current ? { ...current, tasks: upsertTask(current.tasks, fork) } : current
        );
        return;
      }
      setData((current) =>
        current
          ? {
              ...current,
              tasks: [
                fork,
                ...current.tasks.map((item) =>
                  item.id === sourceTask.id && draft.stopSource && !isTerminalTask(item)
                    ? { ...item, status: 'cancelled' as const }
                    : item
                )
              ]
            }
          : current
      );
      setWorkspaceId(fork.workspaceId);
      setTaskId(fork.id);
      clearEvents();
    } catch (cause) {
      input.onError(describeFailure(cause, 'Could not start the new version'));
    } finally {
      setBusy(false);
    }
  };

  return { draft, setDraft, preview, promptRef, edit, retry, editLast, branchFrom, run };
};
