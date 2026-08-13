/**
 * The offline rig every fixture runs on: the real agent loop, a scripted model, a scripted runner.
 *
 * Nothing here is a second execution model. `AgentWorker.run` is the same object the worker process
 * runs, taking the same store interface and the same config; what is replaced is the two things at
 * its edges that would otherwise need a provider key and a Linux box - `fetch` to the inference
 * route, and `fetch` to the workspace runner. That is exactly the seam `apps/worker/src/agent-run.test.ts`
 * already stubs, and the shapes below (the store probe, the SSE frame builders, the runner router)
 * are that machinery: the frames are byte-compatible, the probe answers the same method set, and a
 * fixture that passes here would pass as a test there.
 *
 * It is a copy rather than an import because that machinery is file-local inside a `.test.ts` and
 * exports none of it. Keeping the copy honest is cheap - both drive the same loop, so a shape this
 * one gets wrong fails loudly on the first fixture rather than silently reporting a green run.
 *
 * That claim was wrong once, and the correction is the reason `completionBody` exists below. The
 * copy had only the streaming half: every request was answered with frames, including the two the
 * loop does not stream - a compaction's brief and a delegated specialist's steps. Both callers are
 * written to survive a bad answer rather than to fail on one, so a compaction silently used its
 * deterministic fallback and a mission silently came back as a failed tool call, and the suite
 * reported green for a mechanism it was not exercising. `agent-run.test.ts` has both halves. The
 * lesson is narrower than "keep it honest": a shape this one gets wrong fails loudly only where the
 * loop has nothing to fall back on.
 *
 * The one difference that matters: the model here is a function of what athanor just said, not a
 * fixed list of replies. Every hold in the loop works by pushing a message back and asking again,
 * so a fixed list cannot tell "the model complied on the second attempt" from "the second reply
 * happened to be next". A script that reads the pushback can, and the step count it produces is
 * then the measured price of that hold.
 */
import type { ModelRelease } from '../packages/contracts/src/index.js';
import {
  decryptJson,
  encryptJson,
  generateDataKey,
  wrapDataKey
} from '../packages/core/src/crypto.js';
import type { DataStore, TaskRecord, WorkspaceRecord } from '../packages/data/src/index.js';
import { AgentWorker } from '../apps/worker/src/agent.js';
import { RUNTIME_CONTEXT_MARKER } from '../apps/worker/src/context.js';

const masterKey = Buffer.alloc(32, 5);
const runnerSecret = 'r'.repeat(48);
const userId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';
const dataKey = generateDataKey();

const PROVIDER_URL = 'https://provider.test/v1';
const RUNNER_URL = 'http://127.0.0.1:4300';

/* -------------------------------------------------------------------------- the scripted model */

