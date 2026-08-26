/**
 * What the registry says out loud about a refresh, and when it stays quiet.
 *
 * This service has no listener, no metrics endpoint and nothing watching it. A refresh that keeps
 * failing therefore has exactly one place it can be noticed: the journal, through `athanor logs`.
 * Left silent, a catalogue that stopped changing looks identical to a provider that shipped
 * nothing new for a month - so the first failure is reported, and so is the recovery.
 *
 * Repeats are deliberately suppressed. The loop runs hourly, and a line an hour for a provider
 * outage that lasts a weekend buries everything else in the unit's log.
 */
import type { RefreshOutcome } from './refresh-once.js';

const REASON_LIMIT = 200;

export const refreshFailureReason = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const cleaned = message.replaceAll(/\s+/g, ' ').trim();
  if (!cleaned) return 'no reason given';
  return cleaned.length > REASON_LIMIT ? `${cleaned.slice(0, REASON_LIMIT - 1)}…` : cleaned;
};

export const refreshLogLine = (input: {
  previousFailures: number;
  reason: string | null;
  intervalSeconds: number;
}): string | null => {
  if (input.reason !== null) {
    if (input.previousFailures > 0) return null;
    return (
      `athanor model registry: the model catalogue could not be refreshed (${input.reason}). ` +
      `The catalogue already in the database stays in use; retrying every ${input.intervalSeconds} seconds.\n`
    );
  }
  if (input.previousFailures === 0) return null;
  const attempts =
    input.previousFailures === 1 ? '1 failed attempt' : `${input.previousFailures} failed attempts`;
  return `athanor model registry: the model catalogue refreshed again after ${attempts}.\n`;
};

/**
 * The state above says nothing about, because nothing went wrong in it.
 *
 * A refresh that *fails* has been reported once since this file existed. A refresh that never
 * happens at all was reported never - and that is the same silence a healthy hourly refresh makes.
 * `catalogCredential` answers null for a box with no owner key yet, for an owner on their own
 * endpoint or on a provider this service cannot ask, and for a key the provider revoked; the loop
 * then had nothing to do, said nothing, and slept. Six months of that is a picker offering models
 * withdrawn last quarter at prices from last year, with no surface anywhere that would say so.
 *
 * Said at the same cadence as a failure and for the same reason: once when it starts, once when it
 * ends, because an hourly line for a state that lasts months buries everything else in the unit's
 * log. A brand-new box is exempt - `seeded` means the catalogue was empty and has just been filled
 * from the built-in list, which is not a catalogue going stale but a box being set up.
 */
export const catalogueFrozenLine = (input: {
  /** Whether this stretch of having nothing to refresh from has already been reported. */
  alreadySaid: boolean;
  state: RefreshOutcome['state'];
  models: number;
  lastRefreshAt: Date | null;
}): string | null => {
  if (input.state === 'refreshed') {
    if (!input.alreadySaid) return null;
    return (
      'athanor model registry: there is a provider key again, and the model catalogue is being ' +
      'refreshed from it.\n'
    );
  }
  // `failed` is the line above's to report, and reporting it here as well would say the same
  // outage twice in the same pass. `seeded` is a box being set up.
  if (input.state !== 'frozen' || input.alreadySaid) return null;
  const written = input.lastRefreshAt
    ? `last refreshed from a provider on ${input.lastRefreshAt.toISOString()}`
    : 'never refreshed from a provider on this computer';
  const held =
    input.models === 1
      ? 'its 1 model stays exactly as it is'
      : `its ${input.models} models stay exactly as they are`;
  return (
    `athanor model registry: there is no provider key this catalogue can be refreshed from, so ` +
    `${held} (${written}). A model the provider ` +
    `withdraws will go on being offered in the picker, and the prices a run is charged against ` +
    `are the ones recorded then. Saving a provider key in Settings is what starts the refresh.\n`
  );
};
