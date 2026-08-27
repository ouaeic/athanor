/**
 * The checks for the half of this rig that running it cannot exercise.
 *
 *   NODE_OPTIONS=--conditions=development pnpm exec tsx evals/arms/selftest.ts
 *
 * The offline run proves a good deal about itself every time it runs: it prints real bytes and a
 * baseline catches them moving. What it cannot prove is that the comparison it is printing is a
 * comparison at all, and every failure in that class produces a plausible table rather than an
 * error:
 *
 *   - the one-difference rule is the entire claim to honesty and it lives in a `throw` nobody
 *     reaches on a good day, so a deliberately bad arm is pushed through it here;
 *   - `core` reads athanor's own core set out of source, and a pattern that has gone stale would
 *     make that arm a set of names this file invented while every byte count stayed plausible;
 *   - the contract cut removes a section by string surgery, and surgery that took one byte too
 *     many or landed on the wrong heading is invisible in a byte count that only ever goes down;
 *   - ghosts and unmetered rows are excluded from the primary metrics, and an exclusion that
 *     silently stopped working would raise or lower a success rate rather than erroring;
 *   - the tool oracle must be substitutable, or the arms are being scored on which of them the
 *     rig happened to model rather than on what the model could do.
 *
 * A plain script rather than a vitest file, for the reason `evals/context-quality/selftest.ts`
 * gives: `evals/` is not a workspace package, so nothing here is collected by `pnpm -r test`. It
 * exits non-zero on the first run that finds anything.
 */
import { BASE_SYSTEM_PROMPT } from '../../apps/worker/src/context.js';
import {
  ARMS,
  FLOOR_TOOL_NAMES,
  ROOT_ARM,
  coreToolNamesFromSource,
  settingsFor,
  type Arm
} from './arms.js';
import { MAX_STEPS, resolveKey, runOne, type RunRow } from './live.js';
import { measureArm } from './measure.js';
import { scoreArms } from './report.js';
import { TASKS, sampleOf, type ArmTask } from './tasks.js';
import {
  METHOD_HEADING,
  contractFor,
  danglingToolMentions,
  fullCatalogue,
  methodAxis,
  toolsFor
} from './wire.js';
import { answer, resetWorld } from './world.js';

const failures: string[] = [];
const expect = (condition: boolean, what: string): void => {
  if (!condition) failures.push(what);
};
const throws = (run: () => unknown, what: string): void => {
  try {
    run();
    failures.push(what);
  } catch {
    // The throw is the pass.
  }
};

/* ------------------------------------------------- the rule that makes this a comparison at all */

const root: Arm = {
  id: 'r',
  asks: '',
  inherits: null,
  change: {},
  ships: ''
};

throws(
  () =>
    settingsFor('two', [
      root,
      { id: 'two', asks: '', inherits: 'r', change: { tools: 'core', skills: 'none' }, ships: '' }
    ]),
  'an arm that changes two fields must be refused: its row cannot say which change moved the number'
);
throws(
  () => settingsFor('none', [root, { id: 'none', asks: '', inherits: 'r', change: {}, ships: '' }]),
  'an arm that changes nothing must be refused: it is a duplicate of its parent wearing a second name'
);
throws(
  () =>
    settingsFor('bad-root', [
      { id: 'bad-root', asks: '', inherits: null, change: { tools: 'core' }, ships: '' }
    ]),
  'the root arm must be the shipped settings unchanged, or every delta in both tables is measured against a fiction'
);
throws(
  () =>
    settingsFor('a', [
      { id: 'a', asks: '', inherits: 'b', change: { tools: 'core' }, ships: '' },
      { id: 'b', asks: '', inherits: 'a', change: { skills: 'none' }, ships: '' }
    ]),
  'a cycle in the inheritance must be refused rather than looping'
);
throws(
  () =>
    settingsFor('orphan', [
      root,
      { id: 'orphan', asks: '', inherits: 'gone', change: {}, ships: '' }
    ]),
  'an arm inheriting from an arm that does not exist must be refused'
);

