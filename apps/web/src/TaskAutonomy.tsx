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
  const saving = useRef(false);
  const actualMode = useRef(task.securityMode);
  const desired = useRef(modes.indexOf(task.securityMode));
  useEffect(() => {
    if (saving.current) return;
    actualMode.current = task.securityMode;
    desired.current = modes.indexOf(task.securityMode);
    setDraft(desired.current);
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
    <div className="garden-autonomy" aria-busy={busy}>
      <Shield size={14} aria-hidden="true" />
      <select
        aria-label="Autonomy"
        title={modeFloors[modes[draft]!]}
        value={draft}
        onChange={(event) => change(Number(event.target.value))}
      >
        {modes.map((mode, index) => (
          <option key={mode} value={index}>
            {labels[index]}
          </option>
        ))}
      </select>
      <ErrorNotice error={error} />
    </div>
  );
}
