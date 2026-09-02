/**
 * The join, whole: a real `AgentWorker` runs a task to completion against this shim over a real
 * socket against a real directory, and the box decides whether it was solved.
 *
 * THIS FILE EXISTS BECAUSE EVERYTHING ELSE IN THIS DIRECTORY WAS PROVED IN ISOLATION. The shim
 * answered requests this rig composed. `wiring.ts` went one better and drove athanor's own
 * `AgentRunnerClient` over the socket, which is the wire - but no turn ran, no tool dispatched, no
 * approval floor was consulted and no score was ever produced. That is the computed-and-unwired
 * shape this programme has now shipped three times, and this is the line that was never written.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT, stated before any number below is read:
 *
 *   real - `AgentWorker.run`, the same object the worker process runs, built the way
 *          `evals/harness.ts` builds it, with `WORKSPACE_RUNNER_URL` pointed at this shim.
 *   real - the tool catalogue, the tool dispatch, the plan and acceptance holds, the approval
 *          floor, compaction, the runner protocol, the shim, the box, the files, the verifier.
 *   NOT  - the model. It is a script (`task.ts`), so no provider is called and nothing is billed.
 *
 * So a score of 1.0 below means the loop can carry a scripted solution end to end into a real
 * filesystem and have a command in that filesystem agree. It says NOTHING about athanor's ability
 * on a benchmark, and a reader who takes it for one has been misled by this file. That is why the
 * row goes to `parity-wire.csv` and never to `parity.csv`, why its `model` column names itself as
 * scripted, and why README.md's paid command is still the first number that would mean anything.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFixture, runIdentity } from '../harness.js';

import { localBackend, type ExecResult, type WorkspaceBackend } from './backend.js';
import { benchmarkBoxCatalogueBytes, BYTES_PER_TOKEN } from './catalogue.js';
import { writeFile } from './files.js';
import { renderCsv, rowFrom, type Arm, type RowInput, type TaskResult } from './parity.js';
import { createShim, type Shim } from './shim.js';
import { fixtureFor, TASKS, VERIFIER_PATH, type WireTask } from './task.js';

/**
 * What this environment does NOT do that athanor does, printed in the row rather than omitted.
 *
 * Restated from `shim.ts` and `backend.ts` because a row read a year from now will not have those
 * files open beside it. Each is a real difference between the box that produced the number and the
 * box athanor ships onto.
 */
export const LOCAL_DROPS: readonly string[] = [
  'no capability-token verification (the real runner verifies a signed token per request)',
  'no Landlock sandbox and no rlimits',
  'no per-call egress gating: a command shares this host network namespace',
  'no EXIF strip on /image',
  'background work is never stopped',
  'the verifier runs in the same box the agent could reach'
];

export interface ScoredTask {
  readonly task: WireTask;
  readonly result: TaskResult;
  /** What the box said when the verifier ran, for a reader asking why a task scored 0. */
  readonly verifierExit: number | null;
  readonly verifierStderr: string;
  readonly status: string;
  /**
   * What the turn said about its own evidence, from the completion event.
   *
   * Beside the verdict and never instead of it. `status` and this are athanor's account of itself;
   * `resolved` is the box's. A benchmark adapter that scored on either of these two would be
   * scoring the agent's own report - see this file's header, and the acceptance ceiling in
   * `apps/worker/src/turn-bounds.ts:360`, which ends a turn `completed` after four failed rounds of
   * the model's own checks.
   */
  readonly verification: string;
  /**
   * Commands the turn ran IN THE BOX, counted off the wire by the harness seam.
   *
   * The number that says the acceptance check was carried out rather than merely declared: the
   * scripted model makes two `shell` calls, so anything above two is the loop running a check of
   * its own against the real box through the real shim.
   */
  readonly commandsRun: number;
  /**
   * The tool catalogue the loop offered on this turn's last request, by name.
   *
   * Here so a live run can be asked whether the surface gate HELD, which is the one thing
   * `routes.ts` says outright it had never observed. Under this shim `/surfaces` answers
   * `absent, absent`, so the seven surface tools and `connector_action` must not be in this list -
   * and until a turn actually ran against the shim there was nothing to ask.
   */
  readonly catalogue: readonly string[];
  readonly holds: readonly string[];
  /** What the loop actually said back on each hold, in full. */
  readonly pushback: readonly string[];
  readonly error: string | null;
  /** Routes the run asked for that this shim does not implement. Non-empty voids the whole row. */
  readonly misses: readonly string[];
  readonly absentRequests: number;
  readonly observedRoutes: readonly string[];
}

