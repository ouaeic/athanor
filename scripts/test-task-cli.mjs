#!/usr/bin/env node
/**
 * What `athanor task` promises a script, proved against a stand-in API rather than a live model.
 *
 * The subcommand exists because two callers wanted the same three things - an owner who lives in a
 * terminal, and a harness scoring athanor from outside - and none of the three is what curl gives
 * you on its own: an exit code that is honest about how the WORK ended, one documented object of
 * data instead of prose to grep, and an approval stop that is visible rather than answered.
 *
 * So the checks below are about those three and almost nothing else. A stand-in server answers on
 * a loopback port with the shapes `apps/api` actually returns - `{ error: { code, message } }` for
 * a refusal, the task record `context.ts:119` builds, the event envelope
 * `routes/task-events.ts` returns under `?page=1`, and the `completed` payload
 * `apps/worker/src/agent.ts:1669` writes - and every request the command makes is recorded, so
 * this pins what goes onto the wire and not only what comes back off it.
 *
 * The thing it deliberately cannot prove: that those shapes are still what the server sends. This
 * is a stand-in, so it is exactly the kind of rig that stays green after the API moves underneath
 * it. `scripts/live-drill.mjs` is what proves the other half, against a real box and a real model,
 * and it costs money to run.
 *
 * Usage: node scripts/test-task-cli.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const cli = path.resolve('scripts/athanor');
// Shaped like the real thing: `auth-hook.ts` accepts /^oc_live_[A-Za-z0-9_-]{40,80}$/ and the
// command checks the same pattern before it will put the value in a curl configuration file.
const TOKEN = `oc_live_${'a'.repeat(43)}`;
// No /etc/athanor to fall back to, so the environment variable is the only token in play and the
// "no token at all" check below really has none.
const emptyConfig = mkdtempSync(path.join(tmpdir(), 'athanor-task-cli-'));

let checks = 0;
const failures = [];
const check = (what, run) => {
  checks += 1;
  try {
    run();
  } catch (error) {
    failures.push(`${what}: ${error.message}`);
  }
};

/** The task record shape `apps/api/src/context.ts:119` builds, with only the fields read here. */
const taskRecord = (over = {}) => ({
  id: 'task-1111',
  workspaceId: 'ws-2222',
  status: 'running',
  securityMode: 'balanced',
  modelId: 'a/model',
  maxComputeCredits: 200,
  actualComputeCredits: 3.5,
  maxSpendUsd: 0.5,
  spentUsd: 0.0125,
  ...over
});

/** The `?page=1` envelope `apps/api/src/routes/task-events.ts` returns. */
const eventPage = (events) => ({ events, hasMore: false, oldestSequence: 1, nextCursor: 99 });

/**
 * The payload `#completeTurn` seals into the `completed` event. The command reads its answer out
 * of here, which is the whole of what "a machine-readable final answer" means: before this,
 * `scripts/live-drill.mjs` filtered the event list by hand and then grepped the JSON for the
 * string "exit 0".
 */
const completedEvent = (summary) => ({
  id: 'ev-9',
  sequence: 42,
  kind: 'completed',
  summary: 'Task completed',
  payload: {
    summary,
    verification: { claim: 'the report exists', evidence: 'ls report.pdf' },
    outstanding: ['the second half was not attempted']
  }
});

/**
 * What the worker writes when a turn dies: the `event` call inside `agent.ts`'s `fail`. Two things
 * about it that this file used to get wrong, and that the outcome builder used to get wrong with
 * it:
 *
 *   - the KIND is `warning`, not `error`, whenever the code contains "provider" (agent.ts:2157),
 *     and the task still ends `failed` unless the code is one of the three in
 *     PARKABLE_PROVIDER_WALLS (agent.ts:144). So the commonest failures there are arrive under the
 *     kind an outcome reading only `error` events cannot see.
 *   - the payload carries `owner: true`. `tool-recording.ts:170` writes an `error` event for every
 *     tool call that throws, mid-run, and that one does not. It is the only thing telling a
 *     sentence that ends a run apart from a shell command that failed and was recovered from.
 */
const endingEvent = (message, code, kind = 'error') => ({
  id: 'ev-8',
  sequence: 41,
  kind,
  summary: message,
  payload: { owner: true, code }
});

