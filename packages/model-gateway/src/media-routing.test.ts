import { describe, expect, it, vi } from 'vitest';
import { MediaRouteResolver } from './media-routing.js';

const credential = {
  provider: 'openrouter',
  baseUrl: 'https://provider.example/v1',
  apiKey: 'test-key',
  enforceZeroDataRetention: true
};
const fixture = () => {
  let available = true;
  const request = vi.fn(async (input: string | URL | Request) => {
    if (!available) throw new Error('provider offline');
    const url = input instanceof Request ? input.url : String(input);
    return Response.json(
      url.includes('/images/models/vendor/current/endpoints')
        ? {
            endpoints: [
              {
                provider_tag: 'private',
                pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.04 }]
              }
            ]
          }
        : {
            data: url.endsWith('/images/models')
              ? [
                  {
                    id: 'vendor/current',
                    name: 'Current image',
                    architecture: { output_modalities: ['image'] }
                  }
                ]
              : url.endsWith('/endpoints/zdr')
                ? [{ model_id: 'vendor/current', tag: 'private', status: 0 }]
                : []
          }
    );
  });
  return {
    request,
    fail: () => {
      available = false;
    }
  };
};

describe('one media route policy for display and execution', () => {
  it('independent cold API and worker resolvers select the same live endpoint without saved preferences', async () => {
    const { request } = fixture();
    const api = await new MediaRouteResolver({ fetch: request }).resolve(credential);
    const worker = await new MediaRouteResolver({ fetch: request }).resolve(credential);
    expect(api.routes.image).toMatchObject({
      providerModelId: 'vendor/current',
      providerEndpointTag: 'private',
      pricing: [{ costUsd: 0.04 }]
    });
    const identity = (routes: typeof api.routes) =>
      Object.fromEntries(
        Object.entries(routes).map(([kind, route]) => {
          const copy = { ...route };
          delete copy.metadataVerifiedAt;
          return [kind, { ...copy, updatedAt: '' }];
        })
      );
    expect(identity(worker.routes)).toEqual(identity(api.routes));
    expect(api.options.filter((route) => !route.unavailableReason)).toHaveLength(1);
    expect(api.options.find((route) => route.id === api.routes.image?.id)).toEqual(
      api.routes.image
    );
  });

  it('never replaces an explicit unavailable model with another model', async () => {
    const { request } = fixture();
    const result = await new MediaRouteResolver({ fetch: request }).resolve({
      ...credential,
      mediaModels: { image: { automatic: false, preference: 'balanced', modelId: 'withdrawn' } }
    });
    expect(result.options.filter((route) => !route.unavailableReason)).toHaveLength(1);
    expect(result.routes.image).toBeUndefined();
  });

  it('bounds repeated metadata reads and refuses expired or different-account metadata on outage', async () => {
    const { request, fail } = fixture();
    let now = 0;
    const resolver = new MediaRouteResolver({ fetch: request, now: () => now });
    expect((await resolver.resolve(credential)).routes.image?.providerModelId).toBe(
      'vendor/current'
    );
    const count = request.mock.calls.length;
    expect(count).toBeGreaterThan(0);
    await resolver.resolve(credential);
    expect(request).toHaveBeenCalledTimes(count);
    now = 300_001;
    fail();
    const expired = await resolver.resolve(credential);
    expect(expired.options.length).toBeGreaterThan(0);
    expect(expired.options.every((route) => Boolean(route.unavailableReason))).toBe(true);
    expect(expired.routes.image).toBeUndefined();
    const changed = await resolver.resolve({ ...credential, apiKey: 'different' });
    expect(changed.options.length).toBeGreaterThan(0);
    expect(changed.options.some((route) => route.providerModelId === 'vendor/current')).toBe(false);
    expect(changed.routes.image).toBeUndefined();
  });
});
