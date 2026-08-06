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
