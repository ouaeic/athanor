/**
 * How a schedule reads, and what the form turns into.
 *
 * Scheduled work runs while nobody is watching, so the row describing it is the only chance the
 * owner has to notice that "every morning" is actually every ninety minutes. Both directions are
 * here — the sentence and the spec — so the description cannot drift from the thing it describes.
 */
import type { TaskSchedule, TaskScheduleSpec } from '@athanor/contracts';

const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Seconds are noise on a "next run" line: nobody plans around them. */
export const scheduleWhen = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ''
    : at.toLocaleString([], {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit'
      });
};

/** Minutes are how the box stores an interval and not how anyone says one. */
const everyPhrase = (minutes: number): string => {
  if (minutes % 1_440 === 0) {
    const days = minutes / 1_440;
    return `Every ${days === 1 ? 'day' : `${days} days`}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `Every ${hours === 1 ? 'hour' : `${hours} hours`}`;
  }
  return `Every ${minutes} minutes`;
};

export const scheduleDescription = (spec: TaskScheduleSpec): string => {
  if (spec.kind === 'once') return `Once · ${scheduleWhen(spec.runAt)}`;
  if (spec.kind === 'interval') return everyPhrase(spec.everyMinutes);
  if (spec.kind === 'daily') return `Daily · ${spec.localTime} · ${spec.timeZone}`;
  // Cron is never offered by the form; the agent can still create one and it must read back.
  if (spec.kind === 'cron') return `Advanced · ${spec.expression} · ${spec.timeZone}`;
  const days = [...spec.weekdays].sort((left, right) => left - right);
  const named = days.map((day) => dayNames[day] ?? String(day)).join(', ');
  return `${named} · ${spec.localTime} · ${spec.timeZone}`;
};

/** The second line: where this schedule stands right now, which is not the same as what it is. */
export const scheduleStanding = (
  schedule: Pick<TaskSchedule, 'enabled' | 'nextRunAt' | 'lastErrorCode'>
): string => {
  const state = !schedule.enabled
    ? 'Paused'
    : schedule.nextRunAt
      ? `Next ${scheduleWhen(schedule.nextRunAt)}`
      : // A one-off that has run has nothing left to do, and is not the same thing as paused.
        'Finished — nothing left to run';
  // The stored code is for the log. What belongs here is that the last run did not work and the
  // schedule is still standing.
  return schedule.lastErrorCode ? `${state} · last run failed` : state;
};

/**
 * What the last run left behind, and whether there is a conversation to open from the row.
 *
 * `lastRunAt` and `lastTaskId` have been served on every schedule since the schedule existed and
 * read by nothing, so the row could say "last run failed" and offer no way to find out why. The
 * only remaining route was to scroll the sidebar for a conversation the owner did not start.
 */
export interface ScheduleLastRun {
  /** When it last fired, or that it has not — which is not the same as "nothing went wrong". */
  text: string;
  /** The conversation that run became, when the box recorded one. */
  taskId: string | null;
  /** What opening it will show. A failed run is the one the owner is actually looking for. */
  label: string;
}

export const scheduleLastRun = (
  schedule: Pick<TaskSchedule, 'lastRunAt' | 'lastTaskId' | 'lastErrorCode'>
): ScheduleLastRun => ({
  text: schedule.lastRunAt ? `Last run ${scheduleWhen(schedule.lastRunAt)}` : 'Has not run yet',
  taskId: schedule.lastTaskId,
  label: schedule.lastErrorCode ? 'Open the run that failed' : 'Open that run'
});

/**
 * Which model spends the owner's money here, and how much of it one run may spend.
 *
 * A watcher picks its model once, at creation, and then keeps it for months. Both numbers were
 * served and neither was shown, so "why is this costing that much every night" had no answer on
 * the only screen that lists the thing doing the spending.
 */
export const scheduleBudget = (
  schedule: Pick<TaskSchedule, 'modelId' | 'privacyRoute' | 'maxComputeCredits' | 'maxSpendUsd'>,
  modelName?: string
): string => {
  const route =
    schedule.privacyRoute === 'provider_zdr' ? 'private AI route' : 'provider data policy';
  // A ceiling in money is the one the owner set; credits are what the box falls back to counting.
  const ceiling =
    schedule.maxSpendUsd === null
      ? `${schedule.maxComputeCredits} credits a run`
      : `up to $${schedule.maxSpendUsd.toFixed(2)} a run`;
  return `${modelName || schedule.modelId} · ${route} · ${ceiling}`;
};

/**
 * Every zone this browser will name, with the one it is sitting in first.
 *
 * The API has always accepted any IANA zone and refuses an invalid one rather than guessing; the
 * form stated the browser's zone as a fact instead of offering it, so a schedule made from a hotel
 * fired on hotel time forever. `supportedValuesOf` is guarded because it is the one call here that
 * an older engine can be missing, and a missing list must not take the form down with it.
 */
export const scheduleZones = (resolved: string): string[] => {
  const supported =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const rest = (supported.length ? supported : ['UTC']).filter((zone) => zone !== resolved);
  return [resolved, ...rest];
};

export type ScheduleFormKind = 'once' | 'interval' | 'daily' | 'weekly';

export interface ScheduleForm {
  kind: ScheduleFormKind;
  /** As a `datetime-local` input holds it, in the browser's own zone. */
  runAt: string;
  localTime: string;
  everyMinutes: number;
  weekdays: number[];
  timeZone: string;
}

/** As a `datetime-local` input holds it: the browser's own zone, to the minute, no seconds. */
export const localDateTimeInput = (date: Date): string =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** What the form starts at with nothing loaded into it: an hour from now, daily, at nine. */
export const emptyScheduleForm = (timeZone: string): ScheduleForm => ({
  kind: 'daily',
  runAt: localDateTimeInput(new Date(Date.now() + 60 * 60_000)),
  localTime: '09:00',
  everyMinutes: 60,
  weekdays: [1],
  timeZone
});

/**
 * The spec the API stores, or the reason the form will not send. Bounds are checked here so a typo
 * becomes a sentence rather than a 400 from a schema the owner cannot see.
 */
export const scheduleSpecFromForm = (
  form: ScheduleForm
): { ok: true; spec: TaskScheduleSpec } | { ok: false; message: string } => {
  if (form.kind === 'once') {
    const at = new Date(form.runAt);
    if (Number.isNaN(at.getTime())) return { ok: false, message: 'Choose when this should run.' };
    if (at.getTime() <= Date.now())
      return { ok: false, message: 'That time has already passed. Choose one in the future.' };
    return { ok: true, spec: { kind: 'once', runAt: at.toISOString() } };
  }
  if (form.kind === 'interval') {
    if (
      !Number.isInteger(form.everyMinutes) ||
      form.everyMinutes < 15 ||
      form.everyMinutes > 10_080
    )
      return {
        ok: false,
        message: 'An interval is between 15 minutes and a week, in whole minutes.'
      };
    return { ok: true, spec: { kind: 'interval', everyMinutes: form.everyMinutes } };
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(form.localTime))
    return { ok: false, message: 'Give the time of day as hours and minutes.' };
  if (form.kind === 'daily')
    return {
      ok: true,
      spec: { kind: 'daily', timeZone: form.timeZone, localTime: form.localTime }
    };
  if (!form.weekdays.length) return { ok: false, message: 'Pick at least one day of the week.' };
  return {
    ok: true,
    spec: {
      kind: 'weekly',
      timeZone: form.timeZone,
      localTime: form.localTime,
      weekdays: [...form.weekdays].sort((left, right) => left - right)
    }
  };
};

/**
 * The other direction: a stored schedule loaded back into the form that could have made it.
 *
 * Editing a schedule meant deleting it and retyping the instruction, the model and the timing from
 * memory - which is how a standing instruction quietly gets shorter, and which orphans the run
 * history the sidebar folds under the schedule's own id. Loading the row into the form is the
 * whole of the fix.
 *
 * Cron is the one shape that does not come back, because the form never offered it. A schedule the
 * agent wrote as an expression answers `null` here and keeps its timing untouched through an edit;
 * `scheduleDescription` still reads it out, so the owner can see what they are keeping.
 */
export const scheduleFormFromSpec = (
  spec: TaskScheduleSpec,
  fallbackZone: string
): ScheduleForm | null => {
  const base = emptyScheduleForm(fallbackZone);
  if (spec.kind === 'once') {
    const at = new Date(spec.runAt);
    return {
      ...base,
      kind: 'once',
      runAt: Number.isNaN(at.getTime()) ? base.runAt : localDateTimeInput(at)
    };
  }
  if (spec.kind === 'interval')
    return { ...base, kind: 'interval', everyMinutes: spec.everyMinutes };
  if (spec.kind === 'daily')
    return { ...base, kind: 'daily', localTime: spec.localTime, timeZone: spec.timeZone };
  if (spec.kind === 'weekly')
    return {
      ...base,
      kind: 'weekly',
      localTime: spec.localTime,
      timeZone: spec.timeZone,
      weekdays: [...spec.weekdays]
    };
  return null;
};

/**
 * Whether the timing controls have actually been moved since the schedule was loaded into them.
 *
 * An untouched timing is never rebuilt, and this is what says it was untouched. Two reasons, both
 * of which would otherwise be silent: a `datetime-local` input holds minutes, so rebuilding an
 * untouched one-off shifts the run by up to fifty-nine seconds; and `scheduleSpecFromForm` refuses
 * a one-off in the past, so a one-time schedule that has already fired could not have its name
 * corrected at all. Neither is anything the owner asked for by opening the form.
 */
export const scheduleFormChanged = (left: ScheduleForm, right: ScheduleForm): boolean => {
  const days = (form: ScheduleForm): string =>
    [...form.weekdays].sort((first, second) => first - second).join(',');
  return (
    left.kind !== right.kind ||
    left.runAt !== right.runAt ||
    left.localTime !== right.localTime ||
    left.everyMinutes !== right.everyMinutes ||
    left.timeZone !== right.timeZone ||
    days(left) !== days(right)
  );
};

/**
 * Two specs compared as the timings they are rather than as the JSON they arrived in.
 *
 * A `once` spec makes the round trip through a `datetime-local` input and comes back with a
 * different string for the same instant, and a weekly one comes back in click order. Comparing the
 * text would have sent an edit on every save, and the point of only sending what changed is that
 * the box recomputes `next_run_at` from a new spec: an untouched timing that reads as touched moves
 * tomorrow's run.
 */
const specKey = (spec: TaskScheduleSpec): string => {
  if (spec.kind === 'once') return `once:${new Date(spec.runAt).getTime()}`;
  if (spec.kind === 'interval') return `interval:${spec.everyMinutes}`;
  if (spec.kind === 'daily') return `daily:${spec.timeZone}:${spec.localTime}`;
  if (spec.kind === 'cron') return `cron:${spec.timeZone}:${spec.expression}`;
  const days = [...spec.weekdays].sort((left, right) => left - right).join(',');
  return `weekly:${spec.timeZone}:${spec.localTime}:${days}`;
};

/** What the edit form holds. `spec` is absent when the timing is one the form cannot represent. */
export interface ScheduleEdit {
  title: string;
  prompt: string;
  spec?: TaskScheduleSpec;
}

/** Every key optional, and an omitted one is left exactly as it was. */
export interface ScheduleEditPatch {
  title?: string;
  prompt?: string;
  spec?: TaskScheduleSpec;
}

/**
 * The PATCH body, or the reason there is not one - carrying only the fields that actually moved.
 *
 * The route refuses a patch that would change nothing with `schedule_update_empty`, and refusing it
 * here instead means the owner reads a sentence about their own form rather than a code from a
 * schema they cannot see. An empty name or an empty instruction is refused for the same reason: the
 * box would refuse them too, and "keeps the one you have" is not what a cleared field looks like.
 *
 * An instruction this server could not decrypt arrives as an empty string, so an edit of that
 * schedule has to include a new one - which is exactly what the route says when it refuses.
 */
export const scheduleEditPatch = (
  original: Pick<TaskSchedule, 'title' | 'prompt' | 'spec'>,
  edit: ScheduleEdit
): { ok: true; patch: ScheduleEditPatch } | { ok: false; message: string } => {
  const title = edit.title.trim();
  const prompt = edit.prompt.trim();
  if (!title) return { ok: false, message: 'A schedule keeps a name. Give this one a name.' };
  if (!prompt) return { ok: false, message: 'Say what athanor should do on every run.' };
  const patch: ScheduleEditPatch = {};
  if (title !== original.title.trim()) patch.title = title;
  if (prompt !== original.prompt.trim()) patch.prompt = prompt;
  if (edit.spec && specKey(edit.spec) !== specKey(original.spec)) patch.spec = edit.spec;
  if (patch.title === undefined && patch.prompt === undefined && patch.spec === undefined)
    return { ok: false, message: 'Nothing has changed yet.' };
  return { ok: true, patch };
};

/**
 * Where the conversation a run became actually lives.
 *
 * `App` names the open conversation in the address bar - it writes `?task=` whenever the selection
 * changes and reads it back on `popstate` - so this is a real link the browser can follow, copy or
 * open in a second tab, not a handler dressed as one. The workspace goes with it because a reload
 * reads that too, and a stale one would open the run against the wrong computer for a moment.
 */
export const scheduleRunHref = (
  currentUrl: string,
  workspaceId: string,
  taskId: string
): string => {
  const url = new URL(currentUrl);
  url.searchParams.set('task', taskId);
  url.searchParams.set('workspace', workspaceId);
  return `${url.pathname}${url.search}`;
};
