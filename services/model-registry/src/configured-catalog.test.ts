import { describe, expect, it } from 'vitest';
import { refreshConfiguredCatalog } from './configured-catalog.js';

/**
 * What an endpoint answers on `/models`. Deliberately in the shape a real one uses rather than in
 * the shape `describe()` returns, because the point of these cases is that the registry now makes
 * the same request the save path makes, against the endpoint the owner actually configured.
 */
/** The one form of a fetch argument these fixtures are ever handed, named rather than stringified. */
const requestedUrl = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const endpoint = (models: unknown[]): typeof fetch => {
  const answer: typeof fetch = async (input) => {
    if (!requestedUrl(input).endsWith('/models')) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify({ data: models }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  return answer;
};

/** A row as the save path wrote it, which is the only record of what the owner declared. */
const savedRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'custom/served-model',
  providerModelId: 'served-model',
  provider: 'custom',
  contextTokens: 32_000,
  capabilities: ['chat', 'tools'],
  modalities: ['text'],
  ...over
});

describe('refreshConfiguredCatalog', () => {
  /*
   * The finding this file exists for. An Ollama Cloud subscription reaches every cloud model on the
   * plan; the API wrote all of them at key-save and nothing ever asked again, so a model added to
   * the plan afterwards never appeared and a price that moved never moved here.
   */
  it('picks up a model the subscription gained since the key was saved', async () => {
    const rows = await refreshConfiguredCatalog({
      provider: 'ollama-cloud',
      baseUrl: 'https://ollama.test/v1',
      apiKey: 'sk-owner',
      previous: [savedRow({ id: 'custom/old', providerModelId: 'old' })],
      fetch: endpoint([
        { id: 'old', name: 'Old', context_length: 32_000, supported_parameters: ['tools'] },
        {
          id: 'new-this-week',
          name: 'New',
          context_length: 64_000,
          supported_parameters: ['tools']
        }
      ])
    });
    expect(rows.map((row) => row.id)).toEqual(['custom/old', 'custom/new-this-week']);
    expect(rows.every((row) => row.provider === 'custom')).toBe(true);
  });

  it('carries the price the endpoint publishes today rather than the one recorded at key-save', async () => {
    const [row] = await refreshConfiguredCatalog({
      provider: 'ollama-cloud',
      baseUrl: 'https://ollama.test/v1',
      previous: [savedRow({ id: 'custom/one', providerModelId: 'one' })],
      fetch: endpoint([
        {
          id: 'one',
          context_length: 32_000,
          pricing: { prompt: '0.000002', completion: '0.000008' },
          supported_parameters: ['tools']
        }
      ])
    });
    expect(row?.inputUsdPerMillionTokens).toBe(2);
    expect(row?.outputUsdPerMillionTokens).toBe(8);
  });

  /*
   * The save path keeps one row for a directly configured endpoint on purpose: those are usually a
   * single served model whose facts the owner typed into the form, and a gateway fronting thirty
   * ids would otherwise have one model's declared window and capabilities written across all
   * thirty. Re-deciding that here rather than reproducing it is how an hourly refresh comes to
   * contradict the screen the owner set it up on.
   */
  it('keeps a directly configured endpoint to the model the owner named, however many the gateway fronts', async () => {
    const rows = await refreshConfiguredCatalog({
      provider: 'openai-compatible',
      baseUrl: 'https://gateway.test/v1',
      modelId: 'served-model',
      previous: [savedRow()],
      fetch: endpoint([
        { id: 'served-model', context_length: 32_000 },
        { id: 'something-else-the-gateway-fronts', context_length: 8_000 }
      ])
    });
    expect(rows.map((row) => row.providerModelId)).toEqual(['served-model']);
  });

  it('still refreshes a row written before the credential carried a model id, because the row is the commitment', async () => {
    const rows = await refreshConfiguredCatalog({
      provider: 'openai-compatible',
      baseUrl: 'https://gateway.test/v1',
      previous: [savedRow()],
      fetch: endpoint([
        { id: 'served-model', context_length: 128_000 },
        { id: 'not-ours', context_length: 8_000 }
      ])
    });
    expect(rows.map((row) => row.providerModelId)).toEqual(['served-model']);
    expect(rows[0]?.contextTokens).toBe(128_000);
  });

  /*
   * The declaration is recovered from the rows, and the context window is recovered downwards. The
   * context builder packs a request up to this number, so a fallback guessed high on a model the
   * endpoint publishes no window for is a request rejected at the end of a turn's work.
   */
  it('falls back to the smallest window on record for a model the endpoint states none for', async () => {
    const rows = await refreshConfiguredCatalog({
      provider: 'ollama-cloud',
      baseUrl: 'https://ollama.test/v1',
      previous: [
        savedRow({ id: 'custom/small', providerModelId: 'small', contextTokens: 8_000 }),
        savedRow({ id: 'custom/large', providerModelId: 'large', contextTokens: 200_000 })
      ],
      fetch: endpoint([{ id: 'unstated' }])
    });
    expect(rows[0]?.contextTokens).toBe(8_000);
  });

  it('recovers the declared capability set from rows a previous refresh narrowed', async () => {
    const rows = await refreshConfiguredCatalog({
      provider: 'ollama-cloud',
      baseUrl: 'https://ollama.test/v1',
      previous: [
        savedRow({ id: 'custom/a', providerModelId: 'a', capabilities: ['chat'] }),
        savedRow({ id: 'custom/b', providerModelId: 'b', capabilities: ['chat', 'tools'] })
      ],
      fetch: endpoint([{ id: 'a', context_length: 8_000 }])
    });
    // No parameter list means the endpoint denied nothing, so the declared set stands whole.
    expect(rows[0]?.capabilities).toEqual(['chat', 'tools']);
  });

  it('writes the private route the owner asked for on this account', async () => {
    const [row] = await refreshConfiguredCatalog({
      provider: 'ollama-cloud',
      baseUrl: 'https://ollama.test/v1',
      enforceZeroDataRetention: true,
      previous: [savedRow({ id: 'custom/one', providerModelId: 'one' })],
      fetch: endpoint([{ id: 'one', context_length: 8_000 }])
    });
    expect(row?.privacyRoute).toBe('provider_zdr');
  });

  /*
   * An endpoint answering with nothing this refresh recognises is an outage wearing a 200 - a
   * gateway restarting, a proxy interstitial, a plan between renewals. An empty list is what
   * `replaceModelCatalog` prunes nothing on, so the catalogue already here goes on serving.
   */
  it('answers with nothing rather than an emptied catalogue when the endpoint lists none of ours', async () => {
    expect(
      await refreshConfiguredCatalog({
        provider: 'openai-compatible',
        baseUrl: 'https://gateway.test/v1',
        modelId: 'served-model',
        previous: [savedRow()],
        fetch: endpoint([])
      })
    ).toEqual([]);
  });

  it('reports an endpoint that refused rather than treating the refusal as an empty catalogue', async () => {
    await expect(
      refreshConfiguredCatalog({
        provider: 'ollama-cloud',
        baseUrl: 'https://ollama.test/v1',
        previous: [savedRow()],
        fetch: async () => new Response('nope', { status: 401 })
      })
    ).rejects.toThrow(/401/);
  });
});