/** And the mid-run one, which is not an ending: `apps/worker/src/tool-recording.ts:170`. */
const toolFailureEvent = (message, code) => ({
  id: 'ev-7',
  sequence: 40,
  kind: 'error',
  summary: message,
  payload: { toolCallId: 'call-1', message, code }
});

/**
 * The command itself, in a child process. Never `spawnSync`: the stand-in server below lives in
 * this process, and a synchronous wait would hold the event loop shut for exactly as long as the
 * command spent waiting for it to answer.
 */
const execute = (args, environment, stdin) =>
  new Promise((resolve) => {
    const child = spawn('/bin/sh', [cli, 'task', ...args], {
      env: { ...process.env, ATHANOR_CONFIG: emptyConfig, ...environment }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdin.end(stdin);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

/**
 * Run the command against a server that answers from `routes`, and hand back the exit code, the
 * parsed outcome, and every request that was made.
 *
 * `routes` is keyed by "METHOD /path" without the query string. A handler is called with the
 * request record and returns [status, body]; a handler may be an array of answers, taken in turn,
 * which is how a task is made to be running on the first look and finished on the second.
 */
const drive = async (routes, args, options = {}) => {
  const seen = [];
  // An answer is [status, body]; a sequence of them is an array of those, which is how a task is
  // made to be running on the first look and finished on the second. Both are arrays, so the two
  // are told apart by whether the first element is itself one.
  const isSequence = (value) => Array.isArray(value) && Array.isArray(value[0]);
  const remaining = new Map(
    Object.entries(routes).map(([key, value]) => [key, isSequence(value) ? [...value] : value])
  );
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const raw = Buffer.concat(chunks).toString('utf8');
      const record = {
        method: request.method,
        path: url.pathname,
        query: url.search,
        authorization: request.headers.authorization ?? null,
        idempotencyKey: request.headers['idempotency-key'] ?? null,
        body: raw ? JSON.parse(raw) : null
      };
      seen.push(record);
      const key = `${request.method} ${url.pathname}`;
      const handler = remaining.get(key);
      const answer = isSequence(handler)
        ? handler.length > 1
          ? handler.shift()
          : handler[0]
        : handler;
      if (!answer) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'not_found', message: 'No such route' } }));
        return;
      }
      const [status, body] = answer;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const result = await execute(
    args,
    {
      ATHANOR_API: `http://127.0.0.1:${port}`,
      ATHANOR_TASK_POLL_SECONDS: '1',
      ...(options.token === null
        ? { ATHANOR_TOKEN: '' }
        : { ATHANOR_TOKEN: options.token ?? TOKEN })
    },
    options.stdin ?? ''
  );
  await new Promise((resolve) => server.close(resolve));
  let outcome = null;
  try {
    outcome = JSON.parse(result.stdout);
  } catch {
    outcome = null;
  }
  return { ...result, outcome, seen };
};

const runRoutes = (taskAnswers, events) => ({
  'POST /v1/tasks': [201, taskRecord({ status: 'queued' })],
  'GET /v1/tasks/task-1111': taskAnswers,
  'GET /v1/tasks/task-1111/events': [200, eventPage(events)]
});

const started = [
  'run',
  '--workspace',
  'ws-2222',
  '--prompt',
  'write me a report',
  '--timeout',
  '30'
];

// --- a run that finishes ------------------------------------------------------------------------

const finished = await drive(
  runRoutes(
    [
      [200, taskRecord({ status: 'running' })],
      [200, taskRecord({ status: 'completed', actualComputeCredits: 12 })]
    ],
    [completedEvent('I wrote report.pdf and checked it opens.')]
  ),
  started
);

