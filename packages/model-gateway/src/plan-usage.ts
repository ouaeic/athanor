/**
 * Plan usage for the two subscription providers, read straight off each provider's own account
 * endpoint.
 *
 * The composer's status strip shows CPU, RAM and disk beside what the owner's plan has left; the
 * two subscription providers publish that from different routes with different shapes, and the
 * worker has no credential, so this is read server-side, once per bootstrap, and shaped into one
 * small record the strip can render for either provider.
 *
 * Every field is nullable rather than defaulted: an endpoint that will not say is a fact about the
 * provider, and a made-up zero reads as headroom the owner does not have.
 */

import { z } from 'zod';
import { AthanorError } from '@athanor/core';

/** What a provider's own account endpoint said about the plan. */
export const PlanUsage = z.object({
  provider: z.enum(['ollama-cloud', 'openrouter']),
  /**
   * Utilisation in the provider's own unit - a fraction for Ollama Cloud's session and weekly
   * windows, dollars for OpenRouter - with the period the number covers.
   */
  windows: z.array(
    z.object({
      label: z.string(),
      used: z.number().nullable(),
      limit: z.number().nullable(),
      resetsAt: z.string().nullable()
    })
  ),
  queriedAt: z.string()
});
export type PlanUsage = z.infer<typeof PlanUsage>;

const PlanUsageResponse = z.object({
  activity: z
    .object({ period: z.object({ ending_at: z.string() }).partial().optional() })
    .optional(),
  limits: z
    .object({
      session: z.object({ usage: z.number() }).partial().optional(),
      weekly: z.object({ usage: z.number() }).partial().optional()
    })
    .optional()
});

const OpenRouterCredits = z.object({
  data: z
    .object({ usage: z.number().nullable().optional(), limit: z.number().nullable().optional() })
    .optional()
});

const checkedBody = async (response: Response, who: string): Promise<unknown> => {
  if (!response.ok)
    throw new AthanorError(
      'provider_unavailable',
      `${who} returned ${response.status}`,
      response.status === 401 || response.status === 403 ? 409 : 502
    );
  return response.json();
};

/**
 * Ollama Cloud's `/api/usage`: a session window and a weekly window, each carrying utilisation as
 * a fraction of the plan's allowance. No reset date is published; the period object names when the
 * rolling windows began, which is the closest honest answer.
 */
const ollamaCloudUsage = async (
  apiKey: string | undefined,
  fetchImpl: typeof fetch
): Promise<PlanUsage> => {
  const body = PlanUsageResponse.parse(
    await checkedBody(
      await fetchImpl('https://ollama.com/api/usage', {
        headers: { authorization: `Bearer ${apiKey ?? ''}` },
        signal: AbortSignal.timeout(10_000)
      }),
      'Ollama Cloud usage'
    )
  );
  const resetsAt = body.activity?.period?.ending_at ?? null;
  return {
    provider: 'ollama-cloud',
    windows: (
      [
        ['Session window', body.limits?.session?.usage ?? null],
        ['Weekly window', body.limits?.weekly?.usage ?? null]
      ] as const
    ).map(([label, used]) => ({ label, used, limit: 1, resetsAt })),
    queriedAt: new Date().toISOString()
  };
};

/**
 * OpenRouter's `/api/v1/credits`: the whole account balance, plus the per-key rate limit the same
 * endpoint publishes. One window, because OpenRouter meters spend rather than time.
 */
const openRouterUsage = async (
  apiKey: string | undefined,
  fetchImpl: typeof fetch
): Promise<PlanUsage> => {
  const body = OpenRouterCredits.parse(
    await checkedBody(
      await fetchImpl('https://openrouter.ai/api/v1/credits', {
        headers: { authorization: `Bearer ${apiKey ?? ''}` },
        signal: AbortSignal.timeout(10_000)
      }),
      'OpenRouter credits'
    )
  );
  return {
    provider: 'openrouter',
    windows: [
      {
        label: 'Account balance',
        used: body.data?.usage ?? null,
        limit: body.data?.limit ?? null,
        resetsAt: null
      }
    ],
    queriedAt: new Date().toISOString()
  };
};

/**
 * What the connected provider's own account endpoint says about the plan, or null when this
 * provider publishes no such number. A failure is reported as unavailable rather than thrown:
 * the status strip renders beside every screen, and a provider outage would otherwise take the
 * whole first paint with it.
 */
export const planUsageFor = async (
  provider: 'openrouter' | 'ollama-cloud' | 'openai-compatible',
  apiKey: string | undefined,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<PlanUsage | null> => {
  try {
    if (provider === 'ollama-cloud') return await ollamaCloudUsage(apiKey, fetchImpl);
    if (provider === 'openrouter') return await openRouterUsage(apiKey, fetchImpl);
    return null;
  } catch {
    return null;
  }
};
