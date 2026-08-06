import { describe, expect, it } from 'vitest';
import { noticeWhen, readNotices } from './notice-log.js';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'notice-1',
  taskId: 'task-1',
  kind: 'agent_message',
  taskTitle: 'Watch the property listings',
  message: 'The listing on Cromwell Road dropped to £610,000.',
  createdAt: '2026-07-30T08:15:00.000Z',
  ...overrides
});

describe('readNotices', () => {
  it('reads a plain list and puts the newest first', () => {
    const notices = readNotices([
      row({ id: 'a', createdAt: '2026-07-28T09:00:00.000Z' }),
      row({ id: 'b', createdAt: '2026-07-30T09:00:00.000Z' })
    ]);
    expect(notices.map((notice) => notice.id)).toEqual(['b', 'a']);
  });

  it('reads the same list out of an envelope', () => {
    expect(readNotices({ items: [row()] })).toHaveLength(1);
  });

  it('keeps the conversation name the box decrypted, for work this device never paged in', () => {
    expect(readNotices([row()])[0]?.taskTitle).toBe('Watch the property listings');
    expect(readNotices([row({ taskTitle: null })])[0]?.taskTitle).toBe('');
  });

  it('drops a row with nothing to read rather than rendering an empty line', () => {
    expect(readNotices([row({ message: '   ' }), row({ id: '' })])).toEqual([]);
  });

  it('keeps the takeover kind apart, because it is a request rather than news', () => {
    const [notice] = readNotices([row({ kind: 'takeover_needed' })]);
    expect(notice?.kind).toBe('takeover_needed');
    expect(readNotices([row({ kind: 'something_new' })])[0]?.kind).toBe('agent_message');
  });

  it('survives a box that answers with something else entirely', () => {
    expect(readNotices(null)).toEqual([]);
    expect(readNotices('nope')).toEqual([]);
    expect(readNotices({ error: 'nope' })).toEqual([]);
  });
});

describe('noticeWhen', () => {
  const now = new Date('2026-07-30T18:00:00.000Z').getTime();

  it('says the time for today and the day for this week', () => {
    expect(noticeWhen('2026-07-30T08:15:00.000Z', now)).not.toContain('·');
    expect(noticeWhen('2026-07-28T08:15:00.000Z', now)).toContain('·');
    expect(noticeWhen('2026-07-28T08:15:00.000Z', now)).toMatch(/day/);
  });

  it('falls back to the date once the day name stops meaning anything', () => {
    expect(noticeWhen('2026-06-12T08:15:00.000Z', now)).toMatch(/Jun/);
  });

  it('says nothing at all about a timestamp it cannot read', () => {
    expect(noticeWhen('not a date', now)).toBe('');
  });
});