check('a completed task exits 0', () => assert.equal(finished.code, 0));
check('the outcome names its contract', () =>
  assert.equal(finished.outcome.contract, 'athanor.task.outcome/1')
);
check('a completed task says so', () => {
  assert.equal(finished.outcome.outcome, 'completed');
  assert.equal(finished.outcome.status, 'completed');
  assert.equal(finished.outcome.exitCode, 0);
});
check('the answer comes out of the completed event, not out of prose', () =>
  assert.equal(finished.outcome.answer, 'I wrote report.pdf and checked it opens.')
);
check('the outcome says whether the transcript was read at all', () =>
  assert.equal(finished.outcome.transcript, 'read')
);
check('the completion contract travels with the answer', () => {
  assert.equal(finished.outcome.verification.claim, 'the report exists');
  assert.deepEqual(finished.outcome.outstanding, ['the second half was not attempted']);
});
check('the terms the work ran under are in the result', () => {
  assert.equal(finished.outcome.securityMode, 'balanced');
  assert.equal(finished.outcome.modelId, 'a/model');
  assert.equal(finished.outcome.spentUsd, 0.0125);
  assert.deepEqual(finished.outcome.computeCredits, { used: 12, max: 200 });
});
check('the wait actually waited rather than reading once', () => {
  const polls = finished.seen.filter((r) => r.method === 'GET' && r.path === '/v1/tasks/task-1111');
  assert.equal(polls.length, 2, `polled ${polls.length} time(s)`);
});
check('every call carries the bearer token', () =>
  assert.ok(finished.seen.every((r) => r.authorization === `Bearer ${TOKEN}`))
);
check('the write carries an idempotency key', () => {
  const post = finished.seen.find((r) => r.method === 'POST');
  assert.match(post.idempotencyKey ?? '', /^athanor-task-\d+-[0-9a-f]{16}$/);
});
check('the request is the body the API asks for', () => {
  const post = finished.seen.find((r) => r.method === 'POST');
  assert.deepEqual(post.body, {
    workspaceId: 'ws-2222',
    prompt: 'write me a report',
    privacyRoute: 'provider_zdr'
  });
});
check('the transcript is read as the paged envelope', () => {
  const read = finished.seen.find((r) => r.path === '/v1/tasks/task-1111/events');
  assert.equal(read.query, '?page=1&limit=50');
});

// --- every other way a run can end ---------------------------------------------------------------
//
// One number each. A wrapper that returns 0 while the work died is the defect this subcommand
// exists to make impossible, and a single shared non-zero would leave a caller unable to tell a
// task that failed from a task nobody answered.

const failed = await drive(
  runRoutes(
    [[200, taskRecord({ status: 'failed' })]],
    [endingEvent('The agent could not finish.', 'agent_failed')]
  ),
  started
);
check('a failed task exits 2 and says why', () => {
  assert.equal(failed.code, 2);
  assert.equal(failed.outcome.outcome, 'failed');
  assert.equal(failed.outcome.reason, 'The agent could not finish.');
  assert.equal(failed.outcome.reasonCode, 'agent_failed');
  assert.equal(failed.outcome.answer, null);
});

/*
 * The same ending, written the way the worker actually writes it for the whole provider class.
 *
 * `agent.ts:2157` picks the kind `warning` for any code containing "provider", and only
 * `provider_quota_exhausted`, `provider_not_connected` and `provider_unavailable` park the task
 * instead of failing it. `provider_stream_unparsed` is therefore an ordinary `failed` task whose
 * only account of itself is a `warning` - which an outcome reading `error` events alone reported as
 * exit 2 with no reason at all.
 */
const walled = await drive(
  runRoutes(
    [[200, taskRecord({ status: 'failed' })]],
    [endingEvent('The provider stream could not be parsed.', 'provider_stream_unparsed', 'warning')]
  ),
  started
);
check('a failure the worker recorded as a warning still says why', () => {
  assert.equal(walled.code, 2);
  assert.equal(walled.outcome.reason, 'The provider stream could not be parsed.');
  assert.equal(walled.outcome.reasonCode, 'provider_stream_unparsed');
});

/*
 * And the other direction. A tool call that threw and was recovered from leaves an `error` event
 * behind on a run that then finished; reporting it as the run's reason told a caller that a
 * successful task had failed, beside the answer it had just produced.
 */
const recovered = await drive(
  runRoutes(
    [[200, taskRecord({ status: 'completed' })]],
    [toolFailureEvent('shell failed', 'shell_failed'), completedEvent('I wrote the report.')]
  ),
  started
);
check('a run that recovered from a failed tool call is not reported as having a reason', () => {
  assert.equal(recovered.code, 0);
  assert.equal(recovered.outcome.answer, 'I wrote the report.');
  assert.equal(recovered.outcome.reason, null);
  assert.equal(recovered.outcome.reasonCode, null);
});

