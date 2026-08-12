import {
  AUDIO_READ_MAX_SECONDS,
  MEDIA_VIDEO_UNAVAILABLE_REASON,
  type MediaModelOption
} from '@athanor/contracts';
import { managedMediaModels } from '@athanor/model-gateway';

/**
 * What generated media costs, decided here rather than by the model.
 *
 * The estimate used to be a `generate_media` parameter: the model read the catalogue, then handed
 * the number back on the next call, and both the approval card and the tool result quoted whatever
 * it wrote. Nothing checked it, so a call carrying `estimatedCostUsd: 0` - or omitting it, which
 * arrived as NaN - spent the owner's provider money with no card in front of it. The prices are
 * the provider's own and the request already carries everything they depend on, so the number is
 * derived on this side of the boundary in both places and the model's opinion is not consulted.
 */
export const managedMediaCatalog = {
  image: {
    ...managedMediaModels.image,
    /** Flat per image up to a megapixel, then a small area surcharge, as the provider bills it. */
    estimate: (input: { width: number; height: number }) =>
      managedMediaModels.image.baseUsdPerImage +
      Math.max(0, (input.width * input.height) / 1_000_000 - 1) * 0.001
  },
  audio: {
    ...managedMediaModels.audio,
    estimate: (input: { characterCount: number }) =>
      (input.characterCount * managedMediaModels.audio.usdPerMillionCharacters) / 1_000_000
  },
  /**
   * Kept as an answer rather than an offer, and the one modality the owner cannot be given a
   * picker for.
   *
   * Image and speech became the owner's choice because there is a request shape behind each of
   * them - `/images` and `/audio/speech`, both exercised - so a catalogue of routes is a catalogue
   * of things that would actually run. There is no video request shape here at all: no endpoint,
   * no response parser, no pricing unit. A modality select listing video models would be a control
   * with nothing on the other side of it, which is worse than the refusal, so Settings states this
   * sentence where the picker would be instead.
   */
  video: {
    modelId: '',
    displayName: 'Video generation',
    license: 'not available',
    available: false,
    reason: MEDIA_VIDEO_UNAVAILABLE_REASON
  }
} as const;

/**
 * The routes the owner chose, as the API sealed them into the credential this worker decrypts.
 *
 * A resolved option rather than a preference, because this process has no media catalogue and no
 * business fetching one: it talks to a provider to run the request in front of it and for nothing
 * else, and a catalogue fetch per tool call would put two round trips in front of every generated
 * image. The screen that has the catalogue does the resolving, at the moment the owner chooses.
 */
export interface StoredMediaRoutes {
  image?: MediaModelOption;
  audio?: MediaModelOption;
  transcription?: MediaModelOption;
}

/**
 * The model a generation will actually use, and what this side believes it costs.
 *
 * Until now the two ids in the manifest above were the whole of the answer, in both the pricer and
 * the dispatch arm, which is what the owner meant by having no control over the media models:
 * there was nothing to control, because the choice was a constant. An owner who has never opened
 * the media section still falls back to those reviewed routes, so a box that has never resolved a
 * catalogue generates exactly as it did before.
 */
export interface ResolvedMediaModel {
  modelId: string;
  displayName: string;
  usdPerImage: number | null;
  usdPerMillionCharacters: number | null;
  usdPerMinute: number | null;
  voice: string | undefined;
  /**
   * Whether the price above came from anywhere at all. False means the provider published no cost
   * for this route and athanor has never measured it, which is the state the approval floor below
   * treats as "always ask" - see `mediaEstimateUsd`'s callers.
   */
  priceKnown: boolean;
}

export const resolvedMediaModel = (
  kind: 'image' | 'audio',
  routes?: StoredMediaRoutes
): ResolvedMediaModel => {
  const option = routes?.[kind];
  // A stored route for the wrong modality is not usable as this one's answer, and silently pricing
  // an image against a speech route is the kind of mix-up an owner would only see on the invoice.
  //
  // Nor is one that names no model. Nothing this worker can see validates the sealed blob - it is
  // decrypted and cast, because the screen that wrote it is the thing that parsed it - so a route
  // left empty by a catalogue that answered with a blank id would go out as a request with no model
  // on it, and what the provider does with that is its own business and the owner's bill. The
  // reviewed default is the honest answer to a choice that resolved to nothing.
  if (!option || option.modality !== kind || !option.providerModelId)
    return kind === 'image'
      ? {
          modelId: managedMediaModels.image.modelId,
          displayName: managedMediaModels.image.displayName,
          usdPerImage: managedMediaModels.image.baseUsdPerImage,
          usdPerMillionCharacters: null,
          usdPerMinute: null,
          voice: undefined,
          priceKnown: true
        }
      : {
          modelId: managedMediaModels.audio.modelId,
          displayName: managedMediaModels.audio.displayName,
          usdPerImage: null,
          usdPerMillionCharacters: managedMediaModels.audio.usdPerMillionCharacters,
          usdPerMinute: null,
          voice: managedMediaModels.audio.defaultVoice,
          priceKnown: true
        };
  return {
    modelId: option.providerModelId,
    displayName: option.displayName,
    usdPerImage: option.usdPerImage,
    usdPerMillionCharacters: option.usdPerMillionCharacters,
    usdPerMinute: option.usdPerMinute,
    voice: option.defaultVoice ?? undefined,
    priceKnown:
      option.priceSource !== 'unknown' &&
      (kind === 'image' ? option.usdPerImage !== null : option.usdPerMillionCharacters !== null)
  };
};

