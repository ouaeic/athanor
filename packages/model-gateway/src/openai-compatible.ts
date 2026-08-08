import { performance } from 'node:perf_hooks';
import { duplicatedWebCapabilities, serverToolUseFrom, webCitationsFrom } from '@athanor/contracts';
import { AthanorError } from '@athanor/core';
import type {
  ModelAdapter,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ProviderModel
} from './protocol.js';
import {
  MAX_CACHE_BREAKPOINTS,
  promptCacheStyle,
  readCacheUsage,
  type CacheUsageFields
} from './prompt-cache.js';

/**
 * How long a streamed response may go without a single byte before the provider counts as stalled.
 * The caller's own deadline is a total budget, so on its own it cannot tell a turn that is still
 * producing tokens from one that died silently: a stall used to hold this worker's only slot until
 * the whole budget ran out. Two minutes is far longer than any gap between tokens - including the
 * quiet stretch while a reasoning model thinks, which still arrives as keep-alive bytes.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;

interface Options {
  baseUrl: string;
  apiKey?: string;
  provider: string;
  privacyRoute: string;
  fetch?: typeof fetch;
  appUrl?: string;
  appTitle?: string;
  enforceZeroDataRetention?: boolean;
  /** Zero disables the idle deadline; only tests that drive the reader by hand should do that. */
  streamIdleTimeoutMs?: number;
}

interface CompletionBody {
  model?: string;
  error?: unknown;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_details?: unknown[];
      /** Where a provider attaches the sources a server-side search or fetch grounded the answer in. */
      annotations?: unknown[];
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  provider?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    /** Per-request counters for the tools the provider ran itself, which tokens cannot account for. */
    server_tool_use?: unknown;
  } & CacheUsageFields;
}

/** Content blocks are only used when a message needs a cache breakpoint or carries images. */
type ContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * Array content is well defined for these roles in the OpenAI-compatible schema. An assistant
 * message that also carries `tool_calls` stays a plain string so no provider has to reconcile
 * two representations of the same turn.
 */
const BLOCK_CONTENT_ROLES = new Set<ModelMessage['role']>(['system', 'user', 'tool']);

