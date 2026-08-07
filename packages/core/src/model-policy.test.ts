import { describe, expect, it } from 'vitest';
import type { ModelRelease } from '@athanor/contracts';
import {
  UNMEASURED_QUALITY_PRIOR,
  blendWeights,
  blendedPricePerMillionTokens,
  classifyModelTask,
  coarsenTaskKind,
  contextHeadroomScore,
  effectivePricePerMillionTokens,
  inferModelTask,
  isModelEligible,
  isPrivacyRouteEligible,
  modelTaskKinds,
  priceCeilingBreach,
  qualityScore,
  rankModels,
  readRoutingMetadata,
  taskProfile,
  type ModelRequest,
  type RoutableModel,
  type RoutingMetadata
} from './model-policy.js';

const base: ModelRelease = {
  id: 'fast',
  providerModelId: 'fast',
  displayName: 'Fast',
  provider: 'openrouter',
  revision: '1',
  availability: 'available',
  openness: 'permissive_open_weight',
  license: 'Apache-2.0',
  commercialUse: true,
  privacyRoute: 'provider_zdr',
  contextTokens: 128_000,
  modalities: ['text'],
  capabilities: ['chat', 'tools'],
  usageClass: 'light',
  recommendationTags: [],
  measuredQuality: 0.7,
  measuredLatencyMs: 300,
  updatedAt: new Date().toISOString()
};

const request: ModelRequest = {
  privacyRoute: 'provider_zdr',
  requiredCapabilities: ['tools'],
  requiredModalities: ['text'],
  minContextTokens: 32_000,
  preference: 'balanced'
};