/**
 * The route that reads a recording, or nothing.
 *
 * Deliberately not folded into the resolver above, because it cannot keep that function's promise:
 * image and speech fall back to a reviewed model athanor has itself run and priced, and no such
 * model exists on this side for transcription. Inventing one would be a licence claim about
 * something nobody reviewed and a price about something nobody billed. Null means the owner has
 * chosen nothing yet, which the caller answers by asking the provider what it has - one request,
 * and only when there is no choice to honour.
 */
export const resolvedTranscriptionRoute = (
  routes?: StoredMediaRoutes
): ResolvedMediaModel | null => {
  const option = routes?.transcription;
  if (!option || option.modality !== 'transcription' || !option.providerModelId) return null;
  return {
    modelId: option.providerModelId,
    displayName: option.displayName,
    usdPerImage: null,
    usdPerMillionCharacters: null,
    usdPerMinute: option.usdPerMinute,
    voice: undefined,
    priceKnown: option.priceSource !== 'unknown' && option.usdPerMinute !== null
  };
};

/**
 * The unit transcription is quoted and billed in, and so the smallest stretch of a recording that
 * can be sent to find out what a minute of it costs.
 */
export const TRANSCRIPTION_BILLING_MINUTE_SECONDS = 60;

/**
 * What this computer is entitled to say a minute of reading costs on a route, and on what evidence.
 *
 * Three states rather than a number, because two of them used to arrive here as the same zero. A
 * published price is the provider's own figure carried on the owner's chosen route. A measured one
 * is arithmetic on a reading the provider has already billed, on this route, in this task - the
 * same kind of evidence the two seeded media prices carry, and the only kind this side can come by
 * for a route nobody publishes. Unknown is neither, and it is not free.
 */
export interface TranscriptionRate {
  usdPerMinute: number | null;
  source: 'published' | 'measured' | 'unknown';
}

const finiteRate = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * The strongest evidence available about a route's price, published beating measured.
 *
 * The published figure wins where there is one: it is what the provider will bill, whereas the
 * measured one is what it billed for a particular reading, and a route with tiered or rounded
 * duration billing can differ between the two.
 */
export const transcriptionRate = (
  model: ResolvedMediaModel | null,
  measuredUsdPerMinute?: number | null
): TranscriptionRate => {
  const published = model?.priceKnown ? finiteRate(model.usdPerMinute) : null;
  if (published !== null) return { usdPerMinute: published, source: 'published' };
  const measured = finiteRate(measuredUsdPerMinute);
  if (measured !== null) return { usdPerMinute: measured, source: 'measured' };
  return { usdPerMinute: null, source: 'unknown' };
};

/**
 * Dollars per minute, read back off a reading the provider itself put a price on.
 *
 * Only from the provider's own figure. `transcribe` falls back to multiplying duration by whatever
 * per-minute price it was handed when the response states no cost, and deriving a rate from that
 * would be this side reading its own guess back to itself and promoting it to a measurement - which
 * is exactly how a constant nobody measured ends up tagged as one.
 *
 * The provider's duration is preferred over the prepared one for the same reason the ledger prefers
 * it: what was billed is what a price per billed minute has to be divided by.
 */
export const transcriptionRateFromReading = (
  reading: { costUsd: number; billedSeconds: number | null; costFromProvider: boolean },
  preparedSeconds: number
): number | null => {
  if (!reading.costFromProvider) return null;
  const cost = finiteRate(reading.costUsd);
  const seconds = finiteRate(reading.billedSeconds) ?? finiteRate(preparedSeconds);
  if (cost === null || seconds === null || seconds <= 0) return null;
  return Math.round(((cost * 60) / seconds) * 1e6) / 1e6;
};

/**
 * What a reading of this length will cost at a known rate, before a second of it is sent.
 *
 * Rounded up to the minute, because that is how duration billing is quoted and rounding down would
 * make the card understate every job.
 */
export const transcriptionEstimateAtRate = (seconds: number, rate: TranscriptionRate): number =>
  Math.ceil(Math.max(0, seconds) / 60) * (rate.usdPerMinute ?? 0);

