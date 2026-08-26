import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Pause, Pencil, Play, Trash2, X, Zap } from 'lucide-react';
import { api } from './api.js';
import { describeFailure } from './failure-text.js';
import { Dialog } from './Dialog.js';
import {
  emptyScheduleForm,
  localDateTimeInput,
  scheduleBudget,
  scheduleDescription,
  scheduleEditPatch,
  scheduleFormChanged,
  scheduleFormFromSpec,
  scheduleLastRun,
  scheduleRunHref,
  scheduleSpecFromForm,
  scheduleStanding,
  scheduleZones
} from './schedule-rows.js';
import { useUndo } from './Undo.js';
import type { ScheduleForm } from './schedule-rows.js';
import type { CatalogueModel, TaskSchedule, Workspace } from './types.js';
import './schedule.css';

/**
 * One schedule, as the owner reads it.
 *
 * Four of the fields on this row were served by the box and rendered by nothing: the standing
 * instruction it will carry out unattended, when it last ran, which conversation that run became,
 * and what one run of it may spend. A watcher that fires at three in the morning is exactly the
 * thing whose row is the only chance anyone has to notice what it says - so the row says it.
 *
 * Exported so it can be rendered on its own: `Dialog` portals into the document body, which a
 * static render has no way to reach.
 */