export interface ScoreOptions {
  readonly tasks: readonly WireTask[];
  readonly arm: Arm;
  /**
   * Whether the caller has accepted that the local backend runs commands as this user with this
   * user's network and filesystem. Required for any task whose commands did not come from this
   * repository. @see `WireTask.origin` and `backend.ts`.
   */
  readonly trustLocal: boolean;
  readonly onTask?: (scored: ScoredTask) => void;
}

/**
 * The task's own verifier, run in the box.
 *
 * One function because it runs TWICE - once before the turn and once after - and a second copy of
 * the argv, the environment and the bounds would be a second place for the two runs to drift
 * apart. They must be the same command or the comparison between them says nothing.
 */
const runVerifier = async (backend: WorkspaceBackend, task: WireTask): Promise<ExecResult> =>
  await backend.exec({
    executable: task.verify.call.executable,
    args: task.verify.call.args,
    cwd: task.verify.call.cwd,
    // PATH explicitly, and nothing else: the box's own environment is not this rig's. @see task.ts.
    env: { PATH: VERIFIER_PATH, LC_ALL: 'C' },
    timeoutSeconds: 120,
    network: false,
    maxOutputBytes: 64 * 1024
  });

/**
 * One task, driven to completion.
 *
 * A fresh shim and a fresh temporary directory per task, for the reason a benchmark starts a fresh
 * container per task: a solution that only works because the previous task left a file behind is a
 * solution that scored on evidence nobody declared.
 */
export const scoreTask = async (task: WireTask, trustLocal: boolean): Promise<ScoredTask> => {
  if (task.origin !== 'builtin' && !trustLocal)
    throw new Error(
      `task "${task.id}" is an external task definition and the local backend is not a sandbox: its commands would run as this user with this user's network. Pass --trust-local to accept that, or run it on the docker backend.`
    );
  const backend: WorkspaceBackend = await localBackend();
  let shim: Shim | null = null;
  let stop: (() => Promise<void>) | null = null;
  const startedWall = Date.now();
  try {
    await backend.ensure();
    for (const [file, contents] of Object.entries(task.seed))
      await writeFile(backend, file, Buffer.from(contents, 'utf8'));

    /*
     * THE TASK MUST NOT ALREADY BE SOLVED, asked before the turn is allowed to start.
     *
     * A verifier run only at the END cannot tell work from a starting state that already satisfied
     * it. MEASURED 2026-09-02, before this guard existed: replace the solution script with `true`
     * and add the answer file to `seed`, and this driver printed `resolved`, wrote `score_mean 1`
     * to `parity-wire.csv` and exited 0 while the turn did nothing whatever - and `pnpm eval:bench`
     * said "clean" beside it. Nothing else here could have caught it, because `status`,
     * `verification`, `steps` and `commandsRun` all read EXACTLY as they do on the honest run: the
     * agent still ran its two commands and its acceptance check, and the check passed, because the
     * answer was already on disk.
     *
     * So the verifier runs twice and the first run has to FAIL. It is one exec on a task that
     * costs five model calls, and it is the guard this rig needs at the moment it grows the task
     * loader `WireTask` was shaped to accept: a leaked answer in somebody else's task set arrives
     * as a free point and is indistinguishable from a score. What would change it: nothing. A task
     * that starts solved is not a task.
     */
    const before = await runVerifier(backend, task);
    if (before.exitCode === 0)
      throw new Error(
        `task "${task.id}" passes its own verifier BEFORE the turn runs (${task.verify.label}), so solving it requires nothing of the agent and a score of 1 would belong to the seed. No run.`
      );

    shim = createShim({ backend });
    const server = await shim.listen();
    stop = server.close;

    const outcome = await runFixture(fixtureFor(task, server.url));

    /*
     * The verdict, taken from the box and from nowhere else.
     *
     * NOT from `outcome.status`, and the distinction is the whole of the discipline: a turn that
     * reports `completed` having written the wrong number is a turn that scored 0, and a rig that
     * read its own loop's satisfaction as a score would be a harness marking its own homework.
     * `status` travels beside the verdict as evidence, not as the verdict.
     *
     * The same command that was already run and already failed above, so a pass here is a
     * DIFFERENCE the turn made rather than a property the box arrived with.
     */
    const verified = await runVerifier(backend, task);
    const wallSeconds = (Date.now() - startedWall) / 1_000;

    return {
      task,
      result: {
        taskId: task.id,
        // `null` would mean the run produced no verdict at all, which is not what happened: the
        // verifier ran and answered. A failed verifier is `false`, and `scoreOf` divides by the
        // declared task count either way, so neither reading changes the denominator.
        resolved: verified.exitCode === 0,
        // No provider was called, so nothing was billed. Zero here is a fact about this run and
        // not a cost measurement; the `model` column names the run as scripted so the cell cannot
        // be read as "athanor solved this for nothing".
        costUsd: 0,
        // Real, and measured on the wire by `evals/harness.ts` rather than estimated: the whole
        // request body, catalogue included.
        inputTokens: outcome.promptTokens,
        outputTokens: outcome.outputTokens,
        steps: outcome.modelCalls,
        wallSeconds,
        compactions: outcome.compactions,
        approvalCardsFired: outcome.approvalsRaised,
        // An infrastructure failure is something that stopped the run from being about the agent.
        // A throw out of the loop is one; a wrong answer is not.
        infraFailure: outcome.error !== null
      },
      verifierExit: verified.exitCode,
      verifierStderr: verified.stderr.trim().slice(0, 400),
      status: outcome.status,
      verification: outcome.verification,
      commandsRun: outcome.commandsRun,
      catalogue: outcome.finalCatalogue,
      holds: outcome.holds,
      pushback: outcome.pushback,
      error: outcome.error,
      misses: shim.misses,
      absentRequests: shim.absentRequests,
      observedRoutes: outcome.observedRoutes
    };
  } finally {
    if (stop) await stop();
    await backend.dispose();
  }
};

