import { approvalPhrase, type NotificationKind, type NotificationSubject } from './model.js';

/**
 * The wire contract between this service and apps/web/public/sw.js. The service worker reads these
 * fields by name; changing one without changing the other silently degrades every device that has
 * an older worker cached, so both sides carry the same field names deliberately.
 */
export interface PushPayload {
  kind: NotificationKind;
  title: string;
  body: string;
  url: string;
  tag: string;
  /** Answering from the lock screen needs the id the buttons post to. Approvals only. */
  approvalId?: string;
  /** Rendered as notification buttons. Only an approval has anything to answer. */
  actions?: Array<{ action: 'approve' | 'deny'; title: string }>;
  /** An approval stays on screen until it is dealt with; a status message does not. */
  requireInteraction?: boolean;
}

/** Money the owner is about to be billed for reads as money, to the cent. */
const usd = (value: number): string =>
  value < 0.01 ? 'under $0.01' : value >= 1000 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;

const duration = (milliseconds: number): string => {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 90) return `${Math.max(1, seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
};

/** "in 6 min · $0.31", dropping whichever half is unknown, empty when neither is. */
const receipt = (subject: NotificationSubject): string =>
  [
    subject.durationMs === null ? '' : `in ${duration(subject.durationMs)}`,
    subject.spentUsd === null || subject.spentUsd <= 0 ? '' : usd(subject.spentUsd)
  ]
    .filter(Boolean)
    .join(' · ');

const withReceipt = (sentence: string, subject: NotificationSubject): string => {
  const tail = receipt(subject);
  return tail ? `${sentence} ${tail}.` : `${sentence}.`;
};

/**
 * A notification the owner can act on without opening anything.
 *
 * The old copy said "Cloud task finished / Your cloud task is ready" for every outcome, so a
 * failure, a cancellation and a success were indistinguishable on the lock screen and none of them
 * said which conversation they belonged to. The title is now the owner's own name for the work and
 * the body is what actually happened to it.
 */
export const notificationPayload = (subject: NotificationSubject): PushPayload => {
  const url = `/?task=${encodeURIComponent(subject.taskId)}`;
  const title = subject.taskTitle?.trim() || 'Untitled conversation';

  if (subject.kind === 'approval_required') {
    return {
      kind: 'approval_required',
      title,
      body: `Waiting for you: it wants to ${approvalPhrase(subject.approvalAction, subject.approvalSideEffect)}.`,
      url,
      tag: `approval-${subject.resourceId}`,
      approvalId: subject.resourceId,
      actions: [
        { action: 'approve', title: 'Approve' },
        { action: 'deny', title: 'Deny' }
      ],
      // The agent is stopped until this is answered, so it stays on screen until it is.
      requireInteraction: true
    };
  }

  if (subject.kind === 'takeover_needed') {
    return {
      kind: 'takeover_needed',
      title,
      body:
        subject.message?.trim() ||
        'Stopped at a check only you can clear. Open the Computer and take control.',
      url,
      tag: `takeover-${subject.resourceId}`,
      // Nothing but a person can clear this, and nothing raises it a second time: the agent carries
      // on with the rest of the task elsewhere, so a notice that faded would simply be lost.
      requireInteraction: true
    };
  }

  if (subject.kind === 'agent_message') {
    return {
      kind: 'agent_message',
      title,
      // The agent wrote this sentence because it decided the owner wanted it; there is nothing for
      // this layer to add and a house-style prefix would only push the news off the lock screen.
      body: subject.message?.trim() || 'Something you asked to be told about happened.',
      url,
      tag: `agent-${subject.resourceId}`
    };
  }

  if (subject.kind === 'spend_paused') {
    const spent = subject.spentUsd === null ? null : usd(subject.spentUsd);
    const cap = subject.capUsd === null ? null : usd(subject.capUsd);
    return {
      kind: 'spend_paused',
      title,
      body:
        cap && spent
          ? `Paused at your ${cap} limit after spending ${spent}. Only you can raise it.`
          : 'Paused at your spending limit. Only you can raise it.',
      url,
      tag: `spend-${subject.resourceId}`,
      requireInteraction: true
    };
  }

  return {
    kind: 'task_finished',
    title,
    body:
      subject.taskStatus === 'failed'
        ? withReceipt('Stopped with an error', subject)
        : subject.taskStatus === 'cancelled'
          ? withReceipt('Cancelled', subject)
          : withReceipt('Finished', subject),
    url,
    tag: `task-${subject.resourceId}`
  };
};
