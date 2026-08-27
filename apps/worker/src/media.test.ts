import { describe, expect, it } from 'vitest';
import { AUDIO_READ_MAX_SECONDS, type MediaModelOption } from '@athanor/contracts';
import {
  mediaDimension,
  resolvedTranscriptionRoute,
  TRANSCRIPTION_BILLING_MINUTE_SECONDS,
  transcriptionEstimateAtRate,
  transcriptionEstimateUsd,
  transcriptionRate,
  transcriptionRateFromReading,
  transcriptionRouteWithMeasuredRate,
  transcriptionWindow
} from './media.js';

const option = (overrides: Partial<MediaModelOption> = {}): MediaModelOption => ({
  id: 'openrouter/a-transcription-route',
  providerModelId: 'a-transcription-route',
  displayName: 'A transcription route',
  provider: 'openrouter',
  modality: 'transcription',
  usdPerImage: null,
  usdPerMillionCharacters: null,
  usdPerMinute: null,
  priceSource: 'unknown',
  recommendationTags: [],
  updatedAt: '2026-08-10T00:00:00.000Z',
  ...overrides
});

const priced = () =>
  resolvedTranscriptionRoute({
    transcription: option({ usdPerMinute: 0.006, priceSource: 'provider' })
  });

const unpriced = () => resolvedTranscriptionRoute({ transcription: option() });

/**
 * The two ceilings a first connection puts in place, from the one number the owner is asked for.
 * A ninety-minute recording is measured against these below because that is the exact case the
 * estimate used to wave through: the whole of the longest window one call can ask for.
 */
const MONTHLY_CAP_USD = 60;
const DAILY_CAP_USD = MONTHLY_CAP_USD / 4;

describe('what a minute of reading is known to cost', () => {
  it('prefers the published price to one measured here', () => {
    // The published figure is what the provider will bill; a measured one is what it billed for one
    // particular reading, which a route with tiered or rounded duration billing can differ from.
    expect(transcriptionRate(priced(), 0.02)).toEqual({ usdPerMinute: 0.006, source: 'published' });
  });

  it('falls to what this task has already been billed when nothing is published', () => {
    expect(transcriptionRate(unpriced(), 0.02)).toEqual({ usdPerMinute: 0.02, source: 'measured' });
  });

  it('says unknown rather than zero when neither exists', () => {
    expect(transcriptionRate(unpriced())).toEqual({ usdPerMinute: null, source: 'unknown' });
    expect(transcriptionRate(null)).toEqual({ usdPerMinute: null, source: 'unknown' });
  });

  it('refuses a price the route carries but does not stand behind', () => {
    // `priceKnown` is false on a route whose catalogue entry says `unknown`, and a figure sitting
    // beside that admission is not one to enforce a cap with.
    const doubtful = resolvedTranscriptionRoute({
      transcription: option({ usdPerMinute: 0.006, priceSource: 'unknown' })
    });
    expect(transcriptionRate(doubtful).source).toBe('unknown');
  });
});

describe('measuring a route from what the provider actually billed', () => {
  const reading = (
    overrides: Partial<Parameters<typeof transcriptionRateFromReading>[0]> = {}
  ) => ({
    costUsd: 0.006,
    billedSeconds: 60,
    costFromProvider: true,
    ...overrides
  });

  it('reads dollars per minute off the provider’s own figure', () => {
    expect(transcriptionRateFromReading(reading(), 60)).toBeCloseTo(0.006, 6);
    expect(transcriptionRateFromReading(reading({ billedSeconds: 30 }), 60)).toBeCloseTo(0.012, 6);
  });

  it('learns nothing from a cost this side worked out itself', () => {
    // `transcribe` multiplies duration by whatever per-minute price it was handed when the response
    // states no cost. Promoting that back to a measurement is how a guess ends up tagged as one.
    expect(transcriptionRateFromReading(reading({ costFromProvider: false }), 60)).toBeNull();
  });

  it('takes a provider-stated zero as a measurement, because it is one', () => {
    expect(transcriptionRateFromReading(reading({ costUsd: 0 }), 60)).toBe(0);
  });

  it('divides by nothing rather than by zero', () => {
    expect(transcriptionRateFromReading(reading({ billedSeconds: 0 }), 0)).toBeNull();
    expect(transcriptionRateFromReading(reading({ billedSeconds: null }), 60)).toBeCloseTo(
      0.006,
      6
    );
  });
});

