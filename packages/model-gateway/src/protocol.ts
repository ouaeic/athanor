import type { ServerToolUse, WebCitation } from '@athanor/contracts';
import { z } from 'zod';

export const ModelMessage = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  images: z.array(z.string()).optional(),
  reasoning: z.string().optional(),
  reasoningDetails: z.array(z.unknown()).optional(),
  toolCallId: z.string().optional(),
  toolCalls: z
    .array(
      z.object({ id: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()) })
    )
    .optional(),
  /**
   * Marks the end of a byte-stable prompt prefix. Routes that bill explicit cache breakpoints
   * (currently Anthropic and Google through OpenRouter) receive a `cache_control` marker here.
   * Routes that cache automatically ignore the hint, so it is always safe to set.
   */
  cacheBreakpoint: z.boolean().optional()
});
export type ModelMessage = z.infer<typeof ModelMessage>;

export const ModelTool = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown())
});
export type ModelTool = z.infer<typeof ModelTool>;

/**
 * A tool the provider runs on its own infrastructure rather than one this client implements.
 *
 * It is a separate field from `tools` because it is a different kind of thing on the wire and a
 * different kind of thing in the product: a function tool is a name the model calls and this box
 * answers, and a server tool is a name the provider answers without the request ever coming back
 * here. Keeping the two in one array would have made "which of these disclose the query to a third
 * party" a matter of inspecting each entry's shape, on the one decision where that must never be a
 * guess. Which tools may travel here is not this package's decision: `resolveWebToolPlan` in
 * @athanor/contracts is the only thing that answers it, and the adapter refuses a request that
 * contradicts it.
 */
export const ModelServerTool = z.object({
  type: z.string().min(1),
  parameters: z.record(z.string(), z.unknown())
});
export type ModelServerTool = z.infer<typeof ModelServerTool>;

export const ModelRequest = z.object({
  model: z.string(),
  messages: z.array(ModelMessage).min(1),
  tools: z.array(ModelTool).default([]),
  /**
   * Optional rather than defaulted, so a caller that has no business with provider-side tools -
   * which is every caller on a zero-retention route - says nothing about them at all.
   */
  serverTools: z.array(ModelServerTool).readonly().optional(),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().positive().max(262_144).optional(),
  /**
   * The most the route will write in one response, from the catalogue. `maxTokens` is clamped to it
   * rather than sent past it, because a route that rejects the number answers nothing at all.
   */
  maxOutputTokens: z.number().int().positive().optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  /**
   * Whether the route accepts a reasoning effort. Left unset the effort is sent, which is what every
   * caller has always done; an explicit `false` withholds it, so a route that does not understand
   * the parameter is not asked to honour it.
   */
  supportsReasoningEffort: z.boolean().optional(),
  /**
   * How the route caches a repeated prefix, decided from the catalogue's pricing. Left unset the
   * adapter falls back to reading the slug, which cannot see past a vendor prefix.
   */
  promptCacheStyle: z.enum(['explicit', 'automatic', 'none']).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  onTextDelta: z
    .custom<(delta: string) => void | Promise<void>>((value) => typeof value === 'function')
    .optional(),
  /**
   * The reasoning as it arrives, on routes that produce any. Already parsed off the stream and
   * accumulated; this hands it out rather than keeping it until the response is complete, which is
   * the difference between watching a model think and watching a spinner.
   */
  onReasoningDelta: z
    .custom<(delta: string) => void | Promise<void>>((value) => typeof value === 'function')
    .optional(),
  signal: z.custom<AbortSignal>().optional()
});
export type ModelRequest = z.infer<typeof ModelRequest>;

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Set when the model's arguments would not parse, which in practice means the response was cut
   * off mid-JSON at the output cap. The call is carried rather than dropped so the loop can answer
   * it - a tool call with no tool result is a malformed turn - but `arguments` is empty and must
   * never be executed. The raw string is kept for the message that explains the refusal.
   */
  parseFailed?: true;
  rawArguments?: string;
}

export interface ModelResponse {
  text: string;
  reasoning?: string;
  reasoningDetails?: unknown[];
  toolCalls: ModelToolCall[];
  /**
   * The sources a provider-side tool grounded this answer in, when it attached any.
   *
   * Absent rather than empty when there are none, because that is every response on every in-house
   * route and a field on all of them would say nothing. It is stronger evidence than a tool call
   * id: a citation is the provider reporting a page it fetched, where a tool call id is the model
   * reporting that it asked for one. Nothing here is trusted content - a cited page is a page an
   * attacker can write - so it is evidence of provenance and never of truth.
   */
  citations?: WebCitation[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'cancelled' | 'error';
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    computeSeconds?: number;
    costUsd?: number;
    /** Input tokens the provider served from its prompt cache, billed at a reduced read rate. */
    cachedInputTokens?: number;
    /** Input tokens the provider charged to populate a new cache entry. */
    cacheWriteTokens?: number;
    /**
     * Provider-side tool calls this response spent, under the provider's own counter names. Billed
     * per request rather than per token, so it is the one part of a step's cost that the token
     * counts cannot account for.
     */
    serverToolUse?: ServerToolUse;
  };
  metadata: {
    provider: string;
    model: string;
    revision?: string;
    latencyMs: number;
    /**
     * Milliseconds until the model produced its first token, on a streamed turn. Published latency
     * for these routes is null everywhere it can be observed, so this is the measurement athanor
     * can actually make: over the owner's network, from the owner's box, on the owner's prompts.
     * Absent on a non-streamed turn, where there is no first token to time.
     */
    timeToFirstTokenMs?: number;
    privacyRoute: string;
    upstreamProvider?: string;
  };
}

export interface ModelAdapter {
  readonly provider: string;
  readonly privacyRoute: string;
  list(signal?: AbortSignal): Promise<ProviderModel[]>;
  chat(request: ModelRequest): Promise<ModelResponse>;
}

export interface ProviderModel {
  id: string;
  provider: string;
  revision: string;
  sizeBytes?: number;
  modifiedAt?: string;
}