export interface ScriptedCall {
  /** The id the model gives the call; `finish` evidence has to cite one of these. */
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface ModelTurn {
  /** The streamed reply, which is what the owner reads. */
  readonly text?: string;
  /** Streamed in pieces, for the shapes that only appear across chunk boundaries. */
  readonly chunks?: readonly string[];
  /** Tool calls proposed by this step; more than one is a parallel batch. */
  readonly calls?: readonly ScriptedCall[];
  /** Ends the reply at the provider's output ceiling rather than at a real stop. */
  readonly truncated?: boolean;
  /**
   * Ends the stream where the text stops: no finish reason, and no usage frame ever sent.
   *
   * This is the route that keeps writing rather than the one that finishes, and it is cut on this
   * side once it passes the ceiling the request asked for. That is the one cutoff a fixture can
   * provoke without spending the wall clock the other two are measured in - and the text has to be
   * long enough to reach the ceiling, which is why the fixture that uses it generates its answer.
   */
  readonly cut?: boolean;
}

export interface ScriptContext {
  /** Which model call this is, counting from zero. */
  readonly index: number;
  /**
   * Which step of the turn this is, counting from zero and not counting the calls a compaction
   * made. A script that works from `index` alone starts answering the wrong step the moment the
   * window is condensed once.
   */
  readonly step: number;
  /**
   * The last thing athanor said to the model, which is how every hold in the loop talks back. The
   * runtime block is stepped over: it sits at the end of every window and its clock changes.
   */
  readonly lastMessage: string;
  /** Every message content in this request, for a script that has to look further back. */
  readonly messages: readonly string[];
  /**
   * Whether this is the tool-free call a compaction makes to write the next part of the brief,
   * rather than a step of the turn.
   *
   * Recognised by the absent catalogue rather than by the wording of the request, because the
   * wording is the summariser's prompt and a fixture that matched it would be asserting on prose.
   * A script that ignores this and answers with a tool call gets a brief that says nothing, which
   * is a green run measuring the deterministic fallback.
   */
  readonly summarising: boolean;
  /**
   * Whether this is a delegated specialist's own request rather than a step of the turn.
   *
   * Recognised by the catalogue rather than by the mission text: a specialist is offered the
   * read-only set and never `finish`, because `finish` is how a turn ends and a specialist does not
   * end one. Nothing else in the loop withdraws it - the closing handoff is deliberately handed the
   * same array every other step sent - so "no `finish` on offer" is the one structural statement
   * that separates a specialist's window from the lead's.
   *
   * It matters beyond letting a script answer the right model. A specialist's window is its own:
   * its request shares nothing with the lead's but the catalogue, so counting it as the next link
   * in the chain would report a cache miss for a turn whose own window never moved.
   */
  readonly delegated: boolean;
}

/** A model, as a function of what athanor just said to it. */
export type ModelScript = (context: ScriptContext) => ModelTurn;

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

/** A value read off an untyped payload, as text. Anything that is not a string reads as absent. */
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * A request body as an object, whatever was actually sent.
 *
 * A file write carries the file's own bytes rather than a JSON envelope, so this has to survive a
 * body that is not JSON at all: parsing it unguarded turned every file_write into a failed tool
 * call.
 */
const bodyOf = (init?: RequestInit): Record<string, unknown> => {
  if (typeof init?.body !== 'string') return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/**
 * The text of one message in a request, however the adapter chose to wrap it.
 *
 * A message the context layer marked as a cache breakpoint is sent as a content array carrying a
 * `cache_control` block rather than as a bare string, so reading `content` as a string alone makes
 * exactly the messages athanor considers most important read as empty.
 */
const contentOf = (message: { content?: unknown }): string => {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((block) => asText((block as { text?: unknown } | null)?.text))
    .join('');
};

/** How many leading bytes two requests share, which is the most a prefix cache could read back. */
const commonPrefix = (left: string, right: string): number => {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
};

/**
 * One request as the provider reads it, which is not the order the JSON body happens to be in.
 *
 * A prefix cache is over tokens, and the tool definitions are tokenised ahead of the conversation
 * whatever position the request object puts them in - so comparing the raw bodies scores athanor
 * against the one part of the prompt that never changes, and reports about 23% for a turn whose
 * real repeated run is nearer 90%. The catalogue goes first here for the same reason it goes first
 * there: it is the head of what any provider could hand back.
 */
const promptBytes = (body: Record<string, unknown>): string =>
  `${JSON.stringify(body.tools ?? [])}${JSON.stringify(body.messages ?? [])}`;

const framesFor = (turn: ModelTurn): string[] => {
  const parts: string[] = [];
  const pieces = turn.chunks ?? (turn.text ? [turn.text] : []);
  // A cut stream stops mid-answer: every piece arrives as an ordinary delta and then nothing does.
  // No closing frame, because the closing frame is exactly what a cut call never sends - which is
  // why the usage it carries has to be worked out on the other side.
  if (turn.cut) {
    for (const piece of pieces) parts.push(sse({ choices: [{ delta: { content: piece } }] }));
    return parts;
  }
  // Everything but the last piece goes out with no finish reason, which is what a real stream looks
  // like and what the degenerate-repeat watch reads.
  for (const piece of pieces.slice(0, turn.calls?.length ? pieces.length : -1))
    parts.push(sse({ choices: [{ delta: { content: piece } }] }));
  const tail = turn.calls?.length ? undefined : pieces.at(-1);
  parts.push(
    sse({
      choices: [
        {
          finish_reason: turn.calls?.length ? 'tool_calls' : turn.truncated ? 'length' : 'stop',
          delta: {
            ...(tail === undefined ? {} : { content: tail }),
            ...(turn.calls?.length
              ? {
                  tool_calls: turn.calls.map((call, index) => ({
                    index,
                    id: call.id,
                    function: { name: call.name, arguments: JSON.stringify(call.args) }
                  }))
                }
              : {})
          }
        }
      ]
    })
  );
  parts.push('data: [DONE]\n\n');
  return parts;
};

/**
 * The same turn as one whole JSON body, for the requests that are not streamed.
 *
 * Only the reply the owner is watching is streamed; a request with nowhere to put deltas asks for
 * an ordinary completion, and the two calls this suite most needs to see are exactly those - the
 * tool-free call a compaction makes to write its brief, and every step of a delegated specialist.
 * Answered with SSE they arrive as `Unexpected token 'd', "data: {"ch"...`, which both paths then
 * swallow: a compaction falls back to its deterministic summary and reports success, and a mission
 * comes back as a failed tool call. Both look like a working run from the outside, which is how a
 * suite ends up unable to see the two mechanisms that decide what a long task costs.
 */
const completionBody = (turn: ModelTurn): unknown => {
  const text = (turn.chunks ?? (turn.text ? [turn.text] : [])).join('');
  return {
    choices: [
      {
        finish_reason: turn.calls?.length ? 'tool_calls' : turn.truncated ? 'length' : 'stop',
        message: {
          content: text,
          ...(turn.calls?.length
            ? {
                tool_calls: turn.calls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) }
                }))
              }
            : {})
        }
      }
    ],
    // Counted the same rough way the window is estimated, so a specialist's own compute budget is
    // spent against something proportional to what it actually wrote rather than against nought.
    usage: { prompt_tokens: 0, completion_tokens: Math.ceil(text.length / 4) }
  };
};

const encoder = new TextEncoder();

/**
 * The frames delivered one at a time, over a stream that dies when the request is torn down.
 *
 * A stub that hands back the whole body as a string cannot be interrupted, and two mechanisms in
 * the loop are interruptions: the watch that aborts a reply which has started repeating itself, and
 * the Stop the owner presses. Both raise their abort from inside a text-delta handler, so the frames
 * have to arrive with the event loop free between them or the handler never runs before the body is
 * finished. This is the same shape `heldBody` has in the worker's own tests, for the same reason.
 */
const streamOf = (
  frames: readonly string[],
  signal?: AbortSignal | null
): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const tearDown = (): void => {
        if (closed) return;
        closed = true;
        controller.error(new Error('the request was torn down'));
      };
      if (signal?.aborted) return tearDown();
      signal?.addEventListener('abort', tearDown, { once: true });
      void (async () => {
        for (const frame of frames) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (closed) return;
          controller.enqueue(encoder.encode(frame));
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (closed) return;
        closed = true;
        // A reader that has already been cancelled has closed this end for us, which is what a
        // generation cut on this side does to the socket it was reading. Closing it a second time
        // throws out of the queue nobody is awaiting and takes the process down with it.
        try {
          controller.close();
        } catch {
          // Already closed by the cancel, which is the only way this happens.
        }
      })();
    }
  });

/* ------------------------------------------------------------------------- the scripted runner */

