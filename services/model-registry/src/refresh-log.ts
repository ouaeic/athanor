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
