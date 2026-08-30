/**
 * What each client method actually asks the box for.
 *
 * Nothing here is about the server: every route these call exists and is tested where it lives.
 * What is asserted here is the seam between the two, which is where this program's worst defect
 * class lives — a control that compiles, answers 200 and asked for the wrong thing. A method that
 * drops a filter builds a list of everything and calls it "expired"; one that drops `expectSha256`
 * overwrites the agent's work and reports success. Both are invisible from either side alone.
 *
 * `fetch` is stubbed rather than a server started, because the question is what leaves this file:
 * the URL, the body, and what comes back out of a failure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiFailure } from './api.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

const calls: Call[] = [];

/** Answers every request with `body`, and records what was asked for. */
const answer = (body: unknown, init: ResponseInit = {}): void => {
  vi.stubGlobal('fetch', (input: string | URL, requestInit?: RequestInit) => {
    calls.push({ url: String(input), init: requestInit });
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        ...init,
        headers: { 'content-type': 'application/json', ...init.headers }
      })
    );
  });
};

/** The one call that was made, which is what every test here expects to have happened. */
const only = (): Call => {
  expect(calls).toHaveLength(1);
  return calls[0] as Call;
};

/** Every mutation in this client sends a JSON string, so anything else is the assertion failing. */
const sentBody = (): unknown => {
  const body = only().init?.body;
  expect(typeof body).toBe('string');
  return JSON.parse(body as string);
};

afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
});

describe('the queries each method builds', () => {
  it('asks for pending approvals by asking for nothing, and names any other status', async () => {
    answer([]);
    await api.approvals();
    // Pending is the route's own default. Naming it would still be right and would also make
    // every existing caller's request different from the one it has always sent.
    expect(only().url).toBe('/v1/approvals');

    calls.length = 0;
    await api.approvals('expired');
    expect(only().url).toBe('/v1/approvals?status=expired');
  });

  it('carries a page size and a position through to the approvals route', async () => {
    answer([]);
    await api.approvals('approved', 50, 'MjAyNi0wOC0yNg==');
    expect(only().url).toBe('/v1/approvals?status=approved&limit=50&cursor=MjAyNi0wOC0yNg%3D%3D');
  });

  it('asks for archived conversations only when asked to, and never says active', async () => {
    answer({ tasks: [], nextCursor: null, hasMore: false });
    await api.tasks('cursor-1');
    expect(only().url).toBe('/v1/tasks?cursor=cursor-1');

    calls.length = 0;
    await api.tasks('cursor-1', 'archived');
    expect(only().url).toBe('/v1/tasks?cursor=cursor-1&include=archived');

    // The route defaults to active, so saying it costs a parameter and changes nothing.
    calls.length = 0;
    await api.tasks('cursor-1', 'active');
    expect(only().url).toBe('/v1/tasks?cursor=cursor-1');
  });

  it('names the kind of work a ranking is for, which this client never used to', async () => {
    answer([]);
    await api.recommendModels('provider_zdr', 'best');
    expect(only().url).toBe('/v1/models/recommend?privacyRoute=provider_zdr&preference=best');

    calls.length = 0;
    await api.recommendModels('external', 'balanced', 'vision');
    expect(only().url).toBe(
      '/v1/models/recommend?privacyRoute=external&preference=balanced&taskKind=vision'
    );
  });

  it('sends the digest it read a file at, so a collided write is refused rather than silent', async () => {
    answer({ path: 'workspace/notes.md' });
    await api.writeFile('ws-1', 'workspace/notes.md', new Uint8Array([1, 2, 3]), 'a1b2c3');
    expect(only().url).toBe(
      '/v1/workspaces/ws-1/file?path=workspace%2Fnotes.md&expectSha256=a1b2c3'
    );

    // Omitted, and the write is the unconditional one it has always been.
    calls.length = 0;
    await api.writeFile('ws-1', 'workspace/notes.md', new Uint8Array([1, 2, 3]));
    expect(only().url).toBe('/v1/workspaces/ws-1/file?path=workspace%2Fnotes.md');
  });

  it('bounds the review queue only when a caller asks it to', async () => {
    answer({ procedures: [], disputed: [], proposals: [] });
    await api.memoryReview('ws-1');
    expect(only().url).toBe('/v1/workspaces/ws-1/memory-review');

    calls.length = 0;
    await api.memoryReview('ws-1', { staleDays: 90, limit: 20 });
    expect(only().url).toBe('/v1/workspaces/ws-1/memory-review?staleDays=90&limit=20');
  });
});