describe('model policy', () => {
  it('filters privacy and commercial constraints before ranking', () => {
    const blocked = { ...base, id: 'blocked', commercialUse: false, measuredQuality: 1 };
    const external = { ...base, id: 'external', privacyRoute: 'external' as const };
    const ranked = rankModels([blocked, external, base], {
      privacyRoute: 'provider_zdr',
      requiredCapabilities: ['tools'],
      requiredModalities: ['text'],
      minContextTokens: 32_000,
      preference: 'balanced'
    });
    expect(ranked.map((item) => item.model.id)).toEqual(['fast']);
  });

  it('ranks against the benchmark dimension that matches the task', () => {
    const coding = {
      ...base,
      id: 'coding',
      measuredQuality: 0.8,
      codingQuality: 0.98,
      agenticQuality: 0.55,
      intelligenceQuality: 0.7
    };
    const agentic = {
      ...base,
      id: 'agentic',
      measuredQuality: 0.8,
      codingQuality: 0.6,
      agenticQuality: 0.97,
      intelligenceQuality: 0.75
    };
    const best = { ...request, preference: 'best' as const };
    expect(rankModels([agentic, coding], { ...best, taskKind: 'coding' })[0]?.model.id).toBe(
      'coding'
    );
    expect(rankModels([agentic, coding], { ...best, taskKind: 'agentic' })[0]?.model.id).toBe(
      'agentic'
    );
    expect(inferModelTask('Refactor this TypeScript repository and run tests')).toBe('coding');
    expect(inferModelTask('Research the latest evidence and compare sources')).toBe('agentic');
    expect(inferModelTask('Explain partial pooling')).toBe('general');
  });

  it('refuses a zero-retention route when the live endpoints lost their contract', () => {
    const lapsed = { ...base, id: 'lapsed', zeroDataRetentionAvailable: false, measuredQuality: 1 };
    expect(isPrivacyRouteEligible(lapsed, 'provider_zdr')).toBe(false);
    expect(rankModels([lapsed, base], request).map((item) => item.model.id)).toEqual(['fast']);
  });

  it('drops a reviewed model that no live provider endpoint currently serves', () => {
    const offline = { ...base, id: 'offline', providerAvailable: false, measuredQuality: 1 };
    expect(isModelEligible(offline, request)).toBe(false);
    expect(rankModels([offline, base], request).map((item) => item.model.id)).toEqual(['fast']);
  });

  it('prefers the cheap model for bulk summarisation and the strong one for deep reasoning', () => {
    const cheap = {
      ...base,
      id: 'cheap',
      usageClass: 'light' as const,
      intelligenceQuality: 0.62,
      inputUsdPerMillionTokens: 0.05,
      outputUsdPerMillionTokens: 0.2,
      capabilities: ['chat', 'tools', 'reasoning'] as ModelRelease['capabilities']
    };
    const strong = {
      ...base,
      id: 'strong',
      usageClass: 'extra_high' as const,
      intelligenceQuality: 0.94,
      inputUsdPerMillionTokens: 12,
      outputUsdPerMillionTokens: 60,
      capabilities: ['chat', 'tools', 'reasoning'] as ModelRelease['capabilities']
    };
    expect(
      rankModels([strong, cheap], { ...request, taskKind: 'bulk_summarisation' })[0]?.model.id
    ).toBe('cheap');
    expect(rankModels([cheap, strong], { ...request, taskKind: 'reasoning' })[0]?.model.id).toBe(
      'strong'
    );
  });

  it('prefers real context headroom for long-context work and low latency for conversation', () => {
    const wide = { ...base, id: 'wide', contextTokens: 1_000_000, measuredLatencyMs: 4_000 };
    const snappy = { ...base, id: 'snappy', contextTokens: 128_000, measuredLatencyMs: 200 };
    expect(rankModels([snappy, wide], { ...request, taskKind: 'long_context' })[0]?.model.id).toBe(
      'wide'
    );
    expect(rankModels([wide, snappy], { ...request, taskKind: 'conversation' })[0]?.model.id).toBe(
      'snappy'
    );
  });

  it('never lets a million-token window outweigh quality through context alone', () => {
    // Headroom is capped, so a weak model with an enormous window still loses a reasoning task.
    const wideWeak = {
      ...base,
      id: 'wide-weak',
      contextTokens: 2_000_000,
      intelligenceQuality: 0.4
    };
    const narrowStrong = {
      ...base,
      id: 'narrow-strong',
      contextTokens: 200_000,
      intelligenceQuality: 0.95
    };
    expect(contextHeadroomScore(2_000_000, 64_000)).toBeLessThanOrEqual(1);
    expect(
      rankModels([wideWeak, narrowStrong], { ...request, taskKind: 'reasoning' })[0]?.model.id
    ).toBe('narrow-strong');
  });

  it('treats a missing price as unknown rather than free', () => {
    expect(blendedPricePerMillionTokens(base)).toBeNull();
    expect(
      blendedPricePerMillionTokens({
        ...base,
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 5
      })
    ).toBeCloseTo(2, 10);
    const free = { ...base, id: 'free', inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 };
    const unknown = { ...base, id: 'unknown', usageClass: 'extra_high' as const };
    // The priced-at-zero model must beat the unpriced heavyweight when price dominates.
    expect(
      rankModels([unknown, free], { ...request, taskKind: 'bulk_summarisation' })[0]?.model.id
    ).toBe('free');
    // ...and an unpriced model is never excluded by a price ceiling it cannot be checked against.
    expect(isModelEligible(unknown, { ...request, maxUsdPerMillionTokens: 0.01 })).toBe(true);
    expect(
      isModelEligible(
        { ...base, inputUsdPerMillionTokens: 4, outputUsdPerMillionTokens: 4 },
        { ...request, maxUsdPerMillionTokens: 1 }
      )
    ).toBe(false);
  });

  it('scores an unmeasured model from its usage class instead of zeroing it', () => {
    const unmeasured = {
      ...base,
      id: 'unmeasured',
      measuredQuality: null,
      measuredLatencyMs: null
    };
    const scored = qualityScore(unmeasured, 'coding');
    expect(scored.source).toBe('usage_class');
    expect(scored.value).toBeGreaterThan(0);
    const ranked = rankModels([unmeasured], { ...request, taskKind: 'coding' });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.score).toBeGreaterThan(0);
    expect(ranked[0]?.reasons.join(' ')).toContain(
      'Not benchmarked; ranked at the 40th percentile'
    );
  });

  it('never lets an unmeasured model outrank a measured one on the sub-score that rewards capability', () => {
    // The benchmark columns are percentiles of the live catalogue, so the best model in the world
    // scores 1.0. It used to score its raw index over 100 - about 0.55 on agentic - and lose to
    // every unmeasured model's 0.72 or 0.80 prior, which inverted the whole ranking.
    const bestInTheWorld = {
      ...base,
      id: 'best',
      usageClass: 'extra_high' as const,
      agenticQuality: 1,
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 25
    };
    const unmeasured = {
      ...base,
      id: 'unmeasured',
      usageClass: 'extra_high' as const,
      measuredQuality: null,
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 25
    };
    expect(qualityScore(bestInTheWorld, 'agentic').value).toBe(1);
    expect(qualityScore(unmeasured, 'agentic')).toEqual({
      value: UNMEASURED_QUALITY_PRIOR,
      source: 'usage_class'
    });
    expect(
      rankModels([unmeasured, bestInTheWorld], { ...request, taskKind: 'agentic' })[0]?.model.id
    ).toBe('best');
    // Reachable, though: a model nobody has measured still sits above the weakest measured ones.
    const weak = { ...base, id: 'weak', agenticQuality: 0.2, measuredQuality: 0.2 };
    expect(
      rankModels([weak, unmeasured], { ...request, taskKind: 'agentic', preference: 'best' })[0]
        ?.model.id
    ).toBe('unmeasured');
  });

  it('refuses to score a route nobody has measured or described, and still lets it be picked by name', () => {
    const configured: RoutableModel = {
      ...base,
      id: 'custom/local',
      metadataSource: 'unknown',
      measuredQuality: null,
      measuredLatencyMs: null
    };
    expect(rankModels([configured, base], request).map((item) => item.model.id)).toEqual(['fast']);
    const picked = rankModels([configured, base], { ...request, requestedId: 'custom/local' });
    expect(picked.map((item) => item.model.id)).toEqual(['custom/local']);
    expect(qualityScore(configured, 'coding')).toEqual({ value: 0, source: 'unknown' });
    expect(picked[0]?.reasons.join(' ')).toContain('unrated');
  });

  it('falls back from the task benchmark to the overall score when the column is missing', () => {
    const overallOnly = { ...base, measuredQuality: 0.83 };
    expect(qualityScore(overallOnly, 'agentic')).toEqual({ value: 0.83, source: 'overall' });
    expect(qualityScore({ ...overallOnly, agenticQuality: 0.91 }, 'agentic')).toEqual({
      value: 0.91,
      source: 'benchmark'
    });
  });

  it('bends but does not replace the task profile when a preference is set', () => {
    const coding = taskProfile('coding');
    const fast = blendWeights(coding, 'fast');
    const best = blendWeights(coding, 'best');
    expect(fast.latency).toBeGreaterThan(best.latency);
    expect(best.quality).toBeGreaterThan(fast.quality);
    for (const weights of [fast, best, blendWeights(coding, 'balanced')])
      expect(weights.quality + weights.latency + weights.price + weights.context).toBeCloseTo(
        1,
        10
      );
    // Even at "fast", the ranking still reads the coding column rather than the intelligence one.
    const codingSpecialist = {
      ...base,
      id: 'coder',
      codingQuality: 0.99,
      intelligenceQuality: 0.4
    };
    const generalist = { ...base, id: 'generalist', codingQuality: 0.4, intelligenceQuality: 0.99 };
    expect(
      rankModels([generalist, codingSpecialist], {
        ...request,
        preference: 'fast',
        taskKind: 'coding'
      })[0]?.model.id
    ).toBe('coder');
  });

  it('honours an explicit pick only while it stays eligible', () => {
    const other = { ...base, id: 'other', measuredQuality: 1 };
    const picked = rankModels([base, other], { ...request, requestedId: 'fast' });
    expect(picked.map((item) => item.model.id)).toEqual(['fast']);
    expect(picked[0]?.reasons[0]).toBe('Explicitly selected by the user');
    const external = { ...base, privacyRoute: 'external' as const };
    expect(rankModels([external], { ...request, requestedId: 'fast' })).toEqual([]);
  });

  it('explains every ranked model in terms a person can read', () => {
    const ranked = rankModels(
      [
        {
          ...base,
          codingQuality: 0.88,
          inputUsdPerMillionTokens: 0.3,
          outputUsdPerMillionTokens: 1
        }
      ],
      { ...request, taskKind: 'coding' }
    );
    const first = ranked[0];
    expect(first).toBeDefined();
    expect(first?.explanation).toContain('coding');
    expect(first?.reasons).toContain('Served by a zero-retention endpoint');
    expect(first?.reasons.join(' ')).toContain('coding benchmark 88th percentile');
    expect(first?.reasons.join(' ')).toContain('$0.475 per million tokens blended');
    expect(first?.breakdown.weights.quality).toBeGreaterThan(0);
  });

  it('shows the published index and where it sits, not a synthetic decimal', () => {
    const ranked = rankModels(
      [{ ...base, agenticQuality: 1, agenticIndex: 55.3, benchmarkPopulation: 117 }],
      { ...request, taskKind: 'agentic' }
    );
    expect(ranked[0]?.reasons.join(' ')).toContain(
      'agentic benchmark 55.3, 100th percentile of 117 measured'
    );
  });

  it('counts the column the percentile was computed on, not the biggest column', () => {
    // A live catalogue carries 117 coding scores, 108 agentic and 107 intelligence. Reporting an
    // agentic percentile "of 117 measured" states a number that never measured this column.
    const model: RoutableModel = {
      ...base,
      agenticQuality: 0.99,
      agenticIndex: 55.3,
      codingQuality: 0.5,
      benchmarkPopulation: 117,
      benchmarkPopulations: { coding: 117, agentic: 108, intelligence: 107 }
    };
    expect(
      rankModels([model], { ...request, taskKind: 'agentic' })[0]?.reasons.join(' ')
    ).toContain('agentic benchmark 55.3, 99th percentile of 108 measured');
    expect(rankModels([model], { ...request, taskKind: 'coding' })[0]?.reasons.join(' ')).toContain(
      'coding benchmark 50th percentile of 117 measured'
    );
    // A model scored only on the overall mean has no single column, so it keeps the overall count.
    const overall: RoutableModel = { ...base, measuredQuality: 0.8, benchmarkPopulation: 114 };
    expect(
      rankModels([overall], { ...request, taskKind: 'agentic' })[0]?.reasons.join(' ')
    ).toContain('overall benchmark 80th percentile of 114 measured');
  });

  it('classifies the shape of the work from prompt and turn signals', () => {
    expect(classifyModelTask({ prompt: 'What does this screenshot show?' }).kind).toBe('vision');
    expect(classifyModelTask({ prompt: 'What is on the slide?', hasImages: true }).kind).toBe(
      'vision'
    );
    expect(
      classifyModelTask({ prompt: 'Summarise the meeting', attachedContextTokens: 400_000 }).kind
    ).toBe('long_context');
    expect(classifyModelTask({ prompt: 'Read the entire repository and map it' }).kind).toBe(
      'long_context'
    );
    expect(classifyModelTask({ prompt: 'Classify all these support tickets' }).kind).toBe(
      'bulk_summarisation'
    );
    expect(classifyModelTask({ prompt: 'Fix the failing unit test' }).kind).toBe('coding');
    expect(classifyModelTask({ prompt: 'Prove that this schedule is optimal' }).kind).toBe(
      'reasoning'
    );
    expect(classifyModelTask({ prompt: 'Browse for the cheapest flight' }).kind).toBe('agentic');
    expect(classifyModelTask({ prompt: 'Morning!', interactive: true }).kind).toBe('conversation');
    expect(classifyModelTask({ prompt: 'Morning!' }).kind).toBe('general');
    expect(classifyModelTask({ prompt: 'anything', internalPurpose: 'summarisation' }).kind).toBe(
      'bulk_summarisation'
    );
  });

  it('reports the signal that drove the classification', () => {
    const classified = classifyModelTask({ prompt: 'x', attachedContextTokens: 500_000 });
    expect(classified.signals[0]).toContain('500000 tokens');
  });

  it('collapses the full vocabulary onto the three kinds older callers pass', () => {
    expect(coarsenTaskKind('vision')).toBe('general');
    expect(coarsenTaskKind('long_context')).toBe('general');
    expect(coarsenTaskKind('bulk_summarisation')).toBe('general');
    expect(coarsenTaskKind('reasoning')).toBe('general');
    expect(coarsenTaskKind('conversation')).toBe('general');
    expect(coarsenTaskKind('coding')).toBe('coding');
    expect(coarsenTaskKind('agentic')).toBe('agentic');
  });

  it('gives every task kind a profile with normalised weights', () => {
    expect(modelTaskKinds).toHaveLength(8);
    for (const kind of modelTaskKinds) {
      const profile = taskProfile(kind);
      expect(profile.kind).toBe(kind);
      expect(profile.requiredCapabilities).toContain('chat');
      const { quality, latency, price, context } = profile.weights;
      expect(quality + latency + price + context).toBeCloseTo(1, 10);
    }
    expect(taskProfile('vision').requiredModalities).toContain('image');
    expect(taskProfile('vision').requiredCapabilities).toContain('vision');
  });
});

