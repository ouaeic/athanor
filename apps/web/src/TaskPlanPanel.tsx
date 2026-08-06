import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  History,
  ListChecks,
  Plus,
  Save,
  Trash2
} from 'lucide-react';
import { api, ApiFailure } from './api.js';
import { terminalTaskStatuses } from './task-status.js';
import type { Task, TaskPlan, TaskPlanStep } from './types.js';

export interface PlanProgress {
  completed: number;
  total: number;
  /** The step being worked on right now, for the one line a waiting owner reads. */
  current: string;
}

const resolved = new Set(['completed', 'skipped']);

export const planProgress = (steps: TaskPlanStep[]): PlanProgress | null => {
  if (!steps.length) return null;
  return {
    completed: steps.filter((step) => resolved.has(step.status)).length,
    total: steps.length,
    current:
      steps.find((step) => step.status === 'in_progress')?.title ??
      steps.find((step) => step.status === 'pending')?.title ??
      ''
  };
};

/**
 * How far through it is, fetched without opening anything.
 *
 * The plan used to be mounted only inside the expanded activity log, so it was not even requested
 * until the owner clicked — and "is this nearly done or has it barely started" is the question they
 * are asking for most of the time the agent is working.
 */
export const useTaskPlan = (taskId: string, refreshKey: number): TaskPlan | null => {
  const [plan, setPlan] = useState<TaskPlan | null>(null);
  useEffect(() => {
    let active = true;
    setPlan(null);
    // An empty id is a caller saying it does not want the plan on this render - a work log from
    // twenty minutes ago has no use for today's. Hooks cannot be called conditionally, so the
    // condition lives here instead, and the request is simply not made.
    if (!taskId) return;
    const read = () =>
      void api
        .taskPlan(taskId)
        .then((latest) => {
          if (active) setPlan(latest);
        })
        .catch(() => undefined);
    read();
    return () => {
      active = false;
    };
    // `refreshKey` is the newest plan event's sequence, so a plan the agent revised is re-read
    // without polling for one that never changes.
  }, [taskId, refreshKey]);
  return plan;
};

