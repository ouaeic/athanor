import { useEffect, useState } from 'react';
import type { Artifact, ShareRecord, Task, TaskPage, Workspace } from '@athanor/contracts';
import { del, get, patch } from '../client.js';
import { Button, Dialog, Field } from '../ui.js';
import {
  ActionFeedback,
  ConfirmButton,
  ResourceState,
  Section,
  download,
  fieldValue,
  useAction,
  useResource
} from '../management.js';
import { bytes, date, statusLabel } from '../model.js';
import { ResultPreview } from '../computer/ResultPreview.js';

interface SearchHit {
  taskId: string;
  workspaceId: string;
  title: string;
  excerpt: string;
  updatedAt: string;
}
export function ResultsLibrary({
  workspace,
  onOpenTask,
  onChange,
  onTaskDeleted
}: {
  workspace: Workspace | null;
  onOpenTask: (id: string) => void;
  onChange: () => void;
  onTaskDeleted: (id: string) => void;
}) {
  const artifacts = useResource<Artifact[]>(
    workspace ? `/v1/workspaces/${workspace.id}/artifacts` : null
  );
  const [include, setInclude] = useState('active');
  const taskPath = `/v1/tasks?limit=50&include=${include}${workspace ? `&workspaceId=${workspace.id}` : ''}`;
  const tasks = useResource<TaskPage>(taskPath);
  const [more, setMore] = useState<Task[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const search = useResource<SearchHit[]>(
    searched
      ? `/v1/search?q=${encodeURIComponent(searched)}${workspace ? `&workspaceId=${workspace.id}` : ''}`
      : null
  );
  const shares = useResource<ShareRecord[]>('/v1/shares');
  const [editing, setEditing] = useState<Task | null>(null);
  const [preview, setPreview] = useState<Artifact | null>(null);
  const action = useAction();
  useEffect(() => {
    setMore([]);
    setCursor(tasks.value?.nextCursor ?? null);
  }, [tasks.value]);
  const refresh = () => {
    tasks.refresh();
    artifacts.refresh();
    shares.refresh();
    onChange();
  };
  return (
    <>
      <Section
        title="Saved results"
        description={
          workspace
            ? `Files published from ${workspace.name}, with their own preserved versions.`
            : 'Select a workspace to see its saved files.'
        }
      >
        <ResourceState resource={artifacts} />
        {artifacts.value?.length === 0 && (
          <p className="empty">Finished documents, images and other useful files will live here.</p>
        )}
        <div className="library-results">
          {artifacts.value?.map((artifact) => (
            <article className="library-result" key={artifact.id}>
              {/^image\/(png|jpeg|gif|webp|avif)$/.test(artifact.mimeType) ? (
                <img
                  className="library-art"
                  loading="lazy"
                  src={`/v1/artifacts/${artifact.id}/content`}
                  alt={artifact.name}
                />
              ) : (
                <div className="library-file-icon" aria-hidden="true">
                  {artifact.name.split('.').at(-1)?.slice(0, 5).toUpperCase() || 'FILE'}
                </div>
              )}
              <div className="library-result-body">
                <h4>{artifact.name}</h4>
                <p className="muted management-metadata">
                  Version {artifact.version} · {bytes(artifact.sizeBytes)}
                  <br />
                  {date(artifact.createdAt)}
                </p>
                <div className="management-actions">
                  <Button onClick={() => setPreview(artifact)}>Open</Button>
                  <Button
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        () => download(`/v1/artifacts/${artifact.id}/content`, artifact.name),
                        'Download started'
                      )
                    }
                  >
                    Download
                  </Button>
                  {artifact.taskId && (
                    <Button onClick={() => onOpenTask(artifact.taskId!)}>View work</Button>
                  )}
                  <ConfirmButton
                    label="Delete"
                    description={`Delete saved result “${artifact.name}”, version ${artifact.version}. This removes its published copy.`}
                    action={async () => {
                      await del(`/v1/artifacts/${artifact.id}`);
                      artifacts.refresh();
                    }}
                  />
                </div>
              </div>
            </article>
          ))}
        </div>
        <ActionFeedback action={action} />
      </Section>
      {preview && (
        <Dialog title={preview.name} wide onClose={() => setPreview(null)}>
          <ResultPreview artifact={preview} />
          <Button
            busy={action.busy}
            onClick={() =>
              void action.run(
                () => download(`/v1/artifacts/${preview.id}/content`, preview.name),
                'Download started'
              )
            }
          >
            Download
          </Button>
          <ActionFeedback action={action} />
        </Dialog>
      )}
      <Section title="Find your work">
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            setSearched(query.trim());
          }}
        >
          <Field label="Search titles and remembered conversation content">
            <input
              type="search"
              minLength={2}
              maxLength={500}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="An idea, a phrase, a project…"
            />
          </Field>
          <Button type="submit" disabled={query.trim().length < 2}>
            Search
          </Button>
          {searched && (
            <Button
              onClick={() => {
                setSearched('');
                setQuery('');
              }}
            >
              Clear
            </Button>
          )}
        </form>
        {searched ? (
          <>
            <ResourceState resource={search} />
            {search.value?.map((hit) => (
              <article className="management-item" key={hit.taskId}>
                <div>
                  <button
                    type="button"
                    className="library-task-title"
                    onClick={() => onOpenTask(hit.taskId)}
                  >
                    {hit.title}
                  </button>
                  <p className="muted">{hit.excerpt}</p>
                  <p className="management-metadata muted">{date(hit.updatedAt)}</p>
                </div>
              </article>
            ))}
            {search.value?.length === 0 && (
              <p className="empty">No matching work. Try words you remember using.</p>
            )}
          </>
        ) : (
          <>
            <div className="library-view-toggle management-filter">
              {['active', 'archived', 'all'].map((value) => (
                <Button
                  key={value}
                  aria-pressed={include === value}
                  onClick={() => setInclude(value)}
                >
                  {value === 'active' ? 'Current' : value === 'archived' ? 'Archived' : 'All work'}
                </Button>
              ))}
            </div>
            <ResourceState resource={tasks} />
            {[...(tasks.value?.tasks ?? []), ...more].map((task) => (
              <article className="management-item" key={task.id}>
                <div>
                  <button
                    type="button"
                    className="library-task-title"
                    onClick={() => onOpenTask(task.id)}
                  >
                    {task.title}
                  </button>
                  <p className="muted management-metadata">
                    {statusLabel[task.status]} · {date(task.updatedAt)}
                    {task.scheduleId ? ' · scheduled run' : ''}
                    {task.pinned ? ' · pinned' : ''}
                  </p>
                </div>
                <div className="row">
                  <Button onClick={() => setEditing(task)}>Rename</Button>
                  <Button
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        async () => {
                          await patch(`/v1/tasks/${task.id}`, { pinned: !task.pinned });
                          refresh();
                        },
                        task.pinned ? 'Unpinned' : 'Pinned'
                      )
                    }
                  >
                    {task.pinned ? 'Unpin' : 'Pin'}
                  </Button>
                  <Button
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        async () => {
                          await patch(`/v1/tasks/${task.id}`, { archived: !task.archivedAt });
                          refresh();
                        },
                        task.archivedAt ? 'Restored' : 'Archived'
                      )
                    }
                  >
                    {task.archivedAt ? 'Restore' : 'Archive'}
                  </Button>
                  <ConfirmButton
                    label="Delete"
                    description={`Delete “${task.title}” and its conversation records. Archive it instead if you may want it later.`}
                    action={async () => {
                      await del(`/v1/tasks/${task.id}`);
                      onTaskDeleted(task.id);
                      refresh();
                    }}
                  />
                </div>
              </article>
            ))}
            {tasks.value?.tasks.length === 0 && <p className="empty">No work in this view.</p>}
            {cursor && (
              <Button
                busy={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    const page = await get<TaskPage>(
                      `${taskPath}&cursor=${encodeURIComponent(cursor)}`
                    );
                    setMore((value) => [
                      ...value,
                      ...page.tasks.filter((task) => !value.some((held) => held.id === task.id))
                    ]);
                    setCursor(page.nextCursor);
                  }, 'Older work loaded')
                }
              >
                Load older work
              </Button>
            )}
          </>
        )}
        <ActionFeedback action={action} />
      </Section>
      <Section
        title="Shared snapshots"
        description="Each link preserves a chosen version of the work."
      >
        <ResourceState resource={shares} />
        {shares.value?.map((share) => (
          <div className="management-item" key={share.id}>
            <div>
              <button
                type="button"
                className="library-task-title"
                onClick={() => onOpenTask(share.taskId)}
              >
                Open shared work
              </button>
              <p className="muted">
                Version {share.version} · {share.viewCount} views ·{' '}
                {share.revokedAt
                  ? 'Revoked'
                  : share.expiresAt
                    ? `expires ${date(share.expiresAt)}`
                    : 'No expiry'}
              </p>
              <p className="management-metadata muted">Created {date(share.createdAt)}</p>
            </div>
            {!share.revokedAt && (
              <ConfirmButton
                label="Revoke link"
                description="Readers will no longer be able to open this snapshot through its link. Previously downloaded copies are unaffected."
                action={async () => {
                  await del(`/v1/shares/${share.id}`);
                  shares.refresh();
                  onChange();
                }}
              />
            )}
          </div>
        ))}
        {shares.value?.length === 0 && (
          <p className="empty">Share a result from its work surface to create a snapshot.</p>
        )}
      </Section>
      {editing && (
        <Dialog title="Rename work" onClose={() => setEditing(null)}>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void action.run(async () => {
                await patch(`/v1/tasks/${editing.id}`, { title: fieldValue(form, 'title') });
                setEditing(null);
                refresh();
              }, 'Renamed');
            }}
          >
            <Field label="Title">
              <input required name="title" maxLength={160} defaultValue={editing.title} />
            </Field>
            <Button type="submit" className="primary" busy={action.busy}>
              Save title
            </Button>
            <ActionFeedback action={action} />
          </form>
        </Dialog>
      )}
    </>
  );
}
