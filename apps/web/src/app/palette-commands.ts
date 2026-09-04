import type { Command } from '../CommandPalette.js';
import type { InspectorTab } from '../client-state.js';
import { pauseAction } from '../task-status.js';
import type { Task } from '../types.js';

/**
 * The four panes the palette can open, named for the reader rather than for the store.
 *
 * The identifier is the owner's stored preference and cannot move; the name follows the tab, which
 * now shows what the computer is running rather than a form asking for a port number.
 */
const surfaces: Array<[InspectorTab, string]> = [
  ['files', 'Files'],
  ['computer', 'Computer'],
  ['terminal', 'Terminal'],
  ['preview', 'Running']
];

/** Everything the palette can do, supplied by whoever can actually do it. */
export interface PaletteActions {
  focusApproval: () => void;
  newConversation: () => void;
  stop: () => void;
  pause: (task: Task) => void;
  pin: (task: Task) => void;
  archive: (task: Task) => void;
  copy: () => void;
  download: () => void;
  share: () => void;
  remove: (task: Task) => void;
  openTab: (tab: InspectorTab) => void;
  openSettings: () => void;
  openSchedules: () => void;
  openNotices: () => void;
  showShortcuts: () => void;
}

/**
 * What the palette offers, given what is on screen.
 *
 * Its list was fixed at pane switching, Settings and Schedules, so with a conversation open it could
 * not stop, rename, delete, branch or copy the very thing being looked at — all of which are
 * functions two scopes up from it. Every entry carries its key, since the palette is also the only
 * place the shortcuts are discoverable.
 *
 * A list rather than a component, and pure: what is offered is a decision about state, and it is the
 * one part of this screen that can be read back without a browser.
 */
export const paletteCommands = (input: {
  approvalCount: number;
  task: Task | undefined;
  taskIsActive: boolean;
  noticeCount: number;
  actions: PaletteActions;
}): Command[] => {
  const { approvalCount, task, taskIsActive, noticeCount, actions } = input;
  const commands: Command[] = [
    // First, and only while something is waiting. The palette is where the owner looks for a
    // thing they cannot find, and the one control they could not reach from here was the one
    // where the agent is stopped waiting on them. No key of its own: every chord built on Enter
    // is already a send in the message box (`sendsOnKey`), which is where it would be pressed.
    ...(approvalCount
      ? [
          {
            id: 'approval',
            label: 'Go to the request waiting for you',
            group: 'Actions',
            run: actions.focusApproval
          }
        ]
      : []),
    {
      id: 'new-chat',
      label: 'New conversation',
      hint: '⌘⇧O',
      group: 'Actions',
      run: actions.newConversation
    }
  ];
  if (task) {
    if (taskIsActive)
      commands.push({
        id: 'stop',
        label: 'Stop the agent',
        hint: 'Esc',
        group: 'This conversation',
        run: actions.stop
      });
    if (taskIsActive)
      commands.push({
        id: 'pause',
        label:
          pauseAction(task) === 'resume' ? 'Resume this conversation' : 'Pause this conversation',
        group: 'This conversation',
        run: () => actions.pause(task)
      });
    commands.push(
      {
        id: 'pin-conversation',
        label: task.pinned ? 'Unpin this conversation' : 'Pin this conversation',
        group: 'This conversation',
        run: () => actions.pin(task)
      },
      {
        id: 'archive-conversation',
        label: task.archivedAt
          ? 'Put this conversation back in the list'
          : 'File this conversation away',
        group: 'This conversation',
        run: () => actions.archive(task)
      },
      {
        id: 'copy-conversation',
        label: 'Copy conversation as Markdown',
        group: 'This conversation',
        run: actions.copy
      },
      {
        id: 'download-conversation',
        label: 'Download conversation',
        group: 'This conversation',
        run: actions.download
      },
      {
        id: 'share-conversation',
        label: task.shareCount
          ? 'Manage the links to this conversation'
          : 'Share this conversation',
        group: 'This conversation',
        run: actions.share
      },
      {
        id: 'delete-conversation',
        label: 'Delete this conversation',
        group: 'This conversation',
        run: () => actions.remove(task)
      }
    );
  }
  commands.push(
    ...surfaces.map(([tab, label]) => ({
      id: `open-${tab}`,
      label: `Open ${label}`,
      ...(tab === 'files' ? { hint: '⌘B' } : {}),
      group: 'Computer',
      run: () => actions.openTab(tab)
    })),
    { id: 'settings', label: 'Open Settings', group: 'Actions', run: actions.openSettings },
    {
      id: 'schedules',
      label: 'Open Schedules',
      group: 'Actions',
      run: actions.openSchedules
    },
    // Listed only when there is something behind it, like the sidebar row it opens.
    ...(noticeCount
      ? [
          {
            id: 'notices',
            label: 'What athanor told you',
            group: 'Actions',
            run: actions.openNotices
          }
        ]
      : []),
    {
      id: 'shortcuts',
      label: 'Keyboard shortcuts',
      hint: '?',
      group: 'Actions',
      run: actions.showShortcuts
    }
  );
  return commands;
};
