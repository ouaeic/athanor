import { describe, expect, it } from 'vitest';
import { UpdateTaskScheduleRequest, type TaskScheduleSpec } from '@athanor/contracts';
import {
  scheduleBudget,
  scheduleDescription,
  scheduleEditPatch,
  scheduleFormChanged,
  scheduleFormFromSpec,
  scheduleLastRun,
  scheduleSpecFromForm,
  scheduleStanding,
  scheduleZones,
  type ScheduleForm
} from './schedule-rows.js';

const form = (overrides: Partial<ScheduleForm> = {}): ScheduleForm => ({
  kind: 'daily',
  runAt: '2026-09-01T09:00',
  localTime: '09:00',
  everyMinutes: 60,
  weekdays: [1],
  timeZone: 'Europe/London',
  ...overrides
});

describe('what a schedule says it does', () => {
  it('reads back every shape the form can make', () => {
    expect(
      scheduleDescription({ kind: 'daily', timeZone: 'Europe/London', localTime: '09:00' })
    ).toBe('Daily · 09:00 · Europe/London');
    expect(
      scheduleDescription({
        kind: 'weekly',
        timeZone: 'Europe/London',
        localTime: '18:30',
        weekdays: [5, 1]
      })
    ).toBe('Mon, Fri · 18:30 · Europe/London');
  });

  /* Cron is never offered by the form, but the agent can create one and it has to read back. */
  it('reads back a schedule the agent made that the form cannot', () => {
    expect(scheduleDescription({ kind: 'cron', timeZone: 'UTC', expression: '0 6 * * 1-5' })).toBe(
      'Advanced · 0 6 * * 1-5 · UTC'
    );
  });

  it('says an interval the way a person would say it', () => {
    expect(scheduleDescription({ kind: 'interval', everyMinutes: 90 })).toBe('Every 90 minutes');
    expect(scheduleDescription({ kind: 'interval', everyMinutes: 60 })).toBe('Every hour');
    expect(scheduleDescription({ kind: 'interval', everyMinutes: 360 })).toBe('Every 6 hours');
    expect(scheduleDescription({ kind: 'interval', everyMinutes: 1_440 })).toBe('Every day');
  });

  it('does not print seconds nobody plans around', () => {
    expect(scheduleDescription({ kind: 'once', runAt: '2026-09-01T09:00:00.000Z' })).not.toMatch(
      /:\d\d:\d\d/
    );
  });
});

describe('where a schedule stands', () => {
  const schedule = { enabled: true, nextRunAt: '2026-09-01T09:00:00.000Z', lastErrorCode: null };

  it('separates paused from finished, which are not the same thing', () => {
    expect(scheduleStanding({ ...schedule, enabled: false })).toBe('Paused');
    expect(scheduleStanding({ ...schedule, nextRunAt: null })).toBe(
      'Finished — nothing left to run'
    );
    expect(scheduleStanding(schedule)).toContain('Next');
  });

  it('says the last run failed and that the schedule is still standing', () => {
    expect(scheduleStanding({ ...schedule, lastErrorCode: 'spend_cap_reached' })).toContain(
      'last run failed'
    );
    // The stored code belongs in the log, not on a row the owner reads.
    expect(scheduleStanding({ ...schedule, lastErrorCode: 'spend_cap_reached' })).not.toContain(
      'spend_cap'
    );
  });
});

describe('turning the form into a schedule the box will accept', () => {
  it('builds each of the four shapes the form offers', () => {
    expect(scheduleSpecFromForm(form())).toEqual({
      ok: true,
      spec: { kind: 'daily', timeZone: 'Europe/London', localTime: '09:00' }
    });
    expect(scheduleSpecFromForm(form({ kind: 'interval', everyMinutes: 120 }))).toEqual({
      ok: true,
      spec: { kind: 'interval', everyMinutes: 120 }
    });
  });

  it('orders the weekdays, so the row does not read back in click order', () => {
    const built = scheduleSpecFromForm(form({ kind: 'weekly', weekdays: [5, 0, 3] }));
    expect(built.ok && built.spec.kind === 'weekly' && built.spec.weekdays).toEqual([0, 3, 5]);
  });

  /*
   * The box refuses these, and a refusal that arrives as a 400 from a schema the owner cannot see
   * teaches nothing about which field to change.
   */
  it('refuses what the box would refuse, in words about the field', () => {
    const refusal = (overrides: Partial<ScheduleForm>): string => {
      const built = scheduleSpecFromForm(form(overrides));
      return built.ok ? '' : built.message;
    };
    expect(refusal({ kind: 'interval', everyMinutes: 5 })).toContain('15 minutes');
    expect(refusal({ kind: 'interval', everyMinutes: 20_000 })).toContain('week');
    expect(refusal({ localTime: '9am' })).toContain('hours and minutes');
    expect(refusal({ kind: 'weekly', weekdays: [] })).toContain('at least one day');
    expect(refusal({ kind: 'once', runAt: 'not a date' })).toContain('when this should run');
  });

  it('will not schedule something for a time that has already gone', () => {
    const built = scheduleSpecFromForm(form({ kind: 'once', runAt: '2020-01-01T09:00' }));
    expect(built.ok ? '' : built.message).toContain('already passed');
  });
});

