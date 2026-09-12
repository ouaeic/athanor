import { recoverDeviceDrafts, forgetDraftKey } from './draft-storage';
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowUpRight,
  Bell,
  Check,
  Command,
  FileText,
  FolderOpen,
  Grid2X2,
  Gauge,
  HardDrive,
  MemoryStick,
  PanelLeft,
  X,
  Sparkles,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings2,
  Sun
} from 'lucide-react';
import type { Artifact, Task, TaskPage, Workspace } from '@athanor/contracts';
import { get, ApiError, post, isNativeClient } from './client';
import type { NativeStatus } from './native';
import { createTaskNotifier } from './native-notices';
import { subscribeWorkerNavigation } from './worker-navigation';
import { devSignIn, enroll, recover, register, signIn } from './auth';
import type { AuthResult } from './auth';
import type { Bootstrap, Decision, Draft } from './model';
import {
  hasOngoingWork,
  needsAttention,
  money,
  bytes,
  shortDate,
  taskStatusLabel,
  mergeTaskRefresh
} from './model';
import { Button, Dialog, Empty, ErrorNotice, Field, Spinner } from './ui';
import DecisionQueue from './DecisionQueue';
import { ProjectLink } from './ProjectLink';
import './styles.css';
import './garden.css';
const Composer = lazy(() => import('./Composer'));
const TaskSurface = lazy(() => import('./TaskSurface'));
const Computer = lazy(() => import('./Computer'));
const Library = lazy(() => import('./Library'));
const Settings = lazy(() => import('./Settings'));
const NativeSetup = lazy(() => import('./NativeSetup'));
export type View = 'work' | 'library' | 'computer' | 'settings' | 'attention';
type Tool = 'files' | 'terminal' | 'browser' | 'desktop' | 'previews' | 'processes' | 'checkpoints';
function initialNavigation() {
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  return {
    taskId: params.get('task'),
    view: (['work', 'library', 'computer', 'settings', 'attention'].includes(view ?? '')
      ? view
      : 'work') as View
  };
}
function initialTheme() {
  try {
    return localStorage.getItem('athanor-theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    return this.state.error ? (
      <main className="boundary">
        <h1>This view needs to reopen.</h1>
        <p>Your work continues on your computer.</p>
        <ErrorNotice error={this.state.error} />
        <Button onClick={() => location.reload()}>Reopen workspace</Button>
      </main>
    ) : (
      this.props.children
    );
  }
}
export default function App() {
  return (
    <Boundary>
      <WorkspaceApp />
      <Suspense fallback={null}>
        <NativeAuthorizationPortal />
      </Suspense>
    </Boundary>
  );
}
const NativeAuthorizationPortal = lazy(() => import('./NativeAuthorization'));
function WorkspaceApp() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [nativeState, setNativeState] = useState<NativeStatus | null>(null);
  const [nativePairingCode, setNativePairingCode] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [navigation, setNavigation] = useState(initialNavigation);
  const [workspaceId, setWorkspaceId] = useState('');
  const [taskWorkspaces, setTaskWorkspaces] = useState<{
    ownerId: string;
    values: Record<string, Workspace>;
  }>({ ownerId: '', values: {} });
  const [theme, setTheme] = useState(initialTheme);
  const [mobile, setMobile] = useState(() => window.innerWidth <= 760);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return window.innerWidth > 760 && localStorage.getItem('garden-sidebar') !== 'closed';
    } catch {
      return window.innerWidth > 760;
    }
  });
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const resize = () => {
      setMobile(query.matches);
      if (query.matches) setSidebarOpen(false);
    };
    query.addEventListener('change', resize);
    return () => query.removeEventListener('change', resize);
  }, []);
  useEffect(() => {
    if (!mobile || !sidebarOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSidebarOpen(false);
        document.querySelector<HTMLButtonElement>('[aria-controls="garden-sidebar"]')?.focus();
      }
      if (event.key === 'Tab') {
        const items = [
          ...document.querySelectorAll<HTMLElement>(
            '#garden-sidebar button:not(:disabled), #garden-sidebar input, #garden-sidebar a[href]'
          )
        ].filter((item) => item.getClientRects().length > 0);
        const next = event.shiftKey ? items.at(-1) : items[0];
        const boundary = event.shiftKey ? items[0] : items.at(-1);
        if (
          next &&
          (document.activeElement === boundary ||
            !items.includes(document.activeElement as HTMLElement))
        ) {
          event.preventDefault();
          next.focus();
        }
      }
    };
    document.addEventListener('keydown', close);
    document.querySelector<HTMLButtonElement>('.garden-sidebar-close')?.focus();
    return () => document.removeEventListener('keydown', close);
  }, [mobile, sidebarOpen]);
  function toggleSidebar() {
    setSidebarOpen((current) => {
      try {
        localStorage.setItem('garden-sidebar', current ? 'closed' : 'open');
      } catch {
        /* Storage is optional. */
      }
      return !current;
    });
  }
  const [newWork, setNewWork] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [tool, setTool] = useState<Tool>('files');
  const [computerOpened, setComputerOpened] = useState(initialNavigation().view === 'computer');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [filter, setFilter] = useState<'active' | 'running' | 'complete' | 'archived'>('active');
  const [search, setSearch] = useState('');
  const [moreBusy, setMoreBusy] = useState(false);
  const [archivedCursor, setArchivedCursor] = useState<string | null>(null);
  const activePaged = useRef(false);
  const deletedTasks = useRef(new Set<string>());
  const [offline, setOffline] = useState(!navigator.onLine);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bootstrapRef = useRef(bootstrap);
  const taskNotifier = useRef(createTaskNotifier());
  bootstrapRef.current = bootstrap;
  const refresh = useCallback(async () => {
    try {
      const result = await get<Bootstrap>('/v1/bootstrap');
      let draftError: unknown = null;
      try {
        const recovered = await recoverDeviceDrafts(result.user.id);
        const merged = new Map(
          result.drafts.map((draft) => [draft.taskId ?? `new:${draft.workspaceId}`, draft])
        );
        for (const draft of recovered)
          merged.set(draft.taskId ?? `new:${draft.workspaceId}`, draft);
        result.drafts = [...merged.values()];
      } catch (cause) {
        draftError = cause;
      }
      void taskNotifier.current.update(result.tasks);
      setBootstrap((current) =>
        mergeTaskRefresh(current, result, activePaged.current, deletedTasks.current)
      );
      setAuthRequired(false);
      setError(draftError);
      setWorkspaceId((current) =>
        result.workspaces.some((workspace) => workspace.id === current)
          ? current
          : (result.workspaces[0]?.id ?? '')
      );
      setDrafts((current) => {
        const merged = { ...current };
        for (const draft of result.drafts) {
          const key = draft.taskId ?? `new:${draft.workspaceId}`;
          if (!merged[key]) merged[key] = draft;
        }
        return merged;
      });
    } catch (err) {
      if (
        err instanceof ApiError &&
        ['authentication_required', 'session_expired', 'invalid_session'].includes(err.code)
      ) {
        forgetDraftKey();
        setAuthRequired(true);
      } else setError(err);
    } finally {
      setLoading(false);
    }
  }, []);
  const refreshDecisions = useCallback(async () => {
    try {
      setDecisions(await get<Decision[]>('/v1/approvals'));
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) setError(err);
    }
  }, []);
  const requestRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
      void refreshDecisions();
    }, 400);
  }, [refresh, refreshDecisions]);
  useEffect(() => {
    window.addEventListener('garden-draft-policy', requestRefresh);
    return () => window.removeEventListener('garden-draft-policy', requestRefresh);
  }, [requestRefresh]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        if (isNativeClient()) {
          const native = await import('./native');
          const status = await native.nativeStatus();
          if (!alive) return;
          setNativeState(status);
          if (status && !status.connected) {
            setLoading(false);
            return;
          }
          const details = await native.nativeBootstrap();
          if (!alive) return;
          setNativePairingCode(details.pairingCode ?? '');
        }
        await refresh();
      } catch (cause) {
        if (alive) {
          setError(cause);
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refresh]);
  useEffect(() => {
    if (!bootstrap) return;
    void refreshDecisions();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refresh();
        void refreshDecisions();
      }
    }, 15000);
    return () => clearInterval(timer);
  }, [Boolean(bootstrap), refresh, refreshDecisions]);
  useEffect(() => {
    if (!workspaceId || !bootstrap) return;
    const controller = new AbortController();
    void get<Artifact[]>(`/v1/workspaces/${workspaceId}/artifacts`, { signal: controller.signal })
      .then(setArtifacts)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err);
      });
    return () => controller.abort();
  }, [workspaceId, bootstrap?.tasks.map((task) => `${task.id}:${task.updatedAt}`).join('|')]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem('athanor-theme', theme);
    } catch {
      /* Appearance remains available without storage. */
    }
  }, [theme]);
  useEffect(() => {
    const online = () => {
      setOffline(false);
      requestRefresh();
    };
    const offline = () => setOffline(true);
    const visible = () => {
      if (document.visibilityState === 'visible') requestRefresh();
    };
    const pop = () => {
      const next = initialNavigation();
      if (next.view === 'computer') setComputerOpened(true);
      setNavigation(next);
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('popstate', pop);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('popstate', pop);
    };
  }, [requestRefresh]);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    return subscribeWorkerNavigation(
      navigator.serviceWorker,
      location.origin,
      (taskId) => (taskId ? openTask(taskId) : navigate('work')),
      requestRefresh
    );
  }, [requestRefresh]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((current) => !current);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setNewWork(true);
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (
      !navigation.taskId ||
      !bootstrap ||
      bootstrap.tasks.some((task) => task.id === navigation.taskId)
    )
      return;
    const controller = new AbortController();
    void get<Task>(`/v1/tasks/${navigation.taskId}`, { signal: controller.signal })
      .then((task) => {
        if (controller.signal.aborted) return;
        setBootstrap((current) =>
          current ? { ...current, tasks: [task, ...current.tasks] } : current
        );
        if (
          bootstrap.workspaces.some(
            (workspace) => workspace.id === (task.parentWorkspaceId ?? task.workspaceId)
          )
        )
          setWorkspaceId(task.parentWorkspaceId ?? task.workspaceId);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err);
      });
    return () => controller.abort();
  }, [navigation.taskId, bootstrap?.tasks.some((task) => task.id === navigation.taskId)]);
  useEffect(() => {
    if (!workspaceId || !bootstrap || authRequired) return;
    const heartbeat = () => {
      void post(`/v1/workspaces/${workspaceId}/heartbeat`, {}).catch(() => undefined);
    };
    heartbeat();
    const timer = setInterval(heartbeat, 60000);
    return () => clearInterval(timer);
  }, [workspaceId, Boolean(bootstrap), authRequired]);
  function navigate(view: View, taskId: string | null = null) {
    if (mobile) setSidebarOpen(false);
    if (view === 'computer') setComputerOpened(true);
    setNavigation({ view, taskId });
    const params = new URLSearchParams();
    if (taskId) params.set('task', taskId);
    if (view !== 'work') params.set('view', view);
    history.pushState({}, '', `${location.pathname}${params.size ? '?' + params.toString() : ''}`);
    document.getElementById('main')?.scrollTo({ top: 0, behavior: 'instant' });
  }
  const workspace =
    bootstrap?.workspaces.find((item) => item.id === workspaceId) ??
    bootstrap?.workspaces[0] ??
    null;
  const task = bootstrap?.tasks.find((item) => item.id === navigation.taskId) ?? null;
  const taskWorkspace =
    bootstrap?.workspaces.find((item) => item.id === task?.workspaceId) ??
    (task && taskWorkspaces.ownerId === bootstrap?.user.id
      ? taskWorkspaces.values[task.workspaceId]
      : null);
  const computerWorkspace = navigation.taskId ? (taskWorkspace ?? null) : workspace;
  useEffect(() => {
    const ownerId = bootstrap?.user.id;
    if (!task || taskWorkspace || !ownerId) return;
    const controller = new AbortController();
    void get<Workspace>(`/v1/workspaces/${task.workspaceId}`, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted || bootstrapRef.current?.user.id !== ownerId) return;
        setTaskWorkspaces((current) => ({
          ownerId,
          values: { ...(current.ownerId === ownerId ? current.values : {}), [value.id]: value }
        }));
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [task?.workspaceId, taskWorkspace?.id, bootstrap?.user.id]);
  function openTask(id: string) {
    if (window.innerWidth <= 760) setSidebarOpen(false);
    const target = bootstrapRef.current?.tasks.find((item) => item.id === id);
    if (
      target &&
      bootstrapRef.current?.workspaces.some(
        (item) => item.id === (target.parentWorkspaceId ?? target.workspaceId)
      )
    )
      setWorkspaceId(target.parentWorkspaceId ?? target.workspaceId);
    navigate('work', id);
  }
  function updateTask(next: Task) {
    if (deletedTasks.current.has(next.id)) return;
    setBootstrap((current) =>
      current
        ? { ...current, tasks: [next, ...current.tasks.filter((item) => item.id !== next.id)] }
        : current
    );
    if (next.id !== navigation.taskId) openTask(next.id);
  }
  function saveDraft(draft: Draft) {
    setDrafts((current) => ({ ...current, [draft.taskId ?? `new:${draft.workspaceId}`]: draft }));
  }
  async function loadMore() {
    const cursor = filter === 'archived' ? archivedCursor : bootstrap?.tasksCursor;
    if (!cursor || moreBusy) return;
    setMoreBusy(true);
    try {
      const page = await get<TaskPage>(
        `/v1/tasks?cursor=${encodeURIComponent(cursor)}&include=${filter === 'archived' ? 'archived' : 'active'}`
      );
      if (filter === 'archived') setArchivedCursor(page.nextCursor);
      else activePaged.current = true;
      setBootstrap((current) =>
        current
          ? {
              ...current,
              tasks: Array.from(
                new Map([...current.tasks, ...page.tasks].map((item) => [item.id, item])).values()
              ),
              tasksCursor: filter === 'archived' ? current.tasksCursor : page.nextCursor,
              scheduleRunCounts: { ...current.scheduleRunCounts, ...page.scheduleRunCounts }
            }
          : current
      );
    } catch (err) {
      setError(err);
    } finally {
      setMoreBusy(false);
    }
  }
  async function changeFilter(value: typeof filter) {
    setFilter(value);
    if (value === 'archived') {
      try {
        const page = await get<TaskPage>('/v1/tasks?include=archived');
        setArchivedCursor(page.nextCursor);
        setBootstrap((current) =>
          current
            ? {
                ...current,
                tasks: [...current.tasks.filter((item) => !item.archivedAt), ...page.tasks],
                tasksCursor: current.tasksCursor
              }
            : current
        );
      } catch (err) {
        setError(err);
      }
    } else if (filter === 'archived') {
      void refresh();
    }
  }
  if (nativeState && !nativeState.connected)
    return (
      <Suspense fallback={<Spinner label="Opening connection setup…" />}>
        <NativeSetup
          initialStatus={nativeState}
          onConnected={(details) => {
            setNativePairingCode(details.pairingCode ?? '');
            setNativeState((current) => (current ? { ...current, connected: true } : null));
            setLoading(true);
            void refresh();
          }}
        />
      </Suspense>
    );
  if (loading && !bootstrap)
    return (
      <div className="startup">
        <Brand />
        <Spinner label="Opening your workspace…" />
      </div>
    );
  if (authRequired)
    return (
      <Login
        pairingCode={nativePairingCode}
        onAuthenticated={() => {
          setLoading(true);
          setNativePairingCode('');
          void refresh();
        }}
        theme={theme}
        toggleTheme={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
      />
    );
  if (!bootstrap)
    return (
      <main className="startup">
        <Brand />
        <ErrorNotice
          error={error}
          onRetry={() => (isNativeClient() ? location.reload() : void refresh())}
        />
      </main>
    );
  const attentionTasks = bootstrap.tasks.filter(needsAttention);
  const attentionCount = new Set([
    ...decisions.map((decision) => decision.taskId),
    ...attentionTasks.map((item) => item.id)
  ]).size;
  const visibleTasks = bootstrap.tasks
    .filter(
      (item) =>
        (item.parentWorkspaceId ?? item.workspaceId) === workspace?.id &&
        (filter === 'archived' ? Boolean(item.archivedAt) : !item.archivedAt)
    )
    .filter((item) =>
      filter === 'running'
        ? hasOngoingWork(item)
        : filter === 'complete'
          ? item.status === 'completed' && item.deliveryStatus !== 'pending'
          : true
    )
    .filter((item) => item.title.toLowerCase().includes(search.toLowerCase()));
  const personalTasks = visibleTasks
    .filter((item) => !item.scheduleId)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const scheduleTasks = visibleTasks.filter((item) => item.scheduleId);
  return (
    <div
      className={`garden-shell ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'} ${task && navigation.view === 'work' ? 'task-open' : ''}`}
    >
      <a className="skip-link" href="#main">
        Skip to work
      </a>
      <header className="garden-masthead">
        <button
          className="brand-button"
          onClick={() => navigate('work')}
          aria-label="garden · All work"
        >
          <Brand />
        </button>
        <Button
          aria-label={sidebarOpen ? 'Hide projects' : 'Show projects'}
          aria-expanded={sidebarOpen}
          aria-controls="garden-sidebar"
          onClick={toggleSidebar}
        >
          <PanelLeft size={19} />
        </Button>
        <nav className="garden-main-navigation" aria-label="Main navigation">
          {(
            [
              { id: 'work', label: 'Work', icon: Grid2X2 },
              { id: 'library', label: 'Library', icon: FolderOpen },
              { id: 'computer', label: 'Computer', icon: Monitor }
            ] as const
          ).map((item) => (
            <Button
              key={item.id}
              aria-label={item.label}
              className={navigation.view === item.id ? 'selected' : ''}
              aria-current={navigation.view === item.id ? 'page' : undefined}
              onClick={() => navigate(item.id, item.id === 'computer' ? navigation.taskId : null)}
            >
              <item.icon size={16} />
              <span>{item.label}</span>
            </Button>
          ))}
        </nav>
        <ComputerStatus bootstrap={bootstrap} workspace={workspace} />
        <div className="garden-masthead-end">
          <Button
            className="global-search"
            onClick={() => setSearchOpen(true)}
            aria-label="Find anything"
          >
            <Search size={17} />
            <span>Find anything</span>
            <kbd>⌘ K</kbd>
          </Button>
          <Button
            className={navigation.view === 'attention' ? 'selected' : ''}
            onClick={() => navigate('attention')}
            aria-label={`${attentionCount} work items need attention`}
          >
            <Bell size={18} />
            {attentionCount > 0 && <span className="notification-count">{attentionCount}</span>}
          </Button>
          <Button
            aria-label="Settings"
            className={navigation.view === 'settings' ? 'selected' : ''}
            onClick={() => navigate('settings')}
          >
            <Settings2 size={18} />
          </Button>
        </div>
      </header>
      {sidebarOpen && (
        <button
          className="garden-sidebar-scrim"
          aria-label="Close projects"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        id="garden-sidebar"
        className="garden-sidebar"
        aria-label="Projects"
        inert={!sidebarOpen}
      >
        <div className="garden-sidebar-heading">
          <span className="eyebrow">Your projects</span>
          <Button
            className="garden-sidebar-close"
            aria-label="Close projects"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={16} />
          </Button>
        </div>
        <Button
          className="garden-new-work"
          onClick={() => {
            setNewWork(true);
            if (window.innerWidth <= 760) setSidebarOpen(false);
          }}
        >
          <Plus size={16} />
          Plant an idea
        </Button>
        {bootstrap.workspaces.length > 1 && (
          <select
            aria-label="Project computer"
            value={workspaceId}
            onChange={(event) => {
              setWorkspaceId(event.target.value);
              navigate('work');
            }}
          >
            {bootstrap.workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        )}
        <button
          className={`garden-sidebar-home ${navigation.view === 'work' && !task ? 'selected' : ''}`}
          onClick={() => {
            navigate('work');
            if (window.innerWidth <= 760) setSidebarOpen(false);
          }}
        >
          <Grid2X2 size={15} />
          Overview<span>{personalTasks.length}</span>
        </button>
        <label className="garden-sidebar-search">
          <Search size={14} />
          <input
            aria-label="Find a project"
            placeholder="Find a project…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <nav className="garden-project-list" aria-label="Project work">
          {personalTasks.map((item) => (
            <ProjectLink
              key={item.id}
              task={item}
              current={task?.id === item.id}
              onOpen={openTask}
            />
          ))}
          {!personalTasks.length && (
            <p className="muted">Your ideas and ongoing work will live here.</p>
          )}
        </nav>
        <div className="garden-sidebar-bottom">
          <Button
            className="garden-sidebar-theme"
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}{' '}
            {theme === 'dark' ? 'Light' : 'Dark'} appearance
          </Button>
        </div>
      </aside>
      {offline && (
        <div className="offline-banner" role="status">
          You’re offline. Your work continues on the computer; updates will reconnect here.
        </div>
      )}
      <main
        id="main"
        inert={mobile && sidebarOpen}
        className={`garden-main view-${navigation.view}`}
      >
        <ErrorNotice error={error} onRetry={requestRefresh} />
        <Suspense fallback={<Spinner label="Opening this surface…" />}>
          {navigation.view === 'work' &&
            (navigation.taskId && (!task || !taskWorkspace) ? (
              <Spinner label="Opening project…" />
            ) : task && taskWorkspace ? (
              <TaskSurface
                key={task.id}
                task={task}
                workspace={taskWorkspace}
                bootstrap={bootstrap}
                decisions={decisions}
                {...(drafts[task.id] ? { draft: drafts[task.id] } : {})}
                onDraft={saveDraft}
                onTask={updateTask}
                onRefresh={requestRefresh}
                onBack={() => navigate('work')}
                onOpenTask={openTask}
                onComputer={(nextTool) => {
                  setTool(nextTool);
                  navigate('computer', task.id);
                }}
              />
            ) : (
              <section className="overview">
                <div className="overview-top">
                  <div>
                    <div className="eyebrow">{workspace?.name ?? 'Your workspace'}</div>
                    <h1>
                      {personalTasks.length
                        ? 'What’s taking shape.'
                        : 'What would you like to bring to life?'}
                    </h1>
                  </div>
                  <div className="row">
                    {bootstrap.workspaces.length > 1 && (
                      <select
                        aria-label="Computer workspace"
                        value={workspaceId}
                        onChange={(event) => setWorkspaceId(event.target.value)}
                      >
                        {bootstrap.workspaces.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {personalTasks.length > 0 && (
                      <Button className="primary" onClick={() => setNewWork(true)}>
                        <Plus size={17} />
                        New work
                      </Button>
                    )}
                  </div>
                </div>
                {!bootstrap.instance.providerConfigured && (
                  <div className="setup-note">
                    <Sparkles size={24} />
                    <div>
                      <h3>Connect your model provider.</h3>
                      <p>Add your provider credentials to start working.</p>
                    </div>
                    <Button className="primary" onClick={() => navigate('settings')}>
                      Connect provider
                      <ArrowUpRight size={16} />
                    </Button>
                  </div>
                )}
                {workspace && workspace.status !== 'running' && (
                  <div className="setup-note">
                    <p>This computer is {workspace.status}.</p>
                    {workspace.status === 'hibernated' && (
                      <Button
                        onClick={async () => {
                          try {
                            await post(`/v1/workspaces/${workspace.id}/resume`, {});
                            requestRefresh();
                          } catch (err) {
                            setError(err);
                          }
                        }}
                      >
                        Wake computer
                      </Button>
                    )}
                  </div>
                )}
                {!personalTasks.length && filter === 'active' && !search && workspace && (
                  <div className="first-intent">
                    <Composer
                      key={`new:${workspace.id}`}
                      workspace={workspace}
                      bootstrap={bootstrap}
                      {...(drafts[`new:${workspace.id}`]
                        ? { initialDraft: drafts[`new:${workspace.id}`] }
                        : {})}
                      onDraft={saveDraft}
                      onSent={(next) => {
                        updateTask(next);
                        requestRefresh();
                      }}
                    />
                    <p className="muted">
                      Start with a question, a file, or something you want made.
                    </p>
                  </div>
                )}
                {attentionCount > 0 && (
                  <button className="attention-strip" onClick={() => navigate('attention')}>
                    <span>
                      <Bell size={17} />
                      {attentionCount}{' '}
                      {attentionCount === 1 ? 'piece of work needs' : 'pieces of work need'} your
                      attention
                    </span>
                    <span>
                      Take a look
                      <ArrowUpRight size={16} />
                    </span>
                  </button>
                )}
                {(bootstrap.tasks.length > 0 || filter !== 'active') && (
                  <>
                    <div className="work-filter">
                      <div className="segmented" aria-label="Filter work">
                        {(['active', 'running', 'complete', 'archived'] as const).map((value) => (
                          <button
                            key={value}
                            aria-pressed={filter === value}
                            onClick={() => changeFilter(value)}
                          >
                            {value === 'active'
                              ? 'All work'
                              : value.charAt(0).toUpperCase() + value.slice(1)}
                          </button>
                        ))}
                      </div>
                      <label className="inline-search">
                        <Search size={15} />
                        <input
                          aria-label="Filter work by title"
                          placeholder="Find work…"
                          value={search}
                          onChange={(event) => setSearch(event.target.value)}
                        />
                      </label>
                    </div>
                    <div className="work-grid">
                      {personalTasks.map((item) => (
                        <WorkCard
                          key={item.id}
                          task={item}
                          artifact={artifacts.find((artifact) => artifact.taskId === item.id)}
                          onOpen={() => openTask(item.id)}
                        />
                      ))}
                    </div>
                    {personalTasks.length === 0 && (filter !== 'active' || Boolean(search)) && (
                      <Empty title="No work in this view">
                        Try another filter or begin something new.
                      </Empty>
                    )}
                  </>
                )}
                {scheduleTasks.length > 0 && (
                  <section className="scheduled-work">
                    <h2>Running on a rhythm</h2>
                    {Array.from(new Set(scheduleTasks.map((item) => item.scheduleId))).map((id) => {
                      const rows = scheduleTasks.filter((item) => item.scheduleId === id);
                      const schedule = bootstrap.schedules.find((item) => item.id === id);
                      return (
                        <details key={id}>
                          <summary>
                            {schedule?.title ?? rows[0]?.title}{' '}
                            <span className="muted">
                              {bootstrap.scheduleRunCounts[id ?? ''] ?? rows.length} runs
                            </span>
                          </summary>
                          <div className="stack">
                            {rows.map((item) => (
                              <Button key={item.id} onClick={() => openTask(item.id)}>
                                {item.title} · {taskStatusLabel(item)} · {shortDate(item.createdAt)}
                                <ArrowUpRight size={14} />
                              </Button>
                            ))}
                          </div>
                        </details>
                      );
                    })}
                  </section>
                )}
                {(filter === 'archived' ? archivedCursor : bootstrap.tasksCursor) && (
                  <div className="load-more">
                    <Button onClick={loadMore} busy={moreBusy}>
                      More work
                    </Button>
                  </div>
                )}
              </section>
            ))}
          {navigation.view === 'library' && (
            <Library
              workspace={workspace}
              onOpenTask={openTask}
              onChange={requestRefresh}
              onTaskDeleted={(id) => {
                deletedTasks.current.add(id);
                setBootstrap((current) =>
                  current
                    ? { ...current, tasks: current.tasks.filter((task) => task.id !== id) }
                    : current
                );
              }}
            />
          )}
          {computerOpened && (
            <section hidden={navigation.view !== 'computer'}>
              {navigation.taskId && !computerWorkspace ? (
                <Spinner />
              ) : (
                <Computer
                  key={computerWorkspace?.id}
                  workspace={computerWorkspace}
                  task={task}
                  initialTool={tool}
                  visible={navigation.view === 'computer'}
                  onChange={requestRefresh}
                />
              )}
            </section>
          )}
          {navigation.view === 'settings' && (
            <Settings workspace={workspace} onChange={requestRefresh} />
          )}
          {navigation.view === 'attention' && (
            <section>
              <div className="section-intro">
                <div className="eyebrow">Your attention, well spent</div>
                <h1>A moment for your judgement.</h1>
              </div>
              <DecisionQueue
                decisions={decisions}
                tasks={bootstrap.tasks}
                onResolved={requestRefresh}
                onOpenTask={openTask}
              />
              {attentionTasks
                .filter((item) => !decisions.some((decision) => decision.taskId === item.id))
                .map((item) => (
                  <button
                    className="attention-task"
                    key={item.id}
                    onClick={() => openTask(item.id)}
                  >
                    <span>
                      <small>{taskStatusLabel(item)}</small>
                      <strong>{item.title}</strong>
                    </span>
                    <ArrowUpRight size={20} />
                  </button>
                ))}
              {attentionCount === 0 && (
                <Empty title="Nothing needs you right now.">
                  Your active work can carry on. Come back when there’s something worth deciding.
                </Empty>
              )}
            </section>
          )}
        </Suspense>
      </main>
      {newWork && workspace && (
        <Dialog title="Begin something new" onClose={() => setNewWork(false)}>
          <Suspense fallback={<Spinner />}>
            <Composer
              key={`new:${workspace.id}`}
              workspace={workspace}
              bootstrap={bootstrap}
              {...(drafts[`new:${workspace.id}`]
                ? { initialDraft: drafts[`new:${workspace.id}`] }
                : {})}
              onDraft={saveDraft}
              onSent={(next) => {
                setNewWork(false);
                updateTask(next);
                requestRefresh();
              }}
            />
          </Suspense>
        </Dialog>
      )}
      {searchOpen && (
        <SearchDialog
          workspace={workspace}
          tasks={bootstrap.tasks}
          onClose={() => setSearchOpen(false)}
          onTask={(id) => {
            setSearchOpen(false);
            openTask(id);
          }}
          onView={(view) => {
            setSearchOpen(false);
            navigate(view);
          }}
          onNew={() => {
            setSearchOpen(false);
            setNewWork(true);
          }}
        />
      )}
    </div>
  );
}
function Brand() {
  return (
    <span className="brand">
      <span>garden</span>
    </span>
  );
}
function ComputerStatus({
  bootstrap,
  workspace
}: {
  bootstrap: Bootstrap;
  workspace: Workspace | null;
}) {
  const computer = bootstrap.computer;
  const plan = bootstrap.usage.plan;
  const disk =
    workspace?.hostStorageTotalBytes && workspace.hostStorageAvailableBytes !== undefined
      ? `${Math.round((1 - workspace.hostStorageAvailableBytes / workspace.hostStorageTotalBytes) * 100)}%`
      : null;
  if (!computer && !disk && !bootstrap.usage.plan) return null;
  return (
    <div className="garden-computer-status" aria-label="Computer health">
      {computer && (
        <span title={`CPU load: ${computer.cpuPercent}%`}>
          <Gauge size={13} />
          CPU {computer.cpuPercent}%
        </span>
      )}
      {computer && (
        <span
          title={`${bytes(computer.memoryUsedBytes)} of ${bytes(computer.memoryTotalBytes)} memory used`}
        >
          <MemoryStick size={13} />
          RAM{' '}
          {Math.round((computer.memoryUsedBytes / Math.max(1, computer.memoryTotalBytes)) * 100)}%
        </span>
      )}
      {disk && (
        <span title={`${bytes(workspace!.hostStorageAvailableBytes!)} free on host disk`}>
          <HardDrive size={13} />
          Disk {disk}
        </span>
      )}
      {plan?.windows.map((window, index) => {
        /*
         * Two providers measure two different things, and the strip now renders each in its own
         * unit rather than treating everything as a fraction of a plan. Ollama Cloud publishes how
         * much of a window is used, so a percentage is the whole answer. OpenRouter publishes
         * money, and what an owner wants from money is what is left - so the balance is shown as
         * remaining, which is the number that decides whether the next run starts.
         */
        const remaining =
          window.limit !== null && window.used !== null ? window.limit - window.used : null;
        const label = window.label.startsWith('Session')
          ? 'Session'
          : window.label.startsWith('Weekly')
            ? 'Week'
            : window.label === 'Credit balance'
              ? 'Balance'
              : window.label === 'Key limit'
                ? 'Key'
                : window.label;
        const shown =
          window.unit === 'usd'
            ? remaining === null
              ? window.used === null
                ? '—'
                : `${money(window.used)} used`
              : `${money(remaining)} left`
            : window.used === null
              ? '—'
              : `${Math.round(window.used * 100)}%`;
        const detail =
          window.unit === 'usd'
            ? `${window.label}: ${window.used === null ? 'spend unavailable' : `${money(window.used)} used`}${window.limit === null ? ', no limit set' : ` of ${money(window.limit)}`}`
            : `${window.label}: ${window.used === null ? 'unavailable' : `${Math.round(window.used * 100)}% of plan`}${window.resetsAt ? `, resets at ${new Date(window.resetsAt).toLocaleString()}` : ''}`;
        return (
          <span key={`${window.label}-${index}`} title={detail}>
            <Gauge size={13} />
            {label} {shown}
          </span>
        );
      })}
    </div>
  );
}
function WorkCard({
  task,
  artifact,
  onOpen
}: {
  task: Task;
  artifact?: Artifact | undefined;
  onOpen: () => void;
}) {
  return (
    <button
      className={`garden-work-card ${hasOngoingWork(task) ? 'working' : ''}`}
      onClick={onOpen}
    >
      <div className="card-top">
        <span className="eyebrow">{task.pinned ? 'Pinned work' : taskStatusLabel(task)}</span>
        <ArrowUpRight size={19} />
      </div>
      {artifact && (
        <div className="garden-card-artifact">
          <FileText size={20} />
          <span>{artifact.name}</span>
        </div>
      )}
      <div className="card-bottom">
        <h2>{task.title}</h2>
        <div className="row between">
          <span className="status-line">
            <i />
            {taskStatusLabel(task)}
          </span>
          <small>
            {money(task.spentUsd)} · {shortDate(task.updatedAt)}
          </small>
        </div>
      </div>
    </button>
  );
}
function SearchDialog({
  workspace,
  tasks,
  onClose,
  onTask,
  onView,
  onNew
}: {
  workspace: Workspace | null;
  tasks: Task[];
  onClose: () => void;
  onTask: (id: string) => void;
  onView: (view: View) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{ taskId: string; title: string; excerpt: string }>>(
    []
  );
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      void get<Array<{ taskId: string; title: string; excerpt: string }>>(
        `/v1/search?q=${encodeURIComponent(query)}${workspace ? `&workspaceId=${workspace.id}` : ''}`,
        { signal: controller.signal }
      )
        .then(setResults)
        .catch((err: unknown) => {
          if (!controller.signal.aborted) setError(err);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, workspace?.id]);
  const commands = [
    { label: 'Start new work', action: onNew },
    { label: 'All work', action: () => onView('work') },
    { label: 'Files, terminal, browser and desktop', action: () => onView('computer') },
    { label: 'Memory, skills, connectors and schedules', action: () => onView('library') },
    { label: 'Models, access and settings', action: () => onView('settings') },
    { label: 'Decisions and attention', action: () => onView('attention') }
  ];
  return (
    <Dialog title="Find anything" onClose={onClose}>
      <div className="command-input">
        <Search size={19} />
        <input
          aria-label="Search work and tools"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Work, a tool, or a thought…"
        />
        <kbd>esc</kbd>
      </div>
      <div className="command-results">
        {commands
          .filter((command) => command.label.toLowerCase().includes(query.toLowerCase()))
          .map((command) => (
            <button key={command.label} onClick={command.action}>
              <Command size={15} />
              {command.label}
              <ArrowUpRight size={15} />
            </button>
          ))}
        {(query
          ? results
          : tasks.slice(0, 8).map((task) => ({
              taskId: task.id,
              title: task.title,
              excerpt: taskStatusLabel(task)
            }))
        ).map((result) => (
          <button key={result.taskId} onClick={() => onTask(result.taskId)}>
            <FileText size={17} />
            <span>
              {result.title}
              <small>{result.excerpt}</small>
            </span>
            <ArrowUpRight size={15} />
          </button>
        ))}
      </div>
      {loading && <Spinner label="Searching your work…" />}
      <ErrorNotice error={error} />
    </Dialog>
  );
}
function Login({
  pairingCode,
  onAuthenticated,
  theme,
  toggleTheme
}: {
  pairingCode: string;
  onAuthenticated: () => void;
  theme: string;
  toggleTheme: () => void;
}) {
  const [legal, setLegal] = useState<{ registrationAvailable?: boolean; passkeysUsable?: boolean }>(
    {}
  );
  const [mode, setMode] = useState<'login' | 'register' | 'recover' | 'enroll'>('login');
  const [name, setName] = useState('');
  const [code, setCode] = useState(pairingCode);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState('');
  useEffect(() => {
    let alive = true;
    void (async () => {
      const native = await import('./native');
      const token = native.enrollmentCodeFromFragment(location.hash, location.origin);
      const browserAuthorization = (
        await import('./native-authorization')
      ).browserAuthorizationLocation();
      if (location.hash.startsWith('#pair=')) {
        history.replaceState({}, '', `${location.pathname}${location.search}`);
        if (!token)
          throw new Error(
            'This device link is invalid, expired, or belongs to another server. Create a new device link from Settings → Access on your signed-in device.'
          );
      }
      const value = await get<typeof legal>('/v1/legal');
      if (!alive) return;
      setLegal(value);
      if (browserAuthorization?.onboarding && browserAuthorization.onboarding.mode !== 'passkey') {
        setMode(browserAuthorization.onboarding.mode);
        setCode(browserAuthorization.onboarding.code);
        setName(browserAuthorization.onboarding.name ?? '');
      } else if (token) {
        setCode(token);
        setMode('enroll');
        history.replaceState({}, '', `${location.pathname}${location.search}`);
      } else if (value.registrationAvailable) setMode('register');
      else if (pairingCode) setMode('enroll');
    })().catch((cause: unknown) => {
      if (alive) setError(cause);
    });
    return () => {
      alive = false;
    };
  }, [pairingCode]);
  async function run(development = false) {
    setBusy(true);
    setError(null);
    try {
      const result: AuthResult = development
        ? await devSignIn()
        : mode === 'register'
          ? await register({ displayName: name || 'Owner', pairingCode: code })
          : mode === 'recover'
            ? await recover(code)
            : mode === 'enroll'
              ? await enroll(code, name || undefined)
              : await signIn();
      if (result.recoveryCode) setRecovery(result.recoveryCode);
      else onAuthenticated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="welcome">
      <div className="welcome-top">
        <Brand />
        <Button
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </Button>
      </div>
      <div className="welcome-art" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
      <section className="welcome-content">
        <div className="eyebrow">Your own space to think and make</div>
        <h1>
          Good things
          <br />
          begin here.
        </h1>
        <p>A persistent computer for your ideas, your questions, and the work you want done.</p>
        {recovery ? (
          <div className="recovery-record">
            <h2>Save your recovery code.</h2>
            <p>This is how you regain access if you lose your passkeys. It is shown once.</p>
            <code>{recovery}</code>
            <Button onClick={() => navigator.clipboard.writeText(recovery).catch(setError)}>
              Copy recovery code
            </Button>
            <Button
              className="primary"
              onClick={() => {
                setRecovery('');
                onAuthenticated();
              }}
            >
              <Check size={16} />I have saved it
            </Button>
          </div>
        ) : (
          <form
            className="login-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run();
            }}
          >
            <h2>
              {mode === 'register'
                ? 'Make this space yours.'
                : mode === 'recover'
                  ? 'Recover access.'
                  : mode === 'enroll'
                    ? 'Connect this device.'
                    : 'Welcome back.'}
            </h2>
            {(mode === 'register' || mode === 'enroll') && (
              <Field label="Your name">
                <input
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
            )}
            {mode !== 'login' && (
              <Field
                label={
                  mode === 'recover'
                    ? 'Recovery code'
                    : mode === 'enroll'
                      ? 'Device enrollment token'
                      : 'Installer pairing code'
                }
              >
                <input
                  type="password"
                  autoComplete="off"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                />
              </Field>
            )}
            <Button
              type="submit"
              className="primary"
              busy={busy}
              disabled={legal.passkeysUsable === false}
            >
              {mode === 'register'
                ? 'Create your passkey'
                : mode === 'recover'
                  ? 'Create a replacement passkey'
                  : mode === 'enroll'
                    ? 'Add this device'
                    : 'Continue with your passkey'}
              <ArrowUpRight size={18} />
            </Button>
            {legal.passkeysUsable === false && (
              <p className="error">
                Open this computer through its configured HTTPS hostname to use passkeys.
              </p>
            )}
            <div className="row login-links">
              {mode !== 'login' && (
                <Button
                  onClick={() => {
                    setMode('login');
                    setCode('');
                  }}
                >
                  Sign in
                </Button>
              )}
              {mode !== 'recover' && (
                <Button
                  onClick={() => {
                    setMode('recover');
                    setCode('');
                  }}
                >
                  Recover access
                </Button>
              )}
              {mode !== 'enroll' && (
                <Button
                  onClick={() => {
                    setMode('enroll');
                    setCode('');
                  }}
                >
                  Enroll a device
                </Button>
              )}
            </div>
            {import.meta.env.DEV && (
              <Button onClick={() => run(true)} busy={busy}>
                Development sign-in
              </Button>
            )}
          </form>
        )}
        <ErrorNotice error={error} />
      </section>
      <footer>Self-hosted · AGPL · Your credentials, used directly</footer>
    </main>
  );
}
