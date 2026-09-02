/**
 * The checks the artefacts cannot make about themselves, run on every invocation rather than
 * behind a flag.
 *
 * This programme has found seven saturated assertions, so every check below is written to be
 * breakable: it drives a real shim over a real temporary directory and asserts an outcome that a
 * plausible-looking wrong implementation would not produce. Two of them assert a REFUSAL, which is
 * the only kind of check that can prove a gate exists - a gate is invisible while nothing hits it.
 *
 * Every loop over a collection asserts the collection is non-empty first. This repository has
 * shipped a proof that ran zero times and reported a guarantee it was not making.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dockerExecArgv, localBackend } from './backend.js';
import { BYTES_PER_TOKEN, benchmarkBoxCatalogueBytes, catalogueWeights } from './catalogue.js';
import { readFile } from './files.js';
import {
  aggregate,
  COLUMNS,
  rowFrom,
  scoreOf,
  type RowInput,
  type RunRecord,
  type TaskResult
} from './parity.js';
import { SWEEP_SURFACES } from './observe.js';
import {
  ABSENT_ROUTES,
  canonicalRoute,
  coverageOf,
  IMPLEMENTED_ROUTES,
  type RouteObservation
} from './routes.js';
import { createShim } from './shim.js';
import { wiringChecks } from './wiring.js';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';

/**
 * One request per implemented route, chosen so the route can actually do its work.
 *
 * The point is not that each returns 200 - a 404 for a file that is not there is a correct answer.
 * The point is that none of them comes back a MISS, because a route declared in
 * `IMPLEMENTED_ROUTES` with no arm behind it in the switch is recorded as a miss by `shim.ts` and
 * is the same silence to the loop as a route nobody declared. That is this rig's own version of
 * the computed-and-unwired defect and it is the reason this table exists.
 */
const EXERCISE: ReadonlyArray<{
  readonly route: string;
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
}> = [
  { route: 'PUT /v1/workspaces/:workspaceId', method: 'PUT', url: `/v1/workspaces/${WORKSPACE}` },
  { route: 'GET /v1/workspaces/:workspaceId', method: 'GET', url: `/v1/workspaces/${WORKSPACE}` },
  {
    route: 'POST /v1/workspaces/:workspaceId/exec',
    method: 'POST',
    url: `/v1/workspaces/${WORKSPACE}/exec`,
    body: { executable: '/bin/echo', args: ['hello'] }
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/files',
    method: 'GET',
    url: `/v1/workspaces/${WORKSPACE}/files?path=workspace`
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/file',
    method: 'GET',
    url: `/v1/workspaces/${WORKSPACE}/file?path=${encodeURIComponent('workspace/notes.txt')}`
  },
  {
    route: 'PUT /v1/workspaces/:workspaceId/file',
    method: 'PUT',
    url: `/v1/workspaces/${WORKSPACE}/file?path=${encodeURIComponent('workspace/notes.txt')}`,
    body: 'one\ntwo\nthree\n'
  },
  {
    route: 'DELETE /v1/workspaces/:workspaceId/file',
    method: 'DELETE',
    url: `/v1/workspaces/${WORKSPACE}/file?path=${encodeURIComponent('workspace/gone.txt')}`
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/files/folder',
    method: 'POST',
    url: `/v1/workspaces/${WORKSPACE}/files/folder`,
    body: { path: 'workspace/src' }
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/files/rename',
    method: 'POST',
    url: `/v1/workspaces/${WORKSPACE}/files/rename`,
    body: { from: 'workspace/notes.txt', to: 'workspace/renamed.txt' }
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/toolchain',
    method: 'GET',
    url: `/v1/workspaces/${WORKSPACE}/toolchain`
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/toolchain/probe',
    method: 'POST',
    url: `/v1/workspaces/${WORKSPACE}/toolchain/probe`,
    body: { binaries: ['sh', 'this-binary-does-not-exist'] }
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/machine',
    method: 'GET',
    url: `/v1/workspaces/${WORKSPACE}/machine`
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/surfaces',
    method: 'GET',
    url: `/v1/workspaces/${WORKSPACE}/surfaces`
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/usage',
    method: 'GET',
    url: `/v1/workspaces/${WORKSPACE}/usage`
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/processes/start',
    method: 'POST',
    url: `/v1/workspaces/${WORKSPACE}/processes/start`,
    body: { executable: '/bin/echo', args: ['background'] }
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/processes',
    method: 'GET',
    url: `/v1/workspaces/${WORKSPACE}/processes`
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/processes/stop-owner',
    method: 'POST',
    url: `/v1/workspaces/${WORKSPACE}/processes/stop-owner`,
    body: {}
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/processes/:id',
    method: 'POST',
    url: `/v1/workspaces/${WORKSPACE}/processes/proc_${'a'.repeat(32)}`,
    body: { action: 'poll' }
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/checkpoints',
    method: 'POST',
    url: `/v1/workspaces/${WORKSPACE}/checkpoints`,
    body: { checkpointId: 'cp-1', turn: 1 }
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/checkpoints',
    method: 'GET',
    url: `/v1/workspaces/${WORKSPACE}/checkpoints`
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/image',
    method: 'GET',
    url: `/v1/workspaces/${WORKSPACE}/image?path=${encodeURIComponent('workspace/logo.png')}`
  }
];

