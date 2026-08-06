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
   * Kept as an answer rather than an offer. `media_catalog` still explains why video is refused
   * when a user asks for one, and no tool schema lists it: OpenRouter states that asynchronous
   * video generation is not eligible for zero-data-retention, so there is no route to make one.
   */
  video: {
    modelId: '',
    displayName: 'Private video generation',
    license: 'not available',
    available: false,
    reason:
      'OpenRouter currently states that asynchronous video generation is not eligible for zero-data-retention, so athanor fails closed.'
  }
} as const;

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
}): number => {
  if (input.kind === 'image')
    return managedMediaCatalog.image.estimate({
      width: mediaDimension(input.width),
      height: mediaDimension(input.height)
    });
  if (input.kind === 'audio')
    return managedMediaCatalog.audio.estimate({
      characterCount: mediaCharacterCount(input.characterCount)
    });
  return 0;
};

/**
 * How much one task may spend generating media before every further generation asks.
 *
 * The owner's spend caps are the ceiling on a runaway, and they are optional - an owner who has set
 * none has nothing between the agent and the provider's bill. This is the second brake, and it is
 * cumulative deliberately: a reviewed image is one and a half cents, so a per-call threshold at any
 * amount worth reading could never fire, while the run that re-rolls a logo forty times is exactly
 * what the owner would have stopped. A quarter of a dollar is roughly eighteen images.
 */
export const MEDIA_APPROVAL_USD = 0.25;
