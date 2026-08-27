import type { ReactNode, RefObject } from 'react';
import { HardDrive, Sparkles, WifiOff, X } from 'lucide-react';
import { Approvals } from '../TaskModals.js';
import type { SettingsPage } from '../SelfHostedSettings.js';
import type { composerStrip } from '../composer-strip.js';
import { formatBytes } from '../timeline-state.js';
import type { Approval, TaskEvent } from '../types.js';

/**
 * The one thing allowed above the composer, drawn once.
 *
 * Seven conditions used to render there independently and the only exclusion between them was
 * whichever guard the change that added a strip happened to write, so a box near its disk ceiling
 * that also lost its connection showed storage, offline and an error stacked in three alarm
 * colours above a 176px composer. `composerStrip` holds the whole order; the guards it replaced
 * (`!error && !notice && !showBlock` on storage, `!offline` on the degraded stream) are gone
 * rather than joined by more of them. This component draws whichever one won, and nothing else.
 */
export function ComposerBanners(props: {
  kind: ReturnType<typeof composerStrip>;
  approvals: Approval[];
  workspaceId: string | undefined;
  openTaskId: string | undefined;
  taskTitles: Record<string, string>;
  openTaskEvents: TaskEvent[];
  approvalFailure: { approvalId: string; message: string } | undefined;
  cardRef: RefObject<HTMLDivElement | null>;
  onOpenTask: (id: string) => void;
  onOpenComputer: () => void;
  onOpenFiles: () => void;
  onAnnounce: (sentence: string) => void;
  onResolve: (id: string, decision: 'approve' | 'deny', note?: string) => Promise<void>;
  block: { code: string; message: string; actionLabel: string } | undefined;
  onOpenSettings: (page: SettingsPage) => void;
  onRetryConnection: () => void;
  diskFreeBytes: number | undefined;
  error: string;
  onDismissError: () => void;
  notice: string;
  onDismissNotice: () => void;
}): ReactNode {
  switch (props.kind) {
    case 'approval':
      return (
        /*
          The approval card is a banner like the others, so it lives where they live: in flow,
          inside the composer, above the box. It used to be absolutely positioned at
          `bottom: 150px` against a composer that is 190px tall, so it overlapped the thing it sat
          above and carried two more composer-height guesses of its own.
        */
        <Approvals
          approvals={props.approvals}
          {...(props.workspaceId ? { workspaceId: props.workspaceId } : {})}
          onOpenTask={props.onOpenTask}
          openTaskId={props.openTaskId}
          /* So a request raised somewhere the owner is not looking can say where. */
          taskTitles={props.taskTitles}
          /* So the card can say whether the agent asking had anybody else's text in its context.
             These are the events of the conversation on screen; the card reads them only for an
             approval that belongs to it. */
          openTaskEvents={props.openTaskEvents}
          onOpenComputer={props.onOpenComputer}
          /* The card takes focus itself when it appears; this is how the window gets the owner
             back to it from the palette, which is the only route — see `windowShortcut`. */
          cardRef={props.cardRef}
          /* One arrival, said once, through the region the window already has. The card used to
             announce itself by being assertive, which meant announcing again every time its
             countdown moved. */
          onAnnounce={props.onAnnounce}
          /*
            A decision that failed is reported on the card that asked for it, not through the
            shared error strip. The strip cannot say it while this card is up - the card outranks
            it, and the approval is still pending - so routing the failure there put athanor back
            where it was before any of this: Approve pressed, nothing on screen, no way to tell a
            refusal from a dropped packet. The card is also where the owner is looking.
          */
          {...(props.approvalFailure ? { failure: props.approvalFailure } : {})}
          onResolve={props.onResolve}
        />
      );
    case 'block':
      return props.block ? (
        <div className="composer-block" role="status">
          <Sparkles />
          <span>{props.block.message}</span>
          <button
            onClick={() =>
              props.onOpenSettings(
                props.block?.code === 'private_route_unavailable' ||
                  props.block?.code === 'provider_missing'
                  ? 'ai'
                  : 'server'
              )
            }
          >
            {props.block.actionLabel}
          </button>
        </div>
      ) : undefined;
    case 'offline':
      return (
        /*
          The last-known state stays on screen behind this. A dropped connection is a strip, not a
          sign-out: the box is still working and this device reconnects on its own. What the owner
          actually needs to know is what it means for the work — the turn on screen carries on
          there, and nothing on this device moves until the connection is back.
        */
        <div className="inline-error offline-strip" role="status">
          <WifiOff />
          <span>Can’t reach your athanor. It keeps working; this screen doesn’t.</span>
          <button onClick={props.onRetryConnection}>Retry now</button>
        </div>
      );
    case 'storage':
      /*
        A banner above the composer is the most expensive place in the interface, so storage only
        earns it once the box is refusing writes — which is a floor in free bytes, not a
        percentage: see `hostStorageBlocksWork`. It used to shout at ninety percent, which on a
        large disk is hundreds of gigabytes free and nothing to do about it. The free space is the
        only number here because it is the one that decides how much has to go.
      */
      return props.diskFreeBytes === undefined ? undefined : (
        <div className="usage-warning critical">
          <HardDrive />
          <span>
            {formatBytes(props.diskFreeBytes)} of disk left — the computer has stopped writing
            files.
          </span>
          <button onClick={props.onOpenFiles}>Files</button>
        </div>
      );
    case 'error':
      return (
        <div className="inline-error" role="alert">
          <span>{props.error}</span>
          <button onClick={props.onDismissError} aria-label="Dismiss error">
            <X />
          </button>
        </div>
      );
    case 'degraded':
      return (
        <div className="inline-notice" role="status">
          <span>Reconnecting. New activity may lag.</span>
        </div>
      );
    case 'notice':
      return (
        <div className="inline-notice" role="status">
          <span>{props.notice}</span>
          <button onClick={props.onDismissNotice} aria-label="Dismiss status">
            <X />
          </button>
        </div>
      );
    default:
      return undefined;
  }
}
