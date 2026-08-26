/**
 * Which model answers which request.
 *
 * A box has a catalogue rather than a model, and every request that leaves it has to choose: the
 * turn's own model for the turn, something cheap and long-context for a compaction, something with
 * the right capability for a transcription or a delegated mission. This file holds those choices
 * and the timeouts that go with them, so the rules can be read against each other rather than
 * found one call site at a time.
 *
 * Lifted out of `agent.ts` unchanged by Wave 7.1.
 */
import type { MediaModelOption, ModelRelease } from '@athanor/contracts';
import { readRoutingMetadata, type RoutingMetadata } from '@athanor/core';

/**
 * Which route a request is going to, and how that route caches a repeated prefix.
 *
 * The two travel together because they are read off the same catalogue entry and because sending
 * one without the other is the bug this exists to make unrepeatable. The catalogue works out how a
 * route caches from what it charges for cache writes and reads, stores it on the model, and the
 * provider adapter reads it off the request - and nothing ever carried it from one to the other, so
 * every request fell back to a two-vendor slug list that the comment in `prompt-cache.ts` already
 * describes as the thing that was fixed. On an explicit route the effect is total: the adapter
 * marks nothing, so the whole breakpoint apparatus in `context.ts` is computed each step, counted
 * into the cost event, and thrown away.
 *
 * Measured on one twenty-step task before this existed: 187,014 of 289,514 input tokens billed at
 * full rate, thirteen steps caching nothing at all, against a fixed head of about 12,000 tokens
 * that only ever needed paying for once.
 *
 * Every model call in this worker goes through here rather than writing `model:` by hand, so a new
 * call site cannot quietly opt out of caching again.
 */
export const routeTo = (
  model: {
    providerModelId: string;
  } & Record<string, unknown>
): {
  model: string;
  promptCacheStyle?: RoutingMetadata['promptCacheStyle'];
  maxOutputTokens?: number;
  supportsReasoningEffort?: boolean;
} => {
  const { promptCacheStyle, maxOutputTokens, supportsReasoningEffort } = readRoutingMetadata(model);
  return {
    model: model.providerModelId,
    ...(promptCacheStyle ? { promptCacheStyle } : {}),
    /*
     * The other two the catalogue collects and nothing carried.
     *
     * `maxOutputTokens` is what the route will write in one response, and the adapter clamps the
     * ask to it rather than sending past it - because a route that refuses the number answers
     * nothing at all, where a route that is asked for less than it allows simply writes less.
     * `supportsReasoningEffort` withholds a parameter a route does not understand, which matters
     * most under zero data retention: that posture demands the provider honour every parameter it
     * is given, so one it cannot honour is not a narrower answer, it is a 404 for a model the
     * catalogue correctly listed as available.
     *
     * Absent stays absent in both cases. `undefined` and `false` mean different things here - "the
     * refresh never reported this" is not "the route says no" - and the adapter reads them apart.
     */
    ...(typeof maxOutputTokens === 'number' && maxOutputTokens > 0 ? { maxOutputTokens } : {}),
    ...(typeof supportsReasoningEffort === 'boolean' ? { supportsReasoningEffort } : {})
  };
};

export type ModelCapability = ModelRelease['capabilities'][number];

/**
 * The capabilities a task can actually use from a model, rather than the ones its catalogue entry
 * advertises. A row the registry no longer serves, or that has no endpoint able to honour a
 * zero-retention task, serves nothing at all; and a model listed as vision-capable cannot be sent
 * an image unless its live modalities still accept one. Routing on the advertised list instead
 * lets a stale catalogue hand an image to a model that will reject it, or to a route the user's
 * privacy setting forbids. A zero-retention route also satisfies an ordinary task, so the check is
 * directional rather than an equality test.
 */
export const usableCapabilities = (
  model: ModelRelease,
  privacyRoute: string
): Set<ModelCapability> => {
  const routed =
    model.availability === 'available' &&
    model.providerAvailable !== false &&
    (privacyRoute !== 'provider_zdr' ||
      (model.privacyRoute === 'provider_zdr' && model.zeroDataRetentionAvailable !== false));
  if (!routed) return new Set();
  return new Set(
    model.capabilities.filter(
      (capability) => capability !== 'vision' || model.modalities.includes('image')
    )
  );
};

/**
 * The models a delegated mission may be run on, strongest first.
 *
 * Extracted so it can be asked a question. Inline it was four filters and a sort with two defects,
 * and both were invisible because the failure mode is a silent fallback to the lead rather than an
 * error.
 *
 * **The route test was an equality.** `entry.privacyRoute === task.privacyRoute` is the wrong
 * shape: the policy is directional, and a zero-retention route also satisfies an ordinary task -
 * which is what `usableCapabilities`' own comment says and what every other picker in this file
 * uses. On a default box (`AI_REQUIRE_ZDR` unset) a task's route is `external` while the catalogue
 * stamps `provider_zdr` on live entries, so the equality never matched, the pool was empty on every
 * such box, and `eligible[0] ?? lead` quietly ran every delegated mission ever run on one against
 * the lead. The equality also skipped the two liveness checks `usableCapabilities` makes - a
 * withdrawn row and a route that has lost its zero-retention endpoint were both still eligible.
 *
 * **It never asked whose provider the candidate was on.** `#gateway` throws `provider_model_mismatch`
 * for a model whose provider is not the configured credential's, and the sort is deterministic - so
 * on a box migrated from one provider to another, rows left behind by the old one could be chosen
 * for every mission, for the life of the box. The vision picker beside this has always had the
 * check; this is the same check, made against the lead because the lead is the model the task was
 * admitted on and therefore the one known to match the credential.
 *
 * Note that this reads the catalogue it is handed rather than refreshing it the way the vision
 * picker does through `#currentCatalog`, so `providerAvailable` here is as fresh as the caller's
 * read. Left alone deliberately: changing when the catalogue is refreshed is a different question
 * from which rows are eligible, and no measurement covers it.
 */