const opus: RoutableModel = {
  ...base,
  id: 'opus',
  displayName: 'Claude Opus 5',
  usageClass: 'high',
  intelligenceQuality: 1,
  agenticQuality: 1,
  inputUsdPerMillionTokens: 5,
  outputUsdPerMillionTokens: 25
};

const sonnet: RoutableModel = {
  ...base,
  id: 'sonnet',
  displayName: 'Claude Sonnet 5',
  usageClass: 'medium',
  intelligenceQuality: 0.9,
  agenticQuality: 0.9,
  inputUsdPerMillionTokens: 2,
  outputUsdPerMillionTokens: 10
};

const unpriced: RoutableModel = { ...base, id: 'unpriced', displayName: 'Unpriced' };

/** "The best benchmarked model for the task under $2 per million in and $10 per million out." */
const ceiling: ModelRequest = {
  ...request,
  taskKind: 'agentic',
  maxInputUsdPerMillionTokens: 2,
  maxOutputUsdPerMillionTokens: 10
};

describe('the owner price ceiling', () => {
  it('is inclusive at the boundary and judges the two rates separately', () => {
    expect(isModelEligible(sonnet, ceiling)).toBe(true);
    expect(isModelEligible(opus, ceiling)).toBe(false);
    expect(priceCeilingBreach(opus, ceiling)).toBe(
      '$5.00 per million input is above the $2.00 ceiling'
    );
    // A single blended number cannot express this: $3 in and $6 out blends to $3.75, under a
    // blended $4.00 ceiling, while breaking the $2.00 input rate the owner actually set.
    const blendedPass = {
      ...base,
      id: 'blended',
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 6
    };
    expect(blendedPricePerMillionTokens(blendedPass)).toBeCloseTo(3.75, 10);
    expect(isModelEligible(blendedPass, { ...request, maxUsdPerMillionTokens: 4 })).toBe(true);
    expect(isModelEligible(blendedPass, ceiling)).toBe(false);
  });

  it('refuses a model that publishes no price, and says so', () => {
    expect(priceCeilingBreach(unpriced, ceiling)).toBe('no published price');
    expect(isModelEligible(unpriced, ceiling)).toBe(false);
    // With no ceiling set, an unpublished price still must not shrink the pool.
    expect(isModelEligible(unpriced, request)).toBe(true);
  });

  it('judges the tier the task will actually reach', () => {
    const tiered: RoutableModel = {
      ...base,
      id: 'tiered',
      contextTokens: 1_000_000,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 6,
      priceTiers: [
        { minPromptTokens: 200_000, inputUsdPerMillionTokens: 4, outputUsdPerMillionTokens: 24 }
      ]
    };
    expect(isModelEligible(tiered, { ...ceiling, minContextTokens: 32_000 })).toBe(true);
    expect(isModelEligible(tiered, { ...ceiling, minContextTokens: 250_000 })).toBe(false);
  });

  it('never constrains a model the owner picked by name', () => {
    const picked = rankModels([opus, sonnet], { ...ceiling, requestedId: 'opus' });
    expect(picked.map((item) => item.model.id)).toEqual(['opus']);
  });
});