describe('what a reading of this length is expected to cost', () => {
  it('prices by the minute, rounded up, because that is how duration is billed', () => {
    // Rounding down would make every card understate the job, and a card that understates is worse
    // than no card: the owner reads a number and is billed a different one.
    expect(transcriptionEstimateUsd(61, priced())).toBeCloseTo(0.012, 6);
    expect(transcriptionEstimateUsd(0, priced())).toBe(0);
  });

  it('prices an unpublished route from what this task measured', () => {
    expect(transcriptionEstimateUsd(AUDIO_READ_MAX_SECONDS, unpriced(), 0.02)).toBeCloseTo(1.8, 6);
  });

  it('still lands on zero when nobody anywhere has stated a price', () => {
    // The floor of a cost nothing on this computer has evidence about. What stops the guard being
    // asked to enforce a cap against it is the window below, not a number invented here.
    expect(transcriptionEstimateUsd(AUDIO_READ_MAX_SECONDS, unpriced())).toBe(0);
  });
});

describe('what the approval card is told about a route it has already paid for', () => {
  it('stops saying the cost cannot be known once the provider has said it', () => {
    // The card reads `priceKnown` and otherwise admits it cannot price the reading. That admission
    // is true until the first invoice and false afterwards, and the dispatch arm was already
    // pricing the same reading from the figure the card was denying it had.
    const measured = transcriptionRouteWithMeasuredRate(unpriced(), 0.006);
    expect(measured).toMatchObject({ usdPerMinute: 0.006, priceKnown: true });
    expect(transcriptionEstimateUsd(AUDIO_READ_MAX_SECONDS, measured)).toBeCloseTo(0.54, 6);
  });

  it('leaves a published price alone, and leaves an unmeasured route admitting it', () => {
    expect(transcriptionRouteWithMeasuredRate(priced(), 0.2)?.usdPerMinute).toBe(0.006);
    expect(transcriptionRouteWithMeasuredRate(unpriced())?.priceKnown).toBe(false);
    expect(transcriptionRouteWithMeasuredRate(null, 0.006)).toBeNull();
  });
});

describe('the stretch of a recording one reading may send', () => {
  const rateOf = (usdPerMinute: number | null) =>
    usdPerMinute === null
      ? ({ usdPerMinute: null, source: 'unknown' } as const)
      : ({ usdPerMinute, source: 'published' } as const);

  it('sends the whole of what was asked for once anyone has said what a minute costs', () => {
    expect(
      transcriptionWindow({ startSeconds: 0, endSeconds: 5_400, rate: rateOf(0.006) })
    ).toEqual({ endSeconds: 5_400, measuring: false });
    // No end named is the longest window one call can ask for, which is what the runner would have
    // cut to anyway.
    expect(transcriptionWindow({ startSeconds: 120, rate: rateOf(0.006) })).toEqual({
      endSeconds: 120 + AUDIO_READ_MAX_SECONDS,
      measuring: false
    });
  });

  it('cuts an unpriced reading to one billed minute, so the cap has something to work with', () => {
    expect(transcriptionWindow({ startSeconds: 0, rate: rateOf(null) })).toEqual({
      endSeconds: TRANSCRIPTION_BILLING_MINUTE_SECONDS,
      measuring: true
    });
    expect(
      transcriptionWindow({ startSeconds: 600, endSeconds: 5_400, rate: rateOf(null) })
    ).toEqual({ endSeconds: 600 + TRANSCRIPTION_BILLING_MINUTE_SECONDS, measuring: true });
  });

  it('never widens a window the caller asked to keep short', () => {
    // A short read of an unpriced route is already inside a billing minute, so nothing is cut and
    // nothing is announced as a measurement.
    expect(transcriptionWindow({ startSeconds: 0, endSeconds: 40, rate: rateOf(null) })).toEqual({
      endSeconds: 40,
      measuring: false
    });
  });

  it('ignores an end that does not come after the start', () => {
    expect(
      transcriptionWindow({ startSeconds: 300, endSeconds: 100, rate: rateOf(0.006) }).endSeconds
    ).toBe(300 + AUDIO_READ_MAX_SECONDS);
  });
});

/**
 * The case the estimate used to wave through, followed all the way to the cap.
 *
 * A ninety-minute recording on a box with the seeded ceilings has to behave the same way before and
 * after the provider publishes a price: the same audio read, the same money spent, the same cap
 * stopping it in the same place. All that changes is that the number the owner is shown is one
 * somebody stood behind.
 */