interface StreamChunk {
  model?: string;
  provider?: string;
  error?: unknown;
  choices?: Array<{
    finish_reason?: string | null;
    /**
     * Some routes stream annotations as deltas and others attach the finished list to a `message`
     * on the last chunk. Both are read, because reading one of them drops every citation on the
     * routes that use the other.
     */
    message?: { annotations?: unknown[] };
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_details?: unknown[];
      annotations?: unknown[];
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: CompletionBody['usage'];
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

/** Gateways put the upstream status in `code` as often as in `status`, and sometimes as a string. */
const httpStatusLike = (value: unknown): number | undefined => {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.trim())
        : Number.NaN;
  return Number.isInteger(numeric) && numeric >= 400 && numeric <= 599 ? numeric : undefined;
};

const retryAfterOf = (metadata: unknown): string | undefined => {
  const headers = asRecord(asRecord(metadata)?.headers);
  if (!headers) return undefined;
  for (const [name, value] of Object.entries(headers))
    if (
      name.toLowerCase() === 'retry-after' &&
      (typeof value === 'string' || typeof value === 'number')
    )
      return String(value);
  return undefined;
};

/**
 * A gateway that has already answered with 200 reports a later fault as an `error` object - in an
 * SSE frame, or in the body of a non-streamed reply - never as a status. Reading only `choices`
 * turned that into a successful turn carrying half a sentence and no usage, which the agent then
 * recorded as the model's finished answer. `502` when the payload names no status of its own: the
 * request was accepted and the upstream failed after that, which an identical retry can survive.
 */
const providerFault = (
  value: unknown
): { status: number; message: string; retryAfter?: string } | null => {
  if (typeof value === 'string')
    return value.trim() ? { status: 502, message: value.trim() } : null;
  const error = asRecord(value);
  if (!error) return null;
  const status =
    httpStatusLike(error.code) ??
    httpStatusLike(error.status) ??
    httpStatusLike(asRecord(error.metadata)?.status) ??
    502;
  const retryAfter = retryAfterOf(error.metadata);
  return {
    status,
    message:
      typeof error.message === 'string' && error.message.trim()
        ? error.message.trim()
        : 'the provider gave no detail',
    ...(retryAfter ? { retryAfter } : {})
  };
};

/**
 * A request for more output than the route will write is refused outright by some gateways and
 * silently truncated by others, and the caller has no way to tell the two apart. Where the
 * catalogue published the limit, the ask is clamped to it instead.
 */
const maxTokensFor = (input: ModelRequest): number | undefined =>
  input.maxTokens === undefined
    ? undefined
    : input.maxOutputTokens === undefined
      ? input.maxTokens
      : Math.min(input.maxTokens, input.maxOutputTokens);

const isAbort = (error: unknown): boolean => {
  const record = asRecord(error);
  return record?.name === 'AbortError' || record?.code === 'ABORT_ERR';
};

/** `TypeError: terminated` on its own says nothing; the undici cause names the actual socket fault. */
const transportDetail = (error: unknown): string => {
  const record = asRecord(error);
  const message =
    typeof record?.message === 'string' && record.message ? record.message : 'the connection ended';
  const cause = asRecord(record?.cause);
  return typeof cause?.code === 'string' ? `${message} (${cause.code})` : message;
};

/**
 * What a configured OpenAI-compatible endpoint declared about one of its models, and what it did
 * not. `metadataSource` is `declared` when the endpoint published anything usable and `unknown`
 * when it published nothing at all - and an `unknown` route is selectable by name and never by
 * automatic ranking, because inventing a score for a route we know nothing about is what let a
 * local 7B outrank every measured model in the catalogue.
 */
export interface ConfiguredModelDescription {
  readonly id: string;
  readonly displayName: string;
  readonly contextTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly inputUsdPerMillionTokens: number | null;
  readonly outputUsdPerMillionTokens: number | null;
  readonly supportsTools: boolean | null;
  readonly supportsReasoningEffort: boolean | null;
  /** Fields the owner has to supply because the endpoint did not. */
  readonly unknownFields: readonly string[];
  readonly metadataSource: 'declared' | 'unknown';
}

/**
 * Which of two private routes to measure a request against: the one that accepts more of what an
 * agent turn actually carries. Tools outrank everything - a route that cannot call them cannot run
 * the task at all - and the rest are counted.
 */
const PREFERRED_PARAMETERS = ['tools', 'temperature', 'reasoning', 'max_tokens', 'max_completion_tokens'] as const;
const routeScore = (declared: ReadonlySet<string>): number =>
  (declared.has('tools') ? 100 : 0) +
  PREFERRED_PARAMETERS.filter((parameter) => declared.has(parameter)).length;
const richerRoute = (candidate: ReadonlySet<string>, held: ReadonlySet<string>): boolean =>
  routeScore(candidate) > routeScore(held);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const positiveIntegerFrom = (
  record: Record<string, unknown>,
  keys: readonly string[]
): number | null => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
};

/** Prices are published per token by every endpoint that publishes them at all. */
const pricePerMillionFrom = (
  record: Record<string, unknown> | undefined,
  keys: readonly string[]
): number | null => {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    const parsed =
      typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed * 1_000_000 * 1e6) / 1e6;
  }
  return null;
};