describe('latency and reliability', () => {
  it('drops the latency term entirely when nothing on this server has measured one', () => {
    const untimed = [
      { ...opus, measuredLatencyMs: null },
      { ...sonnet, measuredLatencyMs: null }
    ];
    const ranked = rankModels(untimed, {
      ...request,
      preference: 'fast',
      taskKind: 'conversation'
    });
    const weights = ranked[0]?.breakdown.weights;
    expect(ranked[0]?.breakdown.latency).toBeNull();
    expect(weights?.latency).toBe(0);
    expect((weights?.quality ?? 0) + (weights?.price ?? 0) + (weights?.context ?? 0)).toBeCloseTo(
      1,
      10
    );
    expect(ranked[0]?.reasons.join(' ')).toContain('Latency not measured on this server');
  });

  it('keeps ranking on latency once something has actually been timed', () => {
    const ranked = rankModels([opus, sonnet], { ...request, preference: 'fast' });
    expect(ranked[0]?.breakdown.weights.latency).toBeGreaterThan(0);
    expect(ranked[0]?.breakdown.latency).toEqual({ value: 0.99, source: 'measured' });
  });

  it('routes around a model whose endpoints were failing yesterday, unless it is all there is', () => {
    const flaky = { ...sonnet, id: 'flaky', uptimeLast1dPercent: 42, intelligenceQuality: 1 };
    const steady = { ...sonnet, id: 'steady', uptimeLast1dPercent: 99.99 };
    expect(rankModels([flaky, steady], request).map((item) => item.model.id)).toEqual(['steady']);
    const only = rankModels([flaky], request);
    expect(only.map((item) => item.model.id)).toEqual(['flaky']);
    expect(only[0]?.reasons.join(' ')).toContain('42.00% uptime over the last day');
  });

  it('keeps a route the provider is about to withdraw out of automatic selection', () => {
    const asOf = '2026-08-03T00:00:00.000Z';
    const retiring = { ...sonnet, id: 'retiring', expiresAt: '2026-08-10', intelligenceQuality: 1 };
    const successor = { ...sonnet, id: 'successor' };
    expect(
      rankModels([retiring, successor], { ...request, asOf }).map((item) => item.model.id)
    ).toEqual(['successor']);
    // A date far enough out is not a reason to stop using a model.
    const distant = { ...retiring, id: 'distant', expiresAt: '2098-12-31' };
    expect(
      rankModels([distant, successor], { ...request, asOf, preference: 'best' })[0]?.model.id
    ).toBe('distant');
    // ...and the owner can still choose the retiring route by name, with the date in front of them.
    const picked = rankModels([retiring, successor], {
      ...request,
      asOf,
      requestedId: 'retiring'
    });
    expect(picked[0]?.reasons.join(' ')).toContain('Provider withdraws this route on 2026-08-10');
  });
});