const bodyOf = (value: unknown): Buffer =>
  value === undefined
    ? Buffer.alloc(0)
    : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

const threw = async (what: () => unknown): Promise<string | null> => {
  try {
    await what();
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
};

const baseRow = (): RowInput => ({
  benchmark: 'terminal-bench-2.0',
  taskSet: 'selftest',
  taskSetSha: 'x',
  nTasks: 4,
  model: 'm',
  modelRoute: 'r',
  provider: 'p',
  harness: 'athanor',
  harnessVersion: '0.1.1',
  harnessCommit: 'x',
  arm: 'shipped',
  securityMode: 'balanced',
  approvalsAutoAnswered: 0,
  taskMaxSteps: 120,
  selfContinuations: 2,
  maxComputeCredits: null,
  maxSpendUsd: null,
  catalogueBytes: 0,
  catalogueTokensPerCall: 0,
  surfaces: { browser: 'absent', desktop: 'absent' },
  backend: 'local',
  isolatesNetwork: false,
  verifierEnv: 'separate',
  networkMode: 'none',
  declaredDrops: [],
  shimMisses: [],
  absentRequests: 7,
  runs: [{ startedAt: 'now', tasks: [] }] as readonly RunRecord[]
});

export const selfTest = async (observation: RouteObservation | null): Promise<string[]> => {
  const problems: string[] = [];

  /* --------------------------------------------------- the canonicaliser, in both directions */
  if (
    canonicalRoute('GET', `/v1/workspaces/${WORKSPACE}/file?path=a%2Fb`) !==
    'GET /v1/workspaces/:workspaceId/file'
  )
    problems.push('a workspace id or a query string is not being taken out of a route name');
  if (
    canonicalRoute('POST', `/v1/workspaces/${WORKSPACE}/toolchain/probe`) !==
    'POST /v1/workspaces/:workspaceId/toolchain/probe'
  )
    // The other direction, and it matters more: a canonicaliser that collapsed a LITERAL segment
    // would report the shim as implementing routes it does not, which is the whole failure.
    problems.push('a literal path segment is being collapsed into an id');
  if (
    canonicalRoute('POST', `/v1/workspaces/${WORKSPACE}/processes/proc_${'b'.repeat(32)}`) !==
    'POST /v1/workspaces/:workspaceId/processes/:id'
  )
    problems.push('a runner-minted session id is not being recognised as an id');

  /* ----------------------------------------------------------------- the shim, over a real box */
  if (IMPLEMENTED_ROUTES.length === 0) {
    problems.push('IMPLEMENTED_ROUTES is empty, so nothing below ran');
    return problems;
  }
  if (EXERCISE.length !== IMPLEMENTED_ROUTES.length)
    problems.push(
      `${EXERCISE.length} routes are exercised and ${IMPLEMENTED_ROUTES.length} are declared: a declared route with no exercise is a route nothing has ever driven`
    );

  const backend = await localBackend();
  try {
    await backend.ensure();
    const shim = createShim({ backend });
    for (const step of EXERCISE) {
      const answer = await shim.handle(step.method, step.url, bodyOf(step.body));
      if (answer.status === 501)
        problems.push(`${step.route} answered 501, so it is declared with no handler behind it`);
      if (answer.status >= 500 && answer.status !== 501)
        problems.push(
          `${step.route} failed in the box: ${answer.body.toString('utf8').slice(0, 200)}`
        );
    }
    if (shim.misses.length > 0)
      problems.push(`exercising the declared routes produced misses: ${shim.misses.join(', ')}`);

    /* ------------------------------------------------------- the hard failure, actually driven */
    const seenByMiss: string[] = [];
    const strict = createShim({ backend, onMiss: (route) => seenByMiss.push(route) });
    const refused = await strict.handle(
      'GET',
      `/v1/workspaces/${WORKSPACE}/browser/snapshot`,
      Buffer.alloc(0)
    );
    if (refused.status !== 501)
      problems.push(`an unimplemented route answered ${refused.status} rather than 501`);
    if (strict.misses.length !== 1 || seenByMiss.length !== 1)
      problems.push(
        'an unimplemented route was not recorded as a miss, so nothing would void the run'
      );
    // The 501 is for a human. THIS is the guard: `apps/worker/src/agent.ts` catches three of these
    // into a shrug, so a status code alone would let the run finish and be scored.
    const voided = await threw(() =>
      rowFrom({ ...baseRow(), shimMisses: strict.misses }, (value) => value)
    );
    if (voided === null)
      problems.push('a row was emitted for a run that reached a route the shim does not implement');

    /* ------------------------------------------------------------------- files, round-tripped */
    const written = 'alpha\nbeta\ngamma\n';
    await shim.handle(
      'PUT',
      `/v1/workspaces/${WORKSPACE}/file?path=${encodeURIComponent('workspace/round.txt')}`,
      Buffer.from(written, 'utf8')
    );
    const back = await readFile(backend, 'workspace/round.txt');
    if (back === null || back.toString('utf8') !== written)
      problems.push('a file written through the shim did not read back byte for byte');
    // The command sees the same file. Without this the file half and the exec half could be two
    // different boxes and every test above would still pass.
    const seesIt = await shim.handle(
      'POST',
      `/v1/workspaces/${WORKSPACE}/exec`,
      bodyOf({ executable: '/bin/cat', args: ['round.txt'] })
    );
    const execResult = JSON.parse(seesIt.body.toString('utf8')) as {
      exitCode: number;
      stdout: string;
    };
    if (execResult.exitCode !== 0 || execResult.stdout !== written)
      problems.push(
        `a command run through the shim cannot see a file written through it: exit ${String(execResult.exitCode)}`
      );
    // The three read shapes are three different answers, which is what `file_patch` and the read
    // ledger both depend on. A shim that answered the whole file to all three would pass every
    // other check in this file.
    const window = await shim.handle(
      'GET',
      `/v1/workspaces/${WORKSPACE}/file?path=${encodeURIComponent('workspace/round.txt')}&maxBytes=6&startLine=1&endLine=99`,
      Buffer.alloc(0)
    );
    if (window.headers['x-start-line'] !== '1' || window.body.toString('utf8') !== 'alpha')
      problems.push(
        `a line window returned ${JSON.stringify(window.body.toString('utf8'))} rather than the first line that fits`
      );
    const whole = await shim.handle(
      'GET',
      `/v1/workspaces/${WORKSPACE}/file?path=${encodeURIComponent('workspace/round.txt')}`,
      Buffer.alloc(0)
    );
    if (!whole.headers['x-content-sha256'])
      problems.push(
        'the whole-file read carried no x-content-sha256, so no line-addressed edit could land'
      );

    /* ------------------------------------------------------------------ the listing sees a file */
    const listed = await shim.handle(
      'GET',
      `/v1/workspaces/${WORKSPACE}/files?path=workspace`,
      Buffer.alloc(0)
    );
    const entries = (
      JSON.parse(listed.body.toString('utf8')) as {
        entries: Array<{ path: string; sizeBytes: number }>;
      }
    ).entries;
    const row = entries.find((entry) => entry.path === 'workspace/round.txt');
    if (!row) problems.push('a file written through the shim does not appear in its own listing');
    else if (row.sizeBytes !== Buffer.byteLength(written, 'utf8'))
      problems.push(
        `the listing reported ${row.sizeBytes} bytes for a ${written.length}-byte file`
      );
  } finally {
    await backend.dispose();
  }

  /* --------------------------------------------------------------- the container argv, with no daemon */
  const argv = dockerExecArgv({
    container: 'tb-task',
    sudo: true,
    workspaceRoot: '/workspace',
    call: {
      executable: 'pytest',
      args: ['-q'],
      cwd: 'workspace/src',
      env: { CI: '1' },
      timeoutSeconds: 60,
      network: false,
      maxOutputBytes: 4_096
    }
  });
  if (argv.executable !== 'sudo' || argv.args[0] !== '-n' || argv.args[1] !== 'docker')
    problems.push(
      'the sudo form of docker exec is not `sudo -n docker`, which will prompt and hang'
    );
  if (!argv.args.includes('--workdir') || !argv.args.includes('/workspace/src'))
    problems.push('a relative cwd is not resolved against the box workspace root');
  if (argv.args.includes('-i'))
    problems.push('docker exec attached stdin for a call with no stdin, which hangs a reader');
  if (argv.args.at(-2) !== 'pytest' || argv.args.at(-1) !== '-q')
    problems.push('the command and its arguments are not last, so docker would read them as flags');

  /* ----------------------------------------------------------------- the aggregation discipline */
  const one = aggregate([0.4]);
  if (one.std !== null)
    problems.push(
      'a single run reported a standard deviation, which is the most flattering lie here'
    );
  const three = aggregate([0, 0.5, 1]);
  if (Math.abs(three.mean - 0.5) > 1e-9 || Math.abs((three.std ?? 0) - 0.5) > 1e-9)
    problems.push(`mean/std over [0, 0.5, 1] came back ${three.mean}/${String(three.std)}`);
  // Missing scores 0. Two of four tasks resolved, one verdict-less, one never mentioned at all.
  const partial: RunRecord = {
    startedAt: 'now',
    tasks: [
      {
        taskId: 'a',
        resolved: true,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        steps: null,
        wallSeconds: null,
        compactions: null,
        approvalCardsFired: null,
        infraFailure: false
      },
      {
        taskId: 'b',
        resolved: true,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        steps: null,
        wallSeconds: null,
        compactions: null,
        approvalCardsFired: null,
        infraFailure: false
      },
      {
        taskId: 'c',
        resolved: null,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        steps: null,
        wallSeconds: null,
        compactions: null,
        approvalCardsFired: null,
        infraFailure: true
      }
    ]
  };
  if (scoreOf(partial, 4) !== 0.5)
    problems.push(`a missing result did not score 0: 2 of 4 came back ${scoreOf(partial, 4)}`);

  /* ------------------------------------------------------------------------- the arm discipline */
  const fabricated = await threw(() =>
    rowFrom({ ...baseRow(), approvalsAutoAnswered: 3, arm: 'shipped' }, (value) => value)
  );
  if (fabricated === null)
    problems.push('a row with auto-answered approvals was emitted under an arm that declares none');
  const mislabelled = await threw(() =>
    rowFrom({ ...baseRow(), arm: 'unattended', securityMode: 'balanced' }, (value) => value)
  );
  if (mislabelled === null)
    problems.push('an "unattended" row was emitted for a run that was not autonomous');
  // And the other direction: an honest row must actually come out, or every refusal above is
  // satisfied by a function that refuses everything.
  const honest = await threw(() => rowFrom(baseRow(), (value) => value));
  if (honest !== null) problems.push(`an honest row was refused: ${honest}`);

  /* ------------------------------------------- the row against the header it will be printed under */
  /*
   * `rowFrom` returns a positional array and `COLUMNS` is a hand-kept list of names beside it.
   * Nothing joined the two until this check, and the refusals above are all satisfied by a
   * `rowFrom` that emits the wrong number in every cell.
   *
   * Measured on 2026-09-02, both breaks green before this existed: deleting `input.taskSetSha`
   * from the returned array shifted every later value one column left - `model` published under
   * `task_set_sha`, `score_mean` under `aggregator` - and `pnpm eval:bench` said "clean" and
   * exited 0. So did replacing `String(round(score.mean, 4))` with a hard-coded `0.99`. This is
   * the published number, so it is checked by NAME rather than by count: a length check alone
   * passes a row with two columns transposed, and the transposition that matters here is between
   * two columns of the same width.
   *
   * The sentinels are distinct strings so no cell can satisfy another cell's assertion, and
   * `score_mean` is derived rather than declared - 2 of a declared 4 - so a scorer that returns a
   * constant fails here as well as in the `scoreOf` check above.
   */
  const resolvedTask = (taskId: string): TaskResult => ({
    taskId,
    resolved: true,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    steps: null,
    wallSeconds: null,
    compactions: null,
    approvalCardsFired: null,
    infraFailure: false
  });
  const sentinel: RowInput = {
    ...baseRow(),
    benchmark: 'benchmark-sentinel',
    taskSet: 'task-set-sentinel',
    taskSetSha: 'task-set-sha-sentinel',
    model: 'model-sentinel',
    modelRoute: 'model-route-sentinel',
    provider: 'provider-sentinel',
    harnessVersion: 'harness-version-sentinel',
    harnessCommit: 'harness-commit-sentinel',
    arm: 'autonomous',
    securityMode: 'autonomous',
    nTasks: 4,
    taskMaxSteps: 111,
    selfContinuations: 222,
    catalogueBytes: 333,
    catalogueTokensPerCall: 444,
    backend: 'backend-sentinel',
    verifierEnv: 'same',
    networkMode: 'network-mode-sentinel',
    runs: [{ startedAt: 'started-at-sentinel', tasks: [resolvedTask('a'), resolvedTask('b')] }]
  };
  const sentinelRow = rowFrom(sentinel, () => 'digest-sentinel');
  if (sentinelRow.length !== COLUMNS.length)
    problems.push(
      `rowFrom emitted ${sentinelRow.length} cells under a ${COLUMNS.length}-column header, so every column past the first difference would be published under the wrong name`
    );
  const expected: ReadonlyArray<readonly [string, string]> = [
    ['benchmark', 'benchmark-sentinel'],
    ['task_set', 'task-set-sentinel'],
    ['n_tasks', '4'],
    ['task_set_sha', 'task-set-sha-sentinel'],
    ['model', 'model-sentinel'],
    ['model_route', 'model-route-sentinel'],
    ['provider', 'provider-sentinel'],
    ['harness', 'athanor'],
    ['harness_version', 'harness-version-sentinel'],
    ['harness_commit', 'harness-commit-sentinel'],
    ['arm', 'autonomous'],
    ['n_runs', '1'],
    ['aggregator', 'mean'],
    // 2 resolved of a DECLARED 4, so this cell also fails for a scorer that ignores `nTasks`.
    ['score_mean', '0.5'],
    ['score_std', ''],
    ['resolved_ids_sha', 'digest-sentinel'],
    ['catalogue_bytes', '333'],
    ['catalogue_tokens_per_call', '444'],
    ['approvals_auto_answered', '0'],
    ['security_mode', 'autonomous'],
    ['task_max_steps', '111'],
    ['self_continuations', '222'],
    ['max_compute_credits', ''],
    ['max_spend_usd', ''],
    ['surfaces_browser', 'absent'],
    ['surfaces_desktop', 'absent'],
    // Distinct from every other numeric sentinel, so a column shifted onto it is a wrong VALUE and
    // not a coincidence. It must not void the row: a declared absence answered as declared is the
    // shim working, which is what separates it from `shimMisses`.
    ['absent_route_requests', '7'],
    ['backend', 'backend-sentinel'],
    ['isolates_network', 'false'],
    ['verifier_env', 'same'],
    ['network_mode', 'network-mode-sentinel'],
    ['infra_failures_advisory', '0'],
    ['declared_drops', ''],
    ['run_started_at', 'started-at-sentinel'],
    ['athanor_commit', 'harness-commit-sentinel']
  ];
  if (expected.length === 0) problems.push('the column map is empty, so nothing below ran');
  for (const [column, value] of expected) {
    const index = COLUMNS.indexOf(column);
    if (index < 0) {
      problems.push(`the column map names "${column}", which is not in COLUMNS`);
      continue;
    }
    if (sentinelRow[index] !== value)
      problems.push(
        `column "${column}" carried ${JSON.stringify(sentinelRow[index])} rather than ${JSON.stringify(value)}, so a published row would say it under the wrong name`
      );
  }

  /* ------------------------------------- the seam this rig added to a file it does not own */
  // `evals/harness.ts` grew `observedRoutes` for this rig, and its comment there claims no
  // committed baseline row can move because of it. That claim is only true while `report.ts` -
  // which owns `check` and `baselineFrom` - never reads the field. Asserted rather than believed,
  // because a false comment is a defect ranked with a code defect here and the harness comment
  // points at this check by name.
  const reportSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'report.ts'),
    'utf8'
  );
  if (reportSource.includes('observedRoutes'))
    problems.push(
      'evals/report.ts now reads observedRoutes, so the harness comment claiming no committed row can move because of it is false'
    );

  /* ------------------------------------------------- the catalogue figure the artefact prints */
  // Measured through the production function on every run rather than typed into a column. The
  // ceiling this checks against is the one `apps/worker/src/tool-catalogue.test.ts:749` already
  // commits to for a bare box, so if the catalogue grows past it, this rig fails alongside that
  // test rather than quietly publishing a stale number in a CSV somebody will cite.
  const weights = catalogueWeights();
  if (weights.length === 0) problems.push('no catalogue weights were measured');
  const bare = benchmarkBoxCatalogueBytes();
  const provisioned = weights[0]?.bytes ?? 0;
  if (bare <= 0) problems.push('the benchmark box catalogue measured as zero bytes');
  if (bare >= provisioned)
    problems.push(
      `a box with no browser, no screen and no connections carries ${bare} bytes against a provisioned box's ${provisioned}, so nothing is being withdrawn`
    );
  // BYTES_PER_TOKEN is anchored on the fully provisioned catalogue weighing 55,673 bytes at
  // 12,508 tokens. `evals/baseline.json` commits to the token figure; nothing commits to 55,673
  // exactly - `tool-catalogue.test.ts:402` holds the default catalogue under 55,700, which it sits
  // 27 bytes inside, and the 44,000 assertion later in that file is over a bare box, not this one. If the catalogue moves, the anchor is stale and
  // every token figure this rig prints is quietly wrong - so the anchor is checked, not trusted.
  // The band is 2%, which is roughly one added tool description and well inside the 55,700
  // ceiling the catalogue test holds.
  // One constant, read into both the comparison and the message, so a message cannot say a
  // different number than the one that was checked.
  const anchorBytes = 55_673;
  if (Math.abs(provisioned - anchorBytes) / anchorBytes > 0.02)
    problems.push(
      `the fully provisioned catalogue now weighs ${provisioned} bytes against the ${anchorBytes} BYTES_PER_TOKEN is anchored on, so every token figure this rig prints is stale (ratio ${BYTES_PER_TOKEN.toFixed(3)})`
    );
  if (bare >= 44_000)
    problems.push(
      `the benchmark box catalogue is ${bare} bytes, past the 44,000 bare-box ceiling apps/worker/src/tool-catalogue.test.ts:749 commits to`
    );

  /* ------------------------------------------- the constant that restates another file's answer */
  // A false comment is a defect ranked with a code defect here, and `observe.ts`'s SWEEP_SURFACES
  // is a restatement of a line in a file this lane does not own. Re-read rather than trusted, so a
  // change to the harness's `/surfaces` answer fails this rig instead of silently making every
  // committed observation describe a box the sweep did not run on.
  const harnessSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'harness.ts'),
    'utf8'
  );
  const surfaceLine = /\/surfaces'\)\)\s*return json\(\{([^}]*)\}\)/.exec(harnessSource)?.[1] ?? '';
  if (surfaceLine.trim() === '')
    problems.push(
      'the /surfaces answer could not be found in evals/harness.ts, so SWEEP_SURFACES vouches for nothing'
    );
  else
    for (const [surface, presence] of Object.entries(SWEEP_SURFACES))
      if (!new RegExp(`${surface}:\\s*'${presence}'`).test(surfaceLine))
        problems.push(
          `observe.ts says the sweep runs with ${surface}: '${presence}' and evals/harness.ts answers ${surfaceLine.trim()}`
        );

  /* ------------------------------------------------------- the committed observation, if there is one */
  if (observation === null) problems.push('no committed route observation: run --observe');
  else if (observation.observed.length === 0)
    problems.push(
      'the committed route observation is empty, so its coverage check asserts nothing'
    );
  else {
    const coverage = coverageOf(observation);
    if (coverage.missing.length > 0)
      problems.push(
        `athanor asked for ${coverage.missing.length} route(s) this shim does not implement: ${coverage.missing.join(', ')}`
      );
    // The excuse has to be spendable only where it applies. A `gatedOut` list that grew to cover a
    // route the catalogue gate does not withdraw would be this rig excusing its own gaps, which is
    // the exact failure it exists to prevent - so the two sets are checked against each other.
    for (const route of coverage.gatedOut)
      if (Object.prototype.hasOwnProperty.call(ABSENT_ROUTES, route))
        problems.push(
          `${route} is both surface-gated and declared absent, which cannot both be true`
        );
  }

  /* ----------------------------- the join, driven by athanor's own client over a real socket */
  // Last, and it is the check the others cannot make: every request above was composed by this rig
  // and parsed by this rig. See wiring.ts for why that is not enough on its own.
  problems.push(...(await wiringChecks()));

  /* ------------------------------------------- a declared absence is a refusal the model can read */
  const absentBackend = await localBackend();
  try {
    await absentBackend.ensure();
    const shim = createShim({ backend: absentBackend });
    const routes = Object.keys(ABSENT_ROUTES);
    if (routes.length === 0) problems.push('ABSENT_ROUTES is empty, so nothing below ran');
    for (const route of routes) {
      const [method, pathname] = route.split(' ');
      const answer = await shim.handle(
        method ?? 'POST',
        (pathname ?? '').replace(':workspaceId', WORKSPACE),
        bodyOf({})
      );
      if (answer.status !== 503)
        problems.push(`${route} answered ${answer.status} rather than a named 503 absence`);
      if (!answer.body.toString('utf8').includes('capability_absent'))
        problems.push(`${route} did not name itself as an absent capability`);
    }
    if (shim.misses.length > 0)
      problems.push(`a declared absence was recorded as a miss: ${shim.misses.join(', ')}`);
    if (shim.absentRequests !== routes.length)
      problems.push(
        `${routes.length} absent routes were asked for and ${shim.absentRequests} were counted, so the artefact would understate them`
      );
  } finally {
    await absentBackend.dispose();
  }

  return problems;
};
