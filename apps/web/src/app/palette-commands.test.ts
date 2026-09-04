/**
 * What the palette offers, given what is on screen.
 *
 * This list was fixed at pane switching, Settings and Schedules while `App()` was one function, and
 * the five things it could not reach were the five that belong to the conversation being looked at.
 * Pulling it out of that function is what made it answerable without a browser; these are the cases
 * that were only ever checked by opening the palette and reading it.
 */
import { describe, expect, it, vi } from 'vitest';
import { paletteCommands, type PaletteActions } from './palette-commands.js';
import type { Task } from '../types.js';

const conversation = (patch: Partial<Task> = {}): Task =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: 'desk',
    title: 'Quarterly report',
    status: 'running',
    ...patch
  }) as Task;

const actions = (): PaletteActions => ({
  focusApproval: vi.fn(),
  newConversation: vi.fn(),
  stop: vi.fn(),
  pause: vi.fn(),
  pin: vi.fn(),
  archive: vi.fn(),
  copy: vi.fn(),
  download: vi.fn(),
  share: vi.fn(),
  remove: vi.fn(),
  openTab: vi.fn(),
  openSettings: vi.fn(),
  openSchedules: vi.fn(),
  openNotices: vi.fn(),
  showShortcuts: vi.fn()
});

const ids = (input: Parameters<typeof paletteCommands>[0]) =>
  paletteCommands(input).map((command) => command.id);

describe('what the palette offers', () => {
  it('reaches every function of the conversation on screen', () => {
    expect(
      ids({
        approvalCount: 0,
        task: conversation(),
        taskIsActive: true,
        noticeCount: 0,
        actions: actions()
      })
    ).toEqual([
      'new-chat',
      'stop',
      'pause',
      'pin-conversation',
      'archive-conversation',
      'copy-conversation',
      'download-conversation',
      'share-conversation',
      'delete-conversation',
      'open-files',
      'open-computer',
      'open-terminal',
      'open-preview',
      'settings',
      'schedules',
      'shortcuts'
    ]);
  });

  it('offers nothing about a conversation when none is open', () => {
    const listed = ids({
      approvalCount: 0,
      task: undefined,
      taskIsActive: false,
      noticeCount: 0,
      actions: actions()
    });
    expect(listed.filter((id) => id.endsWith('-conversation'))).toEqual([]);
    expect(listed).not.toContain('stop');
  });

  it('does not offer to stop an agent that is not working', () => {
    const listed = ids({
      approvalCount: 0,
      task: conversation({ status: 'completed' }),
      taskIsActive: false,
      noticeCount: 0,
      actions: actions()
    });
    expect(listed).not.toContain('stop');
    expect(listed).not.toContain('pause');
    // The rest of the conversation's own functions survive a finished turn.
    expect(listed).toContain('delete-conversation');
  });

  it('puts the request waiting for the owner first, and only while one is waiting', () => {
    const waiting = ids({
      approvalCount: 1,
      task: undefined,
      taskIsActive: false,
      noticeCount: 0,
      actions: actions()
    });
    expect(waiting[0]).toBe('approval');
    expect(
      ids({
        approvalCount: 0,
        task: undefined,
        taskIsActive: false,
        noticeCount: 0,
        actions: actions()
      })
    ).not.toContain('approval');
  });

  it('lists the notice log only when there is something behind it', () => {
    const empty = {
      approvalCount: 0,
      task: undefined,
      taskIsActive: false,
      noticeCount: 0,
      actions: actions()
    };
    expect(ids(empty)).not.toContain('notices');
    expect(ids({ ...empty, noticeCount: 3 })).toContain('notices');
  });

  it('names the direction each toggle would move in, not the state it is in', () => {
    const pinned = paletteCommands({
      approvalCount: 0,
      task: conversation({ pinned: true, archivedAt: '2026-08-01T00:00:00.000Z' }),
      taskIsActive: false,
      noticeCount: 0,
      actions: actions()
    });
    expect(pinned.find((command) => command.id === 'pin-conversation')?.label).toBe(
      'Unpin this conversation'
    );
    expect(pinned.find((command) => command.id === 'archive-conversation')?.label).toBe(
      'Put this conversation back in the list'
    );
  });

  it('carries the key for every function that has one, because this is where they are discovered', () => {
    const listed = paletteCommands({
      approvalCount: 0,
      task: conversation(),
      taskIsActive: true,
      noticeCount: 0,
      actions: actions()
    });
    const hinted = Object.fromEntries(
      listed.flatMap((command) => (command.hint ? [[command.id, command.hint]] : []))
    );
    expect(hinted).toEqual({
      'new-chat': '⌘⇧O',
      stop: 'Esc',
      'open-files': '⌘B',
      shortcuts: '?'
    });
  });

  it('runs the conversation it was built for, not whatever is open when it is pressed', () => {
    const target = conversation();
    const handlers = actions();
    const listed = paletteCommands({
      approvalCount: 0,
      task: target,
      taskIsActive: false,
      noticeCount: 0,
      actions: handlers
    });
    listed.find((command) => command.id === 'delete-conversation')?.run();
    expect(handlers.remove).toHaveBeenCalledWith(target);
  });
});