describe('effective price', () => {
  it('prices a resent transcript at the cache-read rate the route actually charges', () => {
    const caching: RoutableModel = { ...opus, cacheReadUsdPerMillionTokens: 0.5 };
    expect(blendedPricePerMillionTokens(caching)).toBeCloseTo(10, 10);
    // Three quarters of the input arrives as a cache read: (5*0.25 + 0.5*0.75)*0.75 + 25*0.25.
    expect(effectivePricePerMillionTokens(caching, taskProfile('agentic'))).toBeCloseTo(7.46875, 8);
    // Work that does not resend a transcript pays the prompt rate, so nothing is assumed for it.
    expect(effectivePricePerMillionTokens(caching, taskProfile('conversation'))).toBeCloseTo(
      10,
      10
    );
    // ...and a route that publishes no cache-read rate is priced at what it charges.
    expect(effectivePricePerMillionTokens(opus, taskProfile('agentic'))).toBeCloseTo(10, 10);
    const ranked = rankModels([caching], { ...request, taskKind: 'agentic' });
    expect(ranked[0]?.reasons.join(' ')).toContain(
      '$10.00 per million tokens blended, $7.47 once the prefix is cached'
    );
  });
});

/**
 * Typed as `Required`, so a field added to `RoutingMetadata` without being covered here fails to
 * compile. The round trip is the only thing standing between the catalogue refresh and a router
 * that reads none of what it collected.
 */