describe('the bodies each method sends', () => {
  it('patches one memory line rather than replacing the list', async () => {
    answer({ id: 'mem-1' });
    await api.updateMemory('ws-1', 'mem-1', { content: 'Bins go out Thursday', validUntil: null });
    expect(only().url).toBe('/v1/workspaces/ws-1/memories/mem-1');
    expect(only().init?.method).toBe('PATCH');
    // An explicit null is the difference between "no expiry" and "leave the expiry alone", so it
    // has to survive JSON rather than being dropped as an absent key.
    expect(sentBody()).toEqual({ content: 'Bins go out Thursday', validUntil: null });
  });

  it('turns a skill off through the state route, carrying the field the toggle means', async () => {
    answer({ id: 'skill-1', enabled: false });
    await api.setSkillState('ws-1', 'skill-1', { enabled: false });
    expect(only().url).toBe('/v1/workspaces/ws-1/skills/skill-1');
    expect(only().init?.method).toBe('PATCH');
    expect(sentBody()).toEqual({ enabled: false });
  });

  it('verifies and retracts a remembered procedure at two different doors', async () => {
    answer({ verified: true });
    await api.verifyMemoryItem('ws-1', 'item-1');
    expect(only().url).toBe('/v1/workspaces/ws-1/memory-items/item-1/verify');
    expect(only().init?.method).toBe('POST');

    calls.length = 0;
    answer({ retracted: true });
    await api.retractMemoryItem('ws-1', 'item-1');
    // Not the DELETE next door: retracting keeps the row and the record that it stopped being
    // true, which is the whole reason the review queue is not a delete button.
    expect(only().url).toBe('/v1/workspaces/ws-1/memory-items/item-1/retract');
    expect(only().init?.method).toBe('POST');
  });

  it('lists the device links this account has minted', async () => {
    answer([]);
    await api.enrollments();
    expect(only().url).toBe('/v1/devices/enrollments');
    expect(only().init?.method).toBeUndefined();
  });

  it('edits a schedule in place, and can clear its ceiling with an explicit null', async () => {
    answer({ id: 'sched-1' });
    await api.updateSchedule('sched-1', {
      spec: { kind: 'daily', timeZone: 'Europe/London', localTime: '07:30' },
      maxSpendUsd: null
    });
    expect(only().url).toBe('/v1/schedules/sched-1');
    expect(only().init?.method).toBe('PATCH');
    expect(sentBody()).toEqual({
      spec: { kind: 'daily', timeZone: 'Europe/London', localTime: '07:30' },
      maxSpendUsd: null
    });
  });

  it('carries a model, a route and a ceiling onto a retried turn', async () => {
    answer({ id: 'task-2' });
    await api.createTaskTrajectory('task-1', {
      operation: 'retry',
      eventId: 'event-9',
      maxComputeCredits: 5,
      stopSource: true,
      rewind: 'conversation',
      modelId: 'openai/gpt-5',
      privacyRoute: 'external',
      maxSpendUsd: 2.5
    });
    expect(only().url).toBe('/v1/tasks/task-1/trajectory');
    expect(sentBody()).toMatchObject({
      modelId: 'openai/gpt-5',
      privacyRoute: 'external',
      maxSpendUsd: 2.5
    });
  });

  it('caps what one conversation may spend, at the start and on the next message', async () => {
    answer({ id: 'task-1' });
    await api.createTask({
      workspaceId: 'ws-1',
      prompt: 'Summarise the week',
      maxComputeCredits: 5,
      maxSpendUsd: 1.25
    });
    expect(sentBody()).toMatchObject({ maxSpendUsd: 1.25 });

    calls.length = 0;
    await api.continueTask('task-1', { prompt: 'And the month', maxSpendUsd: 3 });
    expect(only().url).toBe('/v1/tasks/task-1/messages');
    expect(sentBody()).toMatchObject({ maxSpendUsd: 3 });
  });
});

