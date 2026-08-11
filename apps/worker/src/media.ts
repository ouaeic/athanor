import { MEDIA_VIDEO_UNAVAILABLE_REASON, type MediaModelOption } from '@athanor/contracts';
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
 * What a reading of this length will cost, before a second of it is sent.
 *
 * Rounded up to the minute, because that is how duration billing is quoted and rounding down would
 * make the card understate every job. A route whose price nobody published prices at zero here and
 * is caught by `priceKnown` instead, exactly as an unpriced image route is: an unknown price is a
 * card every time, never a small number.
 */
/**
 * What a reading is expected to cost, from its duration alone.
 *
 * No transcription route publishes a per-minute figure this side can read, so today every one of
 * them lands here with `usdPerMinute` null and prices at zero. That is deliberate and it is not the
 * same thing as free: the image path can fall back to a compiled-in constant because athanor has
 * run and priced that model, and nothing here has ever transcribed anything, so a number in this
 * file would be a price claim about a model nobody has measured. Inventing one is worse than
 * admitting there is none.
 *
 * What actually protects the owner is therefore not this estimate. A route with no published price
 * has `priceKnown` false, so the approval card asks before every single reading and states the
 * minutes; the ledger settles from the provider's own figure once the work is done; and the spend
 * guard is asked again at the next step boundary against money that has really been spent. The
 * exposure is one reading's worth of overshoot on a cap, on a reading the owner was asked about
 * first. Seed a real figure here the moment one can be measured, and this stops being true.
 */
export const transcriptionEstimateUsd = (
  seconds: number,
  model: ResolvedMediaModel | null
): number => Math.ceil(Math.max(0, seconds) / 60) * (model?.usdPerMinute ?? 0);

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