const everyRoutingField: Required<RoutingMetadata> = {
  metadataSource: 'measured',
  agenticIndex: 55.3,
  codingIndex: 78,
  intelligenceIndex: 60.7,
  benchmarkPopulation: 117,
  benchmarkPopulations: { coding: 117, agentic: 108, intelligence: 107 },
  cacheReadUsdPerMillionTokens: 0.5,
  cacheWriteUsdPerMillionTokens: 6.25,
  promptCacheStyle: 'explicit',
  supportsReasoningEffort: true,
  priceTiers: [
    { minPromptTokens: 200_000, inputUsdPerMillionTokens: 4, outputUsdPerMillionTokens: 24 }
  ],
  uptimeLast1dPercent: 99.98,
  expiresAt: '2026-12-31',
  maxOutputTokens: 64_000,
  knowledgeCutoff: '2026-01-31'
};

describe('routing metadata round trip', () => {
  it('carries every field the router reads through the journey the store puts it on', () => {
    const stored = JSON.parse(JSON.stringify({ ...base, ...everyRoutingField })) as unknown;
    expect(readRoutingMetadata(stored)).toEqual(everyRoutingField);
    // ...and off a live model exactly as off the blob it was stored in: one contract, both ways.
    expect(readRoutingMetadata({ ...base, ...everyRoutingField })).toEqual(everyRoutingField);
  });

  it('drops a malformed field on its own rather than taking the entry with it', () => {
    const damaged = {
      ...everyRoutingField,
      expiresAt: 12,
      promptCacheStyle: 'sometimes',
      priceTiers: [{ inputUsdPerMillionTokens: 4 }, 'nonsense'],
      benchmarkPopulations: ['117'],
      somethingElseEntirely: 'ignored'
    };
    const read = readRoutingMetadata(damaged);
    expect(read.expiresAt).toBeUndefined();
    expect(read.promptCacheStyle).toBeUndefined();
    expect(read.benchmarkPopulations).toBeUndefined();
    // A tier with no threshold cannot be evaluated, so it is not carried as one.
    expect(read.priceTiers).toEqual([]);
    expect(read).not.toHaveProperty('somethingElseEntirely');
    expect(read.metadataSource).toBe('measured');
    expect(read.maxOutputTokens).toBe(64_000);
  });

  it('keeps "never reported" apart from "publishes nothing"', () => {
    expect(readRoutingMetadata({ expiresAt: null })).toEqual({ expiresAt: null });
    expect('expiresAt' in readRoutingMetadata({})).toBe(false);
    expect(readRoutingMetadata(null)).toEqual({});
    expect(readRoutingMetadata('not a model')).toEqual({});
  });

  it('keeps the guards working after the round trip, which is the whole point of carrying it', () => {
    const asOf = '2026-08-03T00:00:00.000Z';
    const retiring = { ...sonnet, id: 'retiring', expiresAt: '2026-08-10', intelligenceQuality: 1 };
    const successor = { ...sonnet, id: 'successor' };
    const restore = (model: RoutableModel): RoutableModel => ({
      ...model,
      ...readRoutingMetadata(JSON.parse(JSON.stringify(model)) as unknown)
    });
    expect(
      rankModels([restore(retiring), restore(successor)], { ...request, asOf }).map(
        (item) => item.model.id
      )
    ).toEqual(['successor']);
    // The provenance guard survives too: an unmeasured route stays out of automatic ranking.
    const configured: RoutableModel = { ...base, id: 'custom/local', metadataSource: 'unknown' };
    expect(restore(configured).metadataSource).toBe('unknown');
    expect(rankModels([restore(configured), base], request).map((item) => item.model.id)).toEqual([
      'fast'
    ]);
  });
});