describe('what the last run left behind', () => {
  const ran = {
    lastRunAt: '2026-08-20T07:00:00.000Z',
    lastTaskId: '00000000-0000-4000-8000-0000000000aa',
    lastErrorCode: null as string | null
  };

  /*
   * The row has been able to say "last run failed" since schedules existed, and the conversation
   * that failed was served beside it and read by nothing. The only remaining route was to scroll
   * the sidebar for a conversation the owner did not start.
   */
  it('carries the task id of a failed run, and names it as the one that failed', () => {
    const failed = scheduleLastRun({ ...ran, lastErrorCode: 'spend_cap_reached' });
    expect(failed.taskId).toBe('00000000-0000-4000-8000-0000000000aa');
    expect(failed.label).toContain('failed');
    expect(failed.text).toContain('Last run');
  });

  it('offers the run of a schedule that worked, without calling it a failure', () => {
    expect(scheduleLastRun(ran).label).not.toContain('failed');
    expect(scheduleLastRun(ran).taskId).toBe('00000000-0000-4000-8000-0000000000aa');
  });

  /* Never having run is not the same as having run and left nothing behind. */
  it('has nothing to open when the schedule has never fired', () => {
    expect(
      scheduleLastRun({ lastRunAt: null, lastTaskId: null, lastErrorCode: null })
    ).toMatchObject({ taskId: null, text: 'Has not run yet' });
  });
});

describe('what one run of a schedule may cost', () => {
  const budget = {
    modelId: 'openrouter/openai/gpt-oss-120b',
    privacyRoute: 'provider_zdr' as const,
    maxComputeCredits: 5,
    maxSpendUsd: null as number | null
  };

  it('prefers the money ceiling the owner set to the credits the box counts', () => {
    expect(scheduleBudget({ ...budget, maxSpendUsd: 2.5 }, 'GPT-OSS 120B')).toContain(
      '$2.50 a run'
    );
    expect(scheduleBudget({ ...budget, maxSpendUsd: 2.5 }, 'GPT-OSS 120B')).not.toContain(
      'credits'
    );
    expect(scheduleBudget(budget, 'GPT-OSS 120B')).toContain('5 credits a run');
  });

  it('says which way the run is routed, in the same words the composer uses', () => {
    expect(scheduleBudget(budget, 'GPT-OSS 120B')).toContain('private AI route');
    expect(scheduleBudget({ ...budget, privacyRoute: 'external' }, 'GPT-OSS 120B')).toContain(
      'provider data policy'
    );
  });

  /* A model that has left the catalogue still spends money every night; the id is what is left. */
  it('falls back to the model id when the catalogue no longer lists it', () => {
    expect(scheduleBudget(budget)).toContain('openrouter/openai/gpt-oss-120b');
  });
});

describe('which zone a schedule is anchored to', () => {
  it('offers the browser its own zone first, and only once', () => {
    const zones = scheduleZones('Europe/Lisbon');
    expect(zones[0]).toBe('Europe/Lisbon');
    expect(zones.filter((zone) => zone === 'Europe/Lisbon')).toHaveLength(1);
    // The engine's list is not the point; that a second zone can be chosen at all is.
    expect(zones.length).toBeGreaterThan(1);
  });

  /*
   * The refusal the owner was actually hitting: a schedule made while travelling fired on hotel
   * time for as long as it lived, because the zone was read off the browser and stated as a fact.
   */
  it('reads a schedule back in the zone it was anchored to, not the one reading it', () => {
    const built = scheduleSpecFromForm(form({ kind: 'daily', timeZone: 'Asia/Tokyo' }));
    expect(built.ok && built.spec).toEqual({
      kind: 'daily',
      timeZone: 'Asia/Tokyo',
      localTime: '09:00'
    });
    expect(built.ok && scheduleDescription(built.spec)).toContain('Asia/Tokyo');
  });
});