const describeConfiguredModel = (entry: Record<string, unknown>): ConfiguredModelDescription => {
  const id = typeof entry.id === 'string' ? entry.id : '';
  const pricing = isRecord(entry.pricing) ? entry.pricing : undefined;
  const parameters = Array.isArray(entry.supported_parameters)
    ? entry.supported_parameters.filter((value): value is string => typeof value === 'string')
    : null;
  const topProvider = isRecord(entry.top_provider) ? entry.top_provider : undefined;
  const contextTokens = positiveIntegerFrom(entry, [
    'context_length',
    'context_window',
    'max_model_len',
    'max_context_length'
  ]);
  const maxOutputTokens =
    positiveIntegerFrom(entry, ['max_completion_tokens', 'max_output_tokens']) ??
    (topProvider ? positiveIntegerFrom(topProvider, ['max_completion_tokens']) : null);
  const inputUsdPerMillionTokens = pricePerMillionFrom(pricing, ['prompt', 'input']);
  const outputUsdPerMillionTokens = pricePerMillionFrom(pricing, ['completion', 'output']);
  const unknownFields = [
    ...(contextTokens === null ? ['contextTokens'] : []),
    ...(maxOutputTokens === null ? ['maxOutputTokens'] : []),
    ...(inputUsdPerMillionTokens === null ? ['inputUsdPerMillionTokens'] : []),
    ...(outputUsdPerMillionTokens === null ? ['outputUsdPerMillionTokens'] : []),
    ...(parameters === null ? ['supportedParameters'] : [])
  ];
  return {
    id,
    displayName: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
    contextTokens,
    maxOutputTokens,
    inputUsdPerMillionTokens,
    outputUsdPerMillionTokens,
    supportsTools: parameters === null ? null : parameters.includes('tools'),
    supportsReasoningEffort: parameters === null ? null : parameters.includes('reasoning_effort'),
    unknownFields,
    metadataSource: unknownFields.length === 5 ? 'unknown' : 'declared'
  };
};