/**
 * What a reading is expected to cost, from its duration and the best price anyone has stated.
 *
 * A route nobody has priced still lands on zero here, and that zero is now a floor rather than a
 * claim: it is the true lower bound on a cost nothing on this computer has any evidence about, and
 * `transcriptionWindow` below is what stops the guard being asked to enforce a cap against it.
 * Inventing a number instead would put a price claim about a model nobody billed in front of the
 * owner, which is the defect this repository already carries once and is not repeating.
 */
export const transcriptionEstimateUsd = (
  seconds: number,
  model: ResolvedMediaModel | null,
  measuredUsdPerMinute?: number | null
): number => transcriptionEstimateAtRate(seconds, transcriptionRate(model, measuredUsdPerMinute));

/**
 * A route restated with the price this computer has since been billed for it.
 *
 * For the approval card, which reads `priceKnown` and otherwise says the cost cannot be known until
 * the provider bills it. That sentence is true of a route nobody has ever read a recording on, and
 * it stops being true the moment one has: the provider has stated a figure by then, and repeating
 * the admission in front of a number this side is holding is the interface reporting an absence it
 * could answer. A published price is left exactly as it was - it is the stronger evidence and this
 * has nothing to add to it.
 */
export const transcriptionRouteWithMeasuredRate = (
  route: ResolvedMediaModel | null,
  measuredUsdPerMinute?: number | null
): ResolvedMediaModel | null => {
  if (!route) return null;
  const rate = transcriptionRate(route, measuredUsdPerMinute);
  if (rate.source !== 'measured') return route;
  return { ...route, usdPerMinute: rate.usdPerMinute, priceKnown: true };
};

/**
 * The stretch of a recording one reading is allowed to send.
 *
 * The whole of what was asked for, once anyone has said what a minute costs. While nobody has, the
 * first reading is cut to a single billing minute - not to save the owner money, since the rest is
 * read by the calls that follow and the total duration billed is the same, but because a cap cannot
 * be enforced against an estimate of zero. Ninety minutes of unknown price went past the spend
 * guard in one request and the guard was told it was free; one minute of unknown price comes back
 * with the provider's own figure attached, and every minute after it is priced, checked against the
 * daily cap and refused if it does not fit.
 *
 * So a long recording behaves the same way before and after a provider publishes a price: the same
 * audio is read, the same money is spent, the same cap stops it in the same place. What changes is
 * that the number the owner is shown stops being a zero nobody stood behind.
 */
export const transcriptionWindow = (input: {
  startSeconds: number;
  endSeconds?: number | undefined;
  rate: TranscriptionRate;
}): { endSeconds: number; measuring: boolean } => {
  const start = Math.max(0, Math.floor(input.startSeconds));
  const asked = Number(input.endSeconds);
  const requested =
    Number.isFinite(asked) && asked > start
      ? Math.min(86_400, Math.floor(asked))
      : Math.min(86_400, start + AUDIO_READ_MAX_SECONDS);
  if (input.rate.usdPerMinute !== null) return { endSeconds: requested, measuring: false };
  const measuring = Math.min(requested, start + TRANSCRIPTION_BILLING_MINUTE_SECONDS);
  return { endSeconds: measuring, measuring: measuring < requested };
};

const clamp = (value: unknown, minimum: number, maximum: number, fallback: number): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

/** The bounds `generate_media` declares, applied before anything is priced. */
export const mediaDimension = (value: unknown): number => clamp(value, 256, 4_096, 1_024);
const mediaCharacterCount = (value: unknown): number => clamp(value, 1, 20_000, 1_000);

/**
 * The provider cost of one generation, from the request alone.
 *
 * Speech is billed per character, and the characters are the prompt: `generate_media` has no
 * separate length parameter, so the same text that is spoken is the text that is priced. An
 * unknown kind estimates zero rather than throwing, because the caller that rejects it is the
 * dispatch arm, not the pricer.
 */
export const mediaEstimateUsd = (input: {
  kind: string;
  width?: unknown;
  height?: unknown;
  characterCount?: unknown;
  /**
   * The route this generation will take, when the caller has resolved the owner's choice. Omitting
   * it prices against the reviewed default, which is what every caller did when the default was the
   * only model there was.
   */
  model?: ResolvedMediaModel;
}): number => {
  if (input.kind === 'image') {
    const width = mediaDimension(input.width);
    const height = mediaDimension(input.height);
    const base = input.model?.usdPerImage ?? managedMediaCatalog.image.baseUsdPerImage;
    return base + Math.max(0, (width * height) / 1_000_000 - 1) * 0.001;
  }
  if (input.kind === 'audio') {
    const characters = mediaCharacterCount(input.characterCount);
    const perMillion =
      input.model?.usdPerMillionCharacters ?? managedMediaCatalog.audio.usdPerMillionCharacters;
    return (characters * perMillion) / 1_000_000;
  }
  return 0;
};

/**
 * The cumulative media-spend threshold, which now lives in the contracts package because the
 * Settings screen that chooses the model has to state the same number this card enforces.
 */
export { MEDIA_APPROVAL_USD } from '@athanor/contracts';