describe('loading a schedule back into the form that made it', () => {
  const roundTrip = (spec: TaskScheduleSpec): TaskScheduleSpec | string => {
    const loaded = scheduleFormFromSpec(spec, 'Europe/Lisbon');
    if (!loaded) return 'the form cannot hold this';
    const rebuilt = scheduleSpecFromForm(loaded);
    return rebuilt.ok ? rebuilt.spec : rebuilt.message;
  };

  /*
   * Editing meant deleting and retyping the instruction, the model and the timing from memory -
   * which orphans the run history the sidebar folds under the schedule's own id. This is the whole
   * of the fix, so every shape the form offers has to survive the trip out and back.
   */
  it('round-trips every shape the form can make', () => {
    expect(roundTrip({ kind: 'daily', timeZone: 'Asia/Tokyo', localTime: '07:30' })).toEqual({
      kind: 'daily',
      timeZone: 'Asia/Tokyo',
      localTime: '07:30'
    });
    expect(
      roundTrip({ kind: 'weekly', timeZone: 'Asia/Tokyo', localTime: '18:15', weekdays: [5, 1] })
    ).toEqual({ kind: 'weekly', timeZone: 'Asia/Tokyo', localTime: '18:15', weekdays: [1, 5] });
    expect(roundTrip({ kind: 'interval', everyMinutes: 90 })).toEqual({
      kind: 'interval',
      everyMinutes: 90
    });
    const later = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    const once = roundTrip({ kind: 'once', runAt: later.toISOString() });
    // A `datetime-local` input holds minutes, so the instant comes back rounded to one.
    expect(typeof once === 'object' && once.kind === 'once' && new Date(once.runAt).getTime()).toBe(
      Math.floor(later.getTime() / 60_000) * 60_000
    );
  });

  it('leaves an expression the form never offered alone rather than overwriting it', () => {
    expect(
      scheduleFormFromSpec({ kind: 'cron', timeZone: 'UTC', expression: '0 6 * * 1-5' }, 'UTC')
    ).toBeNull();
  });
});

describe('saving an edit', () => {
  const original = {
    title: 'Morning report',
    prompt: 'Read the overnight logs and write up anything that went wrong.',
    spec: { kind: 'daily', timeZone: 'Europe/Lisbon', localTime: '09:00' } as TaskScheduleSpec
  };
  const patchOf = (result: ReturnType<typeof scheduleEditPatch>): unknown =>
    result.ok ? result.patch : result.message;

  /*
   * Only what moved. The route recomputes `next_run_at` from any spec it is handed, so sending an
   * untouched timing back would move tomorrow's run as a side effect of fixing a typo in the name.
   */
  it('sends the field that changed and no other', () => {
    expect(
      patchOf(
        scheduleEditPatch(original, {
          title: 'Morning report',
          prompt: 'Read the overnight logs and page me only if a service is down.',
          spec: original.spec
        })
      )
    ).toEqual({ prompt: 'Read the overnight logs and page me only if a service is down.' });
    expect(
      patchOf(
        scheduleEditPatch(original, {
          title: 'Morning report',
          prompt: original.prompt,
          spec: { kind: 'daily', timeZone: 'Europe/Lisbon', localTime: '07:00' }
        })
      )
    ).toEqual({ spec: { kind: 'daily', timeZone: 'Europe/Lisbon', localTime: '07:00' } });
  });

  /* Both directions of the same trap: the same timing written differently is not a change. */
  it('does not call a timing changed because it came back written differently', () => {
    const weekly = {
      title: 'Weekly',
      prompt: 'Do the thing',
      spec: {
        kind: 'weekly',
        timeZone: 'UTC',
        localTime: '09:00',
        weekdays: [1, 5]
      } as TaskScheduleSpec
    };
    expect(
      patchOf(
        scheduleEditPatch(weekly, {
          title: 'Weekly',
          prompt: 'Do the thing',
          spec: { kind: 'weekly', timeZone: 'UTC', localTime: '09:00', weekdays: [5, 1] }
        })
      )
    ).toBe('Nothing has changed yet.');
    const once = {
      title: 'Once',
      prompt: 'Do the thing',
      spec: { kind: 'once', runAt: '2026-09-01T09:00:00.000Z' } as TaskScheduleSpec
    };
    expect(
      patchOf(
        scheduleEditPatch(once, {
          title: 'Once',
          prompt: 'Do the thing',
          spec: { kind: 'once', runAt: '2026-09-01T09:00:00Z' }
        })
      )
    ).toBe('Nothing has changed yet.');
  });

  /*
   * The route refuses a patch that changes nothing with `schedule_update_empty`. Refusing it here
   * means the owner reads a sentence about their own form instead of a code from a schema they
   * cannot see.
   */
  it('refuses a save with nothing in it, the way the box would', () => {
    expect(
      patchOf(scheduleEditPatch(original, { title: original.title, prompt: original.prompt }))
    ).toBe('Nothing has changed yet.');
  });

  it('refuses a cleared name or a cleared instruction rather than keeping the old one quietly', () => {
    expect(
      patchOf(scheduleEditPatch(original, { title: '  ', prompt: original.prompt }))
    ).toContain('name');
    expect(patchOf(scheduleEditPatch(original, { title: original.title, prompt: '' }))).toContain(
      'what athanor should do'
    );
  });

  /* A schedule whose instruction this server cannot decrypt answers with an empty string. */
  it('makes an unreadable instruction an edit that has to supply a new one', () => {
    const sealed = { ...original, prompt: '' };
    expect(patchOf(scheduleEditPatch(sealed, { title: sealed.title, prompt: '' }))).toContain(
      'what athanor should do'
    );
    expect(
      patchOf(scheduleEditPatch(sealed, { title: sealed.title, prompt: 'Read the logs again.' }))
    ).toEqual({ prompt: 'Read the logs again.' });
  });

  /*
   * The body the client will actually send, held against the schema the route parses it with. The
   * client's patch type is hand-written - this is what keeps it from drifting away from the box.
   */
  it('builds a body the route will parse', () => {
    const built = scheduleEditPatch(original, {
      title: 'Evening report',
      prompt: 'Read the overnight logs and page me only if a service is down.',
      spec: { kind: 'daily', timeZone: 'Asia/Tokyo', localTime: '19:00' }
    });
    expect(built.ok && UpdateTaskScheduleRequest.parse(built.patch)).toEqual({
      title: 'Evening report',
      prompt: 'Read the overnight logs and page me only if a service is down.',
      spec: { kind: 'daily', timeZone: 'Asia/Tokyo', localTime: '19:00' }
    });
    /*
     * And never these two. The route answers 409 `schedule_model_immutable` rather than accepting a
     * model change it cannot write, so a patch that carried either would turn every edit into a
     * refusal - and echoing the schedule's current values back would be a control that looks like
     * it can move the model and cannot.
     */
    expect(built.ok && Object.keys(built.patch)).not.toContain('modelId');
    expect(built.ok && Object.keys(built.patch)).not.toContain('privacyRoute');
  });
});

