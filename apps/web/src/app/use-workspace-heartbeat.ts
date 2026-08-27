import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { api } from '../api.js';
import type { Bootstrap, Workspace } from '../types.js';

/**
 * Keeping the computer awake, and reading back how much of its disk is left.
 *
 * `failed` as well as `hibernated`. Resume is the same call for both - it asks the runner to bring
 * the computer up and marks it running - but the client only ever made it for a sleeping one, so a
 * computer that failed to start stayed failed for good: every message was answered "Workspace is not
 * running", and no screen anywhere offered a way to try again. It is reachable on a first sign-in,
 * when the runner happens not to answer while bootstrap is provisioning.
 */
export const useWorkspaceHeartbeat = (input: {
  workspace: Workspace | undefined;
  setData: Dispatch<SetStateAction<Bootstrap | undefined>>;
}) => {
  const { workspace, setData } = input;
  useEffect(() => {
    if (!workspace) return;
    let active = true;
    const keepAlive = async () => {
      try {
        if (workspace.status === 'hibernated' || workspace.status === 'failed') {
          const resumed = await api.workspaceAction(workspace.id, 'resume');
          if (active)
            setData((current) =>
              current
                ? {
                    ...current,
                    workspaces: current.workspaces.map((item) =>
                      item.id === resumed.id ? resumed : item
                    )
                  }
                : current
            );
        } else {
          const measured = await api.workspaceHeartbeat(workspace.id);
          if (active)
            setData((current) =>
              current
                ? {
                    ...current,
                    workspaces: current.workspaces.map((item) =>
                      item.id === workspace.id
                        ? {
                            ...item,
                            storageBytes: measured.storageBytes,
                            ...(measured.hostStorageTotalBytes
                              ? { hostStorageTotalBytes: measured.hostStorageTotalBytes }
                              : {}),
                            ...(measured.hostStorageAvailableBytes !== undefined
                              ? {
                                  hostStorageAvailableBytes: measured.hostStorageAvailableBytes
                                }
                              : {})
                          }
                        : item
                    )
                  }
                : current
            );
        }
      } catch {
        // The next heartbeat retries; the current workspace status stays visible.
      }
    };
    void keepAlive();
    const timer = window.setInterval(() => void keepAlive(), 5 * 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [workspace?.id, workspace?.status]);
};