// Inheritance has to actually carry. `floor` derives from `core`, so the two axes it does not
// touch must be the root's - if they were re-stated per arm, this would still pass and the
// property would be a coincidence rather than a mechanism.
const floor = settingsFor('floor');
expect(
  floor.tools === 'floor' && floor.skills === 'index' && floor.contract === 'full',
  'the calibration arm must inherit both untouched axes from the root rather than re-declaring them'
);
expect(
  settingsFor(ROOT_ARM).tools === 'full' &&
    settingsFor(ROOT_ARM).skills === 'index' &&
    settingsFor(ROOT_ARM).contract === 'full',
  'the root arm is what athanor ships today'
);
for (const arm of ARMS)
  expect(arm.ships.length > 20, `arm ${arm.id} has no pre-registered rule for shipping it`);

/* ----------------------------------------------- the core set is athanor's, not this file's copy */

const core = coreToolNamesFromSource();
const catalogue = fullCatalogue().map((tool) => tool.name);
expect(core.length >= 18, `coreToolNames read as ${core.length} names; the pattern has gone stale`);
for (const name of core)
  expect(
    catalogue.includes(name),
    `coreToolNames names "${name}", which is not a tool on the wire`
  );
for (const name of FLOOR_TOOL_NAMES)
  expect(
    catalogue.includes(name),
    `the calibration arm names "${name}", which athanor does not define`
  );
expect(
  toolsFor(settingsFor('core')).length === core.length + 1,
  'the core arm must send exactly athanor own core set plus compact_context'
);
expect(
  toolsFor(settingsFor('floor')).length === FLOOR_TOOL_NAMES.length,
  'the calibration arm must send exactly five tools'
);
expect(
  toolsFor(settingsFor(ROOT_ARM)).length === catalogue.length,
  'the root arm must send the whole catalogue'
);

/* ------------------------------------------------------------ the contract surgery, both halves */

const shippedContract = contractFor(settingsFor(ROOT_ARM));
expect(
  shippedContract === BASE_SYSTEM_PROMPT,
  'the root arm must send the contract byte-for-byte as shipped'
);

/*
 * The method axis, both ways round.
 *
 * The rig was written expecting the section to be in the shipped contract and the candidate arm to
 * remove it. It landed cut instead, mid-build, and the arm was briefly measuring nothing - so the
 * property checked here is the one that holds in either world: the two contracts differ by exactly
 * the method section and by nothing else, whichever of them is carrying it.
 */
