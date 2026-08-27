import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api } from '../api.js';
import { attachmentsFromDraft, draftAttachments, type Attachment } from '../attachments.js';
import { clearDraft, draftWrittenAt, pruneDrafts, readDraft, writeDraft } from '../client-state.js';
import type { MessageDraft } from '../types.js';

/**
 * The sentence being written, and the four places it has to stay in step with.
 *
 * A draft belongs to the conversation it was typed against — it used to be one global string, so a
 * half-written message followed the owner into a different conversation and Enter sent it there. It
 * belongs to the owner rather than to this browser, so it is banked on the box as well as on this
 * device. It must never be replaced by an older copy of itself, which is what the two refs below
 * exist to prevent. And the box on screen has to grow with it.
 *
 * All four rules read the same two cells, which is why they live in one place: `savedDraft` is what
 * this device believes the open conversation is owed, and `sentDraft` is what it last handed the box.
 */
export const useComposerDraft = (input: {
  taskId: string | undefined;
  workspaceId: string | undefined;
  composer: RefObject<HTMLTextAreaElement | null>;
  attachments: Attachment[];
  setAttachments: (update: (current: Attachment[]) => Attachment[]) => void;
  clearAttachments: () => void;
  /** Until the box has answered, a save would be this browser's stale copy overwriting the shared one. */
  serverPreferencesLoaded: RefObject<boolean>;
}) => {
  const { taskId, workspaceId, composer, attachments, serverPreferencesLoaded } = input;
  const [prompt, setPrompt] = useState(() =>
    readDraft(new URLSearchParams(window.location.search).get('task') ?? undefined)
  );

  // The composer grows with the draft up to the CSS max-height, then scrolls. Without this a
  // multi-paragraph prompt is edited through a single visible line.
  useEffect(() => {
    const field = composer.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  }, [prompt]);

  /*
   * A draft belongs to the conversation it was typed against. Swapping on `taskId` — banking what is
   * on screen under the conversation being left, then restoring whatever that conversation was owed
   * — makes the composer part of the conversation rather than part of the window.
   */
  const savedDraft = useRef({ taskId, prompt });
  /*
   * The last body this device handed to the box, so its own echo is recognisable when it comes
   * back. Without it the composer emptied itself mid-sentence: the local copy is written on a
   * debounce and stamped with this clock, the box stamps its copy with its own and later, so the
   * next refresh saw the device's own previous sentence looking newer than the one being typed and
   * adopted it - deleting every character since. It reads as the box refusing to record typing.
   */
  const sentDraft = useRef<Record<string, string>>({});
  useEffect(() => {
    if (savedDraft.current.taskId !== taskId) {
      const leaving = savedDraft.current;
      writeDraft(leaving.taskId, leaving.prompt);
      // Banked on the box too, not only in this browser. Switching conversation cancels the
      // debounce below before it has run, so the last thing typed before moving away - which is
      // most of what anyone types, since moving away is how you stop typing - was saved locally and
      // never sent. Those keystrokes became the one version no other device could ever see.
      if (serverPreferencesLoaded.current && workspaceId)
        sentDraft.current = {
          ...sentDraft.current,
          [leaving.taskId ?? '']: leaving.prompt
        };
      void api
        .saveDraft({
          workspaceId,
          taskId: leaving.taskId ?? null,
          body: leaving.prompt,
          attachments: draftAttachments(attachments)
        })
        .catch(() => undefined);
      const restored = readDraft(taskId);
      savedDraft.current = { taskId, prompt: restored };
      setPrompt(restored);
      // Uploads belong to the message being written, and that message stayed behind.
      input.clearAttachments();
      return;
    }
    savedDraft.current = { taskId, prompt };
    // Debounced: a write per keystroke on a multi-paragraph prompt is a synchronous storage call
    // on every character typed.
    const timer = window.setTimeout(() => {
      writeDraft(taskId, prompt);
      // And to the box, so the sentence is where the owner's other device can find it - which is
      // the whole reason drafts are kept at all. Longer than the local write because it is a
      // request rather than a string assignment, and a failure is silent: the device's own copy is
      // already saved, and there is nothing here worth interrupting someone mid-sentence for.
      if (!serverPreferencesLoaded.current || !workspaceId) return;
      sentDraft.current = { ...sentDraft.current, [taskId ?? '']: prompt };
      void api
        .saveDraft({
          workspaceId,
          taskId: taskId ?? null,
          body: prompt,
          attachments: draftAttachments(attachments)
        })
        .catch(() => undefined);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [taskId, prompt, workspaceId]);

  /**
   * What the owner was part-way through typing, wherever they typed it.
   *
   * Only adopted when this device has nothing of its own for that conversation: a sentence being
   * typed here right now must never be replaced by an older one the box is still holding. Newest
   * wins, rather than local always winning — keeping the local copy unconditionally meant a device
   * that had once seen a draft could never be told about a newer one, and adopting also writes to
   * this device's store, so every device that so much as looked was frozen on the version it first
   * saw and would eventually write it back over the box's.
   */
  const adoptFromBox = useCallback((drafts: MessageDraft[]) => {
    for (const draft of drafts) {
      const key = draft.taskId ?? undefined;
      const mine = readDraft(key);
      const sent = new Date(draft.updatedAt).getTime();
      // This device's own sentence, handed back. It is never news, whatever the clocks say.
      if (draft.body === sentDraft.current[key ?? '']) continue;
      const newer = !mine || (Number.isFinite(sent) && sent > draftWrittenAt(key));
      if (!newer) continue;
      // And nothing replaces a sentence somebody is in the middle of. A draft from another
      // device is worth adopting; it is not worth adopting into the box they are typing in.
      const composing =
        (key ?? undefined) === (savedDraft.current.taskId ?? undefined) &&
        document.activeElement === composer.current &&
        savedDraft.current.prompt !== draft.body;
      if (composing) continue;
      writeDraft(key, draft.body, Number.isFinite(sent) ? sent : Date.now());
      if ((key ?? undefined) === (savedDraft.current.taskId ?? undefined)) {
        savedDraft.current = { taskId: savedDraft.current.taskId, prompt: draft.body };
        setPrompt(draft.body);
        // The files come back with the sentence. Only onto an empty tray: anything mid-upload on
        // this device belongs to the message being written here and is not the box's to replace.
        const carried = attachmentsFromDraft(draft.attachments ?? []);
        if (carried.length) input.setAttachments((current) => (current.length ? current : carried));
      }
    }
  }, []);

  /**
   * Drafts for conversations this device can no longer open would otherwise accumulate forever in a
   * store the browser silently stops accepting writes to. The open conversation is spared
   * explicitly: bootstrap carries only the newest page, and an older one is still openable from
   * search or a link — losing its half-typed draft on refresh would be the original bug again.
   *
   * So is every conversation the box just sent a draft for. Without that, a draft on a conversation
   * older than the bootstrap page was written and deleted in the same tick, on every device, so the
   * box held a sentence no client could ever show — the failure looked exactly like the draft never
   * having been saved at all.
   */
  const prune = useCallback((liveTaskIds: string[], sentDrafts: MessageDraft[]) => {
    const open = savedDraft.current.taskId;
    pruneDrafts([
      ...liveTaskIds,
      ...sentDrafts.flatMap((draft) => (draft.taskId ? [draft.taskId] : [])),
      ...(open ? [open] : [])
    ]);
  }, []);

  /**
   * The composer emptied by a send, on this device and on the box.
   *
   * Explicitly on the box, because emptying the field schedules the debounce above to save a blank
   * draft, which the box turns into a delete — but on a new conversation `setTaskId` runs before
   * those 900ms elapse, the effect's cleanup cancels the pending save, and the re-run returns early
   * on the changed id. The row for the sentence just sent therefore survived, and every other device
   * picked it up at its next bootstrap and put an already-sent message back in the composer, one
   * Enter away from sending it twice.
   */
  const clearForSend = useCallback(
    (sentTaskId: string | undefined) => {
      setPrompt('');
      clearDraft(sentTaskId);
      if (serverPreferencesLoaded.current && workspaceId)
        void api
          .saveDraft({ workspaceId, taskId: sentTaskId ?? null, body: '', attachments: [] })
          .catch(() => undefined);
    },
    [workspaceId]
  );

  /**
   * Banked synchronously, for the one control that deliberately throws React state away.
   *
   * The draft is written to this device on a 900ms debounce, so the last thing typed is routinely
   * still only in React state.
   */
  const bankNow = useCallback(() => writeDraft(taskId, prompt), [taskId, prompt]);

  return { prompt, setPrompt, adoptFromBox, prune, clearForSend, bankNow };
};
