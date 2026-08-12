import { BellRing, ShieldAlert, X } from 'lucide-react';
import { Dialog } from './Dialog.js';
import { noticeWhen, type AgentNotification } from './notice-log.js';

/**
 * Everything athanor has told the owner, in one place and across every conversation.
 *
 * Each of these already appeared twice: once in the conversation it was decided in, and once on
 * whatever device happened to be awake. Neither is somewhere you can look something up — the first
 * needs the conversation found first, and the second is gone the moment it is swiped away. This is
 * the record, newest first, and every row opens the work it came out of.
 */
export function NoticeLog({
  notices,
  onOpenTask,
  onClose
}: {
  notices: AgentNotification[];
  onOpenTask: (taskId: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog className="modal notice-modal" labelledBy="notice-title" onClose={onClose}>
      <button className="modal-close" aria-label="Close messages" onClick={onClose}>
        <X />
      </button>
      <h2 id="notice-title">What athanor told you</h2>
      <p className="subtle">
        Messages athanor decided to send, whether or not a device was awake to receive them.
      </p>
      <div className="notice-list">
        {/* Reachable while empty: the last notice can be read, and then the list refreshes under
            the open dialog. An empty box with a heading over it reads as a failure to load. */}
        {!notices.length && (
          <small>Nothing yet. athanor only writes here when it has something.</small>
        )}
        {notices.map((notice) => (
          <button
            key={notice.id}
            className="notice-row"
            // A row with no conversation behind it is still worth reading; it is just not a way in.
            disabled={!notice.taskId}
            onClick={() => {
              onOpenTask(notice.taskId);
              onClose();
            }}
          >
            {notice.kind === 'takeover_needed' ? <ShieldAlert /> : <BellRing />}
            <span>
              <strong>{notice.message}</strong>
              <small>
                {notice.taskTitle || 'Untitled conversation'} · {noticeWhen(notice.createdAt)}
              </small>
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
