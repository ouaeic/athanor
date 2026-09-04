import { Menu, PanelRight, Pause, Play } from 'lucide-react';
import { pauseAction, queuedFollowUpLabel } from '../task-status.js';
import type { Task, Workspace } from '../types.js';

/**
 * The line above the conversation: what it is called, what the machine is doing about it, and the
 * three controls that belong to the window rather than to the message being written.
 *
 * Everything here is chrome — a fact about the machine, stated once, with nothing to press but the
 * thing it names. Nothing on this line is an alarm; the shelf above the composer is where those go,
 * and it is ranked so that only one of them is ever on screen.
 */
export function WorkbenchHeader(props: {
  task: Task | undefined;
  workspace: Workspace | undefined;
  /** The conversation holding this one's computer, or undefined when nothing holds it. */
  computerHolder: Task | undefined;
  taskIsActive: boolean;
  inspectorOpen: boolean;
  /** Whether this screen is a release the box has already replaced, and the reload is free to offer. */
  offerReload: boolean;
  onOpenNav: (opener: HTMLElement) => void;
  onOpenTask: (id: string) => void;
  onReload: () => void;
  onPause: (task: Task) => void;
  onShare: () => void;
  onToggleInspector: () => void;
}) {
  const { task, workspace, computerHolder, taskIsActive, inspectorOpen } = props;
  return (
    <header className="workbench-header">
      <button
        className="icon-btn mobile-menu"
        aria-label="Open navigation"
        onClick={(event) => props.onOpenNav(event.currentTarget)}
      >
        <Menu />
      </button>
      <div className="task-title">
        <strong>{task?.title ?? 'New conversation'}</strong>
        {/*
          The sidebar already names the computer and shows whether it is ready, so repeating it here
          on every task spends a line saying nothing. What is left is the one thing this line can say
          that nothing else on the screen does: the computer is not there. A fork used to be labelled
          here as well, above a bar that says the same thing with the version number in it and a way
          to move between them.
        */}
        {!workspace && (
          <span>
            <i />
            Computer unavailable
          </span>
        )}
        {/*
          A conversation waiting for the computer looked exactly like one about to start, and the
          wait can be a whole turn long. This is the second question saying which conversation has
          the computer, and offering the way to it — the only two moves here are to wait or to stop
          that one, and Stop lives on that conversation. A fact about the machine, so it is chrome:
          no fire, no caution, nothing to press but the name.
        */}
        {workspace && computerHolder && (
          <span className="computer-held">
            Waiting for the computer.{' '}
            <button
              className="computer-held-open"
              aria-label={`Open ${computerHolder.title}`}
              onClick={() => props.onOpenTask(computerHolder.id)}
            >
              {computerHolder.title}
            </button>{' '}
            has it.
          </span>
        )}
      </div>
      <div className="header-actions">
        {/*
          One fact, and the way to see it.

          Not a strip and not a dialog: this is not an error and it is not the owner's turn, so it
          takes none of the space above the composer and nothing that is already on screen moves for
          it. It says only what this device actually knows — that the box is serving something other
          than this — and never what changed, which it has no way of reading. There is no dismiss,
          because a dismissed fact the machine still holds is the silence this exists to end;
          ignoring it costs a glance and nothing else, and it is stated once whether the owner acts
          on it now or in four hours.
        */}
        {props.offerReload && (
          <div className="update-offer" role="status">
            <span>This screen is not the version on your athanor.</span>
            <button
              onClick={props.onReload}
              title="This screen is not the version on your athanor. Reload to catch up."
            >
              Reload
            </button>
          </div>
        )}
        {/*
          A count of rows in the message queue, said either way round. "1 queued" stayed on screen
          after a turn died mid-step, over a conversation that will not be leased again, so the
          interface went on promising delivery of the correction the owner had typed to stop that
          very turn. The box now carries a message onto the next attempt and takes it out of the
          queue when the attempts are gone, which empties the count on its own in the ordinary case;
          this is what the header says when a write got no further than the status. The card those
          words are on is where they can be picked back up — this only has to stop claiming they are
          on their way.
        */}
        {queuedFollowUpLabel(task) && (
          <span className="header-pill queue-pill">{queuedFollowUpLabel(task)}</span>
        )}
        {/*
          A conversation with a live link says so where its other facts are said, and the word is
          the door to the links: this is chrome, a fact about the machine with the one control that
          belongs to it, and it is not on screen when nothing is shared.
        */}
        {task && task.shareCount > 0 && (
          <button className="header-pill share-pill" onClick={props.onShare}>
            Shared{task.shareCount > 1 ? ` · ${task.shareCount}` : ''}
          </button>
        )}
        {taskIsActive && task && (
          <button className="header-pill" onClick={() => props.onPause(task)}>
            {pauseAction(task) === 'resume' ? <Play /> : <Pause />}
            {pauseAction(task) === 'resume' ? 'Resume' : 'Pause'}
          </button>
        )}
        <button
          className={`workspace-tools-button ${inspectorOpen ? 'active' : ''}`}
          title={inspectorOpen ? 'Hide computer tools' : 'Open computer tools'}
          aria-expanded={inspectorOpen}
          onClick={props.onToggleInspector}
        >
          <PanelRight />
          <span>{inspectorOpen ? 'Hide tools' : 'Computer tools'}</span>
        </button>
      </div>
    </header>
  );
}
