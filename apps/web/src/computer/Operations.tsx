import { useCallback, useEffect, useState } from 'react';
import type {
  Task,
  TaskRewindPreview,
  Workspace,
  WorkspacePreview,
  WorkspaceSnapshot
} from '@athanor/contracts';
import { del, get, isNativeClient, post } from '../client.js';
import { previewIsolated, previewUrl } from '../preview-url';
import { stepUp } from '../auth.js';
import { bytes, message } from './format.js';
import Computation from './Computation';
import DebugSessions from './DebugSessions';

interface Process {
  sessionId: string;
  status: string;
  command: string;
  startedAt: string;
  ranForMs: number;
  outputBytes: number;
  deadlineAt?: string;
  exitCode?: number;
  service?: { name?: string; listening?: string[] };
  lifetime?: 'task' | 'service' | 'job';
  job?: {
    jobId: string;
    name: string;
    state: string;
    checkpointResumable: boolean;
    createdAt: string;
    startedAt: string;
    restarts: number;
    lastExit?: { code?: number; reason?: string };
  };
}
interface ProcessList {
  processes: Process[];
  agentListeners?: string[];
  reachableFromOutsideThisComputer?: string[];
  note?: string;
}

export function Operations({
  workspace,
  task,
  tool,
  onChange
}: {
  workspace: Workspace;
  task: Task | null;
  tool: 'previews' | 'processes' | 'checkpoints';
  onChange: () => void;
}) {
  const base = `/v1/workspaces/${workspace.id}`;
  const [previews, setPreviews] = useState<WorkspacePreview[]>([]);
  const [processes, setProcesses] = useState<ProcessList>({ processes: [] });
  const [snapshots, setSnapshots] = useState<WorkspaceSnapshot[]>([]);
  const [rewind, setRewind] = useState<TaskRewindPreview | null>(null);
  const [rewindError, setRewindError] = useState('');
  const [name, setName] = useState('');
  const [port, setPort] = useState('3000');
  const [path, setPath] = useState('/');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{
    id: string;
    action: 'restore' | 'delete' | 'publish' | 'stop' | 'rotate';
  } | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [opened, setOpened] = useState<WorkspacePreview | null>(null);
  const load = useCallback(async () => {
    if (tool === 'previews') setPreviews(await get<WorkspacePreview[]>(`${base}/previews`));
    if (tool === 'processes') setProcesses(await get<ProcessList>(`${base}/processes`));
    if (tool === 'checkpoints') setSnapshots(await get<WorkspaceSnapshot[]>(`${base}/snapshots`));
  }, [base, tool]);
  useEffect(() => {
    let active = true;
    void load().catch((e) => {
      if (active) setError(message(e));
    });
    const interval = setInterval(
      () => {
        if (document.visibilityState === 'visible')
          void load().catch((e) => {
            if (active) setError(message(e));
          });
      },
      tool === 'processes' ? 5000 : 20_000
    );
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [load, tool]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
      onChange();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const inspectRewind = async () => {
    if (!task) return;
    setRewindError('');
    try {
      setRewind(await get<TaskRewindPreview>(`/v1/tasks/${task.id}/rewind-preview`));
    } catch (e) {
      setRewindError(message(e));
    }
  };
  const executeConfirmation = async () => {
    if (!confirm) return;
    if (confirm.action === 'stop')
      await post(`${base}/processes/${encodeURIComponent(confirm.id)}`, { action: 'kill' });
    if (confirm.action === 'rotate')
      setOpened(await post<WorkspacePreview>(`/v1/previews/${confirm.id}/rotate-access`, {}));
    if (confirm.action === 'publish') {
      await stepUp();
      const result = await post<WorkspacePreview>(`/v1/previews/${confirm.id}/publish`, {
        confirmPublic: true
      });
      setOpened(result);
    }
    if (confirm.action === 'restore') {
      await stepUp();
      await post(`${base}/snapshots/${confirm.id}/restore`, { confirmName });
    }
    if (confirm.action === 'delete') {
      if (tool === 'checkpoints') {
        await stepUp();
        await del(`${base}/snapshots/${confirm.id}`);
      } else {
        await del(`/v1/previews/${confirm.id}`);
        if (opened?.id === confirm.id) setOpened(null);
      }
    }
    setConfirm(null);
    setConfirmName('');
  };
  return (
    <div className="stack">
      <div className="row">
        <h3>
          {tool === 'previews'
            ? 'Apps and previews'
            : tool === 'processes'
              ? 'Background work'
              : 'Recovery points'}
        </h3>
        <button className="button" disabled={busy} onClick={() => void run(load)}>
          Refresh
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p className="muted" role="status">
          Working…
        </p>
      )}
      {confirm && (
        <div className="computer-confirm" role="alert">
          <p>
            {confirm.action === 'publish'
              ? 'Publish this preview? Anyone with its address will be able to open it.'
              : confirm.action === 'restore'
                ? 'Restore this recovery point? Current computer files will be replaced. Enter the computer name to continue.'
                : confirm.action === 'stop'
                  ? 'Stop this process? A stopped service will not restart automatically.'
                  : confirm.action === 'rotate'
                    ? 'Reset private links? Existing links to this preview will stop working. A new private link will open here.'
                    : 'Delete this saved item?'}
          </p>
          {confirm.action === 'restore' && (
            <label>
              Computer name: {workspace.name}
              <input
                className="field"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                autoComplete="off"
              />
            </label>
          )}
          <div className="row">
            <button className="button" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="button primary"
              disabled={busy || (confirm.action === 'restore' && confirmName !== workspace.name)}
              onClick={() => void run(executeConfirmation)}
            >
              {confirm.action === 'publish'
                ? 'Publish'
                : confirm.action === 'restore'
                  ? 'Restore computer'
                  : confirm.action === 'stop'
                    ? 'Stop process'
                    : confirm.action === 'rotate'
                      ? 'Reset private links'
                      : 'Delete'}
            </button>
          </div>
        </div>
      )}
      {tool === 'previews' && (
        <>
          <form
            className="computer-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                setOpened(
                  await post<WorkspacePreview>(`${base}/previews`, {
                    label: name,
                    port: Number(port),
                    entryPath: path
                  })
                );
                setName('');
              });
            }}
          >
            <label>
              Name
              <input
                className="field"
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My app"
              />
            </label>
            <label>
              Port
              <input
                className="field"
                required
                type="number"
                min={1024}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </label>
            <label>
              Start path
              <input className="field" value={path} onChange={(e) => setPath(e.target.value)} />
            </label>
            <button className="button primary" disabled={busy}>
              Create private preview
            </button>
          </form>
          <p className="muted">
            Start the app on your computer, then open its listening port here.
          </p>
          {previews.length ? (
            previews.map((preview) => (
              <article className="computer-item" key={preview.id}>
                <div>
                  <strong>{preview.label}</strong>
                  <p className="muted">
                    Port {preview.port} · {preview.visibility} · {preview.status}
                    {preview.expiresAt
                      ? ` · expires ${new Date(preview.expiresAt).toLocaleString()}`
                      : ''}
                  </p>
                </div>
                <div className="row">
                  <button
                    className="button"
                    disabled={busy || preview.status !== 'active'}
                    onClick={() =>
                      void run(async () => {
                        setOpened(
                          await post<WorkspacePreview>(`/v1/previews/${preview.id}/access`)
                        );
                      })
                    }
                  >
                    Open
                  </button>
                  {preview.visibility === 'private' ? (
                    <>
                      <button
                        className="button"
                        disabled={preview.status !== 'active' || busy}
                        onClick={() => setConfirm({ id: preview.id, action: 'publish' })}
                      >
                        Publish
                      </button>
                      <button
                        className="button"
                        disabled={busy || preview.status !== 'active'}
                        onClick={() => setConfirm({ id: preview.id, action: 'rotate' })}
                      >
                        Reset private links
                      </button>
                    </>
                  ) : (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await stepUp();
                          setOpened(
                            await post<WorkspacePreview>(`/v1/previews/${preview.id}/unpublish`)
                          );
                        })
                      }
                    >
                      Make private
                    </button>
                  )}
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => setConfirm({ id: preview.id, action: 'delete' })}
                  >
                    Remove
                  </button>
                </div>
              </article>
            ))
          ) : (
            <p className="empty">No previews yet.</p>
          )}
          {opened && (
            <div className="stack">
              <div className="row">
                <strong>{opened.label}</strong>
                <a
                  className="button"
                  href={previewUrl(opened.url, false)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => {
                    if (!isNativeClient()) return;
                    event.preventDefault();
                    void run(async () => {
                      const { openPreviewBrowser } = await import('../native');
                      await openPreviewBrowser(previewUrl(opened.url, false));
                    });
                  }}
                >
                  Open in new tab ↗
                </a>
                <button className="button" onClick={() => setOpened(null)}>
                  Close preview
                </button>
              </div>
              <iframe
                title={opened.label}
                className="computer-preview"
                src={previewUrl(opened.url)}
                sandbox={`allow-scripts allow-forms allow-modals allow-downloads allow-popups${previewIsolated(opened.url) ? ' allow-same-origin' : ''}`}
                referrerPolicy="no-referrer"
              />
            </div>
          )}
        </>
      )}
      {tool === 'processes' && (
        <>
          {processes.note && <p className="muted">{processes.note}</p>}
          {processes.reachableFromOutsideThisComputer?.length ? (
            <p>
              Reachable from outside this computer:{' '}
              {processes.reachableFromOutsideThisComputer.join(', ')}
            </p>
          ) : null}
          {processes.processes.length ? (
            processes.processes.map((process) => (
              <article className="computer-item stack" key={process.sessionId}>
                <div className="row">
                  <strong>{process.job?.name || process.service?.name || process.sessionId}</strong>
                  <span className="badge">
                    {process.lifetime === 'job'
                      ? 'Long-running job'
                      : process.lifetime === 'service' || process.service
                        ? 'Persistent service'
                        : 'Task process'}
                  </span>
                  <span className="muted">
                    {process.job?.state ?? process.status}
                    {process.exitCode !== undefined ? ` · exit ${process.exitCode}` : ''} ·{' '}
                    {Math.floor(process.ranForMs / 1000)}s
                  </span>
                </div>
                <code className="computer-command">{process.command}</code>
                <p className="muted">
                  Output {bytes(process.outputBytes)}
                  {process.deadlineAt
                    ? ` · stops ${new Date(process.deadlineAt).toLocaleString()}`
                    : process.service
                      ? ' · persistent service'
                      : ''}
                </p>
                {process.job && (
                  <p className="muted">
                    {process.job.state === 'completed'
                      ? 'Finished. This job will not be started again automatically.'
                      : process.job.checkpointResumable
                        ? 'Continues beyond the agent turn. An interrupted run can recover using its declared checkpoint command.'
                        : 'Continues beyond the agent turn. An interrupted run is kept for inspection and will not be restarted blindly.'}
                  </p>
                )}
                {process.service?.listening && (
                  <p className="muted">
                    Listening: {process.service.listening.join(', ') || 'No listening ports'}
                  </p>
                )}
                <div className="row">
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await post<{ stdout?: string; stderr?: string }>(
                          `${base}/processes/${encodeURIComponent(process.sessionId)}`,
                          { action: 'log' }
                        );
                        setLogs((previous) => ({
                          ...previous,
                          [process.sessionId]:
                            `${previous[process.sessionId] ?? ''}${result.stdout ?? ''}${result.stderr ?? ''}`.slice(
                              -100_000
                            )
                        }));
                      })
                    }
                  >
                    Read output
                  </button>
                  {process.job?.state === 'interrupted' && process.job.checkpointResumable && (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await post(
                            `${base}/processes/${encodeURIComponent(process.sessionId)}/resume`,
                            {}
                          );
                        })
                      }
                    >
                      Resume checkpoint
                    </button>
                  )}
                  <button
                    className="button"
                    disabled={
                      busy ||
                      ['completed', 'killed', 'failed', 'timed_out', 'stopped'].includes(
                        process.job?.state ?? process.status
                      )
                    }
                    onClick={() => setConfirm({ id: process.sessionId, action: 'stop' })}
                  >
                    Stop
                  </button>
                </div>
                {logs[process.sessionId] !== undefined && (
                  <pre className="computer-log">
                    {logs[process.sessionId] || 'No output since the last read.'}
                  </pre>
                )}
              </article>
            ))
          ) : (
            <p className="empty">No background processes are reported by this computer.</p>
          )}
          <Computation key={workspace.id} workspaceId={workspace.id} />
          <DebugSessions key={`debug-${workspace.id}`} workspaceId={workspace.id} />
        </>
      )}
      {tool === 'checkpoints' && (
        <>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await stepUp();
                await post(`${base}/snapshots`, { name });
                setName('');
              });
            }}
          >
            <input
              className="field"
              aria-label="Recovery point name"
              placeholder="Name this recovery point"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
            />
            <button className="button primary" disabled={busy}>
              Save recovery point
            </button>
          </form>
          {snapshots.length ? (
            snapshots.map((item) => (
              <article className="computer-item" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <p className="muted">
                    {item.status} · {new Date(item.createdAt).toLocaleString()} ·{' '}
                    {bytes(item.sizeBytes)}
                  </p>
                </div>
                <div className="row">
                  <button
                    className="button"
                    disabled={busy || item.status !== 'ready'}
                    onClick={() => setConfirm({ id: item.id, action: 'restore' })}
                  >
                    Restore…
                  </button>
                  <button
                    className="button"
                    disabled={busy || ['creating', 'deleting'].includes(item.status)}
                    onClick={() => setConfirm({ id: item.id, action: 'delete' })}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))
          ) : (
            <p className="empty">No named recovery points.</p>
          )}
          {task && (
            <section className="stack">
              <div className="row">
                <h3>Latest task checkpoint</h3>
                <button className="button" onClick={() => void inspectRewind()}>
                  Inspect changes
                </button>
              </div>
              {rewindError && (
                <p className="error" role="alert">
                  {rewindError}
                </p>
              )}
              {rewind &&
                (rewind.computer ? (
                  <>
                    <p>
                      A restore would remove {rewind.computer.addedCount} new files, restore{' '}
                      {rewind.computer.modifiedCount} changed files and recover{' '}
                      {rewind.computer.deletedCount} deleted files.
                    </p>
                    <div className="computer-change-list">
                      {(
                        [
                          ['New files to remove', rewind.computer.added],
                          ['Files to restore', rewind.computer.modified],
                          ['Files to recover', rewind.computer.deleted],
                          ['Uncovered files', rewind.computer.uncovered]
                        ] as const
                      ).map(([title, items]) => (
                        <details key={title}>
                          <summary>{title}</summary>
                          <ul>
                            {items.map((item) => (
                              <li key={item.path}>{item.path}</li>
                            ))}
                          </ul>
                        </details>
                      ))}
                    </div>
                    <p className="muted">
                      System software is not rewound. Installed since this point:{' '}
                      {rewind.computer.packagesInstalled
                        .map((item) => `${item.name} ${item.version}`)
                        .join(', ') || 'None reported'}
                      . Removed:{' '}
                      {rewind.computer.packagesRemoved.map((item) => item.name).join(', ') ||
                        'None reported'}
                      .
                    </p>
                    {rewind.computer.truncated && (
                      <p className="muted">
                        The file lists are abbreviated; counts show the full change.
                      </p>
                    )}
                    <p>
                      Use the work’s Activity → Branch / retry to restore this automatic checkpoint.
                    </p>
                  </>
                ) : (
                  <p className="muted">
                    No restorable computer checkpoint is available at this point.
                  </p>
                ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
