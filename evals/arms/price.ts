/**
 * What the live half costs, in the only unit an owner can act on.
 *
 * ── Why this file exists at all ────────────────────────────────────────────────────────────────
 *
 * The edit table used to end with a sentence saying that this rig does not know the price of a
 * model and that inventing one would be the only figure on the page that was not measured. That
 * was correct about invention and wrong about the conclusion. An estimate an owner cannot convert
 * into money is an estimate an owner cannot act on, so the decision gets taken on somebody's
 * recollection of what a run costs - which is invention with an extra step and no audit trail.
 *
 * So the price is not invented here. It is READ FROM THE PROVIDER, out of the same catalogue the
 * run will be billed against, at the moment the run is being considered. A rate table checked into
 * this repository would be a number that was true on the day it was written and silently wrong
 * afterwards, and it would be wrong in the direction that makes a run look cheap, because prices
 * mostly fall and nobody re-reads a constant that never fails.
 *
 * When the provider cannot be asked, this prints the token figures and says plainly that there is
 * no price - never a fallback rate. `scripts/check-repository.mjs` established the shape: skip
 * loudly, and fail where a skip means the job did not do what it says it does.
 *
 * ── Why the token estimate is arithmetic and not a guess ───────────────────────────────────────
 *
 * Everything the floor of a run costs is already measured somewhere in this rig: the resident
 * block per arm is exact bytes, the request is exact bytes, the file the model reads is exact
 * bytes in both dialects, and the edit call itself is exact characters through both encoders. A
 * correct turn here is read, edit, finish - so the whole conversation of a perfect row can be
 * added up rather than estimated, and the only approximation left is four characters to the token,
 * which is the conversion `evals/harness.ts` bills a request at and every other number in this
 * repository uses.
 *
 * That produces a FLOOR and a CEILING, and both are printed. The floor is every row perfect; the
 * ceiling is every row walking into the step limit with the output cap bound on every call. The
 * true number is between them and closer to the floor, and saying so is more use than a single
 * figure with a confident decimal point.
 */
import { MAX_OUTPUT_TOKENS, MAX_STEPS } from './live.js';
import type { Resident } from './measure.js';
import {
  EDIT_TASKS,
  MIN_CALLS_PER_EDIT,
  characterBound,
  encodeCandidate,
  encodeIncumbent,
  readSurcharge
} from './edit-arm.js';
import { TASKS as CORPUS, fileText, type EditTask } from '../edit/corpus.js';
import { renderNumbered, toLines } from '../../apps/worker/src/edit/format.js';
import { providerModelIdOf } from '../bench/provider.js';
import { settingsFor } from './arms.js';

/** Four characters to the token, the same conversion `measure.ts` and `evals/harness.ts` use. */
const tokensOf = (characters: number): number => Math.ceil(characters / 4);

export interface Estimate {
  readonly armId: string;
  /** Round trips: a perfect row, and the step ceiling. */
  readonly callsFloor: number;
  readonly callsCeiling: number;
  readonly promptTokensFloor: number;
  readonly promptTokensCeiling: number;
  readonly outputTokensFloor: number;
  readonly outputTokensCeiling: number;
}

/**
 * One perfect row of this sample, added up.
 *
 * The conversation of a correct turn is known exactly: the resident block and the request, then
 * the read the model asks for and the file it gets back, then the edit and its receipt. Each of
 * those is carried into every LATER request, which is the part an owner underestimates and the
 * part that makes a numbered read cost more than the character surcharge suggests - the file is
 * re-sent on every subsequent call of the turn, so a read-side surcharge is paid once per
 * remaining call rather than once.
 */
const perfectRow = (
  residentTokens: number,
  task: (typeof EDIT_TASKS)[number],
  dialect: 'patch' | 'lines'
): { prompt: number; output: number } => {
  const corpus = CORPUS.find((one) => one.id === task.corpusId) as EditTask;
  const body = fileText(corpus.path);
  const shown = dialect === 'lines' ? renderNumbered(toLines(body), 1) : body;
  const encoded =
    dialect === 'lines' ? encodeCandidate(corpus) : encodeIncumbent(corpus, fileText(corpus.path));
  const readCall = tokensOf(JSON.stringify({ path: corpus.path }).length);
  const editCall = tokensOf(JSON.stringify(encoded.args).length);
  const finishCall = tokensOf(2);

  const first = residentTokens + tokensOf(task.request.length);
  const second = first + readCall + tokensOf(shown.length);
  const third = second + editCall + tokensOf(60);
  return { prompt: first + second + third, output: readCall + editCall + finishCall };
};

