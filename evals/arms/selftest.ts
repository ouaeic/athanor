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
import { fileTag } from '../../apps/worker/src/edit/format.js';
import { BASE_SYSTEM_PROMPT } from '../../apps/worker/src/context.js';
import { TASKS as CORPUS, fileText, type EditTask } from '../edit/corpus.js';
import { encodeLines, encodeReplace } from '../edit/encode.js';
import { incumbentEntryCost, residentCost } from '../edit/report.js';
import {
  ARMS,
  EDIT_ARM,
  FLOOR_TOOL_NAMES,
  ROOT_ARM,
  coreToolNamesFromSource,
  settingsFor,
  type Arm
} from './arms.js';
import {
  EDIT_TASKS,
  EXCLUDED_CORPUS_IDS,
  EditWorld,
  runEditOne,
  scoreEdit,
  type EditArmTask
} from './edit-arm.js';
import { MAX_STEPS, resolveKey, runOne, type RunRow } from './live.js';
import { measureArm } from './measure.js';
import { scoreArms, scoreEditArms } from './report.js';
import { TASKS, sampleOf, type ArmTask } from './tasks.js';
import {
  INCUMBENT_EDIT_TOOL,
  METHOD_HEADING,
  contractFor,
  danglingToolMentions,
  fullCatalogue,
  methodAxis,
  toolsFor,
  withEditDialect
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

/* ----------------------------------------------------------------------------- the edit axis */

/*
 * The arm whose whole answer is in the half that costs money, checked in the half that does not.
 *
 * Everything here is a way of being wrong that would still print a table. An arm that quietly kept
 * `file_patch` prints a tie; a world whose appliers cannot land a correct edit prints zero for both
 * arms and reads as "models cannot do this"; a sample whose intended text is the text it started
 * with passes without an edit ever being made, which is precisely the defect Wave S4 spent its
 * other half deleting from this repository's test suite. So: both dialects are driven through the
 * real appliers on every row, by a scripted model that gets them right, and the row must come out
 * byte-correct. If it does not, the instrument is broken and no live run should be bought.
 */

expect(
  settingsFor(EDIT_ARM).edit === 'lines' &&
    settingsFor(EDIT_ARM).tools === 'full' &&
    settingsFor(EDIT_ARM).skills === 'index' &&
    settingsFor(EDIT_ARM).contract === 'full',
  'the edit arm must differ from shipped by the edit tool and nothing else'
);

const editTools = toolsFor(settingsFor(EDIT_ARM));
expect(
  editTools.some((tool) => tool.name === 'file_edit') &&
    !editTools.some((tool) => tool.name === INCUMBENT_EDIT_TOOL),
  'the edit arm must hold the candidate INSTEAD of file_patch: two edit tools is two ways to do one thing and every row would be a blend of both dialects'
);
expect(
  editTools.length === toolsFor(settingsFor(ROOT_ARM)).length,
  'a replacement changes no tool count; a count that moved means an entry was dropped rather than swapped'
);
/*
 * The swap is a replacement, so it has to find the thing it replaces. Every arm today sends
 * `file_patch` - it is in the core set and in the hand-written floor - so the way this guard is
 * actually reached is a rename in `tool-catalogue.ts`, and the failure it prevents is silent: the
 * arm would send the shipped catalogue under a second name and print a perfect tie.
 */
throws(
  () =>
    withEditDialect(
      fullCatalogue().filter((tool) => tool.name !== INCUMBENT_EDIT_TOOL),
      settingsFor(EDIT_ARM)
    ),
  'the edit axis must throw when there is no file_patch to replace: an arm that silently kept the shipped catalogue would print a tie, which reads as "the dialect is free"'
);
expect(
  fullCatalogue().some((tool) => tool.name === INCUMBENT_EDIT_TOOL),
  `athanor no longer ships a tool called ${INCUMBENT_EDIT_TOOL}; the edit axis is measuring a replacement for something that is not there`
);

/*
 * Cross-rig arithmetic. `evals/edit` priced this swap at +1,306 bytes net and this arm has to be
 * carrying that same swap, or one of the two numbers in front of the owner is about a catalogue
 * nobody is proposing.
 */
const shippedCatalogue = measureArm(ROOT_ARM).catalogueBytes;
const editCatalogue = measureArm(EDIT_ARM).catalogueBytes;
expect(
  editCatalogue - shippedCatalogue === residentCost() - incumbentEntryCost(),
  `the arm swaps the catalogue by ${editCatalogue - shippedCatalogue} bytes and evals/edit prices the same swap at ${residentCost() - incumbentEntryCost()}; two rigs disagreeing about the size of one thing is two rigs one of which is wrong`
);

/* The sample: real edits, no dialect in the request, and nothing that passes without an edit. */
expect(
  EDIT_TASKS.length > 10,
  `the edit sample is ${EDIT_TASKS.length} rows; the corpus has fifteen`
);
expect(
  EXCLUDED_CORPUS_IDS.length === 3,
  `${EXCLUDED_CORPUS_IDS.length} corpus rows excluded; the drift and refusal rows are three`
);
for (const task of EDIT_TASKS) {
  expect(
    task.wanted !== fileText(task.path) || task.renamedTo !== undefined,
    `${task.corpusId}: the text a correct edit produces is the text it started with, so the row would score correct with no edit made at all`
  );
  expect(
    !/\bPUT \b|\bCUT \b|oldText|newText/.test(task.request),
    `${task.corpusId}: the request contains a dialect, so the sample is teaching one of the two arms its own answer`
  );
}

/*
 * A model that gets it right, on every row, through both dialects and the shipped appliers.
 *
 * The encodings come from `evals/edit/encode.ts` - the same derivation that produced the 61% - so
 * this is the upper bound the arm exists to test, executed rather than asserted. Any row that does
 * not land here is a row where a live number would be measuring this rig rather than the model.
 */
let landed = 0;
for (const task of EDIT_TASKS) {
  const corpus = CORPUS.find((one) => one.id === task.corpusId);
  if (!corpus) {
    failures.push(`${task.corpusId}: no longer in the corpus this sample is derived from`);
    continue;
  }
  const read = fileText(corpus.path);

  const incumbent = new EditWorld(false);
  incumbent.answer('file_read', { path: corpus.path });
  const replaceCall = encodeReplace(corpus, read);
  if (replaceCall.tool === 'shell') incumbent.answer('shell', { ...replaceCall.args });
  else if (replaceCall.tool === 'file_patch')
    incumbent.answer('file_patch', { patches: replaceCall.args.patches });
  expect(
    scoreEdit(incumbent, task).correct,
    `${task.corpusId}: file_patch, given the best encoding of this edit, does not leave the file as the task asked - this world is scoring the rig, not the model`
  );

  const candidate = new EditWorld(true);
  const rendered = candidate.answer('file_read', { path: corpus.path }).content;
  const tag = /#([0-9a-f]{4})\]/.exec(rendered)?.[1] ?? '';
  expect(
    tag !== '',
    `${task.corpusId}: the numbered read carries no tag, so the dialect cannot address it`
  );
  candidate.answer('file_edit', encodeLines(corpus, tag).args);
  expect(
    scoreEdit(candidate, task).correct,
    `${task.corpusId}: the by-line encoding of this edit does not leave the file as the task asked`
  );
  if (scoreEdit(candidate, task).correct && scoreEdit(incumbent, task).correct) landed += 1;
}
expect(
  landed === EDIT_TASKS.length,
  `${landed} of ${EDIT_TASKS.length} rows land through both dialects; a rig that cannot land its own sample cannot measure a model against it`
);

/* A read the model never did. The tag is the format's whole safety story and it must fail closed. */
const fabricated = new EditWorld(true);
fabricated.answer('file_edit', { patch: '[src/queue.ts#0000]\nPUT 11:\n+    return undefined;' });
expect(
  fabricated.editCalls === 1 &&
    fabricated.editApplied === 0 &&
    fabricated.refusals[0]?.kind === 'tag_unknown',
  'an edit against a tag this harness never issued must be refused and counted as a refused call, or the applied column is a fiction'
);
expect(
  !scoreEdit(fabricated, EDIT_TASKS[1] as EditArmTask).correct,
  'a refused edit must not score correct'
);

/* And a quote that is not unique, which is the incumbent's own failure mode. */
const ambiguous = new EditWorld(false);
ambiguous.answer('file_patch', {
  patches: [
    { path: 'src/queue.ts', oldText: '    return null;\n', newText: '    return undefined;\n' }
  ]
});
expect(
  ambiguous.editApplied === 0 && ambiguous.refusals[0]?.kind === 'no_unique_match',
  'a quote that appears six times must be refused by the incumbent here exactly as workspace.ts refuses it'
);

/*
 * The edit loop end to end, against the same stubbed provider, because `runEditOne` is as
 * unreachable on this machine as `runOne` is and rots the same way.
 */
const editTask = EDIT_TASKS.find((task) => task.corpusId === 'repeated-statement') as EditArmTask;
const editCorpus = CORPUS.find((one) => one.id === 'repeated-statement') as EditTask;
const editScript: Array<() => Response> = [
  () =>
    reply(
      [
        {
          id: 'e1',
          function: { name: 'file_read', arguments: JSON.stringify({ path: editCorpus.path }) }
        }
      ],
      null,
      { prompt_tokens: 9000, completion_tokens: 20 }
    ),
  () =>
    reply(
      [
        {
          id: 'e2',
          function: {
            name: 'file_edit',
            arguments: JSON.stringify(
              encodeLines(editCorpus, fileTag(fileText(editCorpus.path))).args
            )
          }
        }
      ],
      null,
      { prompt_tokens: 9400, completion_tokens: 30 }
    ),
  () =>
    reply([{ id: 'e3', function: { name: 'finish', arguments: '{}' } }], 'Done.', {
      prompt_tokens: 9600,
      completion_tokens: 10
    })
];
let editSent = 0;
globalThis.fetch = (async () => {
  const next = editScript[editSent];
  editSent += 1;
  if (!next) throw new Error('the edit loop asked for more replies than the script has');
  return next();
}) as typeof fetch;

const editRow = await runEditOne('sk-test', 'stub', EDIT_ARM, editTask, 0);
globalThis.fetch = realFetch;
expect(
  editRow.completed && editRow.correct && editRow.editCalls === 1 && editRow.editApplied === 1,
  `the edit loop must run a correct row end to end: completed=${editRow.completed} correct=${editRow.correct} calls=${editRow.editCalls} applied=${editRow.editApplied}`
);
expect(
  editRow.tokensOut === 60 && editRow.modelCalls === 3,
  `the edit row must carry the provider own usage: ${editRow.tokensOut} out over ${editRow.modelCalls} calls`
);

const editScores = scoreEditArms([editRow]);
expect(
  editScores.length === 1 && editScores[0]?.correct === 1 && editScores[0]?.editApplied === 1,
  'the edit table must score a correct row as correct, with output tokens on the same row'
);

if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.exit(1);
}
process.stdout.write(
  'arms selftest: the one-difference rule, the core set read from source, both halves of the contract surgery, the ghost and unmetered exclusions, the recovered column, the key arms, the live loop against a stubbed provider, the oracle substitutability, the sample, and the edit axis - its wire, its arithmetic against evals/edit, both dialects landing every row of its sample through the shipped appliers, both failure modes failing closed, and its own live loop - behave as documented.\n'
);