export const delegateSpecialists = (
  catalog: readonly ModelRelease[],
  privacyRoute: string,
  lead?: ModelRelease
): ModelRelease[] =>
  catalog
    .filter((entry) => {
      if (lead && entry.provider !== lead.provider) return false;
      const usable = usableCapabilities(entry, privacyRoute);
      return usable.has('tools') && usable.has('reasoning');
    })
    .sort(
      (left, right) =>
        (right.measuredQuality ?? 0.5) - (left.measuredQuality ?? 0.5) ||
        (left.benchmarkRank ?? Number.MAX_SAFE_INTEGER) -
          (right.benchmarkRank ?? Number.MAX_SAFE_INTEGER) ||
        right.contextTokens - left.contextTokens
    );

/**
 * Whether a recording may be sent to the model that would read it.
 *
 * Every other modality already asks. A chat model is routed through `usableCapabilities`, and so is
 * the vision specialist an image is handed to when the lead cannot see; audio was the one that
 * asked nobody, which made the owner's own voice the least protected thing on the box.
 *
 * The question goes to the owner's own transcription route, because that is the only place the
 * answer is recorded. It cannot go to the chat catalogue: a model that reads a recording declares
 * `transcription` where a chat model declares `text`, and the catalogue builder drops everything
 * that cannot answer with text, so a transcription id is never a row there. Asked of that
 * catalogue the question had exactly one answer on every box - no - which is a tool switched off
 * wearing the clothes of a privacy check.
 *
 * A route the owner has never chosen falls back to whatever the provider listed a moment ago, and
 * about that this box knows nothing at all. On a zero-retention task nothing at all is a refusal; a
 * recording is not the thing to guess about.
 *
 * An ordinary task keeps the route it has always had. Its owner has already accepted external
 * handling for this work, so asking here would close the tool rather than protect anyone.
 */
export const transcriptionRouteAllowed = (
  route: MediaModelOption | undefined,
  privacyRoute: string
): boolean => {
  if (privacyRoute !== 'provider_zdr') return true;
  return route?.zeroDataRetentionAvailable === true;
};

const USAGE_CLASS_RANK: Record<ModelRelease['usageClass'], number> = {
  light: 0,
  medium: 1,
  high: 2,
  extra_high: 3
};

/** Below this the condensed transcript would not fit alongside the brief it has to extend. */
export const COMPACTION_MIN_CONTEXT_TOKENS = 32_000;

/** A brief is short prose; a summariser that stalls must not hold the worker for the full 15 min. */
export const COMPACTION_REQUEST_TIMEOUT_MS = 120_000;

/**
 * A search is one round trip with a page of links at the end of it, and the agent is stopped for the
 * whole of it. Two minutes is already far past any search worth waiting for, and the caller has
 * `browser_action` to fall back on; holding a worker slot for fifteen minutes over a query is not a
 * trade this makes.
 */
export const WEB_SEARCH_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Enough for ten titles and ten addresses, and nothing like enough to be tempted into answering.
 * The reply text is discarded unread - only the sources attached to it are wanted.
 */
export const WEB_SEARCH_MAX_OUTPUT_TOKENS = 2_048;

/**
 * The cheapest model that can still write a faithful brief.
 *
 * Compaction reads the very window the lead model is about to overflow, so charging it at lead
 * rates would add a large recurring cost to exactly the long tasks that need it most, for a task -
 * faithful summarising of text already in front of it - that a light model does well. The candidate
 * must stay on the task's privacy route and on the one provider this run holds a credential for,
 * because `#gateway` refuses any other. Falling back to the lead model keeps compaction working on
 * a single-model registry rather than silently degrading to the deterministic summary.
 */
export const compactionModel = (
  catalog: readonly ModelRelease[],
  lead: ModelRelease,
  privacyRoute: string
): ModelRelease =>
  [...catalog]
    .filter(
      (entry) =>
        entry.provider === lead.provider &&
        entry.commercialUse &&
        entry.contextTokens >= COMPACTION_MIN_CONTEXT_TOKENS &&
        usableCapabilities(entry, privacyRoute).has('chat')
    )
    .sort(
      (left, right) =>
        USAGE_CLASS_RANK[left.usageClass] - USAGE_CLASS_RANK[right.usageClass] ||
        (left.inputUsdPerMillionTokens ?? Number.MAX_SAFE_INTEGER) -
          (right.inputUsdPerMillionTokens ?? Number.MAX_SAFE_INTEGER) ||
        right.contextTokens - left.contextTokens ||
        left.id.localeCompare(right.id)
    )[0] ?? lead;

/** Wording for the user-visible compaction signal; the interface shows this line in the timeline. */
export const compactionEventSummary = (input: {
  trigger: 'budget' | 'agent';
  condensedMessages: number;
  source: 'model' | 'deterministic';
}): string =>
  `${input.trigger === 'agent' ? 'Condensed a finished phase' : 'Condensed earlier work to stay inside the context window'}: ${
    input.condensedMessages
  } message${input.condensedMessages === 1 ? '' : 's'} ${
    input.source === 'model' ? 'summarised into' : 'recorded mechanically in'
  } the running brief`;