/**
 * What one arm costs over the whole sample, on ONE tier, floor and ceiling.
 *
 * Per tier rather than across them, because the two tiers are priced differently and a combined
 * token total would have to be multiplied by a rate that belongs to neither of them. The whole
 * point of the weak tier is that it is cheap; folding it into the strong one's bill hides that.
 *
 * The ceiling holds the prompt at the floor's last request repeated for every remaining step,
 * which understates a runaway row slightly and is stated rather than hidden: a row that spends
 * twelve calls is a row that has gone wrong, and the interesting question about it is that it went
 * wrong rather than the third decimal place of what it cost.
 */
export const estimateArm = (
  resident: Resident,
  seeds: number,
  tasks: readonly (typeof EDIT_TASKS)[number][] = EDIT_TASKS
): Estimate => {
  const dialect = settingsFor(resident.armId).edit;
  let promptFloor = 0;
  let outputFloor = 0;
  let promptCeiling = 0;
  for (const task of tasks) {
    const row = perfectRow(resident.residentTokens, task, dialect);
    promptFloor += row.prompt;
    outputFloor += row.output;
    const last = row.prompt / MIN_CALLS_PER_EDIT;
    promptCeiling += row.prompt + last * (MAX_STEPS - MIN_CALLS_PER_EDIT);
  }
  const runs = seeds;
  return {
    armId: resident.armId,
    callsFloor: tasks.length * MIN_CALLS_PER_EDIT * runs,
    callsCeiling: tasks.length * MAX_STEPS * runs,
    promptTokensFloor: Math.round(promptFloor * runs),
    promptTokensCeiling: Math.round(promptCeiling * runs),
    outputTokensFloor: Math.round(outputFloor * runs),
    outputTokensCeiling: tasks.length * MAX_STEPS * MAX_OUTPUT_TOKENS * runs
  };
};

/* ------------------------------------------------------------------------------ the break-even */

/**
 * The number the offline lanes could not close, computed rather than deferred.
 *
 * Every previous report on this format has ended with the same open question in a different
 * spelling: the saving is in OUTPUT and the price is in INPUT, they are different currencies, and
 * nobody had a rate to convert them at. The rate is a phone call away - the provider publishes it
 * - so the conversion is arithmetic, and the only reason it stayed open is that no rig had asked.
 *
 * The line dialect costs input twice over. The spec is resident, so it is paid on every request of
 * every turn including the turns that never touch a file, and numbering is paid on every request
 * after a read for as long as that file stays in the window. It buys output, once, per landed
 * edit. So the break-even is not a number of lines - it is a number of EDITS PER TURN, and it
 * moves with how big an edit is and with the ratio between what a provider charges for the two.
 *
 * All three inputs are measured on this sample: the resident delta is exact bytes from `wire.ts`,
 * the output saving per edit is the character bound through both encoders, and the numbering is
 * the read surcharge over the same files. The only assumption is how many requests a turn makes,
 * which is stated rather than buried.
 */
export interface BreakEven {
  readonly residentDeltaTokens: number;
  readonly savedOutputTokensPerEdit: number;
  readonly numberingTokensPerRead: number;
  readonly callsPerTurn: number;
  /**
   * Landed edits a turn must make before the line dialect is the cheaper of the two.
   *
   * `Infinity` where the output saving cannot repay the resident spec at any number of edits,
   * which happens whenever a provider charges less than about ten times as much for output as for
   * input - which is most of them.
   */
  readonly editsPerTurn: number;
}

export const breakEven = (
  residentLine: Resident,
  residentQuoted: Resident,
  rate: Rate,
  callsPerTurn = MIN_CALLS_PER_EDIT
): BreakEven => {
  const bound = characterBound();
  const saved =
    bound.reduce((sum, row) => sum + tokensOf(row.quoted) - tokensOf(row.lineAddressed), 0) /
    bound.length;
  const read = readSurcharge();
  const files = new Set(EDIT_TASKS.map((task) => task.path)).size;
  const numbering = (tokensOf(read.numbered) - tokensOf(read.plain)) / files;
  const delta = residentLine.residentTokens - residentQuoted.residentTokens;
  const extraInput = delta * callsPerTurn + numbering * (callsPerTurn - 1);
  const savedOutput = saved * rate.outPerMillion;
  const paidInput = extraInput * rate.inPerMillion;
  return {
    residentDeltaTokens: delta,
    savedOutputTokensPerEdit: Math.round(saved * 10) / 10,
    numberingTokensPerRead: Math.round(numbering * 10) / 10,
    callsPerTurn,
    editsPerTurn: savedOutput <= 0 ? Number.POSITIVE_INFINITY : paidInput / savedOutput
  };
};