const asked = await drive(
  {
    ...runRoutes([[200, taskRecord({ status: 'awaiting_user' })]], []),
    'GET /v1/approvals': [
      200,
      [
        {
          id: 'ap-3333',
          taskId: 'task-1111',
          action: 'shell',
          preview: { action: 'shell', command: 'curl https://example.invalid' }
        }
      ]
    ]
  },
  started
);
check('a task that stopped to ask exits 3', () => {
  assert.equal(asked.code, 3);
  assert.equal(asked.outcome.outcome, 'awaiting_approval');
});
check('what it stopped to ask is in the outcome as data', () => {
  assert.equal(asked.outcome.pendingApprovals.length, 1);
  assert.equal(asked.outcome.pendingApprovals[0].id, 'ap-3333');
  assert.equal(asked.outcome.pendingApprovals[0].preview.command, 'curl https://example.invalid');
});
check('nothing was answered on the owner behalf', () =>
  assert.equal(
    asked.seen.filter((r) => r.path.includes('/approve') || r.path.includes('/deny')).length,
    0
  )
);

const cancelledByServer = await drive(
  runRoutes([[200, taskRecord({ status: 'cancelled' })]], []),
  started
);
check('a cancelled task exits 5', () => {
  assert.equal(cancelledByServer.code, 5);
  assert.equal(cancelledByServer.outcome.outcome, 'cancelled');
});

for (const [status, what] of [
  ['paused', 'a paused task'],
  // The one that reads like it will clear on its own and does not: a provider wall parks a task
  // here and nothing leases it again without a resume, so waiting on it is waiting forever.
  ['awaiting_resource', 'a task waiting on a provider']
]) {
  const blocked = await drive(runRoutes([[200, taskRecord({ status })]], []), started);
  check(`${what} exits 6 rather than waiting`, () => {
    assert.equal(blocked.code, 6);
    assert.equal(blocked.outcome.outcome, 'blocked');
    assert.equal(blocked.outcome.status, status);
  });
}

const ranOut = await drive(runRoutes([[200, taskRecord({ status: 'running' })]], []), [
  ...started.slice(0, -1),
  '0'
]);
check('a wait that runs out exits 4 and leaves the task alone', () => {
  assert.equal(ranOut.code, 4);
  assert.equal(ranOut.outcome.outcome, 'timed_out');
  assert.equal(ranOut.outcome.status, 'running');
  assert.equal(ranOut.seen.filter((r) => r.path.endsWith('/cancel')).length, 0);
});

// --- looking at, and stopping, a task that is already going ---------------------------------------

const looked = await drive(
  {
    'GET /v1/tasks/task-1111': [200, taskRecord({ status: 'running' })],
    'GET /v1/tasks/task-1111/events': [200, eventPage([])]
  },
  ['show', 'task-1111']
);
// A transcript that could not be read is not the same thing as a turn that wrote nothing, and a
// caller scoring on `answer` has to be able to tell those apart.
const unread = await drive(
  { 'GET /v1/tasks/task-1111': [200, taskRecord({ status: 'completed' })] },
  ['wait', 'task-1111']
);
check('a transcript that could not be read says so', () => {
  assert.equal(unread.code, 0);
  assert.equal(unread.outcome.transcript, 'unavailable');
  assert.equal(unread.outcome.answer, null);
});
check('show on a running task exits 7 rather than calling it a timeout', () => {
  assert.equal(looked.code, 7);
  assert.equal(looked.outcome.outcome, 'running');
});

const stopped = await drive(
  {
    'POST /v1/tasks/task-1111/cancel': [200, taskRecord({ status: 'cancelled' })],
    'GET /v1/tasks/task-1111/events': [200, eventPage([])]
  },
  ['cancel', 'task-1111']
);
check('cancel reports the work, not the request', () => {
  assert.equal(stopped.code, 5);
  assert.equal(stopped.outcome.outcome, 'cancelled');
  const post = stopped.seen.find((r) => r.method === 'POST');
  assert.equal(post.idempotencyKey, 'athanor-cancel-task-1111');
});

// --- answering an approval, deliberately ----------------------------------------------------------

for (const decision of ['approve', 'deny']) {
  const answered = await drive(
    { [`POST /v1/approvals/ap-3333/${decision}`]: [200, { ok: true }] },
    [decision, 'ap-3333']
  );
  check(`${decision} posts to its own route and its own key`, () => {
    assert.equal(answered.code, 0);
    assert.equal(answered.outcome.decision, decision);
    const post = answered.seen.find((r) => r.method === 'POST');
    assert.equal(post.path, `/v1/approvals/ap-3333/${decision}`);
    assert.equal(post.idempotencyKey, `athanor-${decision}-ap-3333`);
  });
}

