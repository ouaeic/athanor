import { describe, expect, it, vi } from 'vitest';
import { fetchGenerationThroughput } from './openrouter-generation.js';

const answering = (data: Record<string, unknown>, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify({ data }), { status })) as unknown as typeof fetch;

const ask = (data: Record<string, unknown>, status = 200) =>
  fetchGenerationThroughput({
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'k',
    generationId: 'gen-1',
    fetch: answering(data, status)
  });

/**
 * The only route through which a client ever learns a throughput figure.
 *
 * The endpoints catalogue declares `throughput_last_30m` per company and returns null for it on
 * every endpoint of every model - with a valid API key as much as without one - so a speed floor
 * relative to the fastest company cannot be computed from the catalogue. This route answers about a
 * request already served: the generation time, the completion tokens, and who served it. Asked of a
 * request the aggregator itself routed by throughput, that measures its own fastest company.
 */
describe('reading how fast a served generation actually ran', () => {
  it('turns the aggregator’s own timings into tokens per second', async () => {
    await expect(
      ask({ provider_name: 'Novita', native_tokens_completion: 1420, generation_time: 10_000 })
    ).resolves.toEqual({ provider: 'Novita', tokensPerSecond: 142 });
  });

  /*
   * The generation phase, never the round trip. `latency` carries the queue and the prefill, so a
   * rate computed from it would call a long prompt a slow company - and this figure becomes the
   * ceiling every other company is judged against.
   */
  it('ignores the round-trip latency in favour of the generation time', async () => {
    await expect(
      ask({
        provider_name: 'Novita',
        native_tokens_completion: 1420,
        generation_time: 10_000,
        latency: 90_000
      })
    ).resolves.toMatchObject({ tokensPerSecond: 142 });
  });

  it('falls back to the plain token count when no native one is reported', async () => {
    await expect(
      ask({ provider_name: 'Novita', tokens_completion: 500, generation_time: 5_000 })
    ).resolves.toMatchObject({ tokensPerSecond: 100 });
  });

  /*
   * A short answer is almost entirely overhead however fast the machine is. Judged on one, the
   * quickest company would look slow - and because this figure is the ceiling, an understated one
   * drags every other company's floor down with it.
   */
  it('refuses a generation too short to time', async () => {
    await expect(
      ask({ provider_name: 'Novita', native_tokens_completion: 12, generation_time: 400 })
    ).resolves.toBeNull();
  });

  it('refuses an answer missing anything the rate needs', async () => {
    await expect(
      ask({ native_tokens_completion: 500, generation_time: 5_000 })
    ).resolves.toBeNull();
    await expect(ask({ provider_name: 'Novita', generation_time: 5_000 })).resolves.toBeNull();
    await expect(
      ask({ provider_name: 'Novita', native_tokens_completion: 500, generation_time: 0 })
    ).resolves.toBeNull();
  });

  /*
   * This runs after the answer the owner was waiting for has been delivered. Nothing it does may
   * fail a turn: an unmeasured ceiling is the state the model started in, and the next turn asks
   * again.
   */
  it('answers nothing rather than throwing when the route refuses or the network does', async () => {
    await expect(ask({}, 404)).resolves.toBeNull();
    await expect(
      fetchGenerationThroughput({
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'k',
        generationId: 'gen-1',
        fetch: (async () => {
          throw new Error('offline');
        }) as typeof fetch
      })
    ).resolves.toBeNull();
  });

  it('asks about the generation it was given', async () => {
    const request = answering({
      provider_name: 'Novita',
      native_tokens_completion: 500,
      generation_time: 5_000
    });
    await fetchGenerationThroughput({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'secret',
      generationId: 'gen/1 2',
      fetch: request
    });
    const [url, init] = (request as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/generation?id=gen%2F1%202');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret');
  });
});