describe('task classification', () => {
  it('lets the caller name the kind of work instead of guessing at the words', () => {
    expect(classifyModelTask({ prompt: 'anything at all', declaredKind: 'reasoning' })).toEqual({
      kind: 'reasoning',
      signals: ['The caller named the kind of work']
    });
    // A declared kind outranks even an image attachment, because the caller has seen the turn.
    expect(
      classifyModelTask({ prompt: 'x', hasImages: true, declaredKind: 'bulk_summarisation' }).kind
    ).toBe('bulk_summarisation');
  });

  it('no longer treats an artefact as a plan', () => {
    // "document" used to sit in the agentic pattern, so a short prose edit was routed to the
    // agentic benchmark with a 128K reference window.
    expect(classifyModelTask({ prompt: 'Summarise this document for me' }).kind).toBe('general');
    expect(
      classifyModelTask({ prompt: 'Tidy up this document and tighten the wording' }).kind
    ).toBe('general');
    // Work that genuinely leaves this process still classifies as agentic.
    expect(classifyModelTask({ prompt: 'Browse for the cheapest flight' }).kind).toBe('agentic');
    expect(classifyModelTask({ prompt: 'Deploy the staging build' }).kind).toBe('agentic');
  });

  it('reaches every profile from the only entry point callers use', () => {
    // inferModelTask used to coarsen its answer to three kinds, which left five carefully written
    // profiles unreachable from the API.
    expect(inferModelTask('What does this screenshot show?')).toBe('vision');
    expect(inferModelTask('Read the entire repository and map it')).toBe('long_context');
    expect(inferModelTask('Classify all these support tickets')).toBe('bulk_summarisation');
    expect(inferModelTask('Prove that this schedule is optimal')).toBe('reasoning');
    expect(inferModelTask('Refactor this TypeScript repository and run tests')).toBe('coding');
    expect(inferModelTask('Explain partial pooling')).toBe('general');
  });
});