export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly provider: string;
  readonly privacyRoute: string;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #appUrl: string | undefined;
  readonly #appTitle: string | undefined;
  readonly #enforceZeroDataRetention: boolean;
  readonly #streamIdleTimeoutMs: number;
  #parameterCache: Promise<Map<string, ReadonlySet<string>>> | undefined;

  constructor(options: Options) {
    this.provider = options.provider;
    this.privacyRoute = options.privacyRoute;
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#appUrl = options.appUrl;
    this.#appTitle = options.appTitle;
    this.#enforceZeroDataRetention = options.enforceZeroDataRetention ?? false;
    this.#streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  }

  /** Turns a payload's own `error` object into the throw the caller's retry logic can reason about. */
  #fault(frame: unknown, where: string): AthanorError | null {
    const fault = providerFault(frame);
    if (!fault) return null;
    return new AthanorError(
      fault.status === 429 ? 'provider_quota_exhausted' : 'provider_request_failed',
      `${this.provider} reported an error ${where} (${fault.status}): ${fault.message}`,
      fault.status,
      fault.retryAfter ? { retryAfter: fault.retryAfter } : {}
    );
  }

  /**
   * Which parameters a zero-retention route on this endpoint says it accepts, cached for the life
   * of the process's interest in it.
   *
   * This exists because of a combination that fails silently in testing and completely in
   * production. Under zero data retention the request tells the provider to honour every parameter
   * it is given - anything less and a provider could quietly drop `tools` and leave an agent
   * unable to act. But OpenRouter reads that demand against the declared parameter list of the
   * endpoint it would route to, and an endpoint that never declared `temperature` is then not a
   * route at all: the request comes back 404, no endpoint found, for a model the catalogue
   * correctly listed as available. Zero data retention is what a fresh install turns on, so this
   * was every task on every new box.
   *
   * The list has to come from the zero-retention endpoints themselves. The model-level list is the
   * union across every endpoint including the ones this posture refuses, so it says `temperature`
   * is fine on a model whose only private route has never accepted one.
   *
   * Where a model has several private routes, the one that accepts the most of what we would send
   * is the one measured against - it is the route the request will land on, and holding every
   * route to the poorest of them would give up capability nothing asked us to give up.
   */
  async #zeroRetentionParameters(model: string): Promise<ReadonlySet<string> | null> {
    if (!this.#parameterCache) {
      this.#parameterCache = (async () => {
        const map = new Map<string, ReadonlySet<string>>();
        try {
          const response = await this.#fetch(`${this.#baseUrl}/endpoints/zdr`, {
            headers: this.#headers(),
            signal: AbortSignal.timeout(15_000)
          });
          if (!response.ok) return map;
          const body = (await response.json()) as {
            data?: Array<{ model_id?: unknown; status?: unknown; supported_parameters?: unknown }>;
          };
          for (const endpoint of body.data ?? []) {
            if (typeof endpoint.model_id !== 'string') continue;
            if (endpoint.status !== undefined && endpoint.status !== 0) continue;
            if (!Array.isArray(endpoint.supported_parameters)) continue;
            const declared = new Set(
              endpoint.supported_parameters.filter((v): v is string => typeof v === 'string')
            );
            const held = map.get(endpoint.model_id);
            if (!held || richerRoute(declared, held)) map.set(endpoint.model_id, declared);
          }
          return map;
          // An endpoint that will not describe itself is left alone rather than stripped bare:
          // filtering on an answer we do not have would break every route that publishes nothing.
        } catch {
          return map;
        }
      })();
    }
    return (await this.#parameterCache).get(model) ?? null;
  }

  #headers(): HeadersInit {
    return {
      'content-type': 'application/json',
      ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
      ...(this.#appUrl ? { 'http-referer': this.#appUrl } : {}),
      ...(this.#appTitle ? { 'x-title': this.#appTitle } : {})
    };
  }

  async list(signal?: AbortSignal): Promise<ProviderModel[]> {
    const response = await this.#fetch(`${this.#baseUrl}/models`, {
      headers: this.#headers(),
      ...(signal ? { signal } : {})
    });
    if (!response.ok)
      throw new AthanorError(
        'provider_unavailable',
        `${this.provider} returned ${response.status}`
      );
    const body = (await response.json()) as { data?: Array<{ id: string; owned_by?: string }> };
    return (body.data ?? []).map((model) => ({
      id: model.id,
      provider: this.provider,
      revision: model.owned_by ?? 'provider-managed'
    }));
  }

  /**
   * What the configured endpoint says about itself.
   *
   * A directly configured provider used to be written into the catalogue with invented metadata - a
   * 128K window nobody checked, a "medium" usage class, no price - and those inventions then
   * outranked models that had actually been benchmarked. The endpoint usually publishes some of
   * this: vLLM reports `max_model_len`, LiteLLM reports a context window and a completion limit,
   * gateways that front OpenRouter report prices. Whatever it does not publish is returned in
   * `unknown` so the owner can be asked once, at the screen where they paste the key, instead of
   * having a number made up for them.
   */
  async describe(signal?: AbortSignal): Promise<ConfiguredModelDescription[]> {
    const response = await this.#fetch(`${this.#baseUrl}/models`, {
      headers: this.#headers(),
      ...(signal ? { signal } : {})
    });
    if (!response.ok)
      throw new AthanorError(
        'provider_unavailable',
        `${this.provider} returned ${response.status}`
      );
    const body = (await response.json()) as { data?: unknown };
    const entries = Array.isArray(body.data) ? body.data : [];
    return entries.filter(isRecord).map((entry) => describeConfiguredModel(entry));
  }

  /**
   * Translates portable cache breakpoints into `cache_control` markers for routes that bill them,
   * newest first so the most valuable prefix still gets a marker when a request carries more
   * breakpoints than the provider accepts.
   */
  #cacheBreakpointIndexes(input: ModelRequest): Set<number> {
    const style = input.promptCacheStyle ?? promptCacheStyle(input.model);
    if (style !== 'explicit') return new Set();
    const eligible: number[] = [];
    input.messages.forEach((message, index) => {
      // A message carrying images already needs block content for the image itself; leaving it
      // out keeps one marker per block list and avoids guessing where a provider expects the
      // marker among mixed blocks.
      if (
        message.cacheBreakpoint &&
        BLOCK_CONTENT_ROLES.has(message.role) &&
        !message.images?.length
      )
        eligible.push(index);
    });
    return new Set(eligible.slice(-MAX_CACHE_BREAKPOINTS));
  }

  /**
   * The provider-side tools, in the shape they travel in, or a refusal.
   *
   * A server tool is a type and the settings that type takes, flat, which is how both of the
   * vendors whose tools arrive through this route express theirs - it is not a function tool and
   * must not be wrapped as one, because `{type:'function'}` is precisely the claim that this box
   * will answer the call. `type` is written after the settings so a parameter bag that carries a
   * `type` of its own cannot rename the tool being requested.
   *
   * The check below is a refusal rather than a repair, and it is here rather than only at the call
   * site because this is the last code that runs before the request leaves the machine. A catalogue
   * that still offers the in-house tool the provider one stands in for hands the model two
   * descriptions of one capability. That is not a wire error - the provider would accept it - so
   * nothing downstream would ever report it; it would surface as a model that sometimes searches one
   * way and sometimes the other, which is the shape of failure nobody traces back to a tools array.
   *
   * A second refusal used to stand beside it: server tools on a connection that enforces zero data
   * retention. It was reasoning from the true half of a fact. Zero-retention enforcement covers
   * inference routing and explicitly does not cover tools - which means a search query is outside
   * that guarantee however this request is built, so refusing to send the tools never protected the
   * query. It only ensured that a box configured the shipped way could not search, since the flag
   * ships on. Where a query may go is now settled once, by the plan in @athanor/contracts, and
   * disclosed to the owner in the words that plan hands back; a request arriving here with both is
   * the ordinary case on a zero-retention box, not a caller's bug.
   */
  #serverToolPayload(input: ModelRequest): Array<Record<string, unknown>> {
    const serverTools = input.serverTools ?? [];
    if (serverTools.length === 0) return [];
    const requested = serverTools.map((tool) => tool.type).join(', ');
    const duplicated = duplicatedWebCapabilities(
      serverTools,
      input.tools.map((tool) => tool.name)
    );
    if (duplicated.length > 0)
      throw new AthanorError(
        'web_tool_catalogue_conflict',
        `${requested} was sent while ${duplicated.join(', ')} stayed in the tool catalogue, which offers the model two ways to do one thing`
      );
    return serverTools.map((tool) => ({ ...tool.parameters, type: tool.type }));
  }

  /**
   * Whether a 400 is the provider refusing signed reasoning it can no longer verify. Read from a
   * clone so the caller's error path still has the body to quote.
   */
  async #isSignedReasoningRefusal(response: Response): Promise<boolean> {
    const text = await response
      .clone()
      .text()
      .catch(() => '');
    if (!/thinking|reasoning/i.test(text)) return false;
    return /signature|cannot be modified|must remain|invalid.*block/i.test(text);
  }

  async chat(input: ModelRequest): Promise<ModelResponse> {
    const started = performance.now();
    const serverTools = this.#serverToolPayload(input);
    const cacheBreakpoints = this.#cacheBreakpointIndexes(input);
    // Only consulted where it can change the outcome: the demand that every parameter be honoured
    // is sent under zero data retention and nowhere else, so nowhere else can a declared-parameter
    // list turn a live model into a 404.
    const declared = this.#enforceZeroDataRetention
      ? await this.#zeroRetentionParameters(input.model)
      : null;
    const sends = (parameter: string): boolean => !declared || declared.has(parameter);
    /**
     * The same cap under whichever name the route declared. A route that takes only
     * `max_completion_tokens` still gets an output ceiling rather than none, which is what keeps a
     * long task inside its budget and its context window.
     */
    const outputCap = ((): Record<string, number> => {
      const value = maxTokensFor(input);
      if (value === undefined) return {};
      if (sends('max_tokens')) return { max_tokens: value };
      if (declared?.has('max_completion_tokens')) return { max_completion_tokens: value };
      return {};
    })();
    const payload = (withReasoningDetails: boolean): string =>
      JSON.stringify({
          model: input.model,
          messages: input.messages.map((message, index) => ({
            role: message.role,
            content: ((): string | ContentBlock[] => {
              if (message.images?.length)
                return [
                  { type: 'text', text: message.content },
                  ...message.images.map(
                    (url): ContentBlock => ({ type: 'image_url', image_url: { url } })
                  )
                ];
              if (!cacheBreakpoints.has(index)) return message.content;
              return [
                { type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }
              ];
            })(),
            ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
            ...(message.reasoning ? { reasoning: message.reasoning } : {}),
            ...(withReasoningDetails && message.reasoningDetails?.length
              ? { reasoning_details: message.reasoningDetails }
              : {}),
            ...(message.toolCalls?.length
              ? {
                  tool_calls: message.toolCalls.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.arguments) }
                  }))
                }
              : {})
          })),
          tools: [
            ...input.tools.map((tool) => ({ type: 'function', function: tool })),
            ...serverTools
          ],
          ...(sends('temperature') ? { temperature: input.temperature } : {}),
          ...(input.reasoningEffort &&
          input.supportsReasoningEffort !== false &&
          sends('reasoning')
            ? { reasoning: { effort: input.reasoningEffort } }
            : {}),
          ...(input.sessionId ? { session_id: input.sessionId } : {}),
          ...outputCap,
          ...(input.onTextDelta ? { stream: true, stream_options: { include_usage: true } } : {}),
          ...(this.#enforceZeroDataRetention
            ? {
                provider: {
                  zdr: true,
                  data_collection: 'deny',
                  require_parameters: true,
                  allow_fallbacks: true
                }
              }
            : {})
      });
    const send = async (withReasoningDetails: boolean): Promise<Response> => {
      try {
        return await this.#fetch(`${this.#baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.#headers(),
          ...(input.signal ? { signal: input.signal } : {}),
          body: payload(withReasoningDetails)
        });
      } catch {
        throw new AthanorError('provider_unavailable', `${this.provider} could not be reached`, 503);
      }
    };
    let response = await send(true);
    // A thinking block is signed against the whole turn it was produced in, so anything that
    // reshapes the window - compaction, middle-truncation, the ageing-out of older details -
    // invalidates the signature, and the model refuses the replay with a 400. That is not
    // retryable: the same bytes fail forever, and because the refusal appends nothing the window
    // never advances past the offending message, so a resumed task dies at the same step for good.
    // The one repair is to stop replaying the signed material. It is dropped from this request
    // only, never from the stored trajectory - editing that would poison every future turn.
    // Not gated on provider name: OpenRouter proxies the upstream's wording verbatim.
    if (response.status === 400 && (await this.#isSignedReasoningRefusal(response))) {
      response = await send(false);
    }
    if (!response.ok) {
      // The provider's own account of what it disliked, which is the whole of the diagnosis when a
      // request is refused. A bare "(400)" says a request was malformed without saying which part,
      // and the body is the only thing that does. Bounded, because this is an error path.
      const explanation = await response
        .text()
        .then((text) => {
          const parsed: unknown = text.trim().startsWith('{') ? JSON.parse(text) : text;
          const fault = providerFault(asRecord(parsed)?.error ?? parsed);
          return fault ? `: ${fault.message}` : text.trim() ? `: ${text.trim().slice(0, 400)}` : '';
        })
        .catch(() => '');
      // The status has to travel with the error. Without it every 5xx inherits AthanorError's
      // default of 400, `isRetryableError` reads that as a client mistake, and a task that has run
      // for hours dies on one upstream blip that a single retry would have absorbed.
      throw new AthanorError(
        response.status === 429 ? 'provider_quota_exhausted' : 'provider_request_failed',
        `${this.provider} request failed (${response.status})${explanation}`,
        response.status,
        { retryAfter: response.headers.get('retry-after') ?? undefined }
      );
    }
    // Nothing publishes a usable latency for these routes, so the only honest number is the one
    // measured here: on this owner's network, from this box, on this owner's prompts.
    const firstToken: { at?: number } = {};
    const body = input.onTextDelta
      ? await this.#streamCompletion(response, input.onTextDelta, firstToken, input.onReasoningDelta)
      : ((await response.json()) as CompletionBody);
    if (!body.choices?.length) {
      const fault = this.#fault(body.error, 'in its response');
      if (fault) throw fault;
    }
    const choice = body.choices?.[0];
    // A failed parse used to become `{}` and run anyway: `file_write` cut off mid-JSON was
    // dispatched with no path and no content, failed on a validation error that named neither the
    // truncation nor the remedy, and the turn spent its remaining steps rewriting the same file.
    // The call is marked instead, and the loop refuses it with an explanation.
    const toolCalls = (choice?.message?.tool_calls ?? []).map((call) => {
      try {
        return {
          id: call.id,
          name: call.function.name,
          arguments: JSON.parse(call.function.arguments) as Record<string, unknown>
        };
      } catch {
        return {
          id: call.id,
          name: call.function.name,
          arguments: {},
          parseFailed: true as const,
          rawArguments: call.function.arguments
        };
      }
    });
    const inputTokens = body.usage?.prompt_tokens ?? 0;
    const outputTokens = body.usage?.completion_tokens ?? 0;
    const citations = webCitationsFrom(choice?.message?.annotations);
    const serverToolUse = serverToolUseFrom(body.usage?.server_tool_use);
    return {
      text: choice?.message?.content ?? '',
      ...(choice?.message?.reasoning ? { reasoning: choice.message.reasoning } : {}),
      ...(choice?.message?.reasoning_details?.length
        ? { reasoningDetails: choice.message.reasoning_details }
        : {}),
      toolCalls,
      ...(citations.length > 0 ? { citations } : {}),
      finishReason: toolCalls.length
        ? 'tool_calls'
        : choice?.finish_reason === 'length'
          ? 'length'
          : 'stop',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: body.usage?.total_tokens ?? inputTokens + outputTokens,
        ...(typeof body.usage?.cost === 'number' ? { costUsd: body.usage.cost } : {}),
        ...(serverToolUse ? { serverToolUse } : {}),
        ...readCacheUsage(body.usage)
      },
      metadata: {
        provider: this.provider,
        model: body.model ?? input.model,
        latencyMs: Math.round(performance.now() - started),
        ...(firstToken.at === undefined
          ? {}
          : { timeToFirstTokenMs: Math.round(firstToken.at - started) }),
        privacyRoute: this.privacyRoute,
        ...(body.provider ? { upstreamProvider: body.provider } : {})
      }
    };
  }

  /**
   * One read, bounded by the idle deadline rather than by the request's total budget. The clock
   * restarts on every read, so a turn that keeps producing runs as long as it needs to and only a
   * genuinely silent provider trips it.
   */
  async #readWithIdleDeadline(
    reader: ReadableStreamDefaultReader<Uint8Array>
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (this.#streamIdleTimeoutMs <= 0) return reader.read();
    const pending = reader.read();
    // The deadline can win the race and leave this read outstanding; the caller cancels the reader
    // straight after, but a socket that errors in the same tick would otherwise reject with nobody
    // listening and take the process down with it.
    pending.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AthanorError(
                  'provider_stream_stalled',
                  `${this.provider} sent nothing for ${Math.round(this.#streamIdleTimeoutMs / 1000)} seconds and the response was abandoned`,
                  504
                )
              ),
            this.#streamIdleTimeoutMs
          );
          timer.unref();
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #streamCompletion(
    response: Response,
    onTextDelta: (delta: string) => void | Promise<void>,
    firstToken: { at?: number } = {},
    onReasoningDelta?: (delta: string) => void | Promise<void>
  ): Promise<CompletionBody> {
    if (!response.body)
      throw new AthanorError('provider_request_failed', `${this.provider} returned no stream`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolCalls = new Map<
      number,
      { id: string; function: { name: string; arguments: string } }
    >();
    let buffer = '';
    let content = '';
    let reasoning = '';
    const reasoningDetails: unknown[] = [];
    // Kept raw and deduplicated once at the end: a route that resends the whole list on each chunk
    // would otherwise be deduplicated against a growing list on every frame of a long answer.
    const annotations: unknown[] = [];
    let finishReason: string | undefined;
    let model: string | undefined;
    let upstreamProvider: string | undefined;
    let usage: CompletionBody['usage'];
    const consume = async (line: string): Promise<void> => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(payload) as StreamChunk;
      } catch {
        return;
      }
      const fault = this.#fault(chunk.error, 'mid-response');
      if (fault) throw fault;
      model = chunk.model ?? model;
      upstreamProvider = chunk.provider ?? upstreamProvider;
      usage = chunk.usage ?? usage;
      const choice = chunk.choices?.[0];
      finishReason = choice?.finish_reason ?? finishReason;
      const delta = choice?.delta;
      // Reasoning counts: it is the first token the model produced, and on a reasoning route it is
      // most of the wait. The callback runs after, so the reading is not charged for our own work.
      if (firstToken.at === undefined && (delta?.content || delta?.reasoning))
        firstToken.at = performance.now();
      if (delta?.content) {
        content += delta.content;
        await onTextDelta(delta.content);
      }
      if (delta?.reasoning) {
        reasoning += delta.reasoning;
        if (onReasoningDelta) await onReasoningDelta(delta.reasoning);
      }
      if (delta?.reasoning_details?.length) reasoningDetails.push(...delta.reasoning_details);
      if (delta?.annotations?.length) annotations.push(...delta.annotations);
      if (choice?.message?.annotations?.length) annotations.push(...choice.message.annotations);
      for (const fragment of delta?.tool_calls ?? []) {
        const index = fragment.index ?? toolCalls.size;
        const current = toolCalls.get(index) ?? {
          id: fragment.id ?? `call-${index}`,
          function: { name: '', arguments: '' }
        };
        if (fragment.id) current.id = fragment.id;
        if (fragment.function?.name) current.function.name += fragment.function.name;
        if (fragment.function?.arguments) current.function.arguments += fragment.function.arguments;
        toolCalls.set(index, current);
      }
    };
    try {
      for (;;) {
        const { done, value } = await this.#readWithIdleDeadline(reader);
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) await consume(line);
        if (done) break;
      }
      if (buffer.trim()) await consume(buffer);
    } catch (cause) {
      await reader.cancel().catch(() => undefined);
      // A connection that dies a few bytes into the body is the same fault as one that dies before
      // the headers, and the caller already refuses to replay a request whose text the owner has
      // seen - so it is classified the same way instead of escaping as a bare TypeError that no
      // retry rule recognises. An abort and a fault the provider named for itself pass through.
      if (cause instanceof AthanorError || isAbort(cause)) throw cause;
      throw new AthanorError(
        'provider_unavailable',
        `${this.provider} dropped the response stream: ${transportDetail(cause)}`,
        503
      );
    }
    return {
      ...(model ? { model } : {}),
      ...(upstreamProvider ? { provider: upstreamProvider } : {}),
      choices: [
        {
          ...(finishReason ? { finish_reason: finishReason } : {}),
          message: {
            content,
            ...(reasoning ? { reasoning } : {}),
            ...(reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
            ...(annotations.length ? { annotations } : {}),
            ...(toolCalls.size
              ? {
                  tool_calls: [...toolCalls.entries()]
                    .sort(([a], [b]) => a - b)
                    .map(([, call]) => call)
                }
              : {})
          }
        }
      ],
      ...(usage ? { usage } : {})
    };
  }
}
