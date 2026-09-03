/**
 * The paid path: a borrowed task set, a real model, one container per task, one row.
 *
 * Everything here is assembly. The pieces it joins each refuse on their own terms and none of those
 * refusals are softened: `terminal-bench.ts` refuses a task it cannot read whole, `provider.ts`
 * refuses to start without a key and stops on its own ceilings, `score.ts` refuses a task that
 * passes its verifier before the turn, and `parity.ts` refuses a row that would name a
 * configuration it was not measured under. A run that ends with no row has still told the truth.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderCsv } from './parity.js';
import { scoreRun, type ScoredTask } from './score.js';
import { loadTerminalBenchSuite, terminalBenchTaskIds } from './terminal-bench.js';
import { imagesPresent, scoreTerminalBenchTask } from './terminal-run.js';
import { providerCredential, providerModelIdOf } from './provider.js';
import type { LiveProvider } from '../harness.js';

/**
 * What the account has actually been billed, asked of the provider.
 *
 * Not a price table and not a sum of usage frames: the provider's own figure for this key, read
 * before and after. A row's cost column is the one number a reader can check against a bill, so it
 * comes from the thing that produces the bill. It lags a second or two behind a call, which is why
 * it is read once per task rather than once per step.
 */
const accountSpend = async (apiKey: string): Promise<number> => {
  const response = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { authorization: `Bearer ${apiKey}` }
  });
  if (!response.ok) throw new Error(`the provider would not report this key: ${response.status}`);
  const body = (await response.json()) as { data?: { usage?: number } };
  return typeof body.data?.usage === 'number' ? body.data.usage : 0;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const csvPath = path.join(here, 'parity.csv');

export interface TerminalBenchOptions {
  readonly root: string;
  readonly model: string;
  readonly maxSpendUsd: number;
  readonly maxCallsPerTask: number;
  readonly ids?: readonly string[] | undefined;
  readonly sudo: boolean;
  readonly arm: string;
  readonly out: (line: string) => void;
}

export const runTerminalBench = async (options: TerminalBenchOptions): Promise<number> => {
  const { out } = options;
  if (options.arm !== 'shipped') {
    out(
      `--arm ${options.arm} needs a settable security mode and, for "unattended", an auto-approver. This driver runs "shipped" only.`
    );
    return 2;
  }

  const ids = options.ids?.length ? options.ids : terminalBenchTaskIds(options.root);
  const tasks = loadTerminalBenchSuite(options.root, ids);
  out(`Loaded ${tasks.length} task(s) from ${options.root}.`);

  /*
   * A missing image is a REFUSAL, never a zero. A task whose container could not start did not
   * fail; it did not run, and averaging it in as 0 would report the agent's competence as lower
   * than anything measured it to be.
   */
  const images = await imagesPresent(tasks, options.sudo);
  if (images.missing.length) {
    out(`No image built for ${images.missing.length} task(s): ${images.missing.join(', ')}`);
    out('Build them first. A task with no container is not a task that scored 0.');
    return 2;
  }

  const credential = providerCredential();
  if (!credential) {
    out('No provider key. This path bills a real account, so it does not start without one.');
    return 2;
  }
  const live: LiveProvider = {
    baseUrl: credential.baseUrl,
    apiKey: credential.apiKey,
    provider: credential.provider,
    providerModelId: providerModelIdOf(options.model),
    contextTokens: 1_000_000
  };
  const openedAt = await accountSpend(credential.apiKey);
  out(
    `Model ${options.model} via ${live.providerModelId} at ${live.baseUrl}. Ceiling $${options.maxSpendUsd.toFixed(2)}; this key has spent $${openedAt.toFixed(4)} so far.`
  );

  let report;
  {
    let spentBefore = openedAt;
    report = await scoreRun({
      tasks,
      arm: 'shipped',
      trustLocal: false,
      runTask: async (task) => {
        const found = tasks.find((one) => one.id === task.id) ?? tasks[0]!;
        const scored = await scoreTerminalBenchTask(
          found,
          { sudo: options.sudo, lifetimeSeconds: (found.maxAgentTimeoutSeconds ?? 900) + 600 },
          live
        );
        const now = await accountSpend(credential.apiKey);
        const mine = now - spentBefore;
        spentBefore = now;
        /*
         * The ceiling, checked BETWEEN tasks and never inside one. A turn already under way is not
         * interrupted: a half-run task scores 0 and would be counted as a failure the agent caused,
         * so the bound is "start no task that would go past it" - the only place it can be enforced
         * without corrupting the number it exists to protect.
         */
        if (now - openedAt >= options.maxSpendUsd)
          throw new Error(
            `the $${options.maxSpendUsd.toFixed(2)} ceiling is reached ($${(now - openedAt).toFixed(4)} spent). No further task is started.`
          );
        return { ...scored, result: { ...scored.result, costUsd: mine } } as ScoredTask;
      },
      identity: {
        benchmark: 'terminal-bench',
        model: options.model,
        modelRoute: providerModelIdOf(options.model),
        provider: 'openrouter'
      },
      onTask: (one) => {
        out(
          `  ${one.result.resolved === true ? 'RESOLVED  ' : 'unresolved'}  ${one.task.id}  status=${one.status}/${one.verification} steps=${String(one.result.steps)} cards=${String(one.result.approvalCardsFired)} verifier=exit ${String(one.verifierExit)} $${(one.result.costUsd ?? 0).toFixed(4)}${one.error === null ? '' : ` error=${one.error}`}`
        );
      }
    });
  }

  const closedAt = await accountSpend(credential.apiKey);
  out('');
  out(`The provider billed $${(closedAt - openedAt).toFixed(4)} for this run, by its own account.`);

  if (report.row === null) {
    out('');
    out(`No row: ${report.refusal ?? 'refused'}`);
    return 1;
  }
  writeFileSync(csvPath, renderCsv([report.row]));
  const resolved = report.scored.filter((one) => one.result.resolved === true).length;
  out('');
  out(
    `Score ${(resolved / report.scored.length).toFixed(3)} - ${String(resolved)} of ${String(report.scored.length)} resolved. Row written to ${csvPath}.`
  );
  out(
    `  task set sha ${createHash('sha256')
      .update(tasks.map((t) => t.id).join('+'))
      .digest('hex')
      .slice(0, 16)}`
  );
  return 0;
};
