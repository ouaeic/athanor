import type { FileEntry } from './types.js';

/**
 * Names typed into the Files pane, checked before they become a request.
 *
 * The runner refuses anything that escapes the workspace, so this is not the security boundary —
 * it is the difference between "That name cannot contain a slash" and a 400 with a path in it.
 */
export type NameCheck = { ok: true; name: string } | { ok: false; message: string };

const RESERVED = new Set(['.', '..']);

export const checkFileName = (raw: string): NameCheck => {
  const name = raw.trim();
  if (!name) return { ok: false, message: 'Give it a name.' };
  if (name.length > 255) return { ok: false, message: 'That name is too long for a file system.' };
  if (name.includes('/'))
    return { ok: false, message: 'A name cannot contain a slash. Use New folder to nest it.' };
  /*
   * Control characters are exactly what is being rejected: a file system will accept them and then
   * nothing the owner has will be able to name the result again.
   */
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name))
    return { ok: false, message: 'That name contains characters a file system will not accept.' };
  if (RESERVED.has(name)) return { ok: false, message: 'That name is reserved.' };
  return { ok: true, name };
};

/** Where a new folder typed into `directory` would go. */
export const newFolderPath = (
  directory: string,
  raw: string,
  siblings: FileEntry[]
): { ok: true; path: string } | { ok: false; message: string } => {
  const checked = checkFileName(raw);
  if (!checked.ok) return checked;
  if (siblings.some((entry) => entry.name === checked.name))
    return { ok: false, message: `There is already something called ${checked.name} here.` };
  return { ok: true, path: `${directory}/${checked.name}` };
};

/**
 * Where a rename would move `entry`. The new name replaces only the last segment, so a rename
 * stays in the folder it started in and cannot be turned into a move by typing a path.
 */
export const renamedPath = (
  entry: FileEntry,
  raw: string,
  siblings: FileEntry[]
): { ok: true; path: string } | { ok: false; message: string } => {
  const checked = checkFileName(raw);
  if (!checked.ok) return checked;
  if (checked.name === entry.name) return { ok: false, message: 'That is already its name.' };
  if (siblings.some((item) => item.path !== entry.path && item.name === checked.name))
    return { ok: false, message: `There is already something called ${checked.name} here.` };
  const parent = entry.path.split('/').slice(0, -1).join('/');
  return { ok: true, path: parent ? `${parent}/${checked.name}` : checked.name };
};

/** What the owner is about to lose, said plainly, because deleting a folder takes its contents. */
export const deletionMessage = (entry: FileEntry): string =>
  entry.type === 'directory'
    ? `Deleted ${entry.name} and everything in it`
    : `Deleted ${entry.name}`;