const listed = await drive(
  {
    'GET /v1/approvals': [
      200,
      [
        { id: 'ap-1', taskId: 'task-1111', action: 'shell' },
        { id: 'ap-2', taskId: 'task-other', action: 'browser' }
      ]
    ]
  },
  ['approvals', 'task-1111']
);
check('approvals lists only the task asked about', () => {
  assert.equal(listed.code, 0);
  assert.deepEqual(
    JSON.parse(listed.stdout).map((a) => a.id),
    ['ap-1']
  );
});

// --- the refusals ---------------------------------------------------------------------------------

const noToken = await drive({}, started, { token: null });
check('no token stops before anything is sent', () => {
  assert.equal(noToken.code, 1);
  assert.equal(noToken.seen.length, 0);
  assert.match(noToken.stderr, /no API token/);
});

const wrongToken = await drive({}, started, { token: 'sk-not-an-athanor-token' });
check('a token of the wrong shape stops before anything is sent', () => {
  assert.equal(wrongToken.code, 1);
  assert.equal(wrongToken.seen.length, 0);
  assert.match(wrongToken.stderr, /oc_live_/);
});

const refused = await drive(
  { 'POST /v1/tasks': [403, { error: { code: 'forbidden', message: 'Scope required' } }] },
  started
);
check('a refused token names the scope it needed', () => {
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /tasks:write/);
});

const rejected = await drive(
  {
    'POST /v1/tasks': [
      400,
      { error: { code: 'workspace_unavailable', message: 'Workspace is not running' } }
    ]
  },
  started
);
check('a refused request repeats what the server said', () => {
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /workspace_unavailable/);
  assert.match(rejected.stderr, /Workspace is not running/);
});

/*
 * A 200 that is not the object this reads. An `Idempotency-Key` is not what makes an answer
 * parseable and a proxy in front of the API is free to hand back a courtesy page with a 200 on it.
 *
 * Pinned because the number was wrong rather than merely unhelpful: jq's own failure exit is 5, the
 * command runs under `set -e`, and 5 is this contract's word for "the task was cancelled". So a
 * caller reading the status - the whole reason this subcommand exists - was told the owner had
 * stopped their task. Whatever this is, it is the command failing to do its job, which is 1.
 */
const unreadable = await drive(
  {
    'GET /v1/tasks/task-1111': [200, 'a proxy said hello'],
    'GET /v1/tasks/task-1111/events': [200, eventPage([])]
  },
  ['wait', 'task-1111', '--timeout', '0']
);
check('an answer this cannot read is exit 1, not the code for a cancelled task', () => {
  assert.equal(unreadable.code, 1);
  assert.notEqual(unreadable.code, 5);
});

// Nothing is listening on port 1, which is what an operator gets by pointing this at the wrong one.
const silent = await execute(
  started,
  { ATHANOR_API: 'http://127.0.0.1:1', ATHANOR_TOKEN: TOKEN },
  ''
);
check('a server that does not answer is not a success', () => {
  assert.equal(silent.code, 1);
  assert.match(silent.stderr, /did not answer/);
});

// --- the two design decisions worth pinning --------------------------------------------------------

const overridden = await drive({}, [...started, '--security-mode', 'autonomous']);
check('there is no flag that loosens what a run stops to ask', () => {
  assert.equal(overridden.code, 1);
  assert.equal(overridden.seen.length, 0);
  assert.match(overridden.stderr, /unknown option --security-mode/);
});

const piped = await drive(
  runRoutes([[200, taskRecord({ status: 'completed' })]], [completedEvent('done')]),
  ['run', '--workspace', 'ws-2222', '--prompt-file', '-', '--timeout', '5'],
  { stdin: 'a prompt long enough to be worth a file\n' }
);
check('a prompt can arrive on standard input', () => {
  assert.equal(piped.code, 0);
  const post = piped.seen.find((r) => r.method === 'POST');
  assert.equal(post.body.prompt, 'a prompt long enough to be worth a file');
});

/*
 * The other kind of stop.
 *
 * `awaiting_user` is two situations wearing one status - a card to decide, and a question the agent
 * asked - and only the first had a verb or a field. A headless run that was asked anything parked
 * for ever: `approvals` answered with an empty list, the outcome carried an empty
 * `pendingApprovals`, and docs/HEADLESS.md said that list "holds the questions", which it does not.
 */