const axis = methodAxis();
const otherContract = contractFor(settingsFor('no-method'));
expect(axis.bytes > 2_000, `the method axis read as ${axis.bytes} bytes; that is not the section`);
expect(
  axis.section.includes(METHOD_HEADING),
  'the method axis must be the whole section, heading included'
);
if (axis.direction === 'cut') {
  expect(
    !otherContract.includes(METHOD_HEADING),
    'with the section shipped, the candidate arm must not carry it'
  );
  expect(
    otherContract.length < BASE_SYSTEM_PROMPT.length,
    'the candidate arm is not smaller than the shipped contract; the cut did nothing'
  );
} else {
  expect(
    otherContract.includes(METHOD_HEADING),
    'with the section already cut, the candidate arm must be the one that carries it - otherwise both arms are identical and the table prints a tie that means nothing'
  );
  expect(
    otherContract.length > BASE_SYSTEM_PROMPT.length,
    'restoring the section must make the contract larger'
  );
  expect(
    otherContract.indexOf(METHOD_HEADING) < otherContract.indexOf('## Safety floor'),
    'the section must go back where it was, in front of the safety floor: moving it changes the prompt in a second way and the arm stops being one difference'
  );
}
// Every other heading has to survive either operation. A slice that swallowed the section after it
// would report a larger difference and a worse arm, and both halves of that error point one way.
for (const heading of BASE_SYSTEM_PROMPT.match(/^## .+$/gm) ?? [])
  expect(otherContract.includes(heading), `the method axis also moved "${heading}"`);
// The safety floor is the one section that must never be a casualty of a byte hunt.
expect(
  otherContract.includes('## Safety floor') && otherContract.includes('Never claim a tool'),
  'the safety floor must survive every edit this rig can make'
);
expect(
  Math.abs(otherContract.length - BASE_SYSTEM_PROMPT.length) > 2_000,
  'the two contracts differ by less than the section does; one of the two arms is not what it says'
);

const noSkills = contractFor(settingsFor('no-skills'));
expect(
  !noSkills.includes('- Skills come in two tiers'),
  'the no-skills arm must also drop the sentence pointing at the index: a window with no index whose contract still describes one is a broken configuration, not an absent feature, and it would lose turns for a reason that has nothing to do with the question'
);
expect(
  noSkills.includes(METHOD_HEADING) === BASE_SYSTEM_PROMPT.includes(METHOD_HEADING),
  'the skills axis must leave the method section exactly where it found it; that is a different arm'
);
expect(
  measureArm('no-skills').knowledgeBytes < measureArm(ROOT_ARM).knowledgeBytes,
  'the no-skills arm must actually remove the index from the knowledge block'
);

/* ------------------------------------------------------------- the free diagnostic, both signs */

expect(
  danglingToolMentions(shippedContract, toolsFor(settingsFor(ROOT_ARM))).length === 0,
  'the shipped arm cannot have a dangling tool mention: it sends every tool it names'
);
expect(
  measureArm('floor').dangling.length > 0,
  'a five-tool arm running the whole contract must show holes, or the diagnostic is not reading the contract'
);

/* ------------------------------------------ ghosts and unmetered rows leave the primary metrics */

const row = (over: Partial<RunRow>): RunRow => ({
  armId: 'x',
  taskId: 't',
  shape: 'files',
  tier: 'weak',
  seed: 0,
  completed: true,
  modelCalls: 3,
  tokensIn: 1000,
  tokensOut: 100,
  metered: true,
  toolsCalled: [],
  ghost: false,
  ranOut: false,
  ...over
});

const scored = scoreArms([
  row({ completed: true }),
  row({ completed: false }),
  row({ ghost: true, completed: false, tokensOut: 0, metered: false }),
  row({ error: 'provider refused', completed: false, metered: false }),
  row({ completed: true, metered: false, tokensOut: 0 })
])[0];
expect(scored !== undefined, 'the scorer produced no row at all');
expect(
  scored?.counted === 3,
  `ghosts and errored rows must leave the denominator: counted ${scored?.counted ?? 'nothing'}, expected 3`
);
expect(
  scored?.successRate === 66.7,
  `success is over rows that ran: got ${scored?.successRate ?? 'nothing'}, expected 66.7`
);
expect(
  scored?.meanTokensOut === 100,
  `an unmetered row must not drag the token mean toward zero: got ${scored?.meanTokensOut ?? 'nothing'}`
);
expect(
  scored?.ghosts === 1 && scored?.errors === 1 && scored?.unmetered === 1,
  'the diagnostics are wrong'
);

// "recovered" is the column the whole programme turns on, so both sides of it are pinned.
const recovery = scoreArms([
  row({ armId: ROOT_ARM, taskId: 'q', modelCalls: 3 }),
  row({ armId: 'candidate', taskId: 'q', modelCalls: 5 }),
  row({ armId: ROOT_ARM, taskId: 'r', modelCalls: 4 }),
  row({ armId: 'candidate', taskId: 'r', modelCalls: 4 })
]).find((score) => score.armId === 'candidate');
expect(
  recovery?.recovered === 1,
  `recovered counts completions that cost more turns than the shipped arm needed: got ${recovery?.recovered ?? 'nothing'}, expected 1`
);

/* --------------------------------------------------------------- the key, and its three arms */

const withoutKey = { OPENROUTER_API_KEY: '' } as NodeJS.ProcessEnv;
const withKey = { OPENROUTER_API_KEY: 'sk-test' } as NodeJS.ProcessEnv;
const inCi = { OPENROUTER_API_KEY: '', GITHUB_ACTIONS: 'true' } as NodeJS.ProcessEnv;

expect(
  resolveKey(false, withoutKey).apiKey === null && !resolveKey(false, withoutKey).fatal,
  'a run that did not ask for the live half must not fail for want of a key'
);
expect(
  resolveKey(false, withoutKey).note.includes('cannot say whether an arm finishes the work'),
  'a run without the live half has to say what the offline table is worth, every time'
);
expect(
  resolveKey(true, withKey).apiKey === 'sk-test',
  'OPENROUTER_API_KEY is the variable scripts/live-drill.mjs takes; nothing else is read'
);
expect(
  resolveKey(true, withoutKey).apiKey === null && !resolveKey(true, withoutKey).fatal,
  'asked for on a developer machine with no key, the live half explains and continues'
);
expect(
  resolveKey(true, inCi).fatal,
  'asked for on a CI runner with no key, the live half fails - an optional check that skips silently has stopped running'
);

/* ------------------------------------------- the live loop, against a provider that is not real */

/*
 * The half nobody can run.
 *
 * `runOne` needs a key, so on every machine in this repository it is unreachable - which is exactly
 * the shape of code that rots: it typechecks for months, somebody finally buys a run, and it turns
 * out the loop never terminated on `finish` or never read `usage` and the money is spent. So the
 * provider is stubbed here and the loop is driven for real: three scripted replies, a tool call, a
 * finish, and the counts checked against what the script did.
 *
 * The stub is a plain `fetch` replacement rather than a mock library, for the reason
 * `evals/harness.ts` gives about its own two stubs: the seam that needs replacing is one function,
 * and replacing one function is a change somebody can read.
 */
const realFetch = globalThis.fetch;
const reply = (calls: unknown[] | null, content: string | null, usage: unknown): Response =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content, ...(calls ? { tool_calls: calls } : {}) } }],
      ...(usage ? { usage } : {})
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );

const script: Array<() => Response> = [
  () =>
    reply(
      [{ id: 'c1', function: { name: 'file_read', arguments: '{"path":"workspace/notes.txt"}' } }],
      null,
      { prompt_tokens: 8000, completion_tokens: 40 }
    ),
  () =>
    reply([{ id: 'c2', function: { name: 'finish', arguments: '{}' } }], 'Renewal is 14 March.', {
      prompt_tokens: 8200,
      completion_tokens: 60
    })
];
let sent = 0;
globalThis.fetch = (async () => {
  const next = script[sent];
  sent += 1;
  if (!next) throw new Error('the loop asked for more replies than the script has');
  return next();
}) as typeof fetch;

const completedRow = await runOne('sk-test', 'stub', ROOT_ARM, TASKS[0] as ArmTask, 0);
expect(completedRow.completed, 'the loop must end when the model calls finish');
expect(
  completedRow.modelCalls === 2,
  `the loop must count provider round trips: got ${completedRow.modelCalls}, expected 2`
);
expect(
  completedRow.tokensIn === 16_200 && completedRow.tokensOut === 100,
  `tokens come from the provider usage block and are summed across the turn: got ${completedRow.tokensIn}/${completedRow.tokensOut}`
);
expect(completedRow.metered, 'a row the provider metered on every call is metered');
expect(
  completedRow.toolsCalled.join(',') === 'file_read,finish',
  `the names are recorded in order: got ${completedRow.toolsCalled.join(',')}`
);
expect(
  !completedRow.ghost && !completedRow.ranOut,
  'a completed row is neither a ghost nor capped'
);

// A provider that returns nothing at all. Not a failure of the arm, and it must not be scored as one.
sent = 0;
script.length = 0;
script.push(() => reply(null, null, { prompt_tokens: 8000, completion_tokens: 0 }));
const ghostRow = await runOne('sk-test', 'stub', ROOT_ARM, TASKS[0] as ArmTask, 0);
expect(
  ghostRow.ghost && !ghostRow.completed,
  'no content, no call and no output tokens is a ghost run, not a failed task'
);

// A provider that does not meter. The row runs; it just cannot enter a token mean.
sent = 0;
script.length = 0;
script.push(() => reply([{ id: 'c1', function: { name: 'finish', arguments: '{}' } }], null, null));
const unmeteredRow = await runOne('sk-test', 'stub', ROOT_ARM, TASKS[0] as ArmTask, 0);
expect(
  unmeteredRow.completed && !unmeteredRow.metered,
  'a completed row the provider did not meter must still count as completed, and must not be metered'
);
/*
 * And it must carry nothing where the count would have been.
 *
 * Written after a mutation drill found the gap: replacing the `?? 0` fallback with an invented
 * figure left every assertion above green, because "unmetered" was checked and the numbers were
 * not. That is the precise failure the pre-registration's fourth rule is about - the arms differ
 * in how much of the request is tool schema, so any estimate stood in for a missing count is wrong
 * by a different factor per arm, which is a fabricated difference with a decimal point on it. The
 * exclusion downstream is not enough on its own: the row itself must not carry a number nobody
 * measured, because the next reader of the raw JSON has no way to tell one from the other.
 */
