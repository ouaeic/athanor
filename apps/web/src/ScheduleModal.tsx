import { useEffect, useState } from 'react';
import { CalendarClock, Pause, Play, Trash2, X, Zap } from 'lucide-react';
import { api } from './api.js';
import { describeFailure } from './failure-text.js';
import { Dialog } from './Dialog.js';
import { scheduleDescription, scheduleSpecFromForm, scheduleStanding } from './schedule-rows.js';
import { useUndo } from './Undo.js';
import type { CatalogueModel, TaskSchedule, Workspace } from './types.js';

const localDateTimeInput = (date: Date): string =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function ScheduleModal({
  schedules,
  workspaces,
  models,
  defaultWorkspaceId,
  initialPrompt,
  onClose,
  onChanged
}: {
  schedules: TaskSchedule[];
  workspaces: Workspace[];
  models: CatalogueModel[];
  defaultWorkspaceId?: string;
  initialPrompt: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState(initialPrompt);
  const workspaceId = defaultWorkspaceId ?? workspaces[0]?.id ?? '';
  const privacyRoute =
    models.find((model) => model.availability === 'available')?.privacyRoute ?? 'provider_zdr';
  const eligibleModels = models.filter(
    (model) => model.privacyRoute === privacyRoute && model.availability === 'available'
  );
  const [modelId, setModelId] = useState(eligibleModels[0]?.id ?? '');
  // Cron is not offered here: a five-field expression is not something anyone should have to write
  // to get a daily briefing, and the four shapes below are what people actually schedule. The
  // agent can still create one on request, and `scheduleDescription` still reads it back.
  const [kind, setKind] = useState<'once' | 'interval' | 'daily' | 'weekly'>('daily');
  const [runAt, setRunAt] = useState(localDateTimeInput(new Date(Date.now() + 60 * 60_000)));
  const [localTime, setLocalTime] = useState('09:00');
  const [everyMinutes, setEveryMinutes] = useState(60);
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removed, setRemoved] = useState<string[]>([]);
  const visibleSchedules = schedules.filter((schedule) => !removed.includes(schedule.id));
  const undo = useUndo();

  useEffect(() => {
    if (!eligibleModels.some((model) => model.id === modelId))
      setModelId(eligibleModels[0]?.id ?? '');
  }, [eligibleModels, modelId]);

  /*
   * The default is the recommendation, not whatever the catalogue happens to list first.
   *
   * Listed first was `claude-3-haiku` - alphabetical, and years old - so a schedule created without
   * touching this ran every morning on it. The composer has always asked the box which model it
   * would pick; this is the same question, and a run nobody is watching is the last place to answer
   * it by accident. Only the untouched default moves: once the owner has chosen, this leaves it be.
   */
  const [modelTouched, setModelTouched] = useState(false);
  useEffect(() => {
    if (modelTouched) return;
    let active = true;
    void api
      .recommendModels(privacyRoute === 'provider_zdr' ? 'provider_zdr' : 'external', 'balanced')
      .then((ranked) => {
        const best = ranked.find((entry) =>
          eligibleModels.some((model) => model.id === entry.modelId)
        );
        if (active && best) setModelId(best.modelId);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
    // Deliberately not keyed on eligibleModels: that array is rebuilt on every render, and asking
    // again on each one would fight the owner's own selection.
  }, [privacyRoute, modelTouched]);

  const create = async () => {
    if (!workspaceId || !prompt.trim() || !modelId) return;
    setBusy(true);
    setError('');
    try {
      const built = scheduleSpecFromForm({
        kind,
        runAt,
        localTime,
        everyMinutes,
        weekdays,
        timeZone
      });
      if (!built.ok) throw new Error(built.message);
      const spec = built.spec;
      await api.createSchedule({
        workspaceId,
        prompt: prompt.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
        modelId,
        privacyRoute,
        // The same ceiling a message typed into the composer gets. Real spending is bounded by the
        // daily and monthly caps in Settings, which is one control instead of two currencies.
        maxComputeCredits: 5,
        spec
      });
      setPrompt('');
      setTitle('');
      await onChanged();
    } catch (cause) {
      setError(describeFailure(cause, 'Could not create schedule'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog className="modal schedule-modal" labelledBy="schedule-title" onClose={onClose}>
      <button className="modal-close" aria-label="Close scheduled work" onClick={onClose}>
        <X />
      </button>
      <h2 id="schedule-title">Scheduled work</h2>
      <p className="subtle">
        Runs on your agent computer whether or not you are here, under the same approval rules.
      </p>
      <div className="schedule-layout">
        <div className="schedule-existing">
          <strong>Your schedules</strong>
          {!visibleSchedules.length && <small>No scheduled work yet.</small>}
          {visibleSchedules.map((schedule) => (
            <div className={`schedule-row ${schedule.enabled ? '' : 'paused'}`} key={schedule.id}>
              <CalendarClock />
              <span>
                <strong>{schedule.title}</strong>
                <small>{scheduleDescription(schedule.spec)}</small>
                <small>{scheduleStanding(schedule)}</small>
              </span>
              <button
                className="icon-btn"
                title="Run now"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    await api.scheduleAction(schedule.id, 'run');
                    await onChanged();
                  } catch (cause) {
                    setError(describeFailure(cause, 'Could not run schedule'));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Zap />
              </button>
              <button
                className="icon-btn"
                title={schedule.enabled ? 'Pause schedule' : 'Resume schedule'}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    await api.scheduleAction(schedule.id, schedule.enabled ? 'pause' : 'resume');
                    await onChanged();
                  } catch (cause) {
                    setError(describeFailure(cause, 'Could not update schedule'));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {schedule.enabled ? <Pause /> : <Play />}
              </button>
              <button
                className="icon-btn destructive"
                title="Delete schedule"
                disabled={busy}
                onClick={() => {
                  setRemoved((current) => [...current, schedule.id]);
                  undo({
                    message: `Deleted “${schedule.title}”`,
                    commit: async () => {
                      await api.deleteSchedule(schedule.id);
                      await onChanged();
                    },
                    restore: () =>
                      setRemoved((current) => current.filter((id) => id !== schedule.id))
                  });
                }}
              >
                <Trash2 />
              </button>
            </div>
          ))}
        </div>
        <div className="schedule-form">
          <strong>Create a schedule</strong>
          <label>
            Name <small>optional</small>
            <input
              maxLength={160}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            What should athanor do?
            <textarea rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <div className="schedule-grid">
            <label>
              Repeats
              <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
                <option value="once">Once</option>
                <option value="interval">At an interval</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
            {kind === 'once' && (
              <label>
                Run at
                <input
                  type="datetime-local"
                  value={runAt}
                  onChange={(event) => setRunAt(event.target.value)}
                />
              </label>
            )}
            {kind === 'interval' && (
              <label>
                Every minutes
                <input
                  type="number"
                  min={15}
                  max={10080}
                  value={everyMinutes}
                  onChange={(event) => setEveryMinutes(Number(event.target.value))}
                />
              </label>
            )}
            {(kind === 'daily' || kind === 'weekly') && (
              <label>
                Local time
                <input
                  type="time"
                  value={localTime}
                  onChange={(event) => setLocalTime(event.target.value)}
                />
              </label>
            )}
          </div>
          {kind === 'weekly' && (
            <div className="weekday-picker">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((name, day) => (
                <button
                  type="button"
                  aria-label={
                    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
                      day
                    ]
                  }
                  aria-pressed={weekdays.includes(day)}
                  className={weekdays.includes(day) ? 'active' : ''}
                  key={`${name}-${day}`}
                  onClick={() =>
                    setWeekdays((current) =>
                      current.includes(day)
                        ? current.filter((item) => item !== day)
                        : [...current, day].sort()
                    )
                  }
                >
                  {name}
                </button>
              ))}
            </div>
          )}
          <label>
            Model for every run
            <select
              value={modelId}
              onChange={(event) => {
                setModelTouched(true);
                setModelId(event.target.value);
              }}
            >
              {!eligibleModels.length && <option value="">Connect an AI provider first</option>}
              {eligibleModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </select>
          </label>
          <small className="schedule-zone">
            Times are {timeZone}. Anything consequential still waits for you.
          </small>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <button
            className="primary wide"
            disabled={
              busy ||
              !workspaceId ||
              !prompt.trim() ||
              !modelId ||
              (kind === 'weekly' && !weekdays.length)
            }
            onClick={() => void create()}
          >
            <CalendarClock /> {busy ? 'Saving…' : 'Create schedule'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
