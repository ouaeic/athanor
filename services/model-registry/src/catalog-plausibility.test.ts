import { describe, expect, it } from 'vitest';
import { implausibleReplacement } from './catalog-plausibility.js';

/**
 * A catalogue row as the importer writes one, with only the fields the gate reads.
 *
 * Deliberately not built through `ModelRelease`: the gate reads the rows the database actually
 * holds, which is what makes it survive an upstream shape change, and a fixture that parsed a
 * schema first would test a stricter world than the one the loop runs in.
 */
const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'openrouter/vendor/model',
  capabilities: ['chat', 'tools', 'reasoning'],
  inputUsdPerMillionTokens: 3,
  measuredQuality: 0.8,
  ...over
});

const many = (count: number, over: Record<string, unknown> = {}): Array<Record<string, unknown>> =>
  Array.from({ length: count }, (_unused, index) => row({ id: `openrouter/m-${index}`, ...over }));

describe('implausibleReplacement', () => {
  it('lets an ordinary refresh through, models coming and going', () => {
    expect(implausibleReplacement({ previous: many(300), live: many(287) })).toBeNull();
  });

  /*
   * The defect this exists for, in the form it has already taken once in this feed's history: a
   * field the importer reads is renamed upstream. Every row still arrives, every row still writes,
   * and `supported.has('tools')` is false for all of them - so the catalogue is replaced with 300
   * models that `selectModel` cannot rank, because it requires ['chat','tools']. Before this gate
   * the pass returned `refreshed`, `doctor` reported a current catalogue, and the owner's next
   * question produced nothing with no message naming a cause anywhere on the box.
   */
  it('refuses an answer that lost the tools capability for every model, which is what one renamed field looks like', () => {
    const refusal = implausibleReplacement({
      previous: many(300),
      live: many(300, { capabilities: ['chat'] })
    });
    expect(refusal).toContain('models that can be given tools');
    expect(refusal).toContain('0%');
    expect(refusal).toContain('100%');
    expect(refusal).toContain('kept');
  });

  it('refuses an answer that lost every price, which would have the owner raising a ceiling that is not the cause', () => {
    const refusal = implausibleReplacement({
      previous: many(300),
      live: many(300, { inputUsdPerMillionTokens: null })
    });
    expect(refusal).toContain('models with a published price');
  });

  it('refuses an answer that lost every benchmark, which is what ranks whatever is left', () => {
    expect(
      implausibleReplacement({ previous: many(300), live: many(300, { measuredQuality: null }) })
    ).toContain('models with a benchmark score');
  });

  /*
   * The false positive that made a count gate unusable, and the reason this compares shares.
   *
   * Moving MODEL_CATALOG_SCOPE to reviewed_open_weight takes a three-hundred-model catalogue to the
   * four reviewed seeds on purpose. A gate on counts refuses that for ever - and nothing in this
   * pass could tell it from the break above. The share is identical either side, because the four
   * that remain are described exactly as well as the three hundred were.
   */
  it('lets a deliberate scope change shrink the catalogue by 98%, because the answer is as well described as before', () => {
    expect(implausibleReplacement({ previous: many(300), live: many(4) })).toBeNull();
  });

  it('lets a provider withdraw most of its range, since withdrawing models is what the replace is for', () => {
    expect(implausibleReplacement({ previous: many(300), live: many(30) })).toBeNull();
  });

  it('says nothing about a fact the box never broadly had, so a thinly benchmarked provider is not gated on benchmarks', () => {
    const thinlyBenchmarked = [
      ...many(9, { measuredQuality: null }),
      ...many(1, { measuredQuality: 0.7 })
    ];
    expect(
      implausibleReplacement({
        previous: thinlyBenchmarked,
        live: many(10, { measuredQuality: null })
      })
    ).toBeNull();
  });

  it('has nothing to compare against on a box being set up, and does not stand in the way of the first answer', () => {
    expect(implausibleReplacement({ previous: [], live: many(300) })).toBeNull();
  });

  /*
   * An empty answer is refused a layer earlier - `refreshOpenRouterCatalog` throws
   * provider_catalog_empty on a body with no models - and `replaceModelCatalog` prunes nothing on
   * one anyway. Answering null here rather than a second refusal keeps one reason per failure.
   */
  it('leaves an empty answer to the layer that already refuses one', () => {
    expect(implausibleReplacement({ previous: many(300), live: [] })).toBeNull();
  });

  it('tolerates a real but survivable slide, and refuses the one past half', () => {
    const previous = many(100);
    const mostLost = [...many(60, { capabilities: ['chat'] }), ...many(40)];
    const justOverHalfKept = [...many(49, { capabilities: ['chat'] }), ...many(51)];
    expect(implausibleReplacement({ previous, live: mostLost })).not.toBeNull();
    expect(implausibleReplacement({ previous, live: justOverHalfKept })).toBeNull();
  });
});