describe('whether the timing was actually moved', () => {
  /*
   * The reason an untouched timing is never rebuilt. Both of these were silent: the input holds
   * minutes, so rebuilding an untouched one-off shifts the run by up to fifty-nine seconds and the
   * box recomputes the next occurrence from it; and a one-time schedule that has already fired
   * cannot be rebuilt at all, so correcting its name would have been refused for a reason that has
   * nothing to do with the name.
   */
  it('reads an untouched form as untouched, whichever shape it holds', () => {
    for (const spec of [
      { kind: 'once', runAt: '2020-01-01T09:00:17.412Z' },
      { kind: 'daily', timeZone: 'Asia/Tokyo', localTime: '07:00' },
      { kind: 'weekly', timeZone: 'Asia/Tokyo', localTime: '07:00', weekdays: [1, 5] },
      { kind: 'interval', everyMinutes: 90 }
    ] as TaskScheduleSpec[]) {
      const loaded = scheduleFormFromSpec(spec, 'Europe/Lisbon');
      expect(loaded && scheduleFormChanged(loaded, { ...loaded })).toBe(false);
    }
  });

  it('notices every control the owner can move', () => {
    const loaded = scheduleFormFromSpec(
      { kind: 'weekly', timeZone: 'Asia/Tokyo', localTime: '07:00', weekdays: [1, 5] },
      'Europe/Lisbon'
    );
    if (!loaded) throw new Error('a weekly schedule loads into the form');
    expect(scheduleFormChanged(loaded, { ...loaded, localTime: '08:00' })).toBe(true);
    expect(scheduleFormChanged(loaded, { ...loaded, timeZone: 'Europe/Lisbon' })).toBe(true);
    expect(scheduleFormChanged(loaded, { ...loaded, weekdays: [1, 5, 6] })).toBe(true);
    expect(scheduleFormChanged(loaded, { ...loaded, kind: 'daily' })).toBe(true);
    // Clicking the same two days in the other order is not a change.
    expect(scheduleFormChanged(loaded, { ...loaded, weekdays: [5, 1] })).toBe(false);
  });
});
