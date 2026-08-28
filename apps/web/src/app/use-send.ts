import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from '../api.js';
import type { Attachment } from '../attachments.js';
import { composerSubmission, type SendBlock } from '../composer-state.js';
import { describeFailure } from '../failure-text.js';
import { securityModeNotice } from '../security-mode.js';
import { upsertTask } from '../task-list.js';
import { withPendingMessage, type PendingUserMessage } from '../timeline-state.js';
import { formatUsd } from '../usage-model.js';
import type {
  Bootstrap,
  CatalogueModel,
  SecurityMode,
  Task,
  TaskEvent,
  Workspace
} from '../types.js';

/**
 * Sending, stopping, and the local copy of the message that is still in flight.
 *
 * The optimistic echo belongs here rather than beside the transcript because it is the send's own
 * shadow: it exists from the tick the owner presses Enter until the box hands the same message
 * back, and `withPendingMessage` returns the untouched list at exactly that moment. Leaving the
 * conversation drops it too.
 */
export const useSend = (input: {
  events: TaskEvent[];
  taskId: string | undefined;
  task: Task | undefined;
  taskIsActive: boolean;
  workspace: Workspace | undefined;
  prompt: string;
  setPrompt: Dispatch<SetStateAction<string>>;
  attachments: Attachment[];
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  block: SendBlock | undefined;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  modelId: string;
  privacyRoute: CatalogueModel['privacyRoute'];
  /** Emptied on this device and on the box, which the debounce alone cannot be trusted to do. */
  clearDraftForSend: (sentTaskId: string | undefined) => void;
  setData: Dispatch<SetStateAction<Bootstrap | undefined>>;
  setTaskId: Dispatch<SetStateAction<string | undefined>>;
  /** A tab chosen before the conversation existed was chosen for the one it becomes. */
  carryInspectorChoiceInto: (createdTaskId: string) => void;
  clearEvents: () => void;
  focusComposer: () => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) => {
  const {
    events,
    taskId,
    task,
    taskIsActive,
    workspace,
    prompt,
    setPrompt,
    attachments,
    setAttachments,
    block,
    busy,
    setBusy,
    modelId,
    privacyRoute,
    setData,
    setTaskId,
    clearEvents,
    onNotice,
    onError
  } = input;
  /** What is in the composer's ceiling field, exactly as typed. Empty is the account's own cap. */
  const [capUsd, setCapUsd] = useState('');
  const [pending, setPending] = useState<PendingUserMessage>();

  const visiblePending =
    pending && (pending.taskId === undefined || pending.taskId === taskId) ? pending : undefined;
  const timelineEvents = useMemo(
    () => withPendingMessage(events, visiblePending),
    [events, visiblePending]
  );
  useEffect(() => {
    // `withPendingMessage` returns the untouched list once the server echoes the message, which is
    // exactly when the local copy has nothing left to do. Leaving the conversation drops it too.
    if (!pending) return;
    if (!visiblePending || timelineEvents === events) setPending(undefined);
  }, [timelineEvents, events, pending, visiblePending]);

  /*
   * A stopped conversation continues in place.
   *
   * Excluding `cancelled` here sent the next message down the create-a-new-task path, so Stop's own
   * notice — "the work so far is kept, send a message to continue from here" — was false: the
   * transcript being read was replaced by an empty conversation. The server accepts a message on a
   * cancelled task precisely so that sentence is true.
   */
  const canContinueTask = Boolean(task);

  const send = async (options: { interrupt?: boolean } = {}) => {
    const submission = composerSubmission({ prompt, attachments, block, busy, capUsd });
    if (submission.kind === 'nothing') return;
    if (submission.kind === 'wait') {
      onError(submission.message);
      return;
    }
    if (submission.kind === 'blocked') {
      onError('');
      input.focusComposer();
      return;
    }
    if (!workspace) return;
    /*
     * `text` is the typed sentence with the attachment paths appended to it, not the sentence
     * alone: `composerSubmission` builds it with `withAttachments`, which puts an "Attached files:"
     * block on the end. That block is the only channel the agent reads the paths from, so it has to
     * be in the prompt.
     *
     * What that costs, said here because it is not visible from this line: `splitAttachments`
     * takes the block off again when the transcript renders, so the reader sees their own sentence
     * and a file strip - but the task title is the first ten words of the prompt and the name index
     * is built from the prompt, so a message with no typed text is titled and indexed by its upload
     * path. And no `attachments` list is sent alongside, so `hasImages` in
     * apps/api/src/routes/tasks.ts is false for every task this client creates.
     */
    const { text, attachments: ready, maxSpendUsd } = submission;
    const typed = prompt.trim();
    const optimistic: PendingUserMessage = {
      id: `pending-${crypto.randomUUID()}`,
      taskId: task?.id,
      markdown: text,
      createdAt: new Date().toISOString()
    };
    // The transcript shows the message on this tick; the round trip only decides when work starts.
    setPending(optimistic);
    input.clearDraftForSend(task?.id);
    setAttachments([]);
    setBusy(true);
    onError('');
    try {
      if (canContinueTask && task) {
        const continued = await api.continueTask(task.id, {
          prompt: text,
          modelId,
          privacyRoute,
          maxComputeCredits: 5,
          // Omitted, not null: the route reads an absent ceiling as "use the account default",
          // which is not the same as no ceiling at all.
          ...(maxSpendUsd === null ? {} : { maxSpendUsd }),
          ...(options.interrupt ? { interrupt: true } : {})
        });
        setData((current) =>
          current ? { ...current, tasks: upsertTask(current.tasks, continued) } : current
        );
        if (taskIsActive)
          onNotice(
            options.interrupt
              ? 'Correction sent. The agent picks it up at its next step and keeps what it has done.'
              : `Follow-up queued in this conversation${continued.queuedMessageCount > 1 ? ` · ${continued.queuedMessageCount} waiting` : ''}.`
          );
      } else {
        const created = await api.createTask({
          workspaceId: workspace.id,
          prompt: text,
          modelId,
          privacyRoute,
          maxComputeCredits: 5,
          ...(maxSpendUsd === null ? {} : { maxSpendUsd })
        });
        setData((current) =>
          current ? { ...current, tasks: upsertTask(current.tasks, created) } : current
        );
        setPending((current) =>
          current?.id === optimistic.id ? { ...current, taskId: created.id } : current
        );
        setTaskId(created.id);
        input.carryInspectorChoiceInto(created.id);
        clearEvents();
        // The ceiling read back off the conversation the box actually made, rather than the number
        // that was typed into the field. A control that reports what it sent, instead of what
        // landed, is how a setting comes to be believed for months without ever having been stored.
        if (maxSpendUsd !== null)
          onNotice(
            created.maxSpendUsd
              ? `This conversation stops at ${formatUsd(created.maxSpendUsd)}.`
              : 'This box did not record a ceiling for this conversation; your account caps still apply.'
          );
      }
      // Cleared only on the way out of a successful send, so "cap this run" means this run: a
      // ceiling left in the field would quietly govern every later turn from a control that had
      // scrolled out of sight. A failed send keeps it, because the retry is the same send.
      setCapUsd('');
      for (const item of ready) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    } catch (cause) {
      setPending(undefined);
      // The typed sentence comes back, not the sentence plus its trailer: the attachments are
      // still on the agent computer and go back on the tray so the retry is one keystroke.
      setPrompt((current) => (current ? current : typed));
      setAttachments((current) => (current.length ? current : ready));
      onError(describeFailure(cause, 'Could not start this conversation'));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!task) return;
    setBusy(true);
    onError('');
    try {
      const stopped = await api.taskAction(task.id, 'cancel');
      setData((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.map((item) => (item.id === stopped.id ? stopped : item))
            }
          : current
      );
      onNotice('Stopped. The work so far is kept.');
    } catch (cause) {
      onError(describeFailure(cause, 'Could not stop the agent'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * How much this run asks, changed without a passkey.
   *
   * The server dropped that requirement deliberately - moving a conversation to Autonomous meant a
   * fingerprint every single time, on the one setting whose entire purpose is to be interrupted
   * less - but the client kept asking, so the prompt never went away. Step-up still guards what
   * changing a setting back cannot undo: the provider credential, and raising a spending ceiling.
   */
  const changeSecurityMode = async (securityMode: SecurityMode) => {
    if (!workspace) return;
    const currentMode = task?.securityMode ?? workspace.securityMode;
    if (securityMode === currentMode) return;
    setBusy(true);
    onError('');
    try {
      if (task) {
        const updated = await api.updateTaskSecurityMode(task.id, securityMode);
        setData((current) =>
          current
            ? {
                ...current,
                tasks: current.tasks.map((item) => (item.id === updated.id ? updated : item))
              }
            : current
        );
      } else {
        const updated = await api.updateWorkspaceSecurityMode(workspace.id, securityMode);
        setData((current) =>
          current
            ? {
                ...current,
                workspaces: current.workspaces.map((item) =>
                  item.id === updated.id ? updated : item
                )
              }
            : current
        );
      }
      // The raw enum contradicted the control that set it: the option reads "Ask first" and the
      // confirmation read "Security mode changed to review." Same words, both places.
      onNotice(securityModeNotice(securityMode, task ? 'task' : 'workspace'));
    } catch (cause) {
      onError(describeFailure(cause, 'Could not change security mode'));
    } finally {
      setBusy(false);
    }
  };

  return {
    capUsd,
    setCapUsd,
    timelineEvents,
    canContinueTask,
    send,
    stop,
    changeSecurityMode
  };
};