export interface RunnerStub {
  /**
   * Exit codes handed to consecutive `/exec` calls; the last one repeats. This is what makes an
   * acceptance check fail on the unfinished job and pass on the finished one.
   */
  readonly exec?: readonly number[];
  /**
   * The bytes a media generation comes back with, base64, and what the provider says it cost.
   *
   * Absent means a generation still succeeds, with a small image and a plausible price: the media
   * fixtures are about what the loop does around a generation, not about the provider.
   */
  readonly media?: { readonly base64?: string; readonly costUsd?: number };
  /** What those commands printed, positionally, defaulting to a plausible line. */
  readonly stdout?: readonly string[];
  /** What the workspace holds, by path, for the reads. A path that is absent reads as missing. */
  readonly files?: Readonly<Record<string, string>>;
  /** The rows a `web_search` comes back with. */
  readonly search?: ReadonlyArray<{ readonly title: string; readonly url: string }>;
  /** The text each address returns to `parallel_web_read`, by address. */
  readonly pages?: Readonly<Record<string, string>>;
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** A one-pixel PNG, so a generation comes back with real bytes to write and price. */
const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * The provider's media routes, which live on the same host as inference and are not inference.
 *
 * Generation is an ordinary request to `/images` or `/audio/speech` on the configured provider, so
 * without this the media fixtures would have every logo counted as a model call and answered with a
 * chat frame. It is separated here for the same reason the document binary is separated from the
 * exec codes: a fixture's numbers have to mean what they say.
 */
const mediaResponse = (
  stub: RunnerStub,
  state: RunnerState,
  url: string,
  init?: RequestInit
): Response | null => {
  const image = url.endsWith('/images');
  if (!image && !url.endsWith('/audio/speech')) return null;
  state.media += 1;
  // The route the provider was actually asked for, read off the wire rather than off the tool call.
  // Everything before this line - the picker in Settings, the stored credential, the argument the
  // model passed - is a claim about what will be generated. This is the request that gets billed,
  // and it is the only place a seam between the owner's choice and the generation is visible.
  state.mediaModels.push(asText(bodyOf(init).model));
  const base64 = stub.media?.base64 ?? ONE_PIXEL_PNG;
  const costUsd = stub.media?.costUsd ?? 0.01;
  return image
    ? json({ data: [{ b64_json: base64 }], usage: { cost: costUsd } })
    : new Response(Buffer.from(base64, 'base64'), {
        headers: { 'content-type': 'audio/mpeg', 'x-cost-usd': String(costUsd) }
      });
};

/** What the document tools shell out to, whose stdout has to be JSON rather than a console line. */
const DOCUMENT_BINARY = '/usr/local/lib/athanor/athanor-document';

/** What the workspace has been made to do so far, which is the only state the stub carries. */
interface RunnerState {
  execs: number;
  /** What the turn has written, so a listing sees the work happen and a read gets it back. */
  written: Map<string, { bytes: number; text: string }>;
  /** Media generations the provider was actually asked for. */
  media: number;
  /** The model id each of those named on the wire, in order. */
  mediaModels: string[];
}

const runnerResponse = (
  stub: RunnerStub,
  state: RunnerState,
  url: string,
  init?: RequestInit
): Response => {
  const body = bodyOf(init);
  if (url.includes('/exec') || url.includes('/processes/start')) {
    // document_read and document_search are shell calls too, and they parse their own stdout as
    // JSON. They are answered off to one side so they do not consume the exit codes a fixture wrote
    // for its acceptance checks - the sequence that makes a check fail before the work and pass
    // after it is the whole mechanism, and a document read landing in the middle of it would
    // silently shift every code by one.
    if (asText(body.executable) === DOCUMENT_BINARY) {
      const args = Array.isArray(body.args) ? (body.args as unknown[]) : [];
      const path = asText(args[args.indexOf('--path') + 1]);
      return json({
        exitCode: 0,
        stdout: JSON.stringify(
          (Array.isArray(body.args) ? body.args[0] : '') === 'search'
            ? { matches: Object.keys(stub.files ?? {}).map((file) => ({ path: file, page: 1 })) }
            : { path, text: stub.files?.[path] ?? '', pages: 1 }
        ),
        stderr: '',
        durationMs: 5,
        timedOut: false
      });
    }
    const index = state.execs;
    state.execs += 1;
    const codes = stub.exec ?? [0];
    const exitCode = codes[Math.min(index, codes.length - 1)] ?? 0;
    return json({
      exitCode,
      stdout: stub.stdout?.[index] ?? (exitCode === 0 ? 'ok\n' : ''),
      stderr: exitCode === 0 ? '' : 'AssertionError: expected 3 rows, found 0',
      durationMs: 5,
      timedOut: false
    });
  }
  if (url.includes('/browser/search'))
    return json({
      engine: 'stub',
      query: new URL(url).searchParams.get('q') ?? '',
      results: (stub.search ?? []).map((row, index) => ({
        rank: index + 1,
        title: row.title,
        url: row.url,
        site: new URL(row.url).host,
        snippet: row.title
      }))
    });
  if (url.includes('/browser/read-many'))
    return json({
      pages: Object.entries(stub.pages ?? {}).map(([address, text]) => ({
        url: address,
        title: address,
        text,
        characters: text.length
      }))
    });
  if (url.includes('/files?')) {
    const path = decodeURIComponent(new URL(url).searchParams.get('path') ?? '');
    // The runner's own field names, not an approximation of them. An artifact acceptance check
    // reads `name`, `type` and `sizeBytes` off these rows, so a listing shaped any other way makes
    // every artifact check report the file missing - a green fixture measuring nothing.
    //
    // What the turn has written counts as being there, which is what makes an artifact check fail
    // on the unfinished job and pass on the finished one without a fixture having to say when the
    // file appears.
    const listed: Record<string, number> = {
      ...Object.fromEntries(
        Object.entries(stub.files ?? {}).map(([file, content]) => [file, content.length])
      ),
      ...Object.fromEntries([...state.written].map(([file, entry]) => [file, entry.bytes]))
    };
    return json({
      path,
      entries: Object.entries(listed)
        .filter(([file]) => file.startsWith(path))
        .map(([file, sizeBytes]) => ({
          name: file.split('/').filter(Boolean).pop() ?? file,
          path: file,
          type: 'file',
          sizeBytes,
          modifiedAt: '2026-07-01T00:00:00.000Z'
        }))
    });
  }
  if (url.includes('/file')) {
    // A write is acknowledged; a read of a path the fixture never put in the workspace is a miss,
    // which is how a fixture makes a read fail without inventing an error shape.
    if (init?.method === 'PUT') {
      const path = decodeURIComponent(new URL(url).searchParams.get('path') ?? '');
      const text = typeof init.body === 'string' ? init.body : '';
      const bytes =
        typeof init.body === 'string'
          ? init.body.length
          : init.body instanceof ArrayBuffer
            ? init.body.byteLength
            : ArrayBuffer.isView(init.body)
              ? init.body.byteLength
              : 1;
      if (path) state.written.set(path, { bytes, text });
      return json({ ok: true, storageBytes: 2_048 });
    }
    const path = decodeURIComponent(new URL(url).searchParams.get('path') ?? '');
    const known = state.written.has(path) || stub.files?.[path] !== undefined;
    // A picture comes back as bytes with a picture's content type, because that is the only thing
    // `image_read` accepts - and looking at what it just generated is the first thing the media tool
    // tells the model to do, so a media fixture that could not do it would measure the wrong loop.
    if (known && /\.(png|jpe?g|webp|gif)$/i.test(path))
      return new Response(Buffer.from(ONE_PIXEL_PNG, 'base64'), {
        headers: { 'content-type': 'image/png' }
      });
    // What the turn wrote reads back as what it wrote. Without this a fixture could not measure the
    // one thing worth measuring about a re-read - that the window already held the answer.
    const content = state.written.get(path)?.text ?? stub.files?.[path];
    return content === undefined
      ? new Response('', { status: 404 })
      : json({ path, content, bytes: content.length });
  }
  if (url.includes('/checkpoints'))
    return json({
      id: 'checkpoint',
      mechanism: 'content',
      createdAt: '2026-07-01T00:00:00.000Z',
      fileCount: 12,
      totalBytes: 4_096,
      storedBytes: 128,
      changedFileCount: 2,
      uncoveredFileCount: 0,
      durationMs: 21,
      pruned: []
    });
  return json({ ok: true, storageBytes: 2_048 });
};

/* --------------------------------------------------------------------------------- the fixture */

/** Which owner-shaped request this fixture stands for. Reported so a gap in coverage is visible. */
export type FixtureShape =
  | 'answer'
  | 'files'
  | 'verify'
  | 'research'
  | 'ambiguous'
  | 'refusal'
  | 'small'
  | 'media'
  /** A job long enough that what it costs is decided by how the window is held down, not by holds. */
  | 'long';

export interface Expectation {
  /** Exactly how many model calls the turn cost, including the closing handoff when one happens. */
  readonly modelCalls?: number;
  /**
   * How many of those calls were spent inside delegated specialists rather than by the turn.
   *
   * Asserted alongside `modelCalls` rather than instead of it, because the two move for different
   * reasons: the first is what the loop did, the second is what a mission cost once it was sent.
   */
  readonly delegatedCalls?: number;
  /**
   * Every tool athanor actually started, in order. `finish` and `set_acceptance` never appear: the
   * loop answers those itself, ahead of the line that records a tool as started.
   */
  readonly tools?: readonly string[];
  /** Every tool the model asked for, in order, including the ones the loop answered or refused. */
  readonly proposed?: readonly string[];
  /** The catalogue offered on the last request, for the turns where the loop narrows it. */
  readonly finalCatalogue?: readonly string[];
  /**
   * Whether the closing request offered the same catalogue as the step before it.
   *
   * The property, rather than the list. A turn that swaps its catalogue on the way out rewrites the
   * head of the prompt on its own largest request, and every provider that bills a cached prefix
   * bills that as a fresh write - so the restriction such a swap is meant to buy has to be worth
   * the whole window, and a restriction the loop already enforces by refusing the call is not.
   * Naming the tools instead would make this fail every time a tool is added, which is how an
   * assertion about caching turns into an assertion about the catalogue's length.
   */
  readonly finalCatalogueUnchanged?: boolean;
  /** Tools that must appear somewhere in the run. */
  readonly toolsInclude?: readonly string[];
  /** Tools that must never run - the check that a floor or a gate actually stopped something. */
  readonly toolsExclude?: readonly string[];
  /** Where the task ended up: completed, awaiting_user for an approval, failed. */
  readonly status?: string;
  /** The verification status the completion carries. */
  readonly verification?: 'verified' | 'not_applicable';
  /** Whether the owner was asked to approve something, and what for. */
  readonly askedOwner?: boolean;
  /**
   * How many commands the workspace actually ran, which separates the two orders of declaring an
   * acceptance record: declared first, the harness runs the checks twice - once to watch them fail
   * on the unfinished job and once at the finish. Declared after the work, the baseline is skipped
   * and the finish is the only run there ever was.
   */
  readonly commandsRun?: number;
  /** How many times the provider was asked to generate something, and therefore charged for it. */
  readonly mediaGenerated?: number;
  /**
   * The model id every generation named on the wire, in order.
   *
   * The unit tests around media hand a chosen route in by hand and assert on the value they handed
   * in, which is green whether or not anything carries it to the provider. This is the request the
   * provider answers, so it is the one thing that cannot be green over a wire that does not exist.
   */
  readonly mediaModels?: readonly string[];
  /**
   * The least share of a request that may be a byte-for-byte repeat of the one before it.
   *
   * The floor, not the value: the exact share moves by a point when anything in the window changes
   * size, and a fixture that pinned it would fail on every unrelated edit. What is worth asserting
   * is that a turn which only appends to its window did not rewrite the front of it.
   */
  readonly minCachePrefix?: number;
  /** The fewest compactions this turn must have performed. */
  readonly minCompactions?: number;
  /**
   * Exactly how many compactions this turn performed, for the arm of a pair that must perform none.
   *
   * A floor cannot say "none". The control half of a paired measurement has to, or an arm that
   * quietly condensed on the budget trigger would be doing the same work as the other one and the
   * difference between the two rows would be reported as free.
   */
  readonly compactions?: number;
  /** The fewest sections the running brief must have ended up carrying. */
  readonly minBriefSections?: number;
  /**
   * The fewest of this turn's compactions whose brief a model wrote rather than the fallback.
   *
   * Asserted wherever a compaction is being priced. Without it a summariser that stops being
   * answered - a stub that only speaks one wire format, a request shape that changes - degrades to
   * the deterministic summary and every row here stays green while measuring something else.
   */
  readonly minModelWrittenBriefs?: number;
  /**
   * Exactly which of the procedures this turn opened the brief names as no longer in the window.
   *
   * The whole list, not a floor: naming one that is still open would be athanor telling the model
   * to re-read something it is already holding, which costs a step and a window for nothing.
   */
  readonly skillsNamedInBrief?: readonly string[];
  /** Whether the owner's own words were still in the last window, byte for byte. */
  readonly ownerMessageIntact?: boolean;
  /**
   * The shortest a squeezed tool result may be left in the last window.
   *
   * Nothing squeezed at all satisfies this: the assertion is that no result was cut all the way to
   * the hard floor, which is what a turn looks like when the cheap mechanism has been made to do
   * the work the expensive one exists for.
   */
  readonly minToolResultFloor?: number;
  /** Every hold the harness fired, in the order it fired them. */
  readonly holds?: readonly HoldName[];
  /** Whether the boilerplate fallback plan was written for a task that never asked for one. */
  readonly fallbackPlan?: boolean;
  /** Whether untrusted content was recorded as having entered the turn. */
  readonly untrusted?: boolean;
  /** How many separate replies the owner sees. One answer should arrive as one bubble. */
  readonly replies?: number;
}

export interface Fixture {
  readonly id: string;
  readonly shape: FixtureShape;
  /** The owner's words, as they would arrive. */
  readonly request: string;
  /** What this fixture protects, in prose: what breaks, or costs more, if it changes. */
  readonly why: string;
  readonly model: ModelScript;
  readonly runner?: RunnerStub;
  /** The step ceiling in force, when the fixture is about what happens at one. */
  readonly maxSteps?: number;
  /**
   * The window of the model this fixture runs on, when the size of the window is the subject.
   *
   * Both shipped defaults declare a million tokens, and every mechanism that decides when to
   * condense is a function of that number, so a fixture about the window has to be able to state
   * it. Everything else runs on the ordinary release below.
   */
  readonly contextTokens?: number;
  /** The compute ceiling in force, raised only by the fixtures long enough to reach the default. */
  readonly maxCredits?: number;
  readonly expect: Expectation;
}

/* ------------------------------------------------------------------------------ what is watched */

/**
 * The holds this suite can see, and the string each is recognised by.
 *
 * These are markers in messages the loop pushes back to the model rather than an enum the loop
 * exports, which is the one place this harness is coupled to wording. It is deliberate and it is
 * narrow: a fixture never asserts on the sentence, only on which hold fired and how many model
 * calls it cost. If a marker below stops matching, every fixture that expects that hold fails at
 * once - which is the loud failure, not the silent one.
 */
const HOLD_MARKERS: ReadonlyArray<readonly [HoldName, string]> = [
  ['finish_rejected', 'Finish rejected (attempt'],
  ['plan_hold', 'Finish held: '],
  ['acceptance_hold', 'Finish held: this turn changed'],
  ['silence_hold', 'Finish held: this turn has not said'],
  ['acceptance_failed', 'Finish refused (acceptance '],
  ['completion_nag', 'COMPLETION CHECK ('],
  ['baseline_refused', 'every one of them already passes'],
  ['repetition_stopped', 'began repeating'],
  ['output_limit_continued', 'CONTINUE THE ANSWER ('],
  ['step_budget', 'STEP BUDGET EXHAUSTED'],
  ['idle_break', 'NOTHING HAS RUN FOR']
];

export type HoldName =
  | 'finish_rejected'
  | 'plan_hold'
  | 'acceptance_hold'
  | 'silence_hold'
  | 'acceptance_failed'
  | 'completion_nag'
  | 'baseline_refused'
  | 'repetition_stopped'
  | 'output_limit_continued'
  | 'step_budget'
  | 'idle_break';

// The acceptance hold and the plan hold share an opening, so the longer marker is tried first.
const ORDERED_MARKERS = [...HOLD_MARKERS].sort((left, right) => right[1].length - left[1].length);

const holdsIn = (messages: readonly string[]): { holds: HoldName[]; pushback: string[] } => {
  const holds: HoldName[] = [];
  const pushback: string[] = [];
  for (const message of messages) {
    const match = ORDERED_MARKERS.find(([, marker]) => message.includes(marker));
    if (!match) continue;
    holds.push(match[0]);
    pushback.push(message);
  }
  return { holds, pushback };
};

export interface RunOutcome {
  /** Provider calls, which is what a step costs and what the owner is billed for. */
  readonly modelCalls: number;
  /**
   * How many of those calls a delegated specialist spent, rather than the turn itself.
   *
   * `modelCalls` alone cannot be read a year from now: a delegate call is one step of the turn and
   * then as many provider calls as the missions behind it take, so the same total is reached by a
   * turn that thought for nine steps and by a turn that thought for three and sent two specialists.
   * Split out so a diff can say which of the two moved.
   */
  readonly delegatedCalls: number;
  /** The prompt athanor built, in tokens, by its own estimate, summed over every call. */
  readonly promptTokens: number;
  /** The largest single prompt, which is what decides whether a long task fits its window. */
  readonly peakPromptTokens: number;
  readonly tools: readonly string[];
  readonly proposed: readonly string[];
  readonly finalCatalogue: readonly string[];
  /**
   * Whether the closing request's catalogue was byte-identical to the one before it. True for a
   * turn of a single step, which never swapped anything.
   */
  readonly finalCatalogueUnchanged: boolean;
  readonly commandsRun: number;
  /** Generations the provider was actually billed for, which is the only real money a turn spends. */
  readonly mediaGenerated: number;
  /** The model id each of those generations named on the wire, in order. */
  readonly mediaModels: readonly string[];
  /**
   * The mean share of a request that repeated the previous request byte for byte, 0 to 100.
   *
   * Every provider that bills a cached prefix bills it as a prefix: the read stops at the first
   * byte that differs from what it cached. So the common leading run between one request and the
   * next is the ceiling on what any of them could have read back, and the mean of that over a turn
   * is what a long task's bill actually turns on. A turn of one call has no previous request and
   * reads as zero.
   *
   * It is a mean of per-request shares rather than a share of the whole turn's bytes, so a turn is
   * not scored mostly by its largest step.
   *
   * What it cannot see, so that nobody sets a floor against it in the belief that it can: the tool
   * catalogue is the head of every comparison and it does not move, so on a short turn it is most
   * of the bytes and the share has a floor no message-side defect can push it under. Measured by
   * making the first message of the window differ on every step - every message byte destroyed - on
   * `files-helper-script-then-run`: 97% became 91%, not 0%. A floor worth setting on a five-step
   * fixture is in the mid-nineties; a defect costing less than a point or two is only visible on a
   * turn long enough for the conversation to outweigh the catalogue.
   */
  readonly cachePrefix: number;
  /** Compactions the loop performed, each of which is a model call and a rewritten prefix. */
  readonly compactions: number;
  /** Sections the running brief ended up carrying, which is how much history survived condensing. */
  readonly briefSections: number;
  /**
   * Of those compactions, the ones whose brief a model actually wrote.
   *
   * `compactContext` swallows a summariser that fails and falls back to a deterministic summary, so
   * a compaction reports success either way and every other number here moves by a few per cent.
   * That is how this suite spent its whole life measuring the fallback: the stub answered the
   * tool-free summarising call with SSE, the parse failed, and nothing anywhere said so. This is
   * the one figure that separates the two, and it is why `completionBody` cannot be narrowed back
   * without a fixture going red.
   */
  readonly modelWrittenBriefs: number;
  /**
   * Of the skills this turn opened, the ones a compaction's brief names, sorted.
   *
   * An opened procedure arrives as an ordinary tool result, so a compaction condenses it away like
   * any other - and the model then goes on working to instructions it can no longer read, with
   * nothing in the transcript saying so. The brief is the only place that can say it, so the claim
   * is that the name of every procedure a compaction took survives in the record the model keeps
   * reading. A skill still in the window is not named and must not be: this is a notice about
   * something lost, not a list of what was loaded.
   */
  readonly skillsNamedInBrief: readonly string[];
  /** Whether the owner's own words were still in the last window, byte for byte. */
  readonly ownerMessageIntact: boolean;
  /**
   * The shortest squeezed tool result left in the last window, or 0 when none was squeezed. Read
   * against the hard floor: a window full of results cut to it is one the cheap mechanism has been
   * left to hold down on its own.
   */
  readonly toolResultFloor: number;
  readonly holds: readonly HoldName[];
  /** What the loop actually said back, in full, for the runs that need explaining. */
  readonly pushback: readonly string[];
  readonly status: string;
  readonly verification: string;
  readonly askedOwner: boolean;
  readonly fallbackPlan: boolean;
  readonly untrusted: boolean;
  readonly replies: number;
  /** Anything that escaped the loop, which is a fixture that ran off its own script. */
  readonly error: string | null;
}

/* -------------------------------------------------------------------------------- the run itself */

const workspace: WorkspaceRecord = {
  id: workspaceId,
  userId,
  name: 'Study',
  status: 'running',
  storageBytes: 1_000,
  storageLimitBytes: 1_000_000,
  imageRevision: 'r1',
  region: 'self-hosted',
  keyProtection: 'hosted',
  securityMode: 'balanced',
  runnerRef: null,
  computeMeteredAt: null,
  wrappedKey: wrapDataKey(dataKey, masterKey, workspaceId),
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z'
};

const release: ModelRelease = {
  id: 'model-1',
  providerModelId: 'vendor/model-1',
  displayName: 'Model One',
  provider: 'custom',
  revision: 'r1',
  availability: 'available',
  openness: 'permissive_open_weight',
  license: 'apache-2.0',
  commercialUse: true,
  privacyRoute: 'provider_zdr',
  contextTokens: 128_000,
  modalities: ['text'],
  capabilities: ['chat', 'tools', 'reasoning'],
  usageClass: 'light',
  recommendationTags: [],
  measuredQuality: 0.8,
  measuredLatencyMs: 100,
  updatedAt: '2026-07-01T00:00:00.000Z'
};

const modelFor = (contextTokens?: number): ModelRelease =>
  contextTokens === undefined ? release : { ...release, contextTokens };

const taskFor = (prompt: string, maxComputeCredits: number): TaskRecord => ({
  id: taskId,
  userId,
  workspaceId,
  parentTaskId: null,
  branchedFromEventId: null,
  forkKind: null,
  scheduleId: null,
  rewindScope: null,
  restoredCheckpointId: null,
  titleCiphertext: null,
  legacyTitle: null,
  titleSource: 'prompt',
  pinned: false,
  archivedAt: null,
  status: 'running',
  modelId: release.id,
  privacyRoute: 'provider_zdr',
  securityMode: 'balanced',
  maxComputeCredits,
  actualComputeCredits: 0,
  maxSpendUsd: null,
  spentUsd: 0,
  queuedMessageCount: 0,
  promptCiphertext: encryptJson({ prompt }, dataKey, `task-prompt:${taskId}`),
  agentStateCiphertext: null,
  leaseOwner: 'worker-test',
  leaseExpiresAt: '2026-07-01T00:02:00.000Z',
  attempt: 1,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z'
});

export const runFixture = async (fixture: Fixture): Promise<RunOutcome> => {
  const model = modelFor(fixture.contextTokens);
  const task = taskFor(fixture.request, fixture.maxCredits ?? 50);
  const events: Array<{ kind: string; summary: string; payload: unknown }> = [];
  const approvals: string[] = [];
  let finalStatus = 'running';
  let plan: Record<string, unknown> | null = null;
  let fallbackPlan = false;

  const store = {
    getWorkspaceById: async () => workspace,
    listConnectors: async () => [],
    listModels: async () => [model],
    getManagedProviderCredential: async () => null,
    listWorkspaceMemories: async () => [],
    curateWorkspaceSkills: async () => undefined,
    listWorkspaceSkills: async () => [],
    getLatestTaskPlan: async () => plan,
    createTaskPlan: async (input: Record<string, unknown>) => {
      // The boilerplate fallback is recognised structurally rather than by what it says: it is the
      // plan that appears when the model never asked for one. The loop writes it at the start of any
      // step past the second, or of any step after the turn has changed something, and from then on
      // it travels in every prompt - so "did this task acquire a plan nobody wrote?" is a question
      // about the model's calls, not about the plan's contents.
      if (!proposed.includes('set_plan')) fallbackPlan = true;
      const version = Number(plan?.version ?? 0);
      if (Number(input.expectedVersion) !== version) throw new Error('plan_version_conflict');
      plan = {
        id: 'plan',
        taskId,
        version: version + 1,
        parentVersion: version || null,
        branchName: asText(input.branchName) || 'Main',
        stepsCiphertext: input.stepsCiphertext,
        createdBy: input.createdBy ?? 'agent',
        createdAt: '2026-07-01T00:00:00.000Z'
      };
      return plan;
    },
    listTaskEventPage: async () => ({
      events: [],
      hasMore: false,
      oldestSequence: null,
      nextCursor: 0
    }),
    getTask: async () => task,
    taskClaim: async () => ({ status: task.status, leaseOwner: task.leaseOwner ?? null }),
    updateTask: async (input: Record<string, unknown>) => {
      if (typeof input.status === 'string') finalStatus = input.status;
      return task;
    },
    renewTaskLease: async () => true,
    appendTaskEvent: async (input: {
      kind: string;
      payloadCiphertext: Parameters<typeof decryptJson>[0];
    }) => {
      const body = decryptJson<{ summary: string; payload: unknown }>(
        input.payloadCiphertext,
        dataKey
      );
      events.push({ kind: input.kind, summary: body.summary, payload: body.payload });
      return { id: 'event', sequence: events.length };
    },
    createAgentNotification: async (input: Record<string, unknown>) => ({
      id: 'notification',
      ...input
    }),
    createApproval: async (input: { action?: unknown }) => {
      approvals.push(asText(input.action));
      return `approval-${approvals.length}`;
    },
    recordUsage: async () => undefined,
    // A delivered file, so a job that makes something can be measured all the way to the owner
    // rather than stopping at the workspace.
    createArtifact: async (input: Record<string, unknown>) => ({
      id: `artifact-${asText(input.storageKey)}`,
      version: 1
    }),
    mediaSpendForTask: async () => 0,
    spendGuard: async () => ({
      outcome: 'allow' as const,
      estimateUsd: 0,
      blockedBy: null,
      warnedBy: [],
      reason: null,
      windows: []
    }),
    effectiveSpendLimits: async () => ({ timeZone: 'Europe/London' }),
    setWorkspaceStorage: async () => undefined,
    transitionUsage: async () => undefined,
    getNextQueuedTaskMessage: async () => null,
    createMemoryItem: async () => ({ id: 'item' }),
    createMemorySource: async () => ({ id: 'source' }),
    attachMemoryEvidence: async () => undefined,
    observeMemoryFactCandidate: async () => undefined,
    promoteMemoryFactCandidates: async () => [],
    getMemoryPack: async () => null,
    recordMemoryUse: async () => 0,
    recordWorkspaceCheckpoint: async (input: Record<string, unknown>) => input,
    deleteWorkspaceCheckpoints: async () => 0,
    completeTaskIfNoQueued: async () => {
      finalStatus = 'completed';
      return true;
    },
    consolidateMemory: async () => undefined
  } as unknown as DataStore;

  let modelCalls = 0;
  // Only the last request is kept, and the previous one only as the bytes the next is compared
  // against. A forty-step fixture sends forty windows of up to a megabyte each, and holding them
  // all measures this process's heap rather than the loop.
  let steps = 0;
  // The last request that was a step of the turn, which is not simply the last request: a
  // compaction and a specialist both send one afterwards, and neither is the window the turn ended
  // in nor the catalogue it was offered.
  let lastAgentRequest: Record<string, unknown> = {};
  let previousBytes = '';
  // The catalogue of the last two steps, as sent. Only the two, for the same reason the bytes above
  // are only the previous request's: what a swap costs is paid on the step it happens.
  let lastCatalogue = '';
  let previousCatalogue = '';
  const prefixShares: number[] = [];
  const everyMessage = new Set<string>();
  const proposed: string[] = [];
  /** Of the calls above, the ones a delegated specialist spent rather than the turn itself. */
  let delegatedCalls = 0;
  const openedSkills = new Set<string>();
  const execState: RunnerState = { execs: 0, written: new Map(), media: 0, mediaModels: [] };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.startsWith(PROVIDER_URL)) {
      const media = mediaResponse(fixture.runner ?? {}, execState, url, init);
      if (media) return media;
      const body = bodyOf(init);
      modelCalls += 1;
      // The summarising call a compaction makes carries no catalogue, and it is a fresh prompt with
      // no predecessor rather than the next step of one - so it is neither the window the turn was
      // working in nor a link in the chain a cache reads back along. What it costs is already in the
      // step count and the token total, which is where a one-off call belongs.
      const catalogue = (body.tools ?? []) as Array<{ function?: { name?: unknown } }>;
      const summarising = !catalogue.length;
      // A specialist's request carries a catalogue and no `finish`; see ScriptContext.delegated.
      const delegated =
        !summarising && !catalogue.some((tool) => asText(tool.function?.name) === 'finish');
      if (delegated) delegatedCalls += 1;
      if (!summarising && !delegated) {
        steps += 1;
        lastAgentRequest = body;
        const bytes = promptBytes(body);
        if (previousBytes) prefixShares.push(commonPrefix(previousBytes, bytes) / bytes.length);
        previousBytes = bytes;
        previousCatalogue = lastCatalogue;
        lastCatalogue = JSON.stringify(body.tools ?? []);
      }
      const messages = ((body.messages ?? []) as Array<{ content?: unknown }>).map(contentOf);
      // Collected as the requests arrive, deduplicated in order: a hold pushes one message that
      // then travels in every later request, so a raw scan would count the same hold once per
      // remaining step.
      for (const content of messages) everyMessage.add(content);
      const turn = fixture.model({
        index: modelCalls - 1,
        step: Math.max(0, steps - 1),
        lastMessage:
          [...messages].reverse().find((content) => !content.startsWith(RUNTIME_CONTEXT_MARKER)) ??
          '',
        messages,
        summarising,
        delegated
      });
      // A specialist's calls are the specialist's, not the turn's. `tools`, `proposed` and
      // `finalCatalogue` are all statements about what this turn did, and folding a subordinate
      // model's proposals into them would make the lead's list depend on how many missions were
      // running and in what order three concurrent ones happened to answer. What a specialist
      // actually reached is measured where it lands instead: in `commandsRun`, in the media count,
      // and in whether the turn came out marked as having read untrusted content.
      if (!delegated) {
        for (const call of turn.calls ?? []) {
          proposed.push(call.name);
          // Which procedures this turn opened, so a compaction that drops one can be asked whether
          // it said so. Read off the call rather than off the result, because the claim is about
          // an instruction the model was given and is no longer holding.
          if (call.name === 'skill' && asText(call.args.action) === 'view') {
            const id = asText(call.args.id) || asText(call.args.name);
            if (id) openedSkills.add(id);
          }
        }
      }
      // What the request asked for, rather than what this stub finds convenient: the adapter sets
      // `stream` only when the caller gave it somewhere to put the deltas, and answering the other
      // shape with frames is a parse error the caller is written to survive quietly.
      return body.stream === true
        ? new Response(streamOf(framesFor(turn), init?.signal), {
            headers: { 'content-type': 'text/event-stream' }
          })
        : json(completionBody(turn));
    }
    return runnerResponse(fixture.runner ?? {}, execState, url, init);
  }) as typeof fetch;

  let error: string | null = null;
  try {
    await new AgentWorker(
      store,
      {
        WORKER_ID: 'worker-eval',
        DATABASE_DRIVER: 'pglite',
        DATABASE_URL: 'postgres://localhost/athanor',
        PGLITE_PATH: ':memory:',
        DATA_MASTER_KEY: masterKey.toString('base64'),
        RUNNER_SHARED_SECRET: 'x'.repeat(48),
        WORKSPACE_RUNNER_URL: RUNNER_URL,
        PREVIEW_BASE_URL: 'http://preview.localhost:4400',
        OPENROUTER_BASE_URL: PROVIDER_URL,
        AI_PROVIDER: 'openai-compatible',
        AI_BASE_URL: PROVIDER_URL,
        AI_API_KEY: 'provider-key',
        AI_REQUIRE_ZDR: false,
        // Pinned so a search is answered by the workspace's own browser on every fixture. Which
        // host answers a search is a policy decision with its own tests; what these fixtures are
        // about is what the loop does with the rows, and leaving it to policy would make the
        // research fixtures cost a different number of provider calls when that policy moves.
        AI_FORCE_INHOUSE_WEB: true,
        ALLOW_INSECURE_PROVIDER_URLS: true,
        PUBLIC_APP_URL: 'http://localhost:5173',
        CONNECTOR_ALLOWED_HOST_SUFFIXES: '',
        WORKER_CONCURRENCY: 2,
        WORKER_POLL_MS: 1_000,
        TASK_MAX_STEPS: fixture.maxSteps ?? 12,
        // A turn that renews its own budget is a separate mechanism with its own bounds. Left off
        // so every step count below is the cost of one budget rather than of two.
        TASK_MAX_SELF_CONTINUATIONS: 0
      },
      masterKey,
      runnerSecret
    ).run(task);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    globalThis.fetch = original;
  }

  const costs = events
    .filter((entry) => entry.kind === 'cost')
    .map(
      (entry) =>
        Number(
          (entry.payload as { context?: { estimatedInputTokens?: unknown } } | undefined)?.context
            ?.estimatedInputTokens
        ) || 0
    );
  const completion = [...events].reverse().find((entry) => entry.kind === 'completed');
  // Only a compaction writes a brief, so the field it carries is what tells its status event from
  // every other one. Read structurally rather than off the sentence, which the interface owns.
  const compactions = events
    .map(
      (entry) =>
        (
          (entry.payload ?? {}) as {
            compaction?: { briefParts?: unknown; brief?: unknown; source?: unknown };
          }
        ).compaction ?? {}
    )
    .filter((compaction) => typeof compaction.briefParts === 'number');
  // The sections a compaction wrote, which is where a notice about something the window lost has to
  // land: the brief is the one part of a condensed turn the model keeps reading.
  const brief = compactions.map((compaction) => asText(compaction.brief)).join('\n');
  const modelWrittenBriefs = compactions.filter(
    (compaction) => asText(compaction.source) === 'model'
  ).length;
  const lastWindow = (
    (lastAgentRequest.messages ?? []) as Array<{ role?: unknown; content?: unknown }>
  ).map((message) => ({ role: asText(message.role), content: contentOf(message) }));
  // Squeezed, not merely short: a result the window never had to cut says nothing about the floor,
  // and counting it would make every fixture that reads a small file look like an overrun window.
  const squeezed = lastWindow
    .filter(
      (message) =>
        message.role === 'tool' && message.content.includes('omitted from earlier tool output')
    )
    .map((message) => message.content.length);

  return {
    modelCalls,
    delegatedCalls,
    promptTokens: costs.reduce((total, value) => total + value, 0),
    peakPromptTokens: costs.reduce((peak, value) => Math.max(peak, value), 0),
    tools: events
      .filter((entry) => entry.kind === 'tool_started')
      .map((entry) => asText((entry.payload as { tool?: unknown }).tool)),
    proposed,
    commandsRun: execState.execs,
    mediaGenerated: execState.media,
    mediaModels: execState.mediaModels,
    // Rounded to a whole point, which is all this number can honestly carry: the runtime block at
    // the end of the window rebuilds its clock on every step, so the last few bytes of a request
    // differ from the last one's whatever else the loop did.
    cachePrefix: prefixShares.length
      ? Math.round(
          (prefixShares.reduce((total, share) => total + share, 0) / prefixShares.length) * 100
        )
      : 0,
    compactions: compactions.length,
    briefSections: compactions.reduce(
      (most, payload) => Math.max(most, Number(payload.briefParts) || 0),
      0
    ),
    modelWrittenBriefs,
    skillsNamedInBrief: [...openedSkills].filter((name) => brief.includes(name)).sort(),
    ownerMessageIntact: lastWindow.some((message) => message.content.includes(fixture.request)),
    toolResultFloor: squeezed.length ? Math.min(...squeezed) : 0,
    finalCatalogue: (
      (lastAgentRequest.tools ?? []) as Array<{ function?: { name?: unknown } }>
    ).map((tool) => asText(tool.function?.name)),
    finalCatalogueUnchanged: previousCatalogue === '' || previousCatalogue === lastCatalogue,
    ...holdsIn([...everyMessage]),
    status: finalStatus,
    verification:
      asText(
        (completion?.payload as { verification?: { status?: unknown } } | undefined)?.verification
          ?.status
      ) || 'none',
    askedOwner: approvals.length > 0,
    fallbackPlan,
    untrusted: events.some(
      (entry) => entry.kind === 'warning' && entry.summary.startsWith('Untrusted content entered')
    ),
    replies: events.filter((entry) => entry.kind === 'assistant_message').length,
    error
  };
};

export const evidence = (id: string, claim: string): Record<string, unknown> => ({
  status: 'verified',
  evidence: [{ claim, source: 'tool_result', toolCallId: id }],
  remainingRisks: []
});

export const conversational = (): Record<string, unknown> => ({
  status: 'not_applicable',
  evidence: [],
  remainingRisks: []
});