const questionEvent = (question, why, options) => ({
  sequence: 7,
  kind: 'question_asked',
  summary: question,
  payload: { question, why, ...(options ? { options } : {}) }
});

const questioned = await drive(
  {
    ...runRoutes(
      [[200, taskRecord({ status: 'awaiting_user' })]],
      [questionEvent('Which database should I point it at?', 'Two are configured', ['dev', 'prod'])]
    ),
    'GET /v1/approvals': [200, []]
  },
  started
);
check('a task parked on a question reports what it asked', () => {
  assert.equal(questioned.code, 3);
  assert.equal(questioned.outcome.pendingApprovals.length, 0);
  assert.equal(questioned.outcome.question.question, 'Which database should I point it at?');
  assert.equal(questioned.outcome.question.why, 'Two are configured');
  assert.deepEqual(questioned.outcome.question.options, ['dev', 'prod']);
});

/*
 * Precedence, and the reason it is not both at once: a card is the thing in front of the owner, and
 * a question asked earlier in the same conversation has already been left behind by it.
 */
const cardOverQuestion = await drive(
  {
    ...runRoutes(
      [[200, taskRecord({ status: 'awaiting_user' })]],
      [questionEvent('An older question', 'asked earlier')]
    ),
    'GET /v1/approvals': [
      200,
      [{ id: 'ap-9', taskId: 'task-1111', action: 'shell', preview: { action: 'shell' } }]
    ]
  },
  started
);
check('a pending card takes precedence over a question already asked', () => {
  assert.equal(cardOverQuestion.outcome.pendingApprovals.length, 1);
  assert.equal(cardOverQuestion.outcome.question, null);
});

check('a task that stopped for a card still reports no question', () =>
  assert.equal(asked.outcome.question, null)
);

const answered = await drive(
  { 'POST /v1/tasks/task-1111/messages': [200, taskRecord({ status: 'running' })] },
  ['answer', 'task-1111', '--text', 'Use the dev one']
);
check('answer sends the reply as the next message on the conversation', () => {
  assert.equal(answered.code, 0);
  const post = answered.seen.find((r) => r.method === 'POST');
  assert.equal(post.path, '/v1/tasks/task-1111/messages');
  assert.equal(post.body.prompt, 'Use the dev one');
  assert.equal(answered.outcome.contract, 'athanor.task.answer/1');
});

/*
 * The words are the key when the caller gives none, so a curl retried after a timeout cannot become
 * a second message in the conversation. Saying the same thing twice on purpose takes --key.
 */
const againSameWords = await drive(
  { 'POST /v1/tasks/task-1111/messages': [200, taskRecord({ status: 'running' })] },
  ['answer', 'task-1111', '--text', 'Use the dev one']
);
const differentWords = await drive(
  { 'POST /v1/tasks/task-1111/messages': [200, taskRecord({ status: 'running' })] },
  ['answer', 'task-1111', '--text', 'Use the prod one']
);
const keyOf = (result) => result.seen.find((r) => r.method === 'POST')?.idempotencyKey ?? null;
check('the same answer twice carries the same idempotency key', () => {
  assert.notEqual(keyOf(answered), null);
  assert.equal(keyOf(againSameWords), keyOf(answered));
  assert.notEqual(keyOf(differentWords), keyOf(answered));
});

const answeredFromFile = await drive(
  { 'POST /v1/tasks/task-1111/messages': [200, taskRecord({ status: 'running' })] },
  ['answer', 'task-1111', '--text-file', '-'],
  { stdin: 'the answer, read from standard input' }
);
check('answer reads the words from a file or standard input', () =>
  assert.equal(
    answeredFromFile.seen.find((r) => r.method === 'POST').body.prompt,
    'the answer, read from standard input'
  )
);

const emptyAnswer = await drive({}, ['answer', 'task-1111']);
check('answer refuses to send nothing, and sends nothing', () => {
  assert.equal(emptyAnswer.code, 1);
  assert.equal(emptyAnswer.seen.filter((r) => r.method === 'POST').length, 0);
});

rmSync(emptyConfig, { recursive: true, force: true });

if (failures.length) {
  process.stderr.write(`${failures.map((line) => `  FAIL ${line}`).join('\n')}\n`);
  process.stderr.write(`athanor task: ${failures.length} of ${checks} checks failed\n`);
  process.exit(1);
}
process.stdout.write(`athanor task: ${checks} checks passed against a stand-in API.\n`);
