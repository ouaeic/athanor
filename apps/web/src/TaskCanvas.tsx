import { lazy, Suspense, useState } from 'react';
import { ArrowUpRight, Check, Download, FileText, Globe, Maximize2, X } from 'lucide-react';
import type { Artifact, TaskPresentation, TaskResult, TaskEvent } from '@athanor/contracts';
import { isNativeClient, post } from './client';
import { resultSnapshot } from './result-snapshot';
import { previewIsolated, previewUrl } from './preview-url';
import { useExpandedView } from './use-expanded-view';
import { Button, ErrorNotice, Spinner } from './ui';
const ResultPreview = lazy(() =>
  import('./computer/ResultPreview').then((module) => ({ default: module.ResultPreview }))
);

export function TaskOutputs({
  presentation,
  events = [],
  artifacts = [],
  onArtifact
}: {
  presentation: TaskPresentation;
  events?: TaskEvent[];
  artifacts?: Artifact[];
  onArtifact: (id: string) => void;
}) {
  const [opened, setOpened] = useState<{ id: string; url: string } | null>(null);
  const {
    ref: stage,
    expanded,
    toggle: toggleExpanded,
    close: closeExpanded
  } = useExpandedView<HTMLElement>();
  const [selectedPreview, setSelectedPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [sharedLink, setSharedLink] = useState<{
    id: string;
    url: string;
    copied: boolean;
  } | null>(null);
  const previews = presentation.results.filter((item) => item.kind === 'preview');
  const preview = previews.find((item) => item.id === selectedPreview) ?? previews[0];
  const files = presentation.results.filter((item) => item.kind !== 'preview');
  const captured = preview ? resultSnapshot(preview, events, presentation.taskId) : null;
  const featured = !preview
    ? artifacts.find((item) =>
        files.some((file) => file.artifactId === item.id && file.status === 'ready')
      )
    : undefined;
  async function resultUrl(result: TaskResult) {
    const url = result.accessPath
      ? (await post<{ url: string }>(result.accessPath, {})).url
      : result.url;
    if (!url) throw new Error('This result does not have an available preview.');
    return previewUrl(url, false);
  }
  async function copyLink(result: TaskResult) {
    setBusy(result.id);
    setError(null);
    setSharedLink(null);
    try {
      const url = await resultUrl(result);
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch {
        // Clipboard permission and activation vary; the signed link remains available to select.
      }
      setSharedLink({ id: result.id, url, copied });
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }
  async function open(result: TaskResult, external = false) {
    // Open synchronously with the owner's click so privacy-token exchange is not a popup blocker.
    const nativeExternal = external && isNativeClient();
    const windowRef = external && !nativeExternal ? window.open('about:blank', '_blank') : null;
    if (windowRef) windowRef.opener = null;
    setBusy(result.id);
    setError(null);
    try {
      const url = await resultUrl(result);
      if (nativeExternal) {
        const { openPreviewBrowser } = await import('./native');
        await openPreviewBrowser(url);
      } else if (windowRef) windowRef.location.replace(previewUrl(url, false));
      else setOpened({ id: result.id, url: previewUrl(url) });
    } catch (cause) {
      windowRef?.close();
      setError(cause);
    } finally {
      setBusy(null);
    }
  }
  const frame = opened && (
    <iframe
      title={preview?.title ?? 'Task preview'}
      src={opened.url}
      sandbox={`allow-scripts allow-forms allow-downloads allow-modals allow-pointer-lock${previewIsolated(opened.url) ? ' allow-same-origin' : ''}`}
      referrerPolicy="no-referrer"
      allow="fullscreen"
      className="garden-preview-frame"
    />
  );
  return (
    <section className="garden-outputs" aria-label="Results and downloads">
      <ErrorNotice error={error} />
      {!presentation.results.length &&
        !presentation.delivery?.pendingJobs &&
        presentation.outputs?.some((output) => output.kind !== 'answer') && (
          <div className="garden-planned-outputs">
            {presentation.outputs
              .filter((output) => output.kind !== 'answer')
              .map((output, index) => (
                <div key={`${output.kind}-${index}`}>
                  {output.kind === 'app' ? <Globe size={22} /> : <FileText size={22} />}
                  <div>
                    <small>Planned {output.kind === 'app' ? 'app' : output.kind}</small>
                    <strong>{output.title}</strong>
                  </div>
                </div>
              ))}
          </div>
        )}
      {presentation.sourceBundle && (
        <div className="garden-source-bundle">
          <a className="button" href={presentation.sourceBundle.downloadUrl} download>
            <Download size={15} /> Download source bundle
          </a>
          <small>
            {presentation.sourceBundle.fileCount == null
              ? 'Project files'
              : `${presentation.sourceBundle.fileCount} recorded output files`}{' '}
            · ZIP
          </small>
        </div>
      )}
      {featured && (
        <article className="garden-output-primary">
          <header className="garden-output-header">
            <div>
              <span className="eyebrow">Made with this work</span>
              <h2>{featured.name}</h2>
            </div>
            <FileText size={22} />
          </header>
          <div className="garden-artifact-view">
            <Suspense fallback={<Spinner label="Opening your result…" />}>
              <ResultPreview artifact={featured} />
            </Suspense>
          </div>
        </article>
      )}
      {previews.length > 1 && (
        <nav className="garden-output-tabs" aria-label="Task previews">
          {previews.map((item) => (
            <Button
              key={item.id}
              aria-pressed={preview?.id === item.id}
              onClick={() => {
                setSelectedPreview(item.id);
                setOpened(null);
              }}
            >
              {item.title}
            </Button>
          ))}
        </nav>
      )}
      {preview && (
        <article className={`garden-output-primary ${expanded ? 'expanded' : ''}`} ref={stage}>
          <header className="garden-output-header">
            <div>
              <span className="eyebrow">
                {preview.status === 'ready' ? 'Ready to open' : 'Preview'}
              </span>
              <h2>{preview.title}</h2>
            </div>
            <Globe size={22} />
          </header>
          <div className="garden-output-actions">
            {preview.status === 'ready' && (
              <>
                <Button
                  className="primary"
                  busy={busy === preview.id}
                  onClick={() => void open(preview, true)}
                >
                  Open in browser
                  <ArrowUpRight size={16} />
                </Button>
                <Button busy={busy === preview.id} onClick={() => void copyLink(preview)}>
                  Copy link
                </Button>
                {!opened ? (
                  <Button busy={busy === preview.id} onClick={() => void open(preview)}>
                    View here
                  </Button>
                ) : (
                  <>
                    <Button onClick={() => void toggleExpanded().catch(setError)}>
                      <Maximize2 size={15} />
                      {expanded ? 'Exit full screen' : 'Expand'}
                    </Button>
                    <Button
                      aria-label="Close embedded preview"
                      onClick={() => {
                        void closeExpanded().catch(setError);
                        setOpened(null);
                      }}
                    >
                      <X size={16} />
                    </Button>
                  </>
                )}
              </>
            )}
            {files[0]?.downloadUrl && files[0].status !== 'unavailable' && (
              <a
                className="button garden-primary-download"
                href={files[0].downloadUrl}
                download={files[0].title}
              >
                <Download size={15} />
                Download {files.length === 1 ? 'source' : 'file'}
              </a>
            )}
            {preview.detail && <p className="muted">{preview.detail}</p>}
          </div>
          {sharedLink?.id === preview.id &&
            (sharedLink.copied ? (
              <p role="status">Link copied.</p>
            ) : (
              <label className="field">
                Copy this link
                <input
                  readOnly
                  value={sharedLink.url}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
            ))}
          {opened?.id === preview.id ? (
            frame
          ) : captured ? (
            <figure className="garden-captured-result">
              <img src={captured.src} alt={`Recorded view of ${preview.title}`} />
              <figcaption>
                Recorded view ·{' '}
                {new Date(captured.createdAt).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short'
                })}
                <span>Open for the live version</span>
              </figcaption>
            </figure>
          ) : (
            <div className="garden-result-map">
              <span className="garden-map-grid" aria-hidden="true" />
              <div className="garden-map-source">
                <FileText size={24} />
                <span>{files[0]?.title ?? 'Your work'}</span>
                {files.length > 1 && <small>+ {files.length - 1} more outputs</small>}
              </div>
              <div className="garden-map-link" aria-hidden="true">
                <span />
                <ArrowUpRight size={18} />
              </div>
              <div className="garden-map-target">
                <Globe size={30} />
                <span>Browser preview</span>
                <small>
                  {preview.status === 'ready'
                    ? 'Available on this computer'
                    : preview.status === 'unknown'
                      ? 'Availability not confirmed'
                      : 'Currently unavailable'}
                </small>
              </div>
            </div>
          )}
        </article>
      )}
      {files.length > 0 && (
        <div className="garden-delivery-list">
          {files.map((item) => (
            <article key={item.id} className="garden-delivery">
              <FileText size={20} />
              <div>
                <strong>{item.title}</strong>
                <small>
                  {item.path?.replace(/^workspace\//, '') ?? item.mimeType ?? 'Artifact'}
                  {item.sizeBytes !== undefined &&
                    ` · ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(item.sizeBytes / 1024)} KB`}
                </small>
                {item.detail && <small>{item.detail}</small>}
              </div>
              {item.artifactId && (
                <Button onClick={() => onArtifact(item.artifactId!)}>View</Button>
              )}
              {item.downloadUrl && item.status !== 'unavailable' && (
                <a className="button" href={item.downloadUrl} download={item.title}>
                  <Download size={15} />
                  <span>Download</span>
                </a>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function TaskProgress({
  presentation,
  onEvidence,
  onPlan
}: {
  presentation: TaskPresentation;
  onEvidence: (id: string) => void;
  onPlan: () => void;
}) {
  const { progress } = presentation;
  const phases = progress.phases;
  const complete = phases.filter((phase) => phase.status === 'completed').length;
  return (
    <aside className="garden-progress" aria-label="Recorded progress">
      <header>
        <span className="eyebrow">The work, as it happens</span>
        {phases.length > 0 && (
          <button
            className="garden-phase-count"
            onClick={onPlan}
            aria-label={`Plan: ${complete} of ${phases.length} steps completed`}
          >
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <circle cx="24" cy="24" r="20" />
              <circle
                className="garden-progress-arc"
                cx="24"
                cy="24"
                r="20"
                pathLength="100"
                strokeDasharray={`${(complete / phases.length) * 100} 100`}
              />
            </svg>
            <span>
              {complete}
              <small>/{phases.length}</small>
            </span>
          </button>
        )}
      </header>
      {progress.current && (
        <div className="garden-now">
          <span className="eyebrow">Now</span>
          <p>{progress.current.title}</p>
        </div>
      )}
      {phases.length > 0 && (
        <ol className="garden-phases">
          {phases.map((phase, index) => (
            <li key={phase.id} data-status={phase.status}>
              <button onClick={onPlan}>
                <span className="garden-phase-dot">
                  {phase.status === 'completed' ? <Check size={12} /> : index + 1}
                </span>
                <span>{phase.title}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {progress.metrics.length > 0 && (
        <dl className="garden-metrics">
          {progress.metrics.map((metric) => (
            <div key={metric.key}>
              <dt>{metric.label}</dt>
              <dd>{metric.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <details className="garden-milestone-disclosure" open>
        <summary>
          Changes & evidence <span>{progress.milestones.length}</span>
        </summary>
        <ol className="garden-milestones">
          {progress.milestones
            .slice(-8)
            .reverse()
            .map((milestone) => (
              <li key={milestone.id} data-status={milestone.status}>
                <button onClick={() => onEvidence(milestone.id)}>
                  <span className="garden-milestone-kind">{milestone.kind}</span>
                  <strong>{milestone.title}</strong>
                  {milestone.detail && <small>{milestone.detail}</small>}
                </button>
              </li>
            ))}
        </ol>
        {!progress.milestones.length && (
          <p className="muted">Recorded changes and checks will appear here.</p>
        )}
      </details>
      {presentation.coverage?.scope === 'recent' && (
        <p className="garden-coverage">
          Showing recent activity. Earlier actions remain in Activity.
        </p>
      )}
    </aside>
  );
}
