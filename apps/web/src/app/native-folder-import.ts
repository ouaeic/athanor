import { api } from '../api.js';
import type { Attachment } from '../attachments.js';
import { describeFailure } from '../failure-text.js';
import { nativeBridge } from '../native.js';
import type { Workspace } from '../types.js';

/** Directories and files a project always has and nobody ever meant to hand to an agent. */
const SKIP = new Set(['.git', 'node_modules', '.env', '.DS_Store', 'dist', 'build']);
/** A ceiling on one import, so a mistaken choice of folder cannot become an hour of uploads. */
const MOST_FILES = 500;
const LARGEST_FILE_BYTES = 100 * 1024 * 1024;

/**
 * A folder on the owner's own machine, copied onto the agent computer.
 *
 * Only a packaged shell can offer this — a browser has no folder to grant — and the grant is
 * revoked on the way out whether or not the walk finished. The imported files join the tray like
 * any other attachment, rather than being listed by path inside the message the owner is writing.
 */
export const importNativeFolder = async (input: {
  workspace: Workspace | undefined;
  addAttachments: (update: (current: Attachment[]) => Attachment[]) => void;
  setBusy: (busy: boolean) => void;
  onError: (message: string) => void;
}) => {
  const { workspace, addAttachments, setBusy, onError } = input;
  if (!workspace) return;
  const grant = await nativeBridge.chooseFolder();
  if (!grant) return;
  setBusy(true);
  onError('');
  try {
    const uploaded: string[] = [];
    const visit = async (relative = ''): Promise<void> => {
      const entries = (await nativeBridge.listFolder(grant.token, relative)) ?? [];
      for (const entry of entries) {
        if (uploaded.length >= MOST_FILES || SKIP.has(entry.name)) continue;
        if (entry.isDirectory) await visit(entry.relativePath);
        else if (entry.sizeBytes <= LARGEST_FILE_BYTES) {
          const bytes = await nativeBridge.readFile(grant.token, entry.relativePath);
          if (!bytes) continue;
          const destination = `workspace/imports/${grant.name}/${entry.relativePath}`;
          await api.writeFile(workspace.id, destination, Uint8Array.from(bytes));
          uploaded.push(destination);
        }
      }
    };
    await visit();
    addAttachments((current) => [
      ...current,
      ...uploaded.map((path) => ({
        id: crypto.randomUUID(),
        name: path.slice(`workspace/imports/${grant.name}/`.length) || path,
        sizeBytes: 0,
        mimeType: 'application/octet-stream',
        path,
        status: 'ready' as const,
        progress: 1
      }))
    ]);
  } catch (cause) {
    onError(describeFailure(cause, 'Could not import local folder'));
  } finally {
    await nativeBridge.revokeFolder(grant.token);
    setBusy(false);
  }
};