export interface ScoreReport {
  readonly scored: readonly ScoredTask[];
  /** The row, or null when `rowFrom` refused it - see `refusal`. */
  readonly row: readonly string[] | null;
  readonly refusal: string | null;
  readonly csv: string;
}

export const scoreRun = async (options: ScoreOptions): Promise<ScoreReport> => {
  if (options.tasks.length === 0) throw new Error('a scored run needs at least one task');
  const identity = runIdentity();
  const startedAt = new Date().toISOString();
  const scored: ScoredTask[] = [];
  for (const task of options.tasks) {
    // Sequentially, like `evals/run.ts` and `observe.ts`, and for the same reason: `runFixture`
    // installs its own `globalThis.fetch` for the duration of a run. Two at once measure each other.
    const one = await scoreTask(task, options.trustLocal);
    scored.push(one);
    options.onTask?.(one);
  }

  const catalogueBytes = benchmarkBoxCatalogueBytes();
  const input: RowInput = {
    benchmark: 'athanor-wire',
    taskSet: scored.map((one) => one.task.id).join('+'),
    // The tasks themselves, hashed, so two rows claiming the same task set can be checked rather
    // than believed. Over the prompt, the seed and the verifier argv - everything that decides what
    // solving it means.
    taskSetSha: createHash('sha256')
      .update(
        JSON.stringify(
          scored.map((one) => [one.task.id, one.task.request, one.task.seed, one.task.verify.call])
        )
      )
      .digest('hex')
      .slice(0, 16),
    nTasks: options.tasks.length,
    // Named for what it is in every row it appears in. No provider was reached; see this file's
    // header for what that does and does not invalidate.
    model: 'scripted-no-provider',
    modelRoute: 'none',
    provider: 'none',
    harness: 'athanor',
    harnessVersion: identity.version,
    harnessCommit: identity.commit ?? 'uncommitted',
    arm: options.arm,
    // `evals/harness.ts`'s `taskFor` mints the task `balanced`, which is the mode the owner
    // installs, so `shipped` is the only arm this driver can currently produce. The other two need
    // that field to be settable and the `unattended` one needs an auto-approver as well; both are
    // in README.md's paid ladder, and a row that named an arm it did not run under is exactly what
    // `rowFrom` refuses.
    securityMode: 'balanced',
    approvalsAutoAnswered: 0,
    taskMaxSteps: Math.max(...options.tasks.map((task) => task.maxSteps)),
    // `evals/harness.ts` pins `TASK_MAX_SELF_CONTINUATIONS: 0`, so every step count here is the
    // cost of one budget rather than of two.
    selfContinuations: 0,
    maxComputeCredits: Math.max(...options.tasks.map((task) => task.maxCredits)),
    maxSpendUsd: null,
    catalogueBytes,
    catalogueTokensPerCall: Math.round(catalogueBytes / BYTES_PER_TOKEN),
    surfaces: { browser: 'absent', desktop: 'absent' },
    backend: 'local',
    // False, and it cannot be otherwise on this backend. See `WorkspaceBackend.isolatesNetwork`.
    isolatesNetwork: false,
    verifierEnv: 'same',
    networkMode: 'host',
    declaredDrops: LOCAL_DROPS,
    // The gate. Any route the run asked for that this shim does not implement voids the row, and
    // the misses are unioned across every task because one bad task is one bad environment.
    shimMisses: [...new Set(scored.flatMap((one) => one.misses))],
    absentRequests: scored.reduce((total, one) => total + one.absentRequests, 0),
    runs: [{ startedAt, tasks: scored.map((one) => one.result) }]
  };

  let row: string[] | null = null;
  let refusal: string | null = null;
  try {
    row = rowFrom(input, (value) => createHash('sha256').update(value).digest('hex').slice(0, 16));
  } catch (cause) {
    refusal = cause instanceof Error ? cause.message : String(cause);
  }
  return { scored, row, refusal, csv: renderCsv(row === null ? [] : [row]) };
};

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * A separate artefact from `parity.csv`, and the separation is the point.
 *
 * `parity.csv` is the benchmark artefact and it is committed with zero rows, because there is no
 * athanor benchmark score in this repository. A row produced by a scripted model against a local
 * shim is not one, and putting it in that file would put a `score_mean` of 1.0 in the artefact a
 * reader goes to for athanor's number. Same columns, same `rowFrom`, same refusals; different file,
 * and every row in it says `scripted-no-provider` in its model column.
 */