describe('a ninety-minute recording on a box with a cap', () => {
  const minutes = AUDIO_READ_MAX_SECONDS / 60;

  it('went past the guard as free, and now goes past it a measured minute at a time', () => {
    const rate = transcriptionRate(unpriced());
    // Before: the whole ninety minutes, priced at nothing, checked against nothing.
    expect(transcriptionEstimateAtRate(AUDIO_READ_MAX_SECONDS, rate)).toBe(0);
    // After: one minute leaves first, and the guard is asked about the rest with a real number.
    const first = transcriptionWindow({ startSeconds: 0, rate });
    expect(first).toEqual({ endSeconds: 60, measuring: true });

    const measured = transcriptionRateFromReading(
      { costUsd: 0.006, billedSeconds: 60, costFromProvider: true },
      60
    );
    const rest = transcriptionRate(unpriced(), measured);
    expect(rest.source).toBe('measured');
    expect(transcriptionWindow({ startSeconds: 60, rate: rest }).measuring).toBe(false);
    expect(transcriptionEstimateAtRate(AUDIO_READ_MAX_SECONDS - 60, rest)).toBeCloseTo(0.534, 6);
  });

  it('is not refused for money it would never have cost', () => {
    // A floor picked to feel safe is how an ordinary reading gets refused. Ninety minutes at the
    // rate this route actually billed is a few tenths of a percent of the day, so the reading runs.
    const rate = transcriptionRate(unpriced(), 0.006);
    expect(transcriptionEstimateAtRate(AUDIO_READ_MAX_SECONDS, rate)).toBeCloseTo(minutes * 0.006);
    expect(transcriptionEstimateAtRate(AUDIO_READ_MAX_SECONDS, rate)).toBeLessThan(DAILY_CAP_USD);
  });

  it('is stopped by the day’s ceiling once the route turns out to be an expensive one', () => {
    // The same ninety minutes on a route billing twenty cents a minute is eighteen dollars, which
    // is more than a day. Under the old estimate the guard was told this cost nothing.
    const rate = transcriptionRate(unpriced(), 0.2);
    expect(transcriptionEstimateAtRate(AUDIO_READ_MAX_SECONDS, rate)).toBeGreaterThan(
      DAILY_CAP_USD
    );
  });
});

describe('the bound applied to a dimension before anything is priced', () => {
  /*
   * The standing negative control for `mediaDimension`, which had none.
   *
   * `clamp` guards on `Number.isFinite` before it clamps, and deleting that one line left all
   * 1,178 tests in this package green while `mediaDimension('12px')` started returning NaN and
   * `mediaDimension(Infinity)` started returning the 4,096 ceiling. That is the incident named at
   * the top of media.ts wearing new clothes: a number the model wrote, never checked, arriving as
   * NaN and reaching pricing - except that this time it is the size rather than the estimate, and
   * a NaN dimension prices a generation at NaN, which compares false against every spending limit
   * there is.
   *
   * So the assertion is on the arithmetic and not on the happy path: a value that is not a finite
   * number must come back as the stated default, and every result must be a number the ceiling can
   * actually be compared against. `Math.min(max, Math.max(min, NaN))` is NaN, so a test that only
   * checked the range would pass on the mutant too.
   */
  // Labelled rather than stringified: half of these are the shapes that have no useful `String`,
  // which is the whole reason they reach `clamp` as something other than a number.
  const notNumbers: readonly (readonly [string, unknown])[] = [
    ['a string with units', '12px'],
    ['a word', 'abc'],
    ['an object', {}],
    ['an array', [1, 2]],
    ['null', null],
    ['omitted', undefined],
    ['NaN itself', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY]
  ];

  it('turns anything that is not a finite number into the stated default', () => {
    for (const [label, written] of notNumbers) expect(mediaDimension(written), label).toBe(1_024);
  });

  it('never hands pricing a value a spending limit would compare false against', () => {
    const priced: readonly (readonly [string, unknown])[] = [
      ...notNumbers,
      ['above the ceiling', 8_192],
      ['below the floor', -5],
      ['a numeric string', '2048'],
      ['an ordinary number', 300]
    ];
    for (const [label, written] of priced)
      expect(Number.isFinite(mediaDimension(written)), label).toBe(true);
  });

  it('still clamps a finite number to the range generate_media declares', () => {
    // The empty string is here and not above on purpose: it coerces to a finite 0, so it is a
    // number out of range rather than a non-number, and the floor is the right answer for it.
    expect(mediaDimension('')).toBe(256);
    expect(mediaDimension('2048')).toBe(2_048);
    expect(mediaDimension(8_192)).toBe(4_096);
    expect(mediaDimension(-5)).toBe(256);
  });
});