/* --------------------------------------------------------------------------- the provider's own */

export interface Rate {
  readonly model: string;
  /** US dollars per million tokens, as the provider publishes them. */
  readonly inPerMillion: number;
  readonly outPerMillion: number;
}

export interface Rates {
  readonly rates: readonly Rate[];
  /** Empty when every tier was priced. Printed rather than swallowed. */
  readonly missing: readonly string[];
  /** Where the numbers came from, or why there are none. */
  readonly note: string;
}

const CATALOGUE_URL = 'https://openrouter.ai/api/v1/models';
const RATE_TIMEOUT_MS = 8_000;

interface ModelRow {
  readonly id?: string;
  readonly pricing?: { readonly prompt?: string; readonly completion?: string };
}

/**
 * The rate card, from the provider, for exactly the models this run would spend on.
 *
 * No key is required to read it and none is sent: this is a public catalogue, and asking for a
 * price with a credential attached would put an account identifier on a request that does not need
 * one. A failure returns no rates and says why - never a stale constant, because a wrong price
 * that looks like a measurement is worse than no price at all.
 */
export const ratesFor = async (
  models: readonly string[],
  fetchImpl: typeof fetch = fetch
): Promise<Rates> => {
  let body: { data?: ModelRow[] };
  try {
    // Bounded, because this runs on the free half of a rig somebody may be running on a train.
    // A price that takes longer to fetch than the table takes to read is a price nobody waits for,
    // and the failure path here is already honest: no rate, and the reason printed.
    const response = await fetchImpl(CATALOGUE_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(RATE_TIMEOUT_MS)
    });
    if (!response.ok)
      return {
        rates: [],
        missing: [...models],
        note: `the provider's model catalogue answered ${response.status}, so this run has no price. Nothing here falls back to a rate somebody wrote down: a stale price that looks measured is worse than none.`
      };
    body = (await response.json()) as { data?: ModelRow[] };
  } catch (error) {
    return {
      rates: [],
      missing: [...models],
      note: `the provider's model catalogue could not be reached (${error instanceof Error ? error.message : String(error)}), so this run has no price. No rate is assumed in its place.`
    };
  }
  const byId = new Map(
    (body.data ?? []).filter((row) => row.id).map((row) => [row.id as string, row])
  );
  const rates: Rate[] = [];
  const missing: string[] = [];
  for (const model of models) {
    // A tier is named by its release id, `openrouter/<slug>`, and the catalogue lists it under the
    // slug alone - the same cut the request itself is sent with. The row keeps the release id.
    const found = byId.get(providerModelIdOf(model));
    const prompt = Number(found?.pricing?.prompt);
    const completion = Number(found?.pricing?.completion);
    if (!found || !Number.isFinite(prompt) || !Number.isFinite(completion)) {
      missing.push(model);
      continue;
    }
    rates.push({
      model,
      // Rounded to the millionth of a dollar per million tokens. Providers publish a per-token
      // price as a decimal string, and multiplying it by a million in binary floating point turns
      // $0.40 into $0.39999999999999997 - which then prints in a table as a rate nobody charges
      // and makes every figure beside it look computed rather than read.
      inPerMillion: Math.round(prompt * 1_000_000 * 1e6) / 1e6,
      outPerMillion: Math.round(completion * 1_000_000 * 1e6) / 1e6
    });
  }
  return {
    rates,
    missing,
    note: missing.length
      ? `priced ${rates.length} of ${models.length} tiers from ${CATALOGUE_URL}; ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in that catalogue under that id, so no price is shown for ${missing.length === 1 ? 'it' : 'them'}.`
      : `rates read from ${CATALOGUE_URL} at ${new Date().toISOString().slice(0, 16)}Z, which is the catalogue this run is billed against.`
  };
};

/**
 * Dollars, given tokens and a rate, unrounded.
 *
 * Rounding belongs at the point of printing and nowhere earlier. This rig compares two arms whose
 * difference over a twelve-task sample is a fraction of a cent, and a cost function that rounded
 * to the cent would report that difference as zero - which is the one figure the whole table was
 * built to produce.
 */
export const cost = (promptTokens: number, outputTokens: number, rate: Rate): number =>
  (promptTokens * rate.inPerMillion + outputTokens * rate.outPerMillion) / 1_000_000;

/** The same, at the cent a bill will actually show. For printing a total, never for comparing two. */
export const dollars = (promptTokens: number, outputTokens: number, rate: Rate): number =>
  Math.round(cost(promptTokens, outputTokens, rate) * 100) / 100;