describe('reading a file back with what the machine says it read', () => {
  it('returns the digest of a whole-file read, which is what a later write claims against', async () => {
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(
        new Response(new Uint8Array([104, 105]), {
          headers: { 'content-type': 'application/octet-stream', 'x-content-sha256': 'deadbeef' }
        })
      );
    });
    const file = await api.readFile('ws-1', 'workspace/notes.md');
    expect(only().url).toBe('/v1/workspaces/ws-1/file?path=workspace%2Fnotes.md');
    expect(file.sha256).toBe('deadbeef');
    expect(new Uint8Array(file.bytes)).toEqual(new Uint8Array([104, 105]));
  });

  it('reports no digest for a window, because a digest of part of a file is not a claim about it', async () => {
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(
        new Response(new Uint8Array([104, 105]), {
          headers: {
            'content-type': 'application/octet-stream',
            'x-start-line': '40',
            'x-end-line': '80',
            'x-truncated': 'true',
            'x-next-start-line': '81'
          }
        })
      );
    });
    const file = await api.readFile('ws-1', 'workspace/build.log', {
      startLine: 40,
      maxBytes: 512
    });
    expect(only().url).toBe(
      '/v1/workspaces/ws-1/file?path=workspace%2Fbuild.log&startLine=40&maxBytes=512'
    );
    expect(file.sha256).toBeNull();
    expect(file).toMatchObject({ startLine: 40, endLine: 80, truncated: true, nextStartLine: 81 });
    // A header the runner did not send is absent, not zero: "this file has no lines" and "the
    // runner did not count them" are different answers and a viewer paging through needs to tell.
    expect(file.totalLines).toBeNull();
  });
});

describe('what a failure carries back', () => {
  it('keeps the request id the box minted, so the owner can quote it at their own log', async () => {
    answer(
      {
        error: {
          code: 'file_changed',
          message: 'This file changed after you read it',
          requestId: 'req-7f3a'
        }
      },
      { status: 409 }
    );
    const failure = await api
      .writeFile('ws-1', 'workspace/notes.md', new Uint8Array([1]), 'stale')
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ApiFailure);
    expect(failure).toMatchObject({
      code: 'file_changed',
      status: 409,
      requestId: 'req-7f3a'
    });
  });

  it('carries the id off a read as well as a write', async () => {
    answer(
      { error: { code: 'workspace_not_found', message: 'Gone', requestId: 'req-11' } },
      {
        status: 404
      }
    );
    const failure = (await api
      .readFile('ws-1', 'workspace/notes.md')
      .catch((cause: unknown) => cause)) as ApiFailure;
    expect(failure).toBeInstanceOf(ApiFailure);
    expect(failure.requestId).toBe('req-11');
  });

  it('has no id when the answer came from something that is not this API', async () => {
    // Fastify's own 404 shape, which carries no athanor envelope at all. Inventing a blank id
    // here would make the log line unfindable rather than plainly absent.
    answer({ statusCode: 404, error: 'Not Found', message: 'Route not found' }, { status: 404 });
    const failure = (await api.approvals().catch((cause: unknown) => cause)) as ApiFailure;
    expect(failure).toBeInstanceOf(ApiFailure);
    expect(failure.code).toBe('request_failed');
    expect(failure.requestId).toBeUndefined();
  });
});
