/*
 * The file browser rendered a name and a size, alphabetically, with no sort and no filter - so
 * "what did the agent just make", "what is eating my disk" and "where is that CSV" all had no
 * answer on the one screen that holds the files. These are the two pure parts of the answer.
 */
import { describe, expect, it } from 'vitest';
import { fileLine, sortEntries, timeAgo } from './file-rows.js';
import type { FileEntry } from './types.js';

const NOW = Date.parse('2026-08-10T12:00:00.000Z');

const entry = (patch: Partial<FileEntry> & { name: string }): FileEntry => ({
  path: `workspace/${patch.name}`,
  type: 'file',
  sizeBytes: 0,
  modifiedAt: '2026-08-10T12:00:00.000Z',
  ...patch
});

describe('how long ago something changed', () => {
  it('says it the way a person says it', () => {
    expect(timeAgo('2026-08-10T11:59:30.000Z', NOW)).toBe('just now');
    expect(timeAgo('2026-08-10T11:59:00.000Z', NOW)).toBe('1 minute ago');
    expect(timeAgo('2026-08-10T11:56:00.000Z', NOW)).toBe('4 minutes ago');
    expect(timeAgo('2026-08-10T10:00:00.000Z', NOW)).toBe('2 hours ago');
    expect(timeAgo('2026-08-07T12:00:00.000Z', NOW)).toBe('3 days ago');
  });

  /* Past a month the span stops being the useful fact and the date is: "412 days ago" is a number
     nobody converts. */
  it('gives up on spans and names the date once it is months old', () => {
    const old = timeAgo('2024-02-01T12:00:00.000Z', NOW);
    expect(old).not.toContain('ago');
    expect(old).toContain('2024');
  });

  /*
   * The runner's clock and this device's clock are two clocks. A file written on the box a second
   * before this device asked for the listing must not be reported as changing in the future.
   */
  it('never counts forwards', () => {
    expect(timeAgo('2026-08-10T12:00:20.000Z', NOW)).toBe('just now');
  });

  it('says nothing at all rather than something wrong about an unreadable timestamp', () => {
    expect(timeAgo('', NOW)).toBe('');
    expect(fileLine(entry({ name: 'notes.md', sizeBytes: 12_000, modifiedAt: 'soon' }), NOW)).toBe(
      '12 KB'
    );
  });
});

describe('the line under a file name', () => {
  it('says what it is and when it changed', () => {
    expect(
      fileLine(
        entry({ name: 'notes.md', sizeBytes: 12_000, modifiedAt: '2026-08-10T11:56:00.000Z' }),
        NOW
      )
    ).toBe('12 KB · 4 minutes ago');
  });

  it('counts what is in a folder rather than sizing it', () => {
    expect(
      fileLine(
        entry({
          name: 'reports',
          type: 'directory',
          itemCount: 8,
          sizeBytes: 96,
          modifiedAt: '2026-08-10T10:00:00.000Z'
        }),
        NOW
      )
    ).toBe('8 items · 2 hours ago');
  });

  /*
   * The 96 bytes above is the directory record, not the folder's weight on disk, and the whole
   * point of this line is that it never says so. A server older than this client sends no count,
   * and the row then says the one thing it does know rather than inventing the other.
   */
  it('never prints a folder’s size, with or without a count to print instead', () => {
    const line = fileLine(
      entry({
        name: 'reports',
        type: 'directory',
        sizeBytes: 4096,
        modifiedAt: '2026-08-10T10:00:00.000Z'
      }),
      NOW
    );
    expect(line).toBe('2 hours ago');
    expect(line).not.toContain('KB');
  });
});

describe('the order the listing is read in', () => {
  const listing: FileEntry[] = [
    entry({ name: 'zeta.csv', sizeBytes: 900_000, modifiedAt: '2026-08-10T11:59:00.000Z' }),
    entry({ name: 'alpha.md', sizeBytes: 1_000, modifiedAt: '2026-08-01T12:00:00.000Z' }),
    entry({
      name: 'reports',
      type: 'directory',
      itemCount: 3,
      sizeBytes: 4096,
      modifiedAt: '2026-08-09T12:00:00.000Z'
    })
  ];
  const names = (order: 'name' | 'size' | 'recent'): string[] =>
    sortEntries(listing, order).map((item) => item.name);

  it('keeps folders first and alphabetical when the order is Name', () => {
    expect(names('name')).toEqual(['reports', 'alpha.md', 'zeta.csv']);
  });

  /* Size exists because the storage banner sends the owner to this pane and it had no other way to
     say what is taking the disk. A folder cannot be ranked, so it goes last rather than nowhere. */
  it('puts the biggest file first and the unrankable folders last when the order is Size', () => {
    expect(names('size')).toEqual(['zeta.csv', 'alpha.md', 'reports']);
  });

  /* Recent answers "what did the agent just make", which is not a question about folders and files
     separately - so this is the one order that does not group them. */
  it('puts the newest thing first, folder or not, when the order is Recent', () => {
    expect(names('recent')).toEqual(['zeta.csv', 'reports', 'alpha.md']);
  });

  it('leaves the array the pane is holding untouched', () => {
    const before = listing.map((item) => item.name);
    sortEntries(listing, 'size');
    expect(listing.map((item) => item.name)).toEqual(before);
  });
});