export function ScheduleRow({
  schedule,
  modelName,
  runHref,
  editing,
  busy,
  onOpenRun,
  onEdit,
  onRun,
  onPauseOrResume,
  onDelete
}: {
  schedule: TaskSchedule;
  /** The catalogue's name for the model, or its id when the catalogue no longer lists it. */
  modelName: string;
  runHref: string | null;
  editing: boolean;
  busy: boolean;
  onOpenRun: (href: string, taskId: string) => void;
  onEdit: () => void;
  onRun: () => void;
  onPauseOrResume: () => void;
  onDelete: () => void;
}) {
  const lastRun = scheduleLastRun(schedule);
  const runTaskId = lastRun.taskId;
  return (
    <div
      className={`schedule-row schedule-row-full ${schedule.enabled ? '' : 'paused'} ${
        editing ? 'editing' : ''
      }`}
    >
      <CalendarClock />
      <span>
        <strong>{schedule.title}</strong>
        <small>{scheduleDescription(schedule.spec)}</small>
        <small>{scheduleStanding(schedule)}</small>
        <small>
          {lastRun.text}
          {runHref && runTaskId && (
            <>
              {' · '}
              <a
                className="schedule-run-link"
                href={runHref}
                onClick={(event) => {
                  // A modified click is the owner asking for a second tab. Let the browser have it.
                  if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                  event.preventDefault();
                  onOpenRun(runHref, runTaskId);
                }}
              >
                {lastRun.label}
              </a>
            </>
          )}
        </small>
        <small>{scheduleBudget(schedule, modelName)}</small>
        {/*
          Folded rather than open: five schedules with their instructions unfolded is a wall of
          paragraphs where a list should be, and the timing is what most visits are here for.
        */}
        <details className="schedule-prompt">
          <summary>What it tells athanor to do</summary>
          {schedule.prompt ? (
            <p>{schedule.prompt}</p>
          ) : (
            <p className="unreadable">
              This server cannot read the instruction on this schedule. It will still run; edit it
              to give it a new one.
            </p>
          )}
        </details>
      </span>
      <div className="schedule-row-actions">
        <button
          className="icon-btn"
          title="Edit schedule"
          aria-label={`Edit ${schedule.title}`}
          disabled={busy}
          onClick={onEdit}
        >
          <Pencil />
        </button>
        <button className="icon-btn" title="Run now" disabled={busy} onClick={onRun}>
          <Zap />
        </button>
        <button
          className="icon-btn"
          title={schedule.enabled ? 'Pause schedule' : 'Resume schedule'}
          disabled={busy}
          onClick={onPauseOrResume}
        >
          {schedule.enabled ? <Pause /> : <Play />}
        </button>
        <button
          className="icon-btn destructive"
          title="Delete schedule"
          disabled={busy}
          onClick={onDelete}
        >
          <Trash2 />
        </button>
      </div>
    </div>
  );
}

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
  const resolvedZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
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
  /*
   * Offered rather than stated. This used to be a `const` read off the browser and printed as a
   * fact under the form, so a schedule made from a hotel fired on hotel time for as long as it
   * lived - and could not be corrected afterwards, because schedules could not be edited at all.
   * The API has accepted any IANA zone the whole time and refuses an invalid one rather than
   * guessing at it.
   */
  const [timeZone, setTimeZone] = useState(resolvedZone);
  // Four hundred-odd strings out of the engine, and the form re-renders on every keystroke.
  const zones = useMemo(() => scheduleZones(resolvedZone), [resolvedZone]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removed, setRemoved] = useState<string[]>([]);
  /** The schedule loaded into the form, or nothing when the form is making a new one. */
  const [editing, setEditing] = useState<TaskSchedule | null>(null);
  /** The timing exactly as it was loaded, so an untouched one can be told from an edited one. */
  const [loadedForm, setLoadedForm] = useState<ScheduleForm | null>(null);
  const visibleSchedules = schedules.filter((schedule) => !removed.includes(schedule.id));
  const undo = useUndo();
  const modelName = (id: string): string =>
    models.find((model) => model.id === id)?.displayName ?? id;

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

  /** Back to an empty form, whether the edit was saved or abandoned. */
  const clearForm = () => {
    const blank = emptyScheduleForm(resolvedZone);
    setEditing(null);
    setLoadedForm(null);
    setTitle('');
    setPrompt(initialPrompt);
    setKind(blank.kind);
    setRunAt(blank.runAt);
    setLocalTime(blank.localTime);
    setEveryMinutes(blank.everyMinutes);
    setWeekdays(blank.weekdays);
    setTimeZone(blank.timeZone);
    setError('');
  };

  /*
   * Loading the row back into the form is the whole of the edit affordance. Everything the box
   * stores about the timing round-trips through `scheduleFormFromSpec`; a cron spec is the one that
   * does not, and it answers null so the timing controls can stand down rather than show a shape
   * that would overwrite it.
   */
  const beginEdit = (schedule: TaskSchedule) => {
    setEditing(schedule);
    setError('');
    setTitle(schedule.title);
    setPrompt(schedule.prompt);
    const form = scheduleFormFromSpec(schedule.spec, resolvedZone);
    setLoadedForm(form);
    if (!form) return;
    setKind(form.kind);
    setRunAt(form.runAt);
    setLocalTime(form.localTime);
    setEveryMinutes(form.everyMinutes);
    setWeekdays(form.weekdays);
    setTimeZone(form.timeZone);
  };

  /*
   * Opening the run from the row that reports it, without reloading the shell to do it.
   *
   * `App` writes `?task=` whenever the selection changes and reads it back on `popstate`, so
   * pushing the entry and announcing it is the same move the back button makes. The anchor keeps a
   * real `href` either way, so copy-link and open-in-new-tab still work on a row inside a dialog.
   */
  const openRun = (href: string, taskId: string) => {
    window.history.pushState({ taskId }, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
    onClose();
  };

  const timingLocked = editing?.spec.kind === 'cron';

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

  /*
   * Saving an edit sends only what moved.
   *
   * The route refuses a patch that changes nothing, and it recomputes `next_run_at` from any spec
   * it is given - so sending an untouched timing back would move tomorrow's run as a side effect of
   * fixing a typo in the name. `scheduleEditPatch` is where that comparison lives, and it compares
   * timings rather than the JSON they arrived in.
   */
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      const current: ScheduleForm = { kind, runAt, localTime, everyMinutes, weekdays, timeZone };
      let spec: TaskSchedule['spec'] | undefined;
      // Only a timing the owner actually moved is rebuilt. `scheduleFormChanged` says why.
      if (!timingLocked && loadedForm && scheduleFormChanged(loadedForm, current)) {
        const built = scheduleSpecFromForm(current);
        if (!built.ok) throw new Error(built.message);
        spec = built.spec;
      }
      const patch = scheduleEditPatch(editing, { title, prompt, ...(spec ? { spec } : {}) });
      if (!patch.ok) throw new Error(patch.message);
      await api.updateSchedule(editing.id, patch.patch);
      clearForm();
      await onChanged();
    } catch (cause) {
      setError(describeFailure(cause, 'Could not save schedule'));
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
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              modelName={modelName(schedule.modelId)}
              runHref={
                schedule.lastTaskId
                  ? scheduleRunHref(window.location.href, schedule.workspaceId, schedule.lastTaskId)
                  : null
              }
              editing={editing?.id === schedule.id}
              busy={busy}
              onOpenRun={openRun}
              onEdit={() => beginEdit(schedule)}
              onRun={async () => {
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
              onPauseOrResume={async () => {
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
              onDelete={() => {
                setRemoved((current) => [...current, schedule.id]);
                // A schedule cannot be edited out of the form after it has been deleted from under
                // it, and the undo below can put it back.
                if (editing?.id === schedule.id) clearForm();
                undo({
                  message: `Deleted \u201C${schedule.title}\u201D`,
                  commit: async () => {
                    await api.deleteSchedule(schedule.id);
                    await onChanged();
                  },
                  restore: () => setRemoved((current) => current.filter((id) => id !== schedule.id))
                });
              }}
            />
          ))}
        </div>
        <div className="schedule-form">
          <strong>{editing ? `Edit “${editing.title}”` : 'Create a schedule'}</strong>
          <label>
            Name {!editing && <small>optional</small>}
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
          {timingLocked && editing ? (
            <div className="schedule-fixed">
              <strong>{scheduleDescription(editing.spec)}</strong>
              <small>
                This timing was written as an advanced expression, which this form does not offer.
                Saving keeps it exactly as it is.
              </small>
            </div>
          ) : (
            <>
              <div className="schedule-grid">
                <label>
                  Repeats
                  <select
                    value={kind}
                    onChange={(event) => setKind(event.target.value as typeof kind)}
                  >
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
                        [
                          'Sunday',
                          'Monday',
                          'Tuesday',
                          'Wednesday',
                          'Thursday',
                          'Friday',
                          'Saturday'
                        ][day]
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
              {/* Only a repeating local time is anchored to a zone; a one-off is an instant. */}
              {(kind === 'daily' || kind === 'weekly') && (
                <label>
                  Time zone
                  <select value={timeZone} onChange={(event) => setTimeZone(event.target.value)}>
                    {zones.map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
          {editing ? (
            /*
              Declared read-only rather than quietly dropped. The route refuses a change to either
              with `schedule_model_immutable` - it does not answer 200 and leave the schedule where
              it was - so the form says the same thing the box would.
            */
            <div className="schedule-fixed">
              <strong>{modelName(editing.modelId)}</strong>
              <small>
                A schedule keeps the model and privacy route it was created with. Create a new
                schedule to run this on a different model.
              </small>
            </div>
          ) : (
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
          )}
          <small className="schedule-zone">
            {kind === 'daily' || kind === 'weekly'
              ? `Times are ${timeZone}.`
              : `Times are ${resolvedZone}, this browser's own.`}{' '}
            Anything consequential still waits for you.
          </small>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          {editing ? (
            <div className="schedule-form-actions">
              <button className="primary wide" disabled={busy} onClick={() => void save()}>
                <CalendarClock /> {busy ? 'Saving…' : 'Save changes'}
              </button>
              <button disabled={busy} onClick={clearForm}>
                Cancel
              </button>
            </div>
          ) : (
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
          )}
        </div>
      </div>
    </Dialog>
  );
}
