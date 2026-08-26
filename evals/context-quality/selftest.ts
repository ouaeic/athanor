/**
 * The checks for the half of this directory that cannot be exercised by running it.
 *
 *   NODE_OPTIONS=--conditions=development pnpm exec tsx evals/context-quality/selftest.ts
 *
 * The deterministic run proves itself every time it runs: `configuration-fidelity` has to equal
 * `shipped`, and the owner's goal has to still be in the window. The judged half has no such
 * proof, because it needs a provider key that this repository deliberately does not hold - so the
 * two things about it that would be silently wrong are checked here against a stub instead.
 *
 * Both of them are the kind of defect that produces a plausible number rather than an error:
 *
 *   - a judge that can see which configuration produced an answer is grading the configuration,
 *     and a blinding bug looks exactly like a strong result for whichever row happens to be first;
 *   - a label-to-configuration mapping that is off by one attributes every score to the wrong row,
 *     and every score is still in range.
 *
 * A plain script rather than a vitest file: `evals/` is not a workspace package, so nothing here is
 * collected by `pnpm -r test`, and the repository's other standalone checks - `scripts/check-*.mjs`
 * - are written this way for the same reason. It exits non-zero on the first failure.
 */
import { gradeBlind, resolveKey } from './judge.js';

const failures: string[] = [];
const expect = (condition: boolean, what: string): void => {
  if (!condition) failures.push(what);
};

// --- the key, and the three arms it has to have ------------------------------------------------

const withoutKey = { OPENROUTER_API_KEY: '' } as NodeJS.ProcessEnv;
const withKey = { OPENROUTER_API_KEY: 'sk-test' } as NodeJS.ProcessEnv;
const inCi = { OPENROUTER_API_KEY: '', GITHUB_ACTIONS: 'true' } as NodeJS.ProcessEnv;

expect(
  resolveKey(false, withoutKey).apiKey === null && !resolveKey(false, withoutKey).fatal,
  'a run that did not ask for the judged half must not fail for want of a key'
);
expect(
  resolveKey(false, withoutKey).note.includes('upper bound'),
  'a run without the judged half has to say what the deterministic score is worth, every time'
);
expect(
  resolveKey(true, withKey).apiKey === 'sk-test',
  'OPENROUTER_API_KEY is the variable scripts/live-drill.mjs takes; nothing else is read'
);
expect(
  resolveKey(true, withoutKey).apiKey === null && !resolveKey(true, withoutKey).fatal,
  'asked for on a developer machine with no key, the judged half explains and continues'
);
expect(
  resolveKey(true, inCi).fatal,
  'asked for on a CI runner with no key, the judged half fails - an optional check that skips silently has stopped running'
);

// --- the blinding, and the mapping back ---------------------------------------------------------

const answers = [
  { configurationId: 'shipped', answer: 'The ceiling is 137.' },
  { configurationId: 'detail-2', answer: 'not in my context' },
  { configurationId: 'tool-2', answer: 'It was 137.' }
];

let judgePrompt = '';
const stub: typeof fetch = (_input, init) => {
  const sent = init?.body;
  const body = JSON.parse(typeof sent === 'string' ? sent : '{"messages":[]}') as {
    messages: Array<{ content: string }>;
  };
  judgePrompt = body.messages.map((message) => message.content).join('\n');
  // Deliberately keyed off the answer text, which is the only thing a blinded judge can see. If the
  // labels ever stopped being shuffled this would still pass; the ordering check below is what
  // catches that, and this one catches a mapping that loses track of which answer was whose.
  const scores: Record<string, number> = {};
  for (const line of judgePrompt.split('\n')) {
    const match = /^\[([A-P])\]$/.exec(line.trim());
    if (!match?.[1]) continue;
    const label = match[1];
    const index = judgePrompt.indexOf(`[${label}]`);
    const following = judgePrompt.slice(index + 3, index + 60);
    scores[label] = following.includes('137') ? 5 : 0;
  }
  return Promise.resolve(
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(scores) } }] }), {
      status: 200
    })
  );
};

const verdicts = await gradeBlind(
  { apiKey: 'sk-test', answerModel: 'a', judgeModel: 'b', fetch: stub },
  {
    id: 'recall-pool-ceiling',
    question: 'What value was pool_max_conn set to?',
    reference: 'pool_max_conn = 137.'
  },
  answers
);

for (const id of ['shipped', 'detail-2', 'tool-2'])
  expect(
    verdicts.some((verdict) => verdict.configurationId === id),
    `every configuration must come back from the judge; ${id} did not`
  );
expect(
  verdicts.find((verdict) => verdict.configurationId === 'shipped')?.score === 5,
  'a correct answer must be scored back onto the configuration that produced it'
);
expect(
  verdicts.find((verdict) => verdict.configurationId === 'detail-2')?.score === 0,
  '"not in my context" scores zero: the task still did not get done'
);
for (const id of ['shipped', 'detail-2', 'tool-2'])
  expect(!judgePrompt.includes(id), `the judge must never see a configuration name; it saw ${id}`);
expect(
  !judgePrompt.includes('configuration'),
  'the judge must not be told that a comparison is happening at all'
);

if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.exit(1);
}
process.stdout.write(
  'context-quality selftest: the key arms and the blinded judge behave as documented.\n'
);
