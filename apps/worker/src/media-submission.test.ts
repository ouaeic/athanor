import { afterEach, expect, it, vi } from 'vitest';
import { seedMediaModels, type ModelToolCall } from '@athanor/model-gateway';
import type { AgentState, InferenceCredential } from './agent-state.js';
import type { ToolContext } from './tool-dispatch.js';
import { pinMediaGenerationApproval } from './media-approval.js';
import { executeDocumentTool } from './tools/documents.js';
afterEach(() => vi.unstubAllGlobals());
it.each(['model', 'price', 'credential'] as const)(
  'refuses a %s change after preparation and before reservation or provider upload',
  async (change) => {
    const routes = seedMediaModels();
    expect(routes.length).toBeGreaterThan(0);
    const route = routes.find((item) => item.modality === 'image')!;
    const secret: InferenceCredential = {
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'first',
      enforceZeroDataRetention: true,
      mediaRoutes: { image: route }
    };
    let latest = secret;
    const key = Buffer.alloc(32, 9),
      state: AgentState = { messages: [], step: 0, credits: 0 };
    const call: ModelToolCall = {
      id: 'image-request',
      name: 'generate_media',
      arguments: { kind: 'image', prompt: 'A blue circle', path: 'circle.png' }
    };
    const upload = vi.fn(() => {
      throw Error('Provider must not be contacted');
    });
    vi.stubGlobal('fetch', upload);
    const recordUsage = vi.fn(),
      guard = vi.fn(async () => {
        latest = {
          ...secret,
          ...(change === 'credential'
            ? { apiKey: 'replacement' }
            : {
                mediaRoutes: {
                  image: {
                    ...route,
                    ...(change === 'model'
                      ? { providerModelId: 'replacement' }
                      : { usdPerImage: 0.9 })
                  }
                }
              })
        };
        return { outcome: 'allow' };
      });
    const context = {
      key,
      state,
      task: { id: 'task', userId: 'owner', workspaceId: 'workspace', privacyRoute: 'provider_zdr' },
      config: { WORKER_ID: 'worker', PUBLIC_APP_URL: 'https://garden.example' },
      inferenceCredential: async () => latest,
      store: {
        spendGuard: guard,
        recordUsage,
        taskClaim: async () => ({ status: 'running', leaseOwner: 'worker' })
      }
    } as unknown as ToolContext;
    pinMediaGenerationApproval(key, context.task, state, call, secret);
    await expect(executeDocumentTool(context, call)).rejects.toMatchObject({
      code: 'media_route_changed'
    });
    expect(guard).toHaveBeenCalledOnce();
    expect(recordUsage).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  }
);
