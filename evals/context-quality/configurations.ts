/**
 * The context configurations under comparison, and how a configuration is made to exist.
 *
 * The three constants this wave is arguing about - `RECENT_DETAIL_MESSAGES`,
 * `RECENT_TOOL_OUTPUT_MESSAGES` and `CACHE_CHECKPOINT_STRIDE` - are module-private integer
 * literals in `apps/worker/src/context.ts`. There is no option to pass and no export to override,
 * which is correct for shipped code and leaves a measurement rig with one honest choice: run the
 * real module with one integer changed.
 *
 * So a variant is the production source, verbatim, written to a scratch directory with the named
 * literals substituted and its two bare specifiers rewritten to absolute paths. Nothing is
 * reimplemented, which matters more here than anywhere: a hand-rolled copy of the squeeze would
 * measure the copy, and the copy is what a reader would then have to be persuaded is faithful.
 * `apps/worker/src/context.test.ts` reached the same conclusion for its own sweep and did it with
 * a Node loader hook; this is that technique with the patch written down instead of installed.
 *
 * The substitution asserts it matched exactly once. A rename upstream would otherwise turn every
 * variant into a silent copy of the shipped configuration, and every row in the report would agree
 * with every other row - which reads like a finding and is a broken harness.
 *
 * `configuration-fidelity` exists for the same reason from the other side: it names the shipped
 * values explicitly, so it goes through the whole patch path and must come out identical to
 * `shipped`, which imports the module directly. If those two ever disagree the rig is wrong and
 * every other number in the report is worthless.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as shippedContext from '../../apps/worker/src/context.js';

export type ContextModule = typeof shippedContext;

export interface ContextConfiguration {
  readonly id: string;
  readonly label: string;
  readonly why: string;
  /** Integer literals substituted into a copy of `context.ts`. Empty means the shipped module. */
  readonly constants: Readonly<Record<string, number>>;
}

/** Named separately so the report can say which row is the one the tree currently ships. */
export const SHIPPED = 'shipped';

/**
 * The row that goes through the whole patch path to land on the shipped numbers. Named here rather
 * than spelled out at each use: it is the one configuration that is ALLOWED to be a copy of
 * `shipped`, so every check that exempts it has to be exempting the same string.
 */
export const FIDELITY = 'configuration-fidelity';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '../..');
const contextSource = path.join(repositoryRoot, 'apps/worker/src/context.ts');

/**
 * The value a constant currently holds in the shipped source.
 *
 * Read rather than written down, because `configuration-fidelity` has to stay equal to `shipped`
 * across the very change this rig exists to argue about. Hard-coding 8 here would turn the day
 * step 3.1 lands `RECENT_DETAIL_MESSAGES = 2` into a fidelity failure that says the loader is
 * broken when what actually happened is that the tree moved.
 */
export const shippedConstant = (name: string): number => {
  const match = new RegExp(`const ${name} = (\\d[\\d_]*);`).exec(
    readFileSync(contextSource, 'utf8')
  );
  if (!match?.[1]) throw new Error(`context.ts no longer declares \`const ${name} = <integer>;\``);
  return Number(match[1].replaceAll('_', ''));
};

