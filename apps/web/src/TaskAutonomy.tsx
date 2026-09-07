import { useEffect, useRef, useState } from 'react';
import { Shield } from 'lucide-react';
import type { Task } from '@athanor/contracts';
import { patch } from './client';
import { modeFloors } from './asking-rules';
import { ErrorNotice } from './ui';

const modes = ['review', 'balanced', 'autonomous'] as const;
const labels = ['Review', 'Balanced', 'Autonomous'];

export function TaskAutonomy({
  task,
  onTask,
  onRefresh
}: {
  task: Task;
  onTask: (task: Task) => void;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(modes.indexOf(task.securityMode));
  const [error, setError] = useState<unknown>(null);
  const editing = useRef(false);
  const saving = useRef(false);
  const actualMode = useRef(task.securityMode);
  const desired = useRef(modes.indexOf(task.securityMode));
  useEffect(() => {
    if (saving.current) return;
    actualMode.current = task.securityMode;
    if (!editing.current) {
      desired.current = modes.indexOf(task.securityMode);
      setDraft(desired.current);
    }
  }, [task.securityMode, task.id]);
  async function drain() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      while (modes[desired.current] && modes[desired.current] !== actualMode.current) {
        const securityMode = modes[desired.current]!;
        const updated = await patch<Task>(`/v1/tasks/${task.id}/security-mode`, { securityMode });
        actualMode.current = updated.securityMode;
        onTask(updated);
      }
      onRefresh();
    } catch (cause) {
      desired.current = modes.indexOf(actualMode.current);
      setDraft(desired.current);
      setError(cause);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  function change(index: number) {
    if (!modes[index]) return;
    desired.current = index;
    setDraft(index);
    setError(null);
    void drain();
  }
  return (
    <section className="garden-autonomy" aria-label="Autonomy and safety" aria-busy={busy}>
      <div className="garden-autonomy-control">
        <label htmlFor={`autonomy-${task.id}`}>
          <Shield size={16} />
          Autonomy
        </label>
        <div className="garden-autonomy-track">
          <input
            id={`autonomy-${task.id}`}
            type="range"
            min={0}
            max={2}
            step={1}
            value={draft}
            aria-valuetext={labels[draft]}
            aria-describedby={`autonomy-floor-${task.id}`}
            onPointerDown={() => {
              editing.current = true;
            }}
            onKeyDown={() => {
              editing.current = true;
            }}
            onChange={(event) => setDraft(Number(event.target.value))}
            onPointerUp={(event) => {
              editing.current = false;
              void change(Number(event.currentTarget.value));
            }}
            onKeyUp={(event) => {
              editing.current = false;
              void change(Number(event.currentTarget.value));
            }}
            onBlur={(event) => {
              editing.current = false;
              void change(Number(event.currentTarget.value));
            }}
          />
          <div>
            {labels.map((label, index) => (
              <button
                type="button"
                key={label}
                aria-pressed={modes[index] === task.securityMode}
                onClick={() => void change(index)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <details id={`autonomy-floor-${task.id}`}>
        <summary>{labels[modes.indexOf(task.securityMode)]} · What needs approval</summary>
        <p>{modeFloors[task.securityMode]}</p>
      </details>
      <ErrorNotice error={error} />
    </section>
  );
}