expect(
  unmeteredRow.tokensIn === 0 && unmeteredRow.tokensOut === 0,
  `an unmetered row must carry no token figure at all: got ${unmeteredRow.tokensIn}/${unmeteredRow.tokensOut}. A number nobody measured is worse than a blank.`
);

// The step ceiling, which is the difference between "could not" and "was not allowed to".
sent = 0;
script.length = 0;
for (let index = 0; index < MAX_STEPS + 2; index += 1)
  script.push(() =>
    reply([{ id: 'c', function: { name: 'files_list', arguments: '{}' } }], null, {
      prompt_tokens: 100,
      completion_tokens: 10
    })
  );
const cappedRow = await runOne('sk-test', 'stub', ROOT_ARM, TASKS[0] as ArmTask, 0);
expect(
  cappedRow.ranOut && !cappedRow.completed && cappedRow.modelCalls === MAX_STEPS,
  `a run that hits the ceiling must say so rather than reading as a refusal: calls ${cappedRow.modelCalls}, ranOut ${cappedRow.ranOut}`
);

// A provider that refuses. Recorded as an error, and errors never enter a primary metric.
sent = 0;
globalThis.fetch = (async () => new Response('upstream is angry', { status: 503 })) as typeof fetch;
const erroredRow = await runOne('sk-test', 'stub', ROOT_ARM, TASKS[0] as ArmTask, 0);
expect(
  erroredRow.error !== undefined && !erroredRow.completed && !erroredRow.ghost,
  'a provider refusal is an error on the row, not a ghost and not a failure of the arm'
);

globalThis.fetch = realFetch;

/* ------------------------------------------------------------------- the oracle, substitutable */

resetWorld();
const throughReader = answer('file_read', { path: 'workspace/notes.txt' }).content;
const throughShell = answer('shell', { command: 'cat workspace/notes.txt' }).content;
expect(
  throughReader === throughShell && throughReader.includes('14 March 2027'),
  'the same fact must be reachable through shell and through a reader, or the tool arms are scored on which of them this rig happened to model'
);
expect(
  answer('document_search', { query: 'terminate' }).content.includes('60 days'),
  'the index must find what the documents contain'
);
expect(
  answer('shell', { command: "grep -n 'terminate' workspace/contract.pdf" }).content.includes(
    '60 days'
  ),
  'and grep must find the same thing, in more calls'
);
expect(answer('finish', {}).terminal, 'finish must end the run');
expect(
  !answer('image_read', {}).terminal && answer('image_read', {}).content.includes('not modelled'),
  'a tool this rig does not model must refuse honestly rather than return a plausible success an arm could complete on'
);
expect(
  answer('file_read', { path: 'workspace/notes.txt' }).content ===
    answer('file_read', { path: 'workspace/notes.txt' }).content,
  'a result must be a function of the call alone'
);

/* -------------------------------------------------------------------------------- the sample */

expect(
  TASKS.length > 60,
  `the sample is ${TASKS.length} tasks; it should be the fixtures bar one shape`
);
expect(!TASKS.some((task) => task.shape === 'schema'), 'a claim about the catalogue is not a job');
expect(
  TASKS.some((task) => task.shape === 'refusal'),
  'the awkward shapes stay in: dropping the ones an author expects to go badly is how a sample becomes an argument'
);
expect(
  TASKS.every((task) => task.request.trim().length > 0),
  'every task must carry the owner words'
);
const twelve = sampleOf(12);
expect(twelve.length === 12, `sampleOf(12) returned ${twelve.length}`);
expect(
  new Set(twelve.map((task) => task.shape)).size >= 6,
  'a subset somebody is paying for has to keep the shape mix, or it is the first twelve fixtures wearing the name of a sample'
);
expect(
  sampleOf(10_000).length === TASKS.length,
  'asking for more than there is returns everything'
);

if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.exit(1);
}
process.stdout.write(
  'arms selftest: the one-difference rule, the core set read from source, both halves of the contract surgery, the ghost and unmetered exclusions, the recovered column, the key arms, the live loop against a stubbed provider, the oracle substitutability and the sample behave as documented.\n'
);