export const CONFIGURATIONS: readonly ContextConfiguration[] = [
  {
    id: SHIPPED,
    label: 'shipped',
    why: 'The tree as it stands. Every other row is this row with one integer changed.',
    constants: {}
  },
  {
    id: FIDELITY,
    label: 'shipped, via the patch path',
    why: 'The shipped values written back explicitly. Must equal `shipped` or the rig is lying.',
    constants: {
      RECENT_DETAIL_MESSAGES: shippedConstant('RECENT_DETAIL_MESSAGES'),
      RECENT_TOOL_OUTPUT_MESSAGES: shippedConstant('RECENT_TOOL_OUTPUT_MESSAGES')
    }
  },
  {
    id: 'detail-2',
    label: 'RECENT_DETAIL_MESSAGES 8 -> 2',
    why: "Step 3.1's candidate (a). Wave 0 priced it at cache-read 75.8 -> 86.4% on the large window.",
    constants: { RECENT_DETAIL_MESSAGES: 2 }
  },
  {
    id: 'tool-2',
    label: 'RECENT_TOOL_OUTPUT_MESSAGES 8 -> 2',
    why: "Step 3.1's candidate (b), and the plan's original headline. Wave 0 priced it at +0.1 points.",
    constants: { RECENT_TOOL_OUTPUT_MESSAGES: 2 }
  },
  {
    id: 'detail-4',
    label: 'RECENT_DETAIL_MESSAGES 8 -> 4',
    why: 'The middle this comparison exists to find: half the reasoning window rather than a quarter.',
    constants: { RECENT_DETAIL_MESSAGES: 4 }
  },
  {
    /**
     * The derived floor, not a guess.
     *
     * At request time the newest assistant message sits three from the tail on an ordinary step
     * (assistant, tool, runtime block) and four on a step where the plan version changed, and
     * `#noteStepBudget` can push one more twice a turn. The boundary is `index < length - N`, so
     * the assistant turn from k steps ago survives only while `N >= 3 + 2k` - four rather than
     * three on a plan step, five once the budget notice has landed.
     *
     * At N = 4 the current turn's own thinking is in the request on an ordinary step and on a plan
     * step, and out of it on a step carrying the budget notice. N = 5 is the tightest window that
     * carries it on every step of every turn, which is what this row is. At N = 2, measured rather
     * than reasoned about, it is absent on all sixty steps of all three trajectories.
     */
    id: 'detail-5',
    label: 'RECENT_DETAIL_MESSAGES 8 -> 5',
    why: "The tightest reasoning window that still carries the current turn's own thinking on every step.",
    constants: { RECENT_DETAIL_MESSAGES: 5 }
  },
  {
    id: 'detail-6',
    label: 'RECENT_DETAIL_MESSAGES 8 -> 6',
    why: 'One step of history above the floor, which is what a decision made on the previous step needs.',
    constants: { RECENT_DETAIL_MESSAGES: 6 }
  },
  {
    id: 'both-2',
    label: 'both windows 8 -> 2',
    why: 'Landing (a) and (b) together, which is what a wave that takes both recommendations ships.',
    constants: { RECENT_DETAIL_MESSAGES: 2, RECENT_TOOL_OUTPUT_MESSAGES: 2 }
  },
  {
    /**
     * The noise control, and the incident that moved it.
     *
     * A control has to be a configuration the tree does NOT ship. This row was `stride-4` while the
     * tree shipped stride 8; step 3.1 then landed stride 4, and the control silently became a copy
     * of `shipped` - byte-identical on all 27 rows, reporting a reassuring `+0.00` that was an
     * identity rather than a measurement. Wave 3's gate caught it (WAVE-3-GATE.md section 7, Q-1).
     * It now names 8, the value the tree shipped until 3.1, so the arm is a genuinely different
     * configuration again and its quality delta is once more a statement about noise in the rig.
     *
     * `degenerateConfigurations` below is the part that means this cannot happen a third time
     * quietly: the next time the tree moves onto a control's value, the run says so and fails.
     */
    id: 'stride-8',
    label: 'CACHE_CHECKPOINT_STRIDE 4 -> 8',
    why: 'The stride the tree shipped before step 3.1 halved it. Content-neutral, so this row is the control: any quality movement here is noise in the rig.',
    constants: { CACHE_CHECKPOINT_STRIDE: 8 }
  },
  {
    /**
     * The witness that the probes discriminate at all, and the answer to "a probe that always
     * returns 5.00 is measuring nothing".
     *
     * Every other row narrows one window by a step or two, which is the range worth arguing about
     * and is also a range in which the artifact probe does not move at all: it reads 3.00 in every
     * compacted configuration and 5.00 in every uncompacted one, so on the axis this rig exists to
     * measure that column was a constant. A constant column is indistinguishable from a probe that
     * has stopped reading the window, and a rig one wave old should not be trusted on the strength
     * of a number nothing has ever been able to move.
     *
     * This row is deliberately outside the arguable range and nobody should ever ship it. It takes
     * every character bound the window has down to a value that keeps a marker and little else, so
     * each probe kind can be shown to fall when its material is genuinely gone. `rigFailures` in
     * run.ts is the assertion that uses it: if a probe kind stops moving even here, that column is
     * furniture and the run says so.
     *
     * The four constants are the four mechanisms that can take a written path away, and which one
     * does the work is the finding this row produced. A path is written into the head of the tool
     * result (`{"ok":true,"path":...`) AND into the head of the `file_write` call's arguments, and
     * `truncateMiddle` keeps 62% of what is left as head - so every ordinary cut in this codebase
     * keeps the path and the artifact probe is unmovable by the squeeze at any sane bound. Only two
     * things remove one: a compaction that replaces the message outright, and a bound low enough
     * that the head itself is shorter than the path. Hence 200/120/40 rather than a gentle nudge,
     * and hence the ledger's ARTIFACTS WRITTEN block - the loss is structural, not a tuning error.
     */
    id: 'starved',
    label: 'every character bound at its destructive end',
    why: 'Not a candidate: the destructive end of every window mechanism at once, so each probe kind can be shown to fall when its material is actually gone. It also holds the owner-goal control at 5.00, which is what makes that control worth reading elsewhere.',
    constants: {
      TOOL_OUTPUT_SQUEEZE_FLOOR_CHARS: 200,
      OLDER_TOOL_OUTPUT_CHARS: 120,
      COMPACTED_TOOL_ARGUMENT_CHARS: 40,
      RECENT_TOOL_OUTPUT_CHARS: 300,
      MAX_BRIEF_SECTION_CHARS: 400,
      /*
       * Added when the anchor index landed, and the rig's own furniture guard is why.
       *
       * The anchor index is a model-free regex harvest of exact identifiers out of the span a
       * compaction is about to drop, appended to the brief section AFTER its bound - deliberately,
       * so a long summary can never crowd the identifiers out. That means no bound this row
       * already sets can reach it, and with the paths surviving everywhere the artifact column
       * read 5.00 in every configuration of every trajectory: a saturated column, which the guard
       * in run.ts correctly refuses to accept as evidence, because a column that cannot move looks
       * identical whether the mechanism works or the probe has stopped reading the window.
       *
       * This row is "the destructive end of every window mechanism at once", and a new mechanism
       * arrived that it did not touch. Zeroing the budget is that end for this one. It restores
       * the contrast the column is read for - 5.00 against 3.00 on both compacted trajectories.
       */
      ANCHOR_INDEX_CHARS: 0
    }
  }
];