export function TaskPlanPanel({ task, refreshKey }: { task: Task; refreshKey: number }) {
  const [plan, setPlan] = useState<TaskPlan | null>(null);
  const [steps, setSteps] = useState<TaskPlanStep[]>([]);
  // Carried, never edited: naming a branch of a to-do list is a control with no reader on a
  // single-owner box, but the field is required and an edit must not silently rename anything.
  const [branchName, setBranchName] = useState('Main');
  const [history, setHistory] = useState<TaskPlan[]>([]);
  const [draftParentVersion, setDraftParentVersion] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async (force = false) => {
    try {
      const latest = await api.taskPlan(task.id);
      setPlan((current) => {
        if (dirty && !force && latest?.version !== current?.version) {
          setRemoteChanged(true);
          return current;
        }
        setSteps(latest?.steps ?? []);
        setBranchName(latest?.branchName ?? 'Main');
        setDraftParentVersion(null);
        setDirty(false);
        setRemoteChanged(false);
        return latest;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the active plan');
    }
  };

  useEffect(() => {
    setPlan(null);
    setSteps([]);
    setDirty(false);
    setRemoteChanged(false);
    void load(true);
  }, [task.id]);

  useEffect(() => {
    if (refreshKey > 0) void load();
  }, [refreshKey]);

  const completed = useMemo(
    () => steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length,
    [steps]
  );

  const changeSteps = (next: TaskPlanStep[]) => {
    setSteps(next);
    setDirty(true);
    setError('');
  };

  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    changeSteps(next);
  };

  const save = async () => {
    if (!steps.length || steps.some((step) => !step.title.trim())) {
      setError('Every plan needs at least one named step.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const updated = await api.updateTaskPlan(task.id, {
        expectedVersion: plan?.version ?? 0,
        ...((draftParentVersion ?? plan?.version)
          ? { parentVersion: draftParentVersion ?? plan!.version }
          : {}),
        branchName: branchName.trim() || 'Main',
        steps: steps.map((step) => ({ ...step, title: step.title.trim() }))
      });
      setPlan(updated);
      setSteps(updated.steps);
      setBranchName(updated.branchName);
      setDraftParentVersion(null);
      setDirty(false);
      setRemoteChanged(false);
    } catch (cause) {
      if (cause instanceof ApiFailure && cause.code === 'plan_version_conflict') {
        setRemoteChanged(true);
        setError(
          'The agent or another device revised this plan. Reload it, then reapply your edit.'
        );
      } else setError(cause instanceof Error ? cause.message : 'Could not save the plan');
    } finally {
      setSaving(false);
    }
  };

  const toggleHistory = async () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (!next) return;
    try {
      setHistory(await api.taskPlans(task.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load plan history');
    }
  };

  if (!plan && steps.length === 0 && terminalTaskStatuses.has(task.status)) return null;
  return (
    <section className="task-plan-panel" aria-label="Live task plan">
      <header>
        <div className="task-plan-heading">
          <ListChecks />
          <div>
            <strong>Live plan</strong>
            {/* Version numbers and a `createdBy` enum are storage detail. What is worth a line is
                how far through it is and whether the agent or the owner last touched it. */}
            <span>
              {!plan
                ? 'Being written'
                : steps.length
                  ? `${completed} of ${steps.length} done · last changed by ${plan.createdBy === 'user' ? 'you' : 'the agent'}`
                  : `Written by ${plan.createdBy === 'user' ? 'you' : 'the agent'}`}
            </span>
          </div>
        </div>
        <div className="task-plan-actions">
          <button
            title="Plan history"
            aria-label="Plan history"
            onClick={() => void toggleHistory()}
          >
            <History />
          </button>
          {!terminalTaskStatuses.has(task.status) && (
            <button className="save" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? <span className="tiny-spinner" /> : <Save />}
              Save
            </button>
          )}
        </div>
      </header>
      {remoteChanged && (
        <div className="task-plan-conflict">
          A newer version is active. <button onClick={() => void load(true)}>Reload newest</button>
        </div>
      )}
      {!!steps.length && (
        <div className="task-plan-progress" aria-label={`${completed} of ${steps.length} resolved`}>
          <span style={{ width: `${(completed / steps.length) * 100}%` }} />
        </div>
      )}
      <ol className="task-plan-steps">
        {steps.map((step, index) => (
          <li key={step.id}>
            <select
              value={step.status}
              disabled={terminalTaskStatuses.has(task.status)}
              aria-label={`Status for step ${index + 1}`}
              onChange={(event) =>
                changeSteps(
                  steps.map((item) =>
                    item.id === step.id
                      ? { ...item, status: event.target.value as TaskPlanStep['status'] }
                      : item
                  )
                )
              }
            >
              <option value="pending">Pending</option>
              <option value="in_progress">In progress</option>
              <option value="completed">Completed</option>
              <option value="skipped">Skipped</option>
            </select>
            <input
              value={step.title}
              maxLength={240}
              readOnly={terminalTaskStatuses.has(task.status)}
              aria-label={`Plan step ${index + 1}`}
              onChange={(event) =>
                changeSteps(
                  steps.map((item) =>
                    item.id === step.id ? { ...item, title: event.target.value } : item
                  )
                )
              }
            />
            {!terminalTaskStatuses.has(task.status) && (
              <div className="task-plan-row-actions">
                <button
                  disabled={index === 0}
                  aria-label="Move step up"
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp />
                </button>
                <button
                  disabled={index === steps.length - 1}
                  aria-label="Move step down"
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown />
                </button>
                <button
                  disabled={steps.length === 1}
                  aria-label="Delete step"
                  onClick={() => changeSteps(steps.filter((item) => item.id !== step.id))}
                >
                  <Trash2 />
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {!terminalTaskStatuses.has(task.status) && steps.length < 30 && (
        <button
          className="task-plan-add"
          onClick={() =>
            changeSteps([
              ...steps,
              { id: crypto.randomUUID(), title: 'New step', status: 'pending' }
            ])
          }
        >
          <Plus /> Add step
        </button>
      )}
      {historyOpen && (
        <div className="task-plan-history">
          <div className="task-plan-history-title">
            <ChevronDown /> Earlier versions of this plan
          </div>
          {!history.length && <em>This plan has not been revised yet.</em>}
          {history.map((revision) => (
            <button
              key={revision.id}
              title="Bring this version back into the editor"
              onClick={() => {
                setSteps(revision.steps);
                setBranchName(revision.branchName);
                setDraftParentVersion(revision.version);
                setDirty(true);
                setHistoryOpen(false);
              }}
            >
              <Check />
              <span>
                {revision.steps.length} {revision.steps.length === 1 ? 'step' : 'steps'} ·{' '}
                {revision.createdBy === 'user' ? 'you' : 'the agent'}
              </span>
              <em>{new Date(revision.createdAt).toLocaleString()}</em>
            </button>
          ))}
        </div>
      )}
      {error && <p className="task-plan-error">{error}</p>}
    </section>
  );
}
