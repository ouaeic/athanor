import { AthanorError } from '@athanor/core';
import type { ModelAdapter, ModelRequest, ModelResponse, ProviderModel } from './protocol.js';
import { defaultRetryPolicy, withRetry, type RetryPolicy } from './retry.js';

export type { RetryPolicy } from './retry.js';

export class ModelGateway {
  readonly #adapters = new Map<string, ModelAdapter>();
  readonly #retry: RetryPolicy;

  constructor(options: { retry?: RetryPolicy } = {}) {
    this.#retry = options.retry ?? defaultRetryPolicy;
  }

  register(name: string, adapter: ModelAdapter): this {
    this.#adapters.set(name, adapter);
    return this;
  }

  has(name: string): boolean {
    return this.#adapters.has(name);
  }

  async list(): Promise<ProviderModel[]> {
    const results = await Promise.allSettled(
      [...this.#adapters.values()].map((adapter) => adapter.list())
    );
    return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  }

  async chat(provider: string, request: ModelRequest): Promise<ModelResponse> {
    const adapter = this.#adapters.get(provider);
    if (!adapter)
      throw new AthanorError('provider_not_configured', `Provider ${provider} is not configured`);
    // A long-running task must not die on one transient upstream fault, but replaying a request
    // whose output the owner has already seen would duplicate it, so streaming is watched here
    // rather than trusted to the adapter.
    let streamed = false;
    const onTextDelta = request.onTextDelta;
    const attempted: ModelRequest = onTextDelta
      ? {
          ...request,
          onTextDelta: async (delta: string): Promise<void> => {
            streamed = true;
            await onTextDelta(delta);
          }
        }
      : request;
    return withRetry(() => adapter.chat(attempted), {
      policy: this.#retry,
      hasStreamed: () => streamed,
      ...(request.signal ? { signal: request.signal } : {})
    });
  }
}