export const WIRE_CSV = path.join(here, 'parity-wire.csv');

/** `--score`. Writes the wire artefact and returns the process exit code. */
export const runScore = async (options: {
  readonly arm: Arm;
  readonly trustLocal: boolean;
  readonly filter?: string | undefined;
  readonly out: (line: string) => void;
}): Promise<number> => {
  const tasks = options.filter
    ? TASKS.filter((task) => task.id.includes(options.filter ?? ''))
    : TASKS;
  if (tasks.length === 0) {
    options.out(`No wire task matches "${options.filter ?? ''}".`);
    return 2;
  }
  options.out(
    `Driving ${tasks.length} task(s) through a real AgentWorker against the shim. Scripted model, no provider, no key, no cost.`
  );
  const report = await scoreRun({
    tasks,
    arm: options.arm,
    trustLocal: options.trustLocal,
    onTask: (one) => {
      options.out(
        `  ${one.result.resolved === true ? 'resolved' : 'UNRESOLVED'}  ${one.task.id}  status=${one.status}/${one.verification} steps=${String(one.result.steps)} commands=${String(one.commandsRun)} cards=${String(one.result.approvalCardsFired)} verifier=exit ${String(one.verifierExit)}${one.error === null ? '' : ` error=${one.error}`}`
      );
      if (one.holds.length) options.out(`      holds: ${one.holds.join(', ')}`);
      // Only when the task did not resolve. A hold on a task that still passed is the loop working,
      // and printing four paragraphs of it every run trains a reader to skim the one that matters.
      if (one.result.resolved !== true)
        for (const said of one.pushback)
          options.out(`      >> ${said.replace(/\n/g, ' | ').slice(0, 300)}`);
      options.out(`      routes: ${one.observedRoutes.join(', ')}`);
      if (one.misses.length) options.out(`      MISSES: ${one.misses.join(', ')}`);
    }
  });
  writeFileSync(WIRE_CSV, report.csv);
  options.out('');
  if (report.refusal !== null) {
    options.out(`No row: ${report.refusal}`);
    return 1;
  }
  options.out(`One row, earned, written to ${WIRE_CSV}.`);
  options.out(
    '  It is a wire proof and not a benchmark score: the model is a script. See README.md section 5 for the command that produces a number about athanor.'
  );
  return report.scored.every((one) => one.result.resolved === true) ? 0 : 1;
};