/**
 * Configurations that have quietly become copies of the shipped one.
 *
 * A row whose constants all name the values the tree already ships is byte-identical to `shipped`
 * on every measurement, and its delta is `+0.00` by construction rather than by measurement. That
 * is not a null result, it is an identity, and it reads exactly like a reassuring one - which is
 * what happened to `stride-4` when step 3.1 landed stride 4 and nothing in this directory noticed
 * for a whole wave. `configuration-fidelity` is exempt because being that copy is its entire job.
 */
export const degenerateConfigurations = (): readonly string[] =>
  CONFIGURATIONS.filter(
    (configuration) =>
      configuration.id !== SHIPPED &&
      configuration.id !== FIDELITY &&
      Object.keys(configuration.constants).length > 0 &&
      Object.entries(configuration.constants).every(
        ([name, value]) => shippedConstant(name) === value
      )
  ).map(
    (configuration) =>
      `${configuration.id} names the values context.ts already ships, so its row is a copy of ${SHIPPED} and its delta is +0.00 by construction. Move it to a value the tree does not ship, or delete it.`
  );

/**
 * The bare specifiers `context.ts` imports. A variant lives outside the workspace, so package
 * resolution does not reach it and each one is rewritten to the file it would have resolved to
 * under the `development` condition this rig already runs with.
 */
const SPECIFIERS: ReadonlyArray<readonly [string, string]> = [
  ['@athanor/model-gateway', 'packages/model-gateway/src/index.ts'],
  ['@athanor/data', 'packages/data/src/index.ts']
];

let scratch: string | undefined;
const scratchDirectory = (): string => {
  scratch ??= mkdtempSync(path.join(tmpdir(), 'athanor-context-quality-'));
  // Outside the repository, so nothing here can be committed by accident, and the copy needs its
  // own module declaration because the directory it lands in has no package.json above it.
  writeFileSync(path.join(scratch, 'package.json'), '{"type":"module"}\n');
  return scratch;
};

const loaded = new Map<string, Promise<ContextModule>>();

const patch = (configuration: ContextConfiguration): string => {
  let source = readFileSync(contextSource, 'utf8');
  for (const [specifier, target] of SPECIFIERS) {
    const quoted = `'${specifier}'`;
    if (!source.includes(quoted))
      throw new Error(
        `context.ts no longer imports ${specifier}; the variant loader in evals/context-quality/configurations.ts needs updating`
      );
    source = source.replaceAll(
      quoted,
      JSON.stringify(pathToFileURL(path.join(repositoryRoot, target)).href)
    );
  }
  for (const [name, value] of Object.entries(configuration.constants)) {
    const pattern = new RegExp(`const ${name} = \\d[\\d_]*;`, 'g');
    const matches = source.match(pattern) ?? [];
    if (matches.length !== 1)
      throw new Error(
        `expected exactly one \`const ${name} = <integer>;\` in context.ts, found ${matches.length}. A silent miss here would make every configuration identical.`
      );
    source = source.replace(pattern, `const ${name} = ${value};`);
  }
  return source;
};

/**
 * The module a configuration runs against. `shipped` is the real import rather than a patched copy
 * of itself, so at least one row in every report is unambiguously the code that ships.
 */
export const contextModuleFor = (configuration: ContextConfiguration): Promise<ContextModule> => {
  if (!Object.keys(configuration.constants).length) return Promise.resolve(shippedContext);
  const existing = loaded.get(configuration.id);
  if (existing) return existing;
  const directory = scratchDirectory();
  const file = path.join(directory, `context-${configuration.id}.ts`);
  writeFileSync(file, patch(configuration));
  const started = import(pathToFileURL(file).href) as Promise<ContextModule>;
  loaded.set(configuration.id, started);
  return started;
};
