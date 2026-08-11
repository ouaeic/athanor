import { managedMediaModels } from './license-manifest.js';

/**
 * Generated media, fetched the same way as any other provider call.
 *
 * This used to be a service. A job row was written, a second process leased it, generated, wrote
 * the file and marked the row done, and the agent polled a `media_status` tool until it saw the
 * result. None of that bought asynchrony: the poll blocked the turn anyway, so the only thing the
 * queue added was a second tool call, a second runner client, two encrypted columns and a spend
 * reconciliation that existed purely because a queued job had not billed yet. An image takes about
 * ten seconds and speech about five, on a computer where `shell` blocks for up to an hour, so the
 * generation is just a request now and the file exists when it returns.
 */

export interface GeneratedMedia {
  filename: string;
  bytes: Buffer;
  mimeType: string;
}

export interface GeneratedMediaResult {
  outputs: GeneratedMedia[];
  costUsd: number;
}

export interface MediaRequest {
  /** Names the output files, so a caller can tell one generation's files from another's. */
  id: string;
  kind: 'image' | 'audio';
  model: string;
  prompt: string;
  width: number;
  height: number;
  seed: number;
  /**
   * The voice to speak in, when the chosen route names its voices.
   *
   * Sent only when the caller supplies one. This used to be a constant, and the constant belonged
   * to one specific speech model - so the moment the model became the owner's choice, every other
   * speech route would have been asked for a voice from a different model's list. A route whose
   * voices athanor does not know is asked without one, and the provider's own answer says what it
   * needs, which is better than this side inventing a name for it.
   */
  voice?: string;
  /**
   * What the caller believes this route costs, used only when the provider does not say.
   *
   * Both are per the unit the modality is billed in and both may be absent. Every response path
   * below prefers the provider's own figure; these exist so that a route athanor has measured
   * still prices its own generations rather than borrowing the price of whatever model happened to
   * be compiled in.
   */
  usdPerImage?: number | null;
  usdPerMillionCharacters?: number | null;
}

/** Only over TLS, and only what the provider pointed at. */
const download = async (rawUrl: string): Promise<{ bytes: Buffer; mimeType: string }> => {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('Media output used an unsafe download URL');
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Could not download generated media (${response.status})`);
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mimeType: response.headers.get('content-type') ?? 'application/octet-stream'
  };
};

/** The same zero-retention policy the inference adapter sends, because it is the same account. */
const PROVIDER_POLICY = { zdr: true, data_collection: 'deny', allow_fallbacks: true } as const;

export class MediaClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey?: string;
      appUrl: string;
      timeoutSeconds?: number;
      /** False for an OpenAI-compatible endpoint that would reject OpenRouter's routing block. */
      openRouter?: boolean;
    }
  ) {}

  #headers(): Record<string, string> {
    return {
      ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      'http-referer': this.options.appUrl,
      'x-title': 'athanor',
      'content-type': 'application/json'
    };
  }

  #endpoint(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}/${path}`;
  }

  #routing(): Record<string, unknown> {
    return this.options.openRouter === false ? {} : { provider: PROVIDER_POLICY };
  }

  #signal(): AbortSignal {
    return AbortSignal.timeout((this.options.timeoutSeconds ?? 180) * 1_000);
  }

  async generate(input: MediaRequest): Promise<GeneratedMediaResult> {
    return input.kind === 'image' ? this.#image(input) : this.#speech(input);
  }

  async #image(input: MediaRequest): Promise<GeneratedMediaResult> {
    const response = await fetch(this.#endpoint('images'), {
      method: 'POST',
      headers: this.#headers(),
      signal: this.#signal(),
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        size: `${input.width}x${input.height}`,
        output_format: 'png',
        seed: input.seed,
        ...this.#routing()
      })
    });
    if (!response.ok)
      throw new Error(`Image generation failed (${response.status}): ${await response.text()}`);
    const body = (await response.json()) as {
      data?: Array<{ b64_json?: string; url?: string }>;
      usage?: { cost?: number };
    };
    const outputs: GeneratedMedia[] = [];
    for (const [index, item] of (body.data ?? []).entries()) {
      const name = `${input.id}-${index + 1}.png`;
      if (item.b64_json)
        outputs.push({
          filename: name,
          bytes: Buffer.from(item.b64_json, 'base64'),
          mimeType: 'image/png'
        });
      else if (item.url) outputs.push({ filename: name, ...(await download(item.url)) });
    }
    if (!outputs.length) throw new Error('The provider returned no generated images');
    const megapixels = (input.width * input.height) / 1_000_000;
    const base = input.usdPerImage ?? managedMediaModels.image.baseUsdPerImage;
    return {
      outputs,
      costUsd: body.usage?.cost ?? base + Math.max(0, megapixels - 1) * 0.001
    };
  }

  async #speech(input: MediaRequest): Promise<GeneratedMediaResult> {
    const response = await fetch(this.#endpoint('audio/speech'), {
      method: 'POST',
      headers: this.#headers(),
      signal: this.#signal(),
      body: JSON.stringify({
        model: input.model,
        input: input.prompt,
        ...(input.voice ? { voice: input.voice } : {}),
        response_format: 'mp3',
        ...this.#routing()
      })
    });
    if (!response.ok)
      throw new Error(`Speech generation failed (${response.status}): ${await response.text()}`);
    return {
      outputs: [
        {
          filename: `${input.id}.mp3`,
          bytes: Buffer.from(await response.arrayBuffer()),
          mimeType: response.headers.get('content-type') ?? 'audio/mpeg'
        }
      ],
      costUsd:
        (input.prompt.length *
          (input.usdPerMillionCharacters ?? managedMediaModels.audio.usdPerMillionCharacters)) /
        1_000_000
    };
  }
}
