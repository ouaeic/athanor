import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  FileText,
  GitBranch,
  History,
  Layers,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Share2,
  Shield,
  Terminal,
  X
} from 'lucide-react';
import type {
  Artifact,
  Task,
  TaskEvent,
  TaskPlan,
  Workspace,
  TaskRewindPreview,
  RewindScope
} from '@athanor/contracts';
import type { Bootstrap, Decision, Draft } from './model';
import {
  activeQuestion,
  data,
  date,
  eventText,
  isFinished,
  isWorking,
  lastEvent,
  money,
  planProgress,
  statusLabel,
  strings,
  surfaceAnswer,
  text
} from './model';
import { get, post, patch } from './client';
import { loadEventPage, subscribeTaskEvents } from './stream';
import type { StreamConnection } from './stream';
import { Button, Dialog, Empty, ErrorNotice, Field, Spinner } from './ui';
import { DecisionCard } from './DecisionQueue';
import { createQuestionAnswerSender } from './task-actions';
import { modeFloors } from './asking-rules';
const Markdown = lazy(() => import('./MarkdownBody'));
const Composer = lazy(() => import('./Composer'));
const Share = lazy(() => import('./Sharing'));
const ResultPreview = lazy(() =>
  import('./computer/ResultPreview').then((module) => ({ default: module.ResultPreview }))
);
export interface TaskSurfaceProps {
  task: Task;
  workspace: Workspace;
  bootstrap: Bootstrap;
  decisions: Decision[];
  draft?: Draft;
  onDraft: (draft: Draft) => void;
  onTask: (task: Task) => void;
  onRefresh: () => void;
  onBack: () => void;
  onComputer: (
    tool: 'files' | 'terminal' | 'browser' | 'desktop' | 'previews' | 'processes' | 'checkpoints'
  ) => void;
}
export default function TaskSurface({
  task,
  workspace,
  bootstrap,
  decisions,
  draft,
  onDraft,
  onTask,
  onRefresh,
  onBack,
  onComputer
}: TaskSurfaceProps) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [plan, setPlan] = useState<TaskPlan | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [preview, setPreview] = useState<Artifact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [connection, setConnection] = useState<StreamConnection>('connecting');
  const [panel, setPanel] = useState<
    'direction' | 'history' | 'plan' | 'settings' | 'share' | 'brief' | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [historyMore, setHistoryMore] = useState(false);
  const [historyPage, setHistoryPage] = useState<TaskEvent[]>([]);
  const [evidence, setEvidence] = useState<TaskEvent | null>(null);
  const [scope, setScope] = useState('');
  const [questionAnswer, setQuestionAnswer] = useState('');
  const [deliverAnswer] = useState(createQuestionAnswerSender);
  const [originalBrief, setOriginalBrief] = useState<TaskEvent | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [branchEvent, setBranchEvent] = useState<TaskEvent | null>(null);
  const onTaskRef = useRef(onTask);
  onTaskRef.current = onTask;
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const options = signal ? { signal } : {};
      const results = await Promise.allSettled([
        get<Task>(`/v1/tasks/${task.id}`, options),
        get<TaskPlan | null>(`/v1/tasks/${task.id}/plan`, options),
        get<Artifact[]>(`/v1/workspaces/${workspace.id}/artifacts`, options)
      ]);
      if (signal?.aborted) return;
      const [nextTask, nextPlan, nextArtifacts] = results;
      if (nextTask.status === 'fulfilled') onTaskRef.current(nextTask.value);
      else setError(nextTask.reason);
      if (nextPlan.status === 'fulfilled') setPlan(nextPlan.value);
      else setError(nextPlan.reason);
      if (nextArtifacts.status === 'fulfilled')
        setArtifacts(nextArtifacts.value.filter((item) => item.taskId === task.id));
      else setError(nextArtifacts.reason);
    },
    [task.id, workspace.id]
  );
  useEffect(() => {
    const controller = new AbortController();
    let unsubscribe: () => void = () => undefined;
    setLoading(true);
    setError(null);
    void Promise.all([
      loadEventPage(task.id, { limit: 250, signal: controller.signal }),
      reload(controller.signal)
    ])
      .then(([page]) => {
        if (controller.signal.aborted) return;
        setEvents(page.events);
        setHistoryPage(page.events);
        setHistoryMore(page.hasMore);
        setLoading(false);
        unsubscribe = subscribeTaskEvents(task.id, {
          after: page.nextCursor,
          signal: controller.signal,
          onEvents: (incoming) => {
            setEvents((current) =>
              Array.from(
                new Map([...current, ...incoming].map((event) => [event.sequence, event])).values()
              )
                .sort((a, b) => a.sequence - b.sequence)
                .slice(-4000)
            );
            if (
              incoming.some((event) =>
                [
                  'completed',
                  'approval_requested',
                  'approval_resolved',
                  'question_asked',
                  'error',
                  'artifact',
                  'plan',
                  'status',
                  'cost'
                ].includes(event.kind)
              )
            ) {
              void reload(controller.signal);
              onRefreshRef.current();
            }
          },
          onConnection: setConnection,
          onError: setError
        });
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setError(err);
          setLoading(false);
        }
      });
    const timer = setInterval(() => {
      void reload(controller.signal);
    }, 15000);
    return () => {
      controller.abort();
      unsubscribe();
      clearInterval(timer);
    };
  }, [task.id, reload, isFinished(task)]);
  const answer = surfaceAnswer(events);
  const completionEvent = lastEvent(events, 'completed');
  const completion = data(completionEvent?.payload);
  const verification = data(completion.verification);
  const question = activeQuestion(events, task);
  const questionData = data(question?.payload);
  const progress = planProgress(plan);
  const taskDecisions = decisions.filter((decision) => decision.taskId === task.id);
  const latestActivity = [...events]
    .reverse()
    .find((event) =>
      ['tool_started', 'status', 'notice', 'warning', 'error', 'assistant_reasoning'].includes(
        event.kind
      )
    );
  const opening =
    originalBrief ??
    (events[0]?.sequence === 1 ? events.find((event) => event.kind === 'user_message') : undefined);
  useEffect(() => {
    if (panel !== 'brief' || opening) return;
    const controller = new AbortController();
    setBriefLoading(true);
    void loadEventPage(task.id, { after: 0, limit: 20, signal: controller.signal })
      .then((page) => {
        if (!controller.signal.aborted)
          setOriginalBrief(page.events.find((event) => event.kind === 'user_message') ?? null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBriefLoading(false);
      });
    return () => controller.abort();
  }, [panel, task.id, opening]);
  const notices = events.filter((event) => ['warning', 'error'].includes(event.kind)).slice(-3);
  async function action(value: 'pause' | 'resume' | 'cancel') {
    setBusy(true);
    setError(null);
    try {
      onTask(await post<Task>(`/v1/tasks/${task.id}/${value}`, {}));
      onRefresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function answerQuestion(value: string) {
    if (!value.trim() || !question) return;
    setBusy(true);
    setError(null);
    try {
      onTask(await deliverAnswer(task.id, question.id, value));
      setQuestionAnswer('');
      onRefresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function older() {
    setBusy(true);
    try {
      const before = historyPage[0]?.sequence;
      const page = await loadEventPage(task.id, { ...(before ? { before } : {}), limit: 250 });
      setHistoryPage(page.events);
      setHistoryMore(page.hasMore);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  function selectedContext() {
    const selection = window.getSelection()?.toString().trim() ?? '';
    setScope(selection.slice(0, 12000));
    setPanel('direction');
  }
  return (
    <section className="work-surface">
      <div className="work-navigation">
        <Button className="quiet-button" onClick={onBack}>
          <ArrowLeft size={16} />
          All work
        </Button>
        <div className="row">
          <span
            className={`connection ${connection}`}
            title={
              connection === 'connected'
                ? 'Live updates connected'
                : connection === 'idle'
                  ? 'Checking for late updates'
                  : connection
            }
          >
            {' '}
            <i />
            {connection === 'connected'
              ? 'Live'
              : connection === 'idle'
                ? 'Up to date'
                : connection === 'closed'
                  ? 'Disconnected'
                  : 'Reconnecting'}
          </span>
          <Button aria-label="Work options" onClick={() => setPanel('settings')}>
            <MoreHorizontal size={19} />
          </Button>
        </div>
      </div>
      <div className="work-heading">
        <div>
          <div className="eyebrow">
            {workspace.name}
            <ChevronRight size={12} /> {statusLabel[task.status]}
          </div>
          <h1>{task.title}</h1>
        </div>
        <div className="work-heading-actions">
          <Button onClick={() => setPanel('share')} aria-label="Share this work">
            <Share2 size={17} />
            <span>Share</span>
          </Button>
          <Button className="primary" onClick={() => setPanel('direction')}>
            <Plus size={17} />
            Add direction
          </Button>
        </div>
      </div>
      <div className="run-summary">
        <div className={`status-line ${isWorking(task) ? 'active' : ''}`}>
          <i />
          <span>{statusLabel[task.status]}</span>
          {task.queuedMessageCount > 0 && (
            <span className="badge">{task.queuedMessageCount} queued</span>
          )}
        </div>
        <div className="row">
          <span className="muted">
            {money(task.spentUsd)}
            {task.maxSpendUsd !== null && ` / ${money(task.maxSpendUsd)}`}
          </span>
          {!isFinished(task) && (
            <Button
              className="quiet-button"
              busy={busy}
              onClick={() =>
                action(['paused', 'awaiting_resource'].includes(task.status) ? 'resume' : 'pause')
              }
            >
              {['paused', 'awaiting_resource'].includes(task.status) ? (
                <Play size={14} />
              ) : (
                <Pause size={14} />
              )}{' '}
              {['paused', 'awaiting_resource'].includes(task.status) ? 'Resume' : 'Pause'}
            </Button>
          )}
        </div>
      </div>
      <ErrorNotice
        error={error}
        onRetry={() => {
          setError(null);
          void reload();
        }}
      />
      {plan && (
        <div className="plan-ribbon">
          <button className="plan-overview" onClick={() => setPanel('plan')}>
            <span className="eyebrow">The plan</span>
            <span>
              {progress.completed} of {progress.total} steps
            </span>
          </button>
          <ol>
            {plan.steps.map((step, index) => (
              <li key={step.id} className={step.status}>
                <button
                  onClick={() => {
                    setScope(`Plan v${plan.version}, step ${index + 1}: ${step.title}`);
                    setPanel('direction');
                  }}
                >
                  <span>
                    {step.status === 'completed' ? (
                      <Check size={13} />
                    ) : (
                      String(index + 1).padStart(2, '0')
                    )}
                  </span>
                  {step.title}
                </button>
              </li>
            ))}
          </ol>
          <Button aria-label="Edit plan" onClick={() => setPanel('plan')}>
            <Layers size={16} />
          </Button>
        </div>
      )}
      {loading ? (
        <Spinner label="Opening this work…" />
      ) : (
        <div className={`work-layout ${taskDecisions.length || question ? 'has-decision' : ''}`}>
          <div className="work-primary">
            {answer.markdown ? (
              <article className="result-surface">
                <div className="result-toolbar">
                  <span className="eyebrow">
                    {answer.partial
                      ? 'Taking shape'
                      : answer.previous
                        ? 'Previous result'
                        : task.status !== 'completed'
                          ? 'Latest update'
                          : completion.interrupted
                            ? 'Unverified answer'
                            : 'The result'}
                  </span>
                  <div className="row">
                    <Button className="quiet-button" onClick={selectedContext}>
                      Shape selection
                      <ArrowUpRight size={14} />
                    </Button>
                    <Button
                      className="quiet-button"
                      onClick={() => navigator.clipboard.writeText(answer.markdown).catch(setError)}
                    >
                      Copy
                    </Button>
                  </div>
                </div>
                <Suspense fallback={<Spinner label="Opening the result…" />}>
                  <Markdown>{answer.markdown}</Markdown>
                </Suspense>
                {answer.partial && (
                  <div className="writing-indicator" role="status">
                    Writing…
                  </div>
                )}
              </article>
            ) : (
              <article className="progress-surface">
                <div className="growth-diagram" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <div className="eyebrow">
                  {isWorking(task) ? 'Work in motion' : statusLabel[task.status]}
                </div>
                <h2>
                  {task.status === 'awaiting_user'
                    ? 'A moment for your judgement.'
                    : task.status === 'paused'
                      ? 'Ready when you are.'
                      : task.status === 'failed'
                        ? 'Let’s find a way forward.'
                        : task.status === 'awaiting_resource'
                          ? 'Waiting for what it needs.'
                          : task.status === 'cancelled'
                            ? 'The work is safely stopped.'
                            : 'Your idea is taking shape.'}
                </h2>
                <p>{latestActivity?.summary || 'The first update will appear here.'}</p>
                {
                  <Button className="quiet-button" onClick={() => setPanel('brief')}>
                    Read your brief
                    <ArrowUpRight size={14} />
                  </Button>
                }
              </article>
            )}
            {completionEvent && (
              <section
                className={`completion-record ${completion.interrupted || verification.status === 'checks_failed' || verification.status === 'checks_did_not_run' ? 'needs-review' : ''}`}
              >
                <div className="row between">
                  <span className="eyebrow">
                    {(lastEvent(events, 'user_message')?.sequence ?? 0) > completionEvent.sequence
                      ? 'Previous completion'
                      : 'Completion record'}
                  </span>
                  <span className="badge">
                    {completion.interrupted
                      ? 'Review needed'
                      : verification.status === 'verified'
                        ? 'Verified'
                        : verification.status === 'not_applicable'
                          ? 'No executable checks needed'
                          : verification.status === 'checks_failed'
                            ? 'Checks failed'
                            : verification.status === 'checks_did_not_run'
                              ? 'Checks did not run'
                              : 'Verification not recorded'}
                  </span>
                </div>
                {text(completion.summary) && <p>{text(completion.summary)}</p>}
                {strings(verification.remainingRisks).length > 0 && (
                  <div className="remaining-risks">
                    <strong>Still to consider</strong>
                    <ul>
                      {strings(verification.remainingRisks).map((risk, index) => (
                        <li key={index}>{risk}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {Array.isArray(verification.evidence) && verification.evidence.length > 0 && (
                  <details>
                    <summary>Evidence and checks</summary>
                    <ul className="evidence-list">
                      {verification.evidence.map((item, index) => {
                        const record = data(item);
                        const call = text(record.toolCallId);
                        const source = events.find(
                          (event) =>
                            text(data(event.payload).toolCallId) === call &&
                            event.kind === 'tool_result'
                        );
                        return (
                          <li key={index}>
                            <span>{text(record.claim)}</span>
                            <small>{text(record.source).replaceAll('_', ' ')}</small>
                            {source && (
                              <Button onClick={() => setEvidence(source)}>Inspect evidence</Button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    {completion.acceptance !== undefined && (
                      <pre>{JSON.stringify(completion.acceptance, null, 2)}</pre>
                    )}
                  </details>
                )}
              </section>
            )}
            {artifacts.length > 0 && (
              <section className="result-shelf">
                <div className="section-heading">
                  <h2>Made with this work</h2>
                  <Button onClick={() => onComputer('files')}>
                    All files
                    <ArrowUpRight size={15} />
                  </Button>
                </div>
                <div className="artifact-grid">
                  {artifacts.map((artifact) => (
                    <button
                      type="button"
                      className="artifact-tile"
                      key={artifact.id}
                      onClick={() => setPreview(artifact)}
                    >
                      <FileText size={24} />
                      <span>{artifact.name}</span>
                      <small>
                        Version {artifact.version} · {artifact.mimeType.split('/').at(-1)}
                      </small>
                      <ArrowUpRight className="artifact-arrow" size={17} />
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
          {(taskDecisions.length > 0 || question) && (
            <aside className="work-attention">
              {taskDecisions.map((decision) => (
                <DecisionCard
                  key={decision.id}
                  decision={decision}
                  onComputer={onComputer}
                  onResolved={() => {
                    onRefresh();
                    void reload();
                  }}
                />
              ))}
              {question && (
                <article className="question-card">
                  <div className="eyebrow">
                    <MessageSquare size={14} />
                    Your judgement
                  </div>
                  <h2>{text(questionData.question, question.summary)}</h2>
                  {text(questionData.why) && <p>{text(questionData.why)}</p>}
                  <div className="stack">
                    {strings(questionData.options).map((option) => (
                      <Button key={option} disabled={busy} onClick={() => answerQuestion(option)}>
                        {option}
                        <ArrowUpRight size={15} />
                      </Button>
                    ))}
                  </div>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void answerQuestion(questionAnswer);
                    }}
                  >
                    <Field label="Your answer">
                      <textarea
                        value={questionAnswer}
                        onChange={(event) => setQuestionAnswer(event.target.value)}
                        rows={3}
                      />
                    </Field>
                    <Button
                      type="submit"
                      className="primary"
                      disabled={!questionAnswer.trim()}
                      busy={busy}
                    >
                      Send answer
                      <ArrowUpRight size={16} />
                    </Button>
                  </form>
                </article>
              )}
            </aside>
          )}
        </div>
      )}
      {notices.length > 0 && (
        <details className="notices">
          <summary>
            {notices.length} recent {notices.length === 1 ? 'notice' : 'notices'}
          </summary>
          {notices.map((event) => (
            <article key={event.id}>
              <strong>{event.summary}</strong>
              <p>{text(data(event.payload).detail)}</p>
              <Button onClick={() => setEvidence(event)}>Inspect</Button>
            </article>
          ))}
        </details>
      )}
      <div className="work-tools">
        <span className="eyebrow">With this work</span>
        <Button onClick={() => onComputer('terminal')}>
          <Terminal size={16} />
          Terminal
        </Button>
        <Button onClick={() => onComputer('browser')}>Browser</Button>
        <Button onClick={() => onComputer('desktop')}>Desktop</Button>
        <Button onClick={() => onComputer('files')}>Files</Button>
        <Button onClick={() => onComputer('previews')}>Previews</Button>
        <Button
          onClick={() => {
            setHistoryPage(events.slice(-250));
            setHistoryMore((events.at(-250)?.sequence ?? events[0]?.sequence ?? 1) > 1);
            setPanel('history');
          }}
        >
          <History size={16} />
          Activity
        </Button>
        <Button onClick={() => setPanel('plan')}>Plan</Button>
      </div>
      {panel === 'direction' && (
        <Dialog
          title="Shape this work"
          onClose={() => {
            setPanel(null);
            setScope('');
          }}
        >
          {scope && (
            <div className="selected-context">
              <span className="eyebrow">Selected context</span>
              <p>{scope}</p>
              <Button onClick={() => setScope('')}>
                <X size={13} />
                Clear selection
              </Button>
            </div>
          )}
          <Suspense fallback={<Spinner />}>
            <Composer
              workspace={workspace}
              task={task}
              bootstrap={bootstrap}
              {...(draft ? { initialDraft: draft } : {})}
              {...(scope ? { scope } : {})}
              onDraft={onDraft}
              onSent={(result) => {
                onTask(result);
                setPanel(null);
                setScope('');
                onRefresh();
              }}
            />
          </Suspense>
        </Dialog>
      )}
      {panel === 'brief' && (
        <Dialog title="Your brief" onClose={() => setPanel(null)}>
          <Suspense fallback={<Spinner />}>
            <Markdown>
              {opening
                ? eventText(opening)
                : briefLoading
                  ? 'Loading your original direction…'
                  : 'No opening direction is available in the first recorded events.'}
            </Markdown>
          </Suspense>
        </Dialog>
      )}
      {panel === 'history' && (
        <Dialog title="Activity and directions" wide onClose={() => setPanel(null)}>
          <div className="row between">
            <p className="muted">The recorded work, with details available at each step.</p>
            {historyMore && (
              <Button busy={busy} onClick={older}>
                Earlier activity
              </Button>
            )}
            <Button
              onClick={() => {
                setHistoryPage(events.slice(-250));
                setHistoryMore((events.at(-250)?.sequence ?? events[0]?.sequence ?? 1) > 1);
              }}
            >
              Latest
            </Button>
          </div>
          <ol className="activity-ledger">
            {historyPage
              .filter((event) => !['assistant_delta', 'assistant_reasoning'].includes(event.kind))
              .map((event) => (
                <li key={event.id}>
                  <span className="activity-kind">{event.kind.replaceAll('_', ' ')}</span>
                  <div>
                    <p>{event.summary}</p>
                    <small className="muted">{date(event.createdAt)}</small>
                    <div className="row">
                      <Button className="quiet-button" onClick={() => setEvidence(event)}>
                        Details
                      </Button>
                      {['user_message', 'assistant_message'].includes(event.kind) && (
                        <Button className="quiet-button" onClick={() => setBranchEvent(event)}>
                          <GitBranch size={13} />
                          Branch / retry
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
          </ol>
        </Dialog>
      )}
      {panel === 'plan' && (
        <Dialog title="The plan" wide onClose={() => setPanel(null)}>
          <PlanEditor
            task={task}
            plan={plan}
            onSaved={(next) => {
              setPlan(next);
              onRefresh();
            }}
          />
        </Dialog>
      )}
      {panel === 'settings' && (
        <Dialog title="Work options" onClose={() => setPanel(null)}>
          <TaskOptions task={task} onTask={onTask} onRefresh={onRefresh} />
          {!isFinished(task) && (
            <Button busy={busy} onClick={() => action('cancel')}>
              Stop this work
            </Button>
          )}
          <p className="muted">
            Stopping preserves its files and history. Send another direction to continue later.
          </p>
          <Button
            onClick={() => {
              const event = [...events]
                .reverse()
                .find((item) => ['assistant_message', 'user_message'].includes(item.kind));
              if (event) setBranchEvent(event);
            }}
          >
            <GitBranch size={16} />
            Branch from latest message
          </Button>
        </Dialog>
      )}
      {panel === 'share' && (
        <Dialog title="Share a snapshot" wide onClose={() => setPanel(null)}>
          <Suspense fallback={<Spinner />}>
            <Share task={task} artifacts={artifacts} onChange={onRefresh} />
          </Suspense>
        </Dialog>
      )}
      {evidence && (
        <Dialog title={evidence.kind.replaceAll('_', ' ')} wide onClose={() => setEvidence(null)}>
          <h3>{evidence.summary}</h3>
          {['assistant_message', 'user_message'].includes(evidence.kind) ? (
            <Suspense fallback={<Spinner />}>
              <Markdown>{eventText(evidence)}</Markdown>
            </Suspense>
          ) : (
            <pre>{JSON.stringify(evidence.payload, null, 2)}</pre>
          )}
        </Dialog>
      )}
      {preview && (
        <Dialog title={preview.name} onClose={() => setPreview(null)}>
          <Suspense fallback={<Spinner label="Opening result" />}>
            <ResultPreview key={preview.id} artifact={preview} />
          </Suspense>
          <Button
            onClick={() => {
              setPreview(null);
              onComputer('files');
            }}
          >
            Open files and download
            <ArrowUpRight size={15} />
          </Button>
        </Dialog>
      )}
      {branchEvent && (
        <Dialog title="Continue from this point" wide onClose={() => setBranchEvent(null)}>
          <Trajectory
            task={task}
            event={branchEvent}
            onCreated={(result) => {
              setBranchEvent(null);
              setPanel(null);
              onTask(result);
              onRefresh();
            }}
          />
        </Dialog>
      )}
    </section>
  );
}
function PlanEditor({
  task,
  plan,
  onSaved
}: {
  task: Task;
  plan: TaskPlan | null;
  onSaved: (plan: TaskPlan) => void;
}) {
  const [steps, setSteps] = useState(plan?.steps ?? []);
  const [name, setName] = useState(plan?.branchName ?? 'Main');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<TaskPlan[]>([]);
  useEffect(() => {
    void get<TaskPlan[]>(`/v1/tasks/${task.id}/plans`).then(setVersions).catch(setError);
  }, [task.id]);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = await post<TaskPlan>(`/v1/tasks/${task.id}/plan`, {
        expectedVersion: plan?.version ?? 0,
        branchName: name,
        steps
      });
      onSaved(result);
      setVersions((current) => [result, ...current]);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <Field label="Plan name">
        <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
      </Field>
      {steps.map((step, index) => (
        <div className="plan-editor-step" key={step.id}>
          <label className="sr-only" htmlFor={`step-${step.id}`}>
            Step {index + 1}
          </label>
          <input
            id={`step-${step.id}`}
            value={step.title}
            maxLength={240}
            onChange={(event) =>
              setSteps((current) =>
                current.map((item) =>
                  item.id === step.id ? { ...item, title: event.target.value } : item
                )
              )
            }
          />
          <select
            aria-label={`Step ${index + 1} status`}
            value={step.status}
            onChange={(event) =>
              setSteps((current) =>
                current.map((item) =>
                  item.id === step.id
                    ? { ...item, status: event.target.value as typeof step.status }
                    : item
                )
              )
            }
          >
            {['pending', 'in_progress', 'completed', 'skipped'].map((status) => (
              <option key={status} value={status}>
                {status.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
          <Button
            aria-label={`Remove step ${index + 1}`}
            onClick={() => setSteps((current) => current.filter((item) => item.id !== step.id))}
          >
            <X size={16} />
          </Button>
        </div>
      ))}
      {!steps.length && (
        <Empty title="No plan yet">You or the agent can set a plan for this work.</Empty>
      )}
      <div className="row">
        <Button
          disabled={steps.length >= 30}
          onClick={() =>
            setSteps((current) => [
              ...current,
              { id: crypto.randomUUID(), title: '', status: 'pending' }
            ])
          }
        >
          <Plus size={15} />
          Add step
        </Button>
        <Button
          className="primary"
          busy={busy}
          disabled={!steps.length || steps.some((step) => !step.title.trim())}
          onClick={save}
        >
          Save plan
        </Button>
      </div>
      <ErrorNotice error={error} />
      {versions.length > 0 && (
        <details>
          <summary>Earlier plan versions</summary>
          {versions.map((version) => (
            <article key={version.id}>
              <h3>
                {version.branchName} · v{version.version}
              </h3>
              <p className="muted">
                {date(version.createdAt)} · {version.createdBy}
              </p>
              <ol>
                {version.steps.map((step) => (
                  <li key={step.id}>
                    {step.title} · {step.status.replaceAll('_', ' ')}
                  </li>
                ))}
              </ol>
              <Button
                onClick={() => {
                  setSteps(version.steps);
                  setName(version.branchName);
                }}
              >
                Use these steps as a new version
              </Button>
            </article>
          ))}
        </details>
      )}
    </div>
  );
}
function TaskOptions({
  task,
  onTask,
  onRefresh
}: {
  task: Task;
  onTask: (task: Task) => void;
  onRefresh: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function change(body: Record<string, unknown>, suffix = '') {
    setBusy(true);
    setError(null);
    try {
      onTask(await patch<Task>(`/v1/tasks/${task.id}${suffix}`, body));
      onRefresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          void change({ title });
        }}
      >
        <Field label="Work title">
          <input value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Button type="submit" busy={busy}>
          Rename
        </Button>
      </form>
      <Field label="How much should it ask?">
        <select
          value={task.securityMode}
          disabled={busy}
          onChange={(event) => change({ securityMode: event.target.value }, '/security-mode')}
        >
          <option value="review">Review</option>
          <option value="balanced">Balanced</option>
          <option value="autonomous">Autonomous</option>
        </select>
      </Field>
      <p className="mode-floor">
        <Shield size={16} />
        {modeFloors[task.securityMode]}
      </p>
      <dl className="facts">
        <div>
          <dt>Model</dt>
          <dd>{task.modelId}</dd>
        </div>
        <div>
          <dt>Privacy</dt>
          <dd>
            {task.privacyRoute === 'provider_zdr' ? 'Zero data retention' : 'External provider'}
          </dd>
        </div>
        <div>
          <dt>Spend</dt>
          <dd>{money(task.spentUsd)}</dd>
        </div>
      </dl>
      <div className="row">
        <Button disabled={busy} onClick={() => change({ pinned: !task.pinned })}>
          {task.pinned ? 'Unpin' : 'Pin this work'}
        </Button>
        <Button disabled={busy} onClick={() => change({ archived: !task.archivedAt })}>
          {task.archivedAt ? 'Restore to work' : 'Archive'}
        </Button>
      </div>
      <ErrorNotice error={error} />
    </div>
  );
}
function Trajectory({
  task,
  event,
  onCreated
}: {
  task: Task;
  event: TaskEvent;
  onCreated: (task: Task) => void;
}) {
  const [preview, setPreview] = useState<TaskRewindPreview | null>(null);
  const [operation, setOperation] = useState<'branch' | 'edit' | 'retry'>('branch');
  const [rewind, setRewind] = useState<RewindScope>('conversation');
  const [prompt, setPrompt] = useState(eventText(event));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    void get<TaskRewindPreview>(`/v1/tasks/${task.id}/rewind-preview?eventId=${event.id}`)
      .then(setPreview)
      .catch(setError);
  }, [task.id, event.id]);
  async function create() {
    setBusy(true);
    setError(null);
    try {
      const result = await post<Task>(`/v1/tasks/${task.id}/trajectory`, {
        operation,
        eventId: event.id,
        rewind,
        ...(rewind !== 'conversation' && preview?.checkpoint
          ? { checkpointId: preview.checkpoint.id }
          : {}),
        ...(operation === 'edit' ? { prompt } : {}),
        ...(operation !== 'branch' ? { stopSource: true } : {})
      });
      onCreated(result);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <p>{event.summary}</p>
      <Field label="Continue with">
        <select
          value={operation}
          onChange={(e) => setOperation(e.target.value as typeof operation)}
        >
          <option value="branch">Branch into separate work</option>
          {event.kind === 'user_message' && (
            <option value="edit">Edit this direction and retry</option>
          )}
          <option value="retry">Retry from this point</option>
        </select>
      </Field>
      {operation === 'edit' && (
        <Field label="Revised direction">
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} />
        </Field>
      )}
      <Field label="Restore">
        <select value={rewind} onChange={(e) => setRewind(e.target.value as RewindScope)}>
          <option value="conversation">Conversation only · leave files as they are</option>
          <option value="computer" disabled={!preview?.checkpoint}>
            Computer only
          </option>
          <option value="both" disabled={!preview?.checkpoint}>
            Conversation and computer
          </option>
        </select>
      </Field>
      {preview && (
        <p>
          {preview.droppedEventCount} later events stay in the source work.{' '}
          {operation !== 'branch' && 'The source run will stop when this retry begins.'}
        </p>
      )}
      {rewind !== 'conversation' && preview?.computer && (
        <details open>
          <summary>Changes to your computer</summary>
          <pre>{JSON.stringify(preview.computer, null, 2)}</pre>
        </details>
      )}
      <ErrorNotice error={error} />
      <Button
        className="primary"
        disabled={!preview || (operation === 'edit' && !prompt.trim())}
        busy={busy}
        onClick={create}
      >
        Create {operation === 'branch' ? 'branch' : 'retry'}
        <GitBranch size={16} />
      </Button>
    </div>
  );
}
