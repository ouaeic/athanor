/**
 * The table this whole step exists to produce: cache gain and quality cost, on the same rows.
 *
 * Every previous argument about `context.ts` has been settled on one axis. The plan quotes cache
 * percentages; the eval suite counts steps and tokens; nothing anywhere has been able to say what a
 * narrower window costs the model, so "49/49 still pass" has been standing in for an answer to a
 * question it cannot reach. A row here carries both, measured on the same sixty requests, and the
 * columns are deliberately ordered cost-first so the gain is read against something.
 *
 * The committed baseline is a tripwire, not a specification. A change that moves a number here is
 * a decision about what athanor's agent can still remember, and the intended way to make it is to
 * re-accept the baseline in the commit that moves it, with the new figure quoted in the message.
 */
import { judgeCeiling } from './probes.js';
import { meanCeiling, tokensPerTask, type Measurement } from './measure.js';
import { PROBE_KINDS } from './probes.js';

export interface BaselineRow {
  readonly availability: number;
  readonly tokensPerTask: number;
  readonly cacheReadShare: number;
  readonly newestReasoningSteps: number;
  readonly unrecoverableLosses: number;
}

export type Baseline = Record<string, BaselineRow>;

export const rowKey = (measurement: Measurement): string =>
  `${measurement.trajectoryId}/${measurement.configurationId}`;

/** Mean availability across every probe, on the judge's 0-5 scale. */
export const availabilityOf = (measurement: Measurement): number => meanCeiling(measurement);

export const baselineFrom = (measurements: readonly Measurement[]): Baseline => {
  const baseline: Baseline = {};
  for (const measurement of measurements)
    baseline[rowKey(measurement)] = {
      availability: availabilityOf(measurement),
      tokensPerTask: tokensPerTask(measurement),
      cacheReadShare: Math.round(measurement.meanCacheReadShare * 1_000) / 1_000,
      newestReasoningSteps: measurement.newestReasoningSteps,
      unrecoverableLosses: measurement.unrecoverableLosses
    };
  return baseline;
};

/**
 * What counts as a regression.
 *
 * Availability and the reasoning-window count are exact: they are integer-derived and nothing but
 * a real change to what the model can read moves them, so a band would only hide the thing this
 * file is for. Tokens per task gets 2%, the same band `evals/report.ts` gives its own token
 * columns, because the catalogue and the operating contract drift with unrelated work.
 */
export const check = (
  measurement: Measurement,
  baseline: Baseline | undefined
): readonly string[] => {
  const expected = baseline?.[rowKey(measurement)];
  if (!expected) return [];
  const failures: string[] = [];
  const availability = availabilityOf(measurement);
  if (availability < expected.availability)
    failures.push(
      `probe availability ${availability.toFixed(2)} is below the accepted ${expected.availability.toFixed(2)}: the model can read less than it could`
    );
  if (measurement.newestReasoningSteps < expected.newestReasoningSteps)
    failures.push(
      `the current turn's own reasoning survived ${measurement.newestReasoningSteps} steps, accepted ${expected.newestReasoningSteps}`
    );
  if (measurement.unrecoverableLosses > expected.unrecoverableLosses)
    failures.push(
      `${measurement.unrecoverableLosses} unrecoverable losses, accepted ${expected.unrecoverableLosses}: no tool call brings these back`
    );
  const tokens = tokensPerTask(measurement);
  if (tokens > expected.tokensPerTask * 1.02)
    failures.push(
      `tokens per task ${tokens.toLocaleString('en-GB')} is over the accepted ${expected.tokensPerTask.toLocaleString('en-GB')} by more than 2%`
    );
  return failures;
};

const pad = (value: string, width: number): string => value.padEnd(width);
const padStart = (value: string, width: number): string => value.padStart(width);

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

export interface JudgedScore {
  readonly probeId: string;
  readonly score: number;
}

export const render = (
  measurements: readonly Measurement[],
  baseline: Baseline | undefined,
  judged: ReadonlyMap<string, readonly JudgedScore[]> = new Map()
): string => {
  const lines: string[] = [];
  const byTrajectory = new Map<string, Measurement[]>();
  for (const measurement of measurements) {
    const list = byTrajectory.get(measurement.trajectoryId) ?? [];
    list.push(measurement);
    byTrajectory.set(measurement.trajectoryId, list);
  }

  for (const [trajectoryId, rows] of byTrajectory) {
    lines.push('', trajectoryId, '='.repeat(trajectoryId.length));
    const header = [
      pad('configuration', 30),
      padStart('avail', 6),
      ...PROBE_KINDS.map((kind) => padStart(kind.slice(0, 5), 6)),
      padStart('judged', 7),
      padStart('tokens/task', 12),
      padStart('rework', 8),
      padStart('unrec', 6),
      padStart('cache', 7),
      padStart('prefix', 7),
      padStart('own-think', 10)
    ].join(' ');
    lines.push(header, '-'.repeat(header.length));
    // The shipped row leads and every other row is printed as a delta against it, because the
    // question is never "is 3.7 good" but "is this change worth what it costs".
    const shipped = rows.find((row) => row.configurationId === 'shipped');
    for (const row of rows) {
      const scores = judged.get(rowKey(row));
      const judgedMean = scores?.length
        ? (scores.reduce((sum, score) => sum + score.score, 0) / scores.length).toFixed(2)
        : '-';
      const delta =
        shipped && row !== shipped
          ? ` (${(availabilityOf(row) - availabilityOf(shipped) >= 0 ? '+' : '') + (availabilityOf(row) - availabilityOf(shipped)).toFixed(2)})`
          : '';
      lines.push(
        [
          pad(row.configurationId, 30),
          padStart(availabilityOf(row).toFixed(2), 6),
          ...PROBE_KINDS.map((kind) => padStart(meanCeiling(row, kind).toFixed(2), 6)),
          padStart(judgedMean, 7),
          padStart(tokensPerTask(row).toLocaleString('en-GB'), 12),
          padStart(row.reworkTokens.toLocaleString('en-GB'), 8),
          padStart(String(row.unrecoverableLosses), 6),
          padStart(percent(row.meanCacheReadShare), 7),
          padStart(percent(row.meanPrefixShare), 7),
          padStart(`${row.newestReasoningSteps}/${row.steps.length}`, 10)
        ].join(' ') + delta
      );
    }

    for (const row of rows) {
      const failures = check(row, baseline);
      for (const failure of failures) lines.push(`  ! ${row.configurationId}: ${failure}`);
    }
  }

  lines.push('', 'Per-probe availability at the step the task needed it (0-5 ceiling)', '');
  const probeIds = measurements[0]?.probes.map((outcome) => outcome.probe.id) ?? [];
  const width = Math.max(24, ...probeIds.map((id) => id.length));
  for (const [trajectoryId, rows] of byTrajectory) {
    lines.push(trajectoryId);
    lines.push(
      [
        pad('probe', width),
        ...rows.map((row) => padStart(row.configurationId.slice(0, 12), 13))
      ].join(' ')
    );
    for (const id of probeIds) {
      const cells = rows.map((row) => {
        const outcome = row.probes.find((candidate) => candidate.probe.id === id);
        return padStart(outcome ? judgeCeiling(outcome.atAsk.retained).toFixed(1) : '-', 13);
      });
      lines.push([pad(id, width), ...cells].join(' '));
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
};
