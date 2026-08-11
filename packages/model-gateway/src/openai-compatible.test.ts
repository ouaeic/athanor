import { resolveWebToolPlan } from '@athanor/contracts';
import { AthanorError } from '@athanor/core';
import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import { isRetryableError, retryAfterMsOf } from './retry.js';

describe('OpenAICompatibleAdapter', () => {
  it('calls a managed OpenRouter model with tools and fail-closed privacy routing', async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'z-ai/glm-5.2', owned_by: 'z-ai' }] }), {
          status: 200
        });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer managed-key');
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
      expect(JSON.parse(init.body)).toMatchObject({
        model: 'z-ai/glm-5.2',
        session_id: 'opaque-task-session',
        reasoning: { effort: 'high' },
        messages: [
          { role: 'assistant', content: '', reasoning: 'encrypted prior reasoning' },
          { role: 'user', content: 'Inspect the workspace' }
        ],
        provider: {
          zdr: true,
          data_collection: 'deny',
          require_parameters: true,
          allow_fallbacks: true
        }
      });
      return new Response(
        JSON.stringify({
          model: 'z-ai/glm-5.2',
          provider: 'inference.net',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                reasoning: 'inspect before acting',
                reasoning_details: [{ type: 'reasoning.text', text: 'inspect before acting' }],
                tool_calls: [
                  {
                    id: 'call-1',
                    function: { name: 'shell', arguments: '{"command":"pwd"}' }
                  }
                ]
              }
            }
          ],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, cost: 0.004 }
        }),
        { status: 200 }
      );
    });
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'provider_zdr',
      enforceZeroDataRetention: true,
      fetch: request as typeof fetch
    });

    await expect(adapter.list()).resolves.toEqual([
      { id: 'z-ai/glm-5.2', provider: 'openrouter', revision: 'z-ai' }
    ]);
    await expect(
      adapter.chat({
        model: 'z-ai/glm-5.2',
        messages: [
          { role: 'assistant', content: '', reasoning: 'encrypted prior reasoning' },
          { role: 'user', content: 'Inspect the workspace' }
        ],
        tools: [{ name: 'shell', description: 'Run a command', parameters: {} }],
        temperature: 0.2,
        reasoningEffort: 'high',
        sessionId: 'opaque-task-session'
      })
    ).resolves.toMatchObject({
      toolCalls: [{ id: 'call-1', name: 'shell', arguments: { command: 'pwd' } }],
      reasoning: 'inspect before acting',
      reasoningDetails: [{ type: 'reasoning.text', text: 'inspect before acting' }],
      finishReason: 'tool_calls',
      usage: { costUsd: 0.004 },
      metadata: {
        provider: 'openrouter',
        upstreamProvider: 'inference.net',
        model: 'z-ai/glm-5.2'
      }
    });
  });

  it('streams visible text while reconstructing reasoning and tool calls', async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
      expect(JSON.parse(init.body)).toMatchObject({
        stream: true,
        stream_options: { include_usage: true }
      });
      const frames = [
        {
          model: 'z-ai/glm-5.2',
          provider: 'inference.net',
          choices: [
            {
              delta: {
                content: 'I will ',
                reasoning: 'inspect ',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-2',
                    function: { name: 'shell', arguments: '{"executable":' }
                  }
                ]
              }
            }
          ]
        },
        {
          choices: [
            {
              finish_reason: 'tool_calls',
              delta: {
                content: 'check.',
                reasoning: 'first',
                tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }]
              }
            }
          ],
          usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14, cost: 0.002 }
        }
      ]
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join('')
        .concat('data: [DONE]\n\n');
      return new Response(frames, { headers: { 'content-type': 'text/event-stream' } });
    });
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'provider_zdr',
      fetch: request as typeof fetch
    });
    const deltas: string[] = [];
    const result = await adapter.chat({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'Check the workspace' }],
      tools: [{ name: 'shell', description: 'Run a command', parameters: {} }],
      temperature: 0.2,
      onTextDelta: (delta) => {
        deltas.push(delta);
      }
    });

    expect(deltas).toEqual(['I will ', 'check.']);
    expect(result).toMatchObject({
      text: 'I will check.',
      reasoning: 'inspect first',
      toolCalls: [{ id: 'call-2', name: 'shell', arguments: { executable: 'pwd' } }],
      finishReason: 'tool_calls',
      usage: { totalTokens: 14, costUsd: 0.002 }
    });
  });

  const cachingAdapter = (capture: { body?: unknown }, usage?: Record<string, unknown>) =>
    new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'external',
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
        capture.body = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'done' } }],
            usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, ...usage }
          }),
          { status: 200 }
        );
      }) as typeof fetch
    });

  it('marks cache breakpoints as content blocks for routes that bill them', async () => {
    const capture: { body?: unknown } = {};
    await cachingAdapter(capture).chat({
      model: 'anthropic/claude-opus-5',
      messages: [
        { role: 'system', content: 'contract', cacheBreakpoint: true },
        { role: 'user', content: 'go' },
        { role: 'tool', toolCallId: 'call-1', content: 'result', cacheBreakpoint: true }
      ],
      tools: [],
      temperature: 0.2
    });

    expect((capture.body as { messages: unknown[] }).messages).toEqual([
      {
        role: 'system',
        content: [{ type: 'text', text: 'contract', cache_control: { type: 'ephemeral' } }]
      },
      { role: 'user', content: 'go' },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: [{ type: 'text', text: 'result', cache_control: { type: 'ephemeral' } }]
      }
    ]);
  });

  it('never sends a cache field to routes that cache automatically', async () => {
    const capture: { body?: unknown } = {};
    await cachingAdapter(capture).chat({
      model: 'openai/gpt-6',
      messages: [
        { role: 'system', content: 'contract', cacheBreakpoint: true },
        { role: 'user', content: 'go', cacheBreakpoint: true }
      ],
      tools: [],
      temperature: 0.2
    });

    expect((capture.body as { messages: unknown[] }).messages).toEqual([
      { role: 'system', content: 'contract' },
      { role: 'user', content: 'go' }
    ]);
  });

  it('keeps at most four breakpoints and prefers the newest prefixes', async () => {
    const capture: { body?: unknown } = {};
    await cachingAdapter(capture).chat({
      model: 'anthropic/claude-opus-5',
      messages: Array.from({ length: 6 }, (_unused, index) => ({
        role: 'user' as const,
        content: `turn-${index}`,
        cacheBreakpoint: true
      })),
      tools: [],
      temperature: 0.2
    });

    const messages = (capture.body as { messages: Array<{ content: unknown }> }).messages;
    expect(messages.map((message) => typeof message.content === 'string')).toEqual([
      true,
      true,
      false,
      false,
      false,
      false
    ]);
  });

  it('leaves an image message as plain image blocks rather than guessing a marker position', async () => {
    const capture: { body?: unknown } = {};
    await cachingAdapter(capture).chat({
      model: 'anthropic/claude-opus-5',
      messages: [
        {
          role: 'user',
          content: 'look',
          images: ['data:image/png;base64,AA'],
          cacheBreakpoint: true
        }
      ],
      tools: [],
      temperature: 0.2
    });

    expect((capture.body as { messages: unknown[] }).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }
        ]
      }
    ]);
  });

  const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

  const streamingAdapter = (
    body: BodyInit,
    options: {
      streamIdleTimeoutMs?: number;
      generationTimeoutMs?: number;
      generationMaxChars?: number;
    } = {}
  ): OpenAICompatibleAdapter =>
    new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'provider_zdr',
      ...options,
      fetch: (async () =>
        new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
    });

  const streamRequest = (adapter: OpenAICompatibleAdapter, deltas: string[]): Promise<unknown> =>
    adapter.chat({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'Summarise the workspace' }],
      tools: [],
      temperature: 0.2,
      onTextDelta: (delta) => {
        deltas.push(delta);
      }
    });

  it('raises a mid-stream error frame instead of returning a truncated turn as a success', async () => {
    const deltas: string[] = [];
    const frames = [
      'data: {"choices":[{"delta":{"content":"Working on "}}]}\n\n',
      'data: {"error":{"code":429,"message":"rate limited mid-stream","metadata":{"headers":{"Retry-After":"120"}}}}\n\n'
    ].join('');

    const failure = await streamRequest(streamingAdapter(frames), deltas).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(AthanorError);
    expect((failure as AthanorError).code).toBe('provider_quota_exhausted');
    expect((failure as AthanorError).statusCode).toBe(429);
    expect((failure as AthanorError).message).toContain('rate limited mid-stream');
    expect(retryAfterMsOf(failure)).toBe(120_000);
    expect(deltas).toEqual(['Working on ']);
  });

  it('treats an unnumbered mid-stream fault as a retryable upstream failure', async () => {
    const failure = await streamRequest(
      streamingAdapter('data: {"error":{"message":"upstream model crashed"}}\n\n'),
      []
    ).catch((error: unknown) => error);

    expect((failure as AthanorError).code).toBe('provider_request_failed');
    expect((failure as AthanorError).statusCode).toBe(502);
    expect(isRetryableError(failure)).toBe(true);
  });

  it('raises an error object that arrives in an otherwise successful body', async () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      provider: 'openrouter',
      privacyRoute: 'provider_zdr',
      fetch: (async () =>
        new Response(JSON.stringify({ error: { code: 503, message: 'no instances available' } }), {
          status: 200
        })) as typeof fetch
    });

    await expect(
      adapter.chat({
        model: 'z-ai/glm-5.2',
        messages: [{ role: 'user', content: 'go' }],
        tools: [],
        temperature: 0.2
      })
    ).rejects.toThrow('no instances available');
  });

  it('classifies a connection dropped mid-stream as retryable, like one dropped before it', async () => {
    const deltas: string[] = [];
    let delivered = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(encode('data: {"choices":[{"delta":{"content":"Half an "}}]}\n\n'));
          return;
        }
        controller.error(
          Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } })
        );
      }
    });

    const failure = await streamRequest(streamingAdapter(body), deltas).catch(
      (error: unknown) => error
    );

    expect((failure as AthanorError).code).toBe('provider_unavailable');
    expect((failure as AthanorError).statusCode).toBe(503);
    expect((failure as AthanorError).message).toContain('UND_ERR_SOCKET');
    expect(isRetryableError(failure)).toBe(true);
    expect(deltas).toEqual(['Half an ']);
  });

  it('keeps what a stream had written when it goes silent, rather than losing it with the error', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode('data: {"choices":[{"delta":{"content":"Thinking"}}]}\n\n'));
      }
    });

    const result = await streamRequest(streamingAdapter(body, { streamIdleTimeoutMs: 25 }), deltas);

    expect(result).toMatchObject({
      text: 'Thinking',
      finishReason: 'length',
      truncated: { reason: 'stalled' },
      // The provider's usage frame never arrived, so it is estimated from what was generated rather
      // than recorded as the zero the owner watched for a quarter of an hour.
      usage: { outputTokens: 2, estimated: true }
    });
    expect(deltas).toEqual(['Thinking']);
  });

  it('reports a stream that goes silent before it says anything as the retryable provider fault it is', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      start() {
        // Headers, then nothing at all: no text reached the caller, so a second attempt costs the
        // owner nothing they have already paid for and may well land on a working instance.
      }
    });

    const failure = await streamRequest(
      streamingAdapter(body, { streamIdleTimeoutMs: 25 }),
      deltas
    ).catch((error: unknown) => error);

    expect((failure as AthanorError).code).toBe('provider_stream_stalled');
    expect((failure as AthanorError).statusCode).toBe(504);
    expect(isRetryableError(failure)).toBe(true);
    expect(deltas).toEqual([]);
  });

  /*
   * The measured failure. A stream that never goes quiet for long enough to look stalled, produces
   * a trickle, and would keep producing it until the caller's fifteen-minute deadline. The idle
   * clock cannot see this - every read returns - so the generation clock is what ends it, and it
   * ends it with the answer in hand.
   */
  it('cuts a generation that streams forever without finishing, and hands back what it wrote', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        controller.enqueue(encode('data: {"choices":[{"delta":{"content":"and on "}}]}\n\n'));
      }
    });

    const result = (await streamRequest(
      streamingAdapter(body, { streamIdleTimeoutMs: 500, generationTimeoutMs: 60 }),
      deltas
    )) as { text: string; truncated?: { reason: string; detail: string } };

    expect(result.truncated?.reason).toBe('timeout');
    expect(result.truncated?.detail).toContain('still writing');
    expect(result.text.startsWith('and on ')).toBe(true);
    expect(deltas.length).toBeGreaterThan(1);
  });

  it('stops a route that writes past the output ceiling the request asked for', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        controller.enqueue(encode('data: {"choices":[{"delta":{"content":"0123456789"}}]}\n\n'));
      }
    });

    // The clock is set as well, and deliberately much later: a route with no ceiling on it would be
    // cut by the deadline eventually, and this has to show the ceiling doing the cutting.
    const result = (await streamRequest(
      streamingAdapter(body, { generationMaxChars: 25, generationTimeoutMs: 300 }),
      deltas
    )) as { text: string; truncated?: { reason: string } };

    expect(result.truncated?.reason).toBe('overrun');
    expect(result.text.length).toBeGreaterThan(25);
    expect(result.text.length).toBeLessThan(60);
  });

  it('leaves an answer that finishes inside its budget completely alone', async () => {
    const deltas: string[] = [];
    const paragraph = 'The importer reads all three columns. '.repeat(40);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const sentence of paragraph.split('. ').filter(Boolean))
          controller.enqueue(
            encode(`data: {"choices":[{"delta":{"content":"${sentence}. "}}]}\n\n`)
          );
        controller.enqueue(
          encode(
            'data: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":900,"completion_tokens":380}}\n\n'
          )
        );
        controller.close();
      }
    });

    const result = (await streamRequest(streamingAdapter(body), deltas)) as {
      finishReason: string;
      truncated?: unknown;
      usage: { outputTokens: number; estimated?: true };
    };

    expect(result.finishReason).toBe('stop');
    expect(result.truncated).toBeUndefined();
    // The provider's own count stands; nothing here estimates over the top of it.
    expect(result.usage).toEqual({ inputTokens: 900, outputTokens: 380, totalTokens: 1280 });
  });

  /*
   * The largest thing this product generates is not prose - it is the content of a file, and that
   * travels inside a tool call's arguments. Those characters were once counted by nothing: the
   * ceiling could not see them, so a route writing a runaway file ran to the clock, and the answer
   * came back billed at zero for twenty-four thousand characters of generation.
   */
  it('counts what a runaway tool call writes, and bills for it', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        controller.enqueue(
          encode(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-1',
                        function: { name: 'file_write', arguments: 'x'.repeat(200) }
                      }
                    ]
                  }
                }
              ]
            })}\n\n`
          )
        );
      }
    });

    // The clock is set as well, and deliberately later than the ceiling, so that a run which stops
    // counting these characters fails on the reason rather than by hanging until vitest gives up.
    const result = (await streamRequest(
      streamingAdapter(body, { generationMaxChars: 400, generationTimeoutMs: 300 }),
      deltas
    )) as {
      finishReason: string;
      truncated?: { reason: string };
      usage: { outputTokens: number; estimated?: true };
      toolCalls: { rawArguments?: string }[];
    };

    expect(result.truncated?.reason).toBe('overrun');
    // A cut-off call is still a call the loop has to refuse rather than run, and `length` is how it
    // is told the arguments were cut rather than malformed.
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage.estimated).toBe(true);
    expect(result.usage.outputTokens).toBeGreaterThan(100);
    expect(result.toolCalls[0]?.rawArguments?.length).toBeGreaterThanOrEqual(400);
  });

  /*
   * A cut-off answer is only worth continuing if continuing it can finish it, and the loop upstream
   * continues one three times before giving up. At the rate the measured failure produced - ten
   * characters a second - those three continuations buy half an hour and end up cut off anyway, so
   * this is reported as the end of an answer rather than as one to carry on from.
   */
  it('does not ask a route that has stopped being productive to carry on', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // Ten characters a second, which is the rate the incident was measured at.
        await new Promise((resolve) => setTimeout(resolve, 100));
        controller.enqueue(encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
      }
    });

    const result = (await streamRequest(
      streamingAdapter(body, { streamIdleTimeoutMs: 500, generationTimeoutMs: 250 }),
      deltas
    )) as { text: string; finishReason: string; truncated?: { reason: string } };

    expect(result.truncated?.reason).toBe('timeout');
    expect(result.finishReason).toBe('stop');
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('asks a long answer that was still being written to carry on', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        controller.enqueue(
          encode(`data: {"choices":[{"delta":{"content":"${'a'.repeat(200)}"}}]}\n\n`)
        );
      }
    });

    const result = (await streamRequest(
      streamingAdapter(body, { streamIdleTimeoutMs: 500, generationTimeoutMs: 200 }),
      deltas
    )) as { finishReason: string; truncated?: { reason: string } };

    expect(result.truncated?.reason).toBe('timeout');
    expect(result.finishReason).toBe('length');
  });

  /*
   * The deadline has to hold against a route that keeps the socket busy, and racing it against the
   * read is not enough to make it: a read that finds bytes already buffered resolves as a settled
   * promise, and a settled promise runs ahead of any timer. Measured before the loop read the clock
   * for itself, a stream like this one ran forty-three times past its deadline and was stopped in
   * the end by the character ceiling - the wrong bound, under the wrong name.
   */
  it('holds the deadline against a stream that never makes it wait', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(
          encode(`data: {"choices":[{"delta":{"content":"${'c'.repeat(100)}"}}]}\n\n`)
        );
      }
    });

    const result = (await streamRequest(
      streamingAdapter(body, { generationTimeoutMs: 5, generationMaxChars: 60_000 }),
      deltas
    )) as { truncated?: { reason: string } };

    expect(result.truncated?.reason).toBe('timeout');
    expect(deltas.join('').length).toBeLessThan(60_000);
  });

  /*
   * A route that reports usage on every chunk rather than only at the end reports a count that
   * stops where the cut did. Trusting it is the same zero the owner was shown, one decimal place
   * along, so the larger of the two numbers stands.
   */
  it('will not bill a cut-off answer at the count a half-finished usage frame carried', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        controller.enqueue(
          encode(
            `data: {"choices":[{"delta":{"content":"${'b'.repeat(100)}"}}],"usage":{"prompt_tokens":900,"completion_tokens":1}}\n\n`
          )
        );
      }
    });

    const result = (await streamRequest(
      streamingAdapter(body, { generationTimeoutMs: 120 }),
      deltas
    )) as { usage: { inputTokens: number; outputTokens: number; estimated?: true } };

    expect(result.usage.estimated).toBe(true);
    expect(result.usage.outputTokens).toBeGreaterThan(50);
    // The prompt was reported by the provider and is not estimated over.
    expect(result.usage.inputTokens).toBe(900);
  });

  it('lets a slow but productive stream run past the idle window', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const part of ['one ', 'two ', 'three']) {
          await new Promise((resolve) => setTimeout(resolve, 15));
          controller.enqueue(encode(`data: {"choices":[{"delta":{"content":"${part}"}}]}\n\n`));
        }
        controller.enqueue(encode('data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n'));
        controller.close();
      }
    });

    await expect(
      streamRequest(streamingAdapter(body, { streamIdleTimeoutMs: 40 }), deltas)
    ).resolves.toMatchObject({ text: 'one two three', finishReason: 'stop' });
    expect(deltas).toEqual(['one ', 'two ', 'three']);
  });

  it('reports cache accounting back to usage', async () => {
    const capture: { body?: unknown } = {};
    const result = await cachingAdapter(capture, {
      prompt_tokens_details: { cached_tokens: 64 },
      cache_creation_input_tokens: 30
    }).chat({
      model: 'anthropic/claude-opus-5',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      temperature: 0.2
    });

    expect(result.usage).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 64,
      cacheWriteTokens: 30
    });
  });

  it('takes the cache style from the catalogue when the caller supplies it', async () => {
    const marked: { body?: unknown } = {};
    await cachingAdapter(marked).chat({
      model: 'openai/gpt-5.6-terra',
      promptCacheStyle: 'explicit',
      messages: [{ role: 'system', content: 'contract', cacheBreakpoint: true }],
      tools: [],
      temperature: 0.2
    });
    expect((marked.body as { messages: unknown[] }).messages).toEqual([
      {
        role: 'system',
        content: [{ type: 'text', text: 'contract', cache_control: { type: 'ephemeral' } }]
      }
    ]);

    // ...and a route the catalogue says does not cache is sent nothing, whatever its vendor is.
    const plain: { body?: unknown } = {};
    await cachingAdapter(plain).chat({
      model: 'anthropic/claude-opus-5',
      promptCacheStyle: 'none',
      messages: [{ role: 'system', content: 'contract', cacheBreakpoint: true }],
      tools: [],
      temperature: 0.2
    });
    expect((plain.body as { messages: unknown[] }).messages).toEqual([
      { role: 'system', content: 'contract' }
    ]);
  });

  it('clamps the output ask to what the route will write, and withholds an unsupported effort', async () => {
    const capture: { body?: unknown } = {};
    await cachingAdapter(capture).chat({
      model: 'anthropic/claude-sonnet-5',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      temperature: 0.2,
      maxTokens: 120_000,
      maxOutputTokens: 64_000,
      reasoningEffort: 'high',
      supportsReasoningEffort: false
    });
    const body = capture.body as { max_tokens?: number; reasoning?: unknown };
    expect(body.max_tokens).toBe(64_000);
    expect(body.reasoning).toBeUndefined();
  });

  it('sends a zero-retention route only the parameters it declared, and still demands they hold', async () => {
    // The failure this locks out: under zero data retention the request asks the provider to
    // honour every parameter it receives, and OpenRouter reads that against each endpoint's own
    // declared list. A route that never declared `temperature` was then no route at all - 404, no
    // endpoint found, for a model the catalogue listed as available. Since zero data retention is
    // what a fresh install turns on, that was every task on every new box.
    const capture: { body?: unknown } = {};
    const requested: string[] = [];
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'provider_zdr',
      enforceZeroDataRetention: true,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requested.push(url);
        if (url.endsWith('/endpoints/zdr'))
          return new Response(
            JSON.stringify({
              data: [
                // The shape a real private route takes: tools and reasoning, no temperature, and
                // the output cap under its other name.
                {
                  model_id: 'openai/gpt-5.6-luna',
                  status: 0,
                  supported_parameters: [
                    'tools',
                    'tool_choice',
                    'reasoning',
                    'reasoning_effort',
                    'max_completion_tokens'
                  ]
                },
                // A poorer route for the same model, which must not be the one measured against.
                { model_id: 'openai/gpt-5.6-luna', status: 0, supported_parameters: ['seed'] }
              ]
            }),
            { status: 200 }
          );
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
        capture.body = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'done' } }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
          }),
          { status: 200 }
        );
      }) as typeof fetch
    });
    const ask = {
      model: 'openai/gpt-5.6-luna',
      messages: [{ role: 'user' as const, content: 'go' }],
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
      temperature: 0.2,
      maxTokens: 512,
      reasoningEffort: 'high' as const
    };
    await adapter.chat(ask);
    const body = capture.body as Record<string, unknown>;
    expect(body.temperature).toBeUndefined();
    // Reasoning survives, because this route does take it.
    expect(body.reasoning).toEqual({ effort: 'high' });
    // The cap survives too, under the name the route declared, rather than being dropped.
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBe(512);
    // Tools are never withheld: a route that cannot call them has to fail rather than answer as
    // though the agent had none.
    expect((body.tools as unknown[]).length).toBe(1);
    expect(body.provider).toMatchObject({ zdr: true, require_parameters: true });

    // The declared list is fetched once and reused, not re-read for every turn of a task.
    await adapter.chat(ask);
    expect(requested.filter((url) => url.endsWith('/endpoints/zdr'))).toHaveLength(1);
  });

  it('leaves the output ask alone when the catalogue never published a limit', async () => {
    const capture: { body?: unknown } = {};
    await cachingAdapter(capture).chat({
      model: 'anthropic/claude-sonnet-5',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      temperature: 0.2,
      maxTokens: 8_000,
      reasoningEffort: 'high'
    });
    const body = capture.body as { max_tokens?: number; reasoning?: unknown };
    expect(body.max_tokens).toBe(8_000);
    expect(body.reasoning).toEqual({ effort: 'high' });
  });

  it('times the first token, because nothing publishes a latency for these routes', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.enqueue(encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.enqueue(encode('data: {"choices":[{"delta":{"content":" rest"}}]}\n\n'));
        controller.enqueue(encode('data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n'));
        controller.close();
      }
    });
    const result = (await streamRequest(streamingAdapter(body), deltas)) as {
      metadata: { latencyMs: number; timeToFirstTokenMs?: number };
    };
    expect(result.metadata.timeToFirstTokenMs).toBeGreaterThan(0);
    expect(result.metadata.timeToFirstTokenMs).toBeLessThanOrEqual(result.metadata.latencyMs);
  });

  it('reports no first-token time on a turn that was never streamed', async () => {
    const capture: { body?: unknown } = {};
    const result = await cachingAdapter(capture).chat({
      model: 'anthropic/claude-opus-5',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      temperature: 0.2
    });
    expect(result.metadata.timeToFirstTokenMs).toBeUndefined();
  });

  it('reports what a configured endpoint declares about itself, and what it does not', async () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'http://127.0.0.1:8000/v1',
      provider: 'openai-compatible',
      privacyRoute: 'external',
      fetch: (async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'qwen3-32b', max_model_len: 131_072, owned_by: 'vllm' },
              {
                id: 'gpt-5.6-sol',
                name: 'GPT-5.6 Sol',
                context_length: 400_000,
                top_provider: { max_completion_tokens: 128_000 },
                pricing: { prompt: '0.000001', completion: '0.000006' },
                supported_parameters: ['tools', 'reasoning_effort']
              },
              { id: 'mystery-model' }
            ]
          }),
          { status: 200 }
        )) as typeof fetch
    });

    const described = await adapter.describe();
    expect(described[0]).toMatchObject({
      id: 'qwen3-32b',
      contextTokens: 131_072,
      metadataSource: 'declared'
    });
    expect(described[0]?.unknownFields).toEqual([
      'maxOutputTokens',
      'inputUsdPerMillionTokens',
      'outputUsdPerMillionTokens',
      'supportedParameters'
    ]);
    expect(described[1]).toMatchObject({
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      contextTokens: 400_000,
      maxOutputTokens: 128_000,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 6,
      supportsTools: true,
      supportsReasoningEffort: true,
      metadataSource: 'declared'
    });
    // An endpoint that publishes nothing is recorded as unknown rather than given invented numbers.
    expect(described[2]).toMatchObject({ id: 'mystery-model', metadataSource: 'unknown' });
    expect(described[2]?.contextTokens).toBeNull();
  });

  const providerSearchPlan = resolveWebToolPlan({ provider: 'openrouter' });

  it('sends a provider-side tool unwrapped, in the tools array it shares with none', async () => {
    const capture: { body?: unknown } = {};
    await cachingAdapter(capture).chat({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'Query: what changed in the rules this week?' }],
      // Empty, because this is the request athanor builds to spend one provider search and nothing
      // else. A function tool here would be a second answerer for the same question.
      tools: [],
      serverTools: providerSearchPlan.serverTools,
      temperature: 0.2
    });

    // A server tool wrapped as `{type:'function'}` would be a claim that this box answers the call.
    expect((capture.body as { tools: unknown[] }).tools).toEqual([
      { type: 'openrouter:web_search', engine: 'auto', max_results: 10, max_uses: 2 }
    ]);
  });

  it('sends nothing extra when the plan withheld the provider tools', async () => {
    const capture: { body?: unknown } = {};
    const inHouse = resolveWebToolPlan({ provider: 'openrouter', forceInHouse: true });
    await cachingAdapter(capture).chat({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'web_search', description: 'Search the internet', parameters: {} }],
      serverTools: inHouse.serverTools,
      temperature: 0.2
    });

    expect((capture.body as { tools: unknown[] }).tools).toEqual([
      {
        type: 'function',
        function: { name: 'web_search', description: 'Search the internet', parameters: {} }
      }
    ]);
  });

  /**
   * This used to be a refusal, and the refusal was the bug.
   *
   * Zero-retention enforcement covers inference routing and says in terms that it does not cover
   * tools - so a search query sits outside that guarantee whether the tools are sent or withheld,
   * and withholding them protected nothing. What it did do was take search off every box configured
   * the shipped way, because the flag ships on, and this adapter is the last code before the wire:
   * an owner who reached this point had already been told by the plan and by the settings page that
   * their searches would be answered by the provider, and then got an error instead.
   *
   * So the connection carries both, and both halves are asserted here: the provider block that
   * makes the inference request zero-retention, and the search tools it never covered.
   */
  it('sends provider search on a zero-retention connection, which the flag never covered', async () => {
    const capture: { body?: unknown } = {};
    const request = vi.fn(async (_url: string, init: { body: string }) => {
      capture.body = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200
      });
    });
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'provider_zdr',
      enforceZeroDataRetention: true,
      fetch: request as unknown as typeof fetch
    });

    await adapter.chat({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      serverTools: providerSearchPlan.serverTools,
      temperature: 0.2
    });

    const body = capture.body as { tools: Array<{ type: string }>; provider: unknown };
    expect(body.tools.map((tool) => tool.type)).toEqual(['openrouter:web_search']);
    expect(body.provider).toMatchObject({ zdr: true, data_collection: 'deny' });
  });

  it('refuses a search request that also offers the model a search tool of its own', async () => {
    const request = vi.fn(async () => new Response('{}', { status: 200 }));
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'external',
      fetch: request as unknown as typeof fetch
    });

    const failure = await adapter
      .chat({
        model: 'z-ai/glm-5.2',
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'web_search', description: 'Search the internet', parameters: {} }],
        serverTools: providerSearchPlan.serverTools,
        temperature: 0.2
      })
      .catch((error: unknown) => error);

    expect((failure as AthanorError).code).toBe('web_tool_catalogue_conflict');
    expect((failure as AthanorError).message).toContain('web_search');
    expect(request).not.toHaveBeenCalled();
  });

  it('carries the sources and the per-request counters back from a provider-side search', async () => {
    const capture: { body?: unknown } = {};
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'external',
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
        capture.body = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: 'The rate was held at 4.25 per cent.',
                  annotations: [
                    {
                      type: 'url_citation',
                      url_citation: {
                        url: 'https://example.invalid/decision',
                        title: 'Rate decision',
                        content: 'held at 4.25 per cent'
                      }
                    },
                    { type: 'url_citation', url_citation: { title: 'no address' } }
                  ]
                }
              }
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              server_tool_use: { web_search_requests: 2 }
            }
          }),
          { status: 200 }
        );
      }) as typeof fetch
    });

    const result = await adapter.chat({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'What did they decide?' }],
      tools: [],
      serverTools: providerSearchPlan.serverTools,
      temperature: 0.2
    });

    expect(result.citations).toEqual([
      {
        url: 'https://example.invalid/decision',
        title: 'Rate decision',
        excerpt: 'held at 4.25 per cent'
      }
    ]);
    expect(result.usage.serverToolUse).toEqual({ web_search_requests: 2 });
  });

  it('collects citations from a streamed answer, however the route spells them', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"Held.","annotations":[{"type":"url_citation","url_citation":{"url":"https://example.invalid/a","title":"A"}}]}}]}\n\n',
      // The same annotation again, which is what a route that resends the whole list looks like.
      'data: {"choices":[{"delta":{"annotations":[{"type":"url_citation","url_citation":{"url":"https://example.invalid/a","title":"A"}}]}}]}\n\n',
      // And a route that attaches the finished list to a message on the closing chunk instead.
      'data: {"choices":[{"finish_reason":"stop","delta":{},"message":{"annotations":[{"url":"https://example.invalid/b"}]}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"server_tool_use":{"web_search_requests":1}}}\n\n',
      'data: [DONE]\n\n'
    ].join('');

    const result = (await streamRequest(streamingAdapter(frames), [])) as {
      citations?: Array<{ url: string }>;
      usage: { serverToolUse?: Record<string, number> };
    };

    expect(result.citations?.map((citation) => citation.url)).toEqual([
      'https://example.invalid/a',
      'https://example.invalid/b'
    ]);
    expect(result.usage.serverToolUse).toEqual({ web_search_requests: 1 });
  });

  it('leaves both fields off a response that never used a provider tool', async () => {
    const capture: { body?: unknown } = {};
    const result = await cachingAdapter(capture).chat({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      temperature: 0.2
    });

    expect(result.citations).toBeUndefined();
    expect(result.usage.serverToolUse).toBeUndefined();
    // No `serverTools` at all, rather than an empty array nobody asked for.
    expect((capture.body as { tools: unknown[] }).tools).toEqual([]);
  });
  /*
   * A response cut off at the output cap ends mid-JSON. The arguments used to be swallowed into an
   * empty object and the call run anyway, so `file_write` arrived with no path and no content and
   * failed on a validation error that named neither the truncation nor the way out of it.
   */
  it.each([
    ['whole', false],
    ['streamed', true]
  ])(
    'marks a %s tool call whose arguments were cut off, rather than emptying them',
    async (_name, streaming) => {
      const truncated = '{"path":"report.md","content":"lorem ipsum dolor';
      const request = vi.fn(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.endsWith('/models'))
          return new Response(
            JSON.stringify({ data: [{ id: 'z-ai/glm-5.2', owned_by: 'z-ai' }] }),
            {
              status: 200
            }
          );
        if (streaming) {
          const frames = [
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-1',
                        function: { name: 'file_write', arguments: truncated }
                      }
                    ]
                  }
                }
              ]
            })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ finish_reason: 'length', delta: {} }] })}\n\n`,
            'data: [DONE]\n\n'
          ].join('');
          return new Response(frames, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
          });
        }
        return new Response(
          JSON.stringify({
            model: 'z-ai/glm-5.2',
            choices: [
              {
                finish_reason: 'length',
                message: {
                  content: '',
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: { name: 'file_write', arguments: truncated }
                    }
                  ]
                }
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 4 }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      });
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'managed-key',
        provider: 'openrouter',
        privacyRoute: 'provider_zdr',
        enforceZeroDataRetention: true,
        fetch: request as typeof fetch
      });
      const result = streaming
        ? await adapter.chat({
            model: 'z-ai/glm-5.2',
            messages: [{ role: 'user', content: 'Write the report' }],
            tools: [{ name: 'file_write', description: 'Write a file', parameters: {} }],
            temperature: 0.2,
            onTextDelta: (): void => undefined
          })
        : await adapter.chat({
            model: 'z-ai/glm-5.2',
            messages: [{ role: 'user', content: 'Write the report' }],
            tools: [{ name: 'file_write', description: 'Write a file', parameters: {} }],
            temperature: 0.2
          });
      const call = result.toolCalls[0];
      expect(call?.name).toBe('file_write');
      expect(call?.parseFailed).toBe(true);
      // The raw text is kept so the refusal can say how much was cut off.
      expect(call?.rawArguments).toBe(truncated);
      // And crucially it is NOT a plausible-looking empty call.
      expect(call?.arguments).toEqual({});
    }
  );
  /*
   * A thinking block is signed against the whole turn that produced it, so compaction or truncation
   * invalidates it and the replay is refused with a 400. Nothing about that is retryable - the same
   * bytes fail forever - and since a refusal appends nothing, a resumed task would die at the same
   * step for good. The one repair is to stop replaying the signed material.
   */
  it("drops replayed reasoning once when the provider refuses its signature, and keeps the caller's messages intact", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/models'))
        return new Response(JSON.stringify({ data: [{ id: 'z-ai/glm-5.2', owned_by: 'z-ai' }] }), {
          status: 200
        });
      if (!url.includes('/chat/completions'))
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      bodies.push(
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>
      );
      if (bodies.length === 1)
        return new Response(
          JSON.stringify({
            error: {
              message:
                'messages.1: thinking blocks cannot be modified; the signature must remain as they were'
            }
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      return new Response(
        JSON.stringify({
          model: 'z-ai/glm-5.2',
          choices: [{ finish_reason: 'stop', message: { content: 'carried on' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'provider_zdr',
      enforceZeroDataRetention: true,
      fetch: request as typeof fetch
    });
    const messages = [
      {
        role: 'assistant' as const,
        content: 'thinking out loud',
        reasoningDetails: [{ type: 'reasoning.text', text: 'signed', signature: 'abc' }]
      },
      { role: 'user' as const, content: 'carry on' }
    ];
    await expect(
      adapter.chat({
        model: 'z-ai/glm-5.2',
        messages,
        tools: [],
        temperature: 0.2
      })
    ).resolves.toMatchObject({ text: 'carried on' });

    expect(bodies).toHaveLength(2);
    const sent = (index: number): Array<Record<string, unknown>> =>
      (bodies[index]?.messages ?? []) as Array<Record<string, unknown>>;
    // First attempt replays the signed reasoning; the repair does not.
    expect(sent(0)[0]?.reasoning_details).toBeDefined();
    expect(sent(1)[0]?.reasoning_details).toBeUndefined();
    // Everything else is identical - the repair drops one field, it does not rebuild the window.
    expect(sent(1)[0]?.content).toBe('thinking out loud');
    expect(sent(1)).toHaveLength(2);
    // And the caller's own messages were never edited: persisting a stripped trajectory would make
    // every later turn replay the damage.
    expect(messages[0]?.reasoningDetails).toEqual([
      { type: 'reasoning.text', text: 'signed', signature: 'abc' }
    ]);
  });

  it('does not re-send on a 400 that is not about a reasoning signature', async () => {
    let calls = 0;
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/models'))
        return new Response(JSON.stringify({ data: [{ id: 'z-ai/glm-5.2', owned_by: 'z-ai' }] }), {
          status: 200
        });
      if (!url.includes('/chat/completions'))
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      calls += 1;
      return new Response(JSON.stringify({ error: { message: 'unknown model' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      });
    });
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'provider_zdr',
      enforceZeroDataRetention: true,
      fetch: request as typeof fetch
    });
    await expect(
      adapter.chat({
        model: 'z-ai/glm-5.2',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        temperature: 0.2
      })
    ).rejects.toThrow('unknown model');
    expect(calls).toBe(1);
  });
});
