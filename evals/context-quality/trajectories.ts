/**
 * The long-running trajectories the probes are asked about, with the answers planted in them.
 *
 * A trajectory here is the message list `apps/worker/src/agent.ts` builds - the same preamble
 * blocks in the same order at production sizes, an assistant turn carrying prose, reasoning,
 * reasoning details and a tool call, and a tool result serialized the way the loop serializes it.
 * `evals/harness.ts` runs the real loop and cannot answer a question about content, because its
 * model is scripted; this file goes the other way, scripting the trajectory precisely so that the
 * questions have known answers.
 *
 * Everything is planted deliberately and at a stated distance from where it is asked for, because
 * distance is the whole experiment. One step appends two messages, and the two constants under
 * review are counted in messages: `RECENT_DETAIL_MESSAGES = 8` is about four steps of reasoning
 * history, `= 2` is about one. A probe set clustered at one distance would measure one constant
 * and report it as a property of the design, so the distances below run from 1 step to 23.
 *
 * Two probes are controls and must score 1.00 in every configuration:
 *
 *   `recall-owner-constraint`   the owner's own goal message, which every pass protects by name.
 *                               If this ever moves, the run is measuring a broken driver.
 *   `recall-newest-reasoning`   asked one step after it is planted. It looks like a control and it
 *                               is not - see the note on it below, which is the single most useful
 *                               thing this file found.
 *
 * The sizes and the seeded size sequence are the ones `apps/worker/src/context.test.ts` settled on
 * for its sixty-step harness: tool results spread 0.6-24 kB, assistant turns carrying reasoning,
 * the real catalogue in front. A fixture whose results are all one size measures one branch of the
 * squeeze, which is how the plan came to quote numbers from a 20 kB-uniform fixture that the Wave
 * 0 harness then corrected.
 */
import type { ModelMessage } from '../../packages/model-gateway/src/index.js';

import { BASE_SYSTEM_PROMPT, serializeToolResultForModel } from '../../apps/worker/src/context.js';
import type { Probe } from './probes.js';

/** Tool results at the sizes production actually produces, up to the 24 kB recent bound. */
const RESULT_SIZES = [600, 900, 1_500, 3_200, 6_400, 12_000, 18_000, 24_000];

/** Tagged and non-repeating, so two different messages can never share bytes by accident. */
const text = (chars: number, tag: string): string => {
  let value = '';
  while (value.length < chars)
    value += `${tag} ${value.length} the pooler answered in ${value.length % 97} ms and held ${value.length % 13} sessions. `;
  return value.slice(0, chars);
};

/**
 * Splices a span into a body at a fraction of its length, keeping the body exactly as long.
 *
 * Length is preserved because the position of a fact inside a result is the thing being tested:
 * `truncateMiddle` keeps the leading 62% and the trailing remainder, so a span at 0.05 survives
 * every truncation the window applies and the same span at 0.5 is the first thing to go. A splice
 * that also changed the length would move the result across a size band at the same time and the
 * two effects would be inseparable.
 */
const embed = (body: string, span: string, at: number): string => {
  const start = Math.min(
    Math.max(0, Math.floor(body.length * at)),
    Math.max(0, body.length - span.length)
  );
  return `${body.slice(0, start)}${span}${body.slice(start + span.length)}`;
};

interface Plant {
  /** Embedded in this step's reasoning, which is what the detail boundary deletes. */
  readonly reasoning?: string;
  /** Embedded in this step's assistant prose, which nothing but a compaction removes. */
  readonly prose?: string;
  /** Embedded at 5% of the tool result, inside the head every truncation keeps. */
  readonly resultHead?: string;
  /** Embedded at 50% of the tool result, inside the span every truncation removes. */
  readonly resultMiddle?: string;
  /** Makes this step a write, which is what an artifact probe is asked about. */
  readonly write?: { readonly path: string; readonly bytes: number; readonly resultChars: number };
}

const OWNER_GOAL_CONSTRAINT = 'never exceed 40 pooled connections during business hours';

const PLAN_LINE =
  'Plan: (1) audit every caller, (2) stand up the pooler, (3) migrate the writer pool, ' +
  '(4) dry run the cutover, (5) re-point the notifications service, (6) retire the direct role.';

const PLANTS: ReadonlyMap<number, Plant> = new Map<number, Plant>([
  [4, { resultMiddle: 'pool_max_conn = 137' }],
  [
    6,
    {
      reasoning:
        'transaction pooling was chosen over session pooling because each task opens four short-lived connections',
      // The same decision, said out loud as well as thought. Its pair is what keeps the reasoning
      // result honest: an agent usually states a choice in its visible answer too, and a fixture
      // that only ever plants rationale in reasoning would overstate what the detail window costs.
      prose: 'session pooling was ruled out for the writer pool'
    }
  ],
  [7, { prose: PLAN_LINE }],
  [8, { write: { path: 'workspace/infra/pooler.ini', bytes: 2_180, resultChars: 700 } }],
  [10, { resultHead: 'SQLSTATE 53300 too_many_connections on replica two' }],
  [14, { write: { path: 'workspace/src/db/pool.ts', bytes: 9_400, resultChars: 18_000 } }],
  [
    18,
    {
      reasoning:
        'LISTEN NOTIFY was rejected because transaction pooling drops the session that owns the listener'
    }
  ],
  [
    22,
    {
      write: {
        path: 'workspace/services/notifications/config.json',
        bytes: 1_100,
        resultChars: 620
      }
    }
  ],
  [26, { reasoning: 'replica lag peaked at 4812 ms during the dry run' }],
  [31, { write: { path: 'workspace/docs/runbook-pool.md', bytes: 6_700, resultChars: 900 } }],
  [33, { resultMiddle: 'migration 0067 pool ceiling applied in 1420 ms' }],
  [40, { write: { path: 'workspace/infra/pgbouncer-userlist.txt', bytes: 430, resultChars: 640 } }],
  [
    44,
    {
      reasoning:
        'the next action is to re-point the notifications service at the pooler on port 6432'
    }
  ]
]);

/**
 * The block `refreshActivePlan` (agent.ts:9394-9462) maintains, in its shape and its wording.
 *
 * It is re-pushed only when the plan VERSION changes, not on every step - the function returns
 * early when `plan.version === state.planVersion` - so the block lands at the tail on the steps
 * below and sits still in between. That is why it belongs in this fixture at all: on a plan step
 * the newest assistant message is one position further from the tail than usual, and the detail
 * boundary is counted from the tail.
 *
 * It is also the answer to a question this rig would otherwise get wrong. The published probe work
 * says artifact tracking "may need dedicated state tracking beyond summarization". Athanor already
 * has exactly that for the plan - a durable, re-rendered, model-visible block that no compaction
 * and no truncation reaches - and has nothing of the kind for the set of files it has written.
 */
const PLAN_STEPS = new Set([2, 12, 24, 36, 48]);

const PLAN_BLOCK_STEPS = [
  'Audit every caller of the direct database role',
  'Stand up the pooler',
  'Migrate the writer pool',
  'Dry run the cutover',
  'Re-point the notifications service',
  'Retire the direct role'
];

/** The plan block as it stands at a given step, with the step it is on marked in progress. */
export const activePlanBlock = (step: number): ModelMessage => {
  const version = [...PLAN_STEPS].filter((planStep) => planStep <= step).length;
  const current = Math.min(PLAN_BLOCK_STEPS.length - 1, version - 1);
  return {
    role: 'system',
    content: `ACTIVE USER-VISIBLE PLAN v${version} (Main). Follow this newest version and do not execute stale work. The user watches these statuses live, so call set_plan again whenever one changes: send every step with its status (pending, in_progress, completed or skipped) and keep the step you are working on marked in_progress.\n${PLAN_BLOCK_STEPS.map(
      (title, index) =>
        `${index + 1}. [${index < current ? 'completed' : index === current ? 'in_progress' : 'pending'}] ${title}`
    ).join('\n')}`
  };
};

export const isPlanStep = (step: number): boolean => PLAN_STEPS.has(step);

const ARTIFACT_PATHS = [
  'workspace/infra/pooler.ini',
  'workspace/src/db/pool.ts',
  'workspace/services/notifications/config.json',
  'workspace/docs/runbook-pool.md',
  'workspace/infra/pgbouncer-userlist.txt'
] as const;

export const PROBES: readonly Probe[] = [
  {
    id: 'recall-owner-constraint',
    kind: 'recall',
    plantedAtStep: -1,
    askedAtStep: 55,
    question: 'What connection ceiling did the owner impose, and when does it apply?',
    reference: `${OWNER_GOAL_CONSTRAINT}.`,
    evidence: [OWNER_GOAL_CONSTRAINT],
    // The goal is never dropped by any pass, so nothing is ever re-read to recover it.
    reworkChars: 0
  },
  {
    id: 'recall-pool-ceiling',
    kind: 'recall',
    plantedAtStep: 4,
    askedAtStep: 12,
    question: 'What value was pool_max_conn set to in the configuration that was read earlier?',
    reference: 'pool_max_conn = 137.',
    evidence: ['pool_max_conn = 137'],
    reworkChars: 18_000
  },
  {
    id: 'recall-sqlstate',
    kind: 'recall',
    plantedAtStep: 10,
    askedAtStep: 14,
    question: 'Which SQLSTATE did the replica raise, and which replica raised it?',
    reference: 'SQLSTATE 53300 too_many_connections, on replica two.',
    evidence: ['SQLSTATE 53300 too_many_connections on replica two'],
    reworkChars: 12_000
  },
  {
    id: 'recall-migration-id',
    kind: 'recall',
    plantedAtStep: 33,
    askedAtStep: 41,
    question: 'Which migration applied the pool ceiling, and how long did it take?',
    reference: 'migration 0067, the pool ceiling, applied in 1420 ms.',
    evidence: ['migration 0067 pool ceiling applied in 1420 ms'],
    reworkChars: 12_000
  },
  {
    /**
     * Planted one step before it is asked for, which reads like a control and is not.
     *
     * At request time the tail of the window is not the assistant turn. `refreshRuntimeContext`
     * (agent.ts:9144, called at agent.ts:9798 on every step) removes and re-pushes the runtime
     * block at the very end, and `refreshActivePlan` and the step-budget notice push there too. So
     * the newest assistant message sits at least three from the end and often five, and the detail
     * boundary is `index < messages.length - RECENT_DETAIL_MESSAGES`.
     *
     * At 8 the current turn's own thinking is inside the window. At 2 it is outside it: the model
     * is asked to take its next step having had the thoughts that produced the last one deleted
     * from the request. That is not a defect - `openai-compatible.ts:781-793` already carries a
     * fallback for the inverse case, so nothing breaks - and it is precisely the kind of change
     * that passes 49/49 while altering what the model can think with.
     */
    id: 'recall-newest-reasoning',
    kind: 'recall',
    plantedAtStep: 26,
    askedAtStep: 27,
    question: 'What did the replica lag peak at during the dry run?',
    reference: '4812 ms.',
    evidence: ['replica lag peaked at 4812 ms during the dry run'],
    // Reasoning is the agent's own thinking. No tool call brings it back, at any price.
    reworkChars: 0
  },
  {
    id: 'decision-pooling-mode',
    kind: 'decision',
    plantedAtStep: 6,
    askedAtStep: 9,
    question: 'Which pooling mode was chosen, and what was the stated reason?',
    reference:
      'Transaction pooling, over session pooling, because each task opens four short-lived connections.',
    evidence: [
      'transaction pooling was chosen over session pooling because each task opens four short-lived connections'
    ],
    reworkChars: 0
  },
  {
    /**
     * The pair to `decision-pooling-mode`: one decision, stated once in thinking and once out
     * loud. Prose is not touched by the detail boundary at all, so the two together separate "the
     * detail window costs decisions" from the true and much narrower "the detail window costs
     * decisions the agent never said out loud".
     */
    id: 'decision-pooling-mode-prose',
    kind: 'decision',
    plantedAtStep: 6,
    askedAtStep: 9,
    question: 'Was session pooling used for the writer pool?',
    reference: 'No, it was ruled out.',
    evidence: ['session pooling was ruled out for the writer pool'],
    reworkChars: 0
  },
  {
    id: 'decision-notify-rejected',
    kind: 'decision',
    plantedAtStep: 18,
    askedAtStep: 21,
    question: 'Was LISTEN/NOTIFY adopted, and why?',
    reference:
      'No. It was rejected because transaction pooling drops the session that owns the listener.',
    evidence: [
      'LISTEN NOTIFY was rejected because transaction pooling drops the session that owns the listener'
    ],
    reworkChars: 0
  },
  {
    /**
     * The plan as the agent narrated it in prose at step 7. Prose is not state: nothing re-pushes
     * it, a compaction condenses it like any other turn, and what survives is whatever the
     * summariser chose to keep. Read against `continuation-plan-block` directly below, which is
     * the same question asked of the mechanism athanor actually maintains for this.
     */
    id: 'continuation-plan-order',
    kind: 'continuation',
    plantedAtStep: 7,
    askedAtStep: 30,
    question: 'What is step 5 of the plan agreed at the start of this task?',
    reference: 'Re-point the notifications service.',
    evidence: ['(5) re-point the notifications service'],
    reworkChars: 0
  },
  {
    /**
     * The same fact carried by the durable plan block instead. This is expected to score 5.0 in
     * every configuration on every window, and it is not a control - it is the finding: a fact
     * held in a re-rendered block is out of reach of every mechanism in `context.ts`, and a fact
     * held in the conversation is not. Anything a long task must not lose belongs in a block.
     */
    id: 'continuation-plan-block',
    kind: 'continuation',
    plantedAtStep: 2,
    askedAtStep: 55,
    question: 'According to the active plan, what is step 5?',
    reference: 'Re-point the notifications service.',
    // The status at step 55, not a guess: five plan versions have landed by then, so step 5 is
    // the one in progress. A probe that named the wrong status would score zero and read as a loss.
    evidence: ['5. [in_progress] Re-point the notifications service'],
    reworkChars: 0
  },
  {
    id: 'continuation-resume-next',
    kind: 'continuation',
    plantedAtStep: 44,
    askedAtStep: 47,
    question: 'What is the next action, and against which port?',
    reference: 'Re-point the notifications service at the pooler on port 6432.',
    evidence: ['re-point the notifications service at the pooler on port 6432'],
    reworkChars: 0
  },
  {
    /**
     * The probe the published work says is the worst of the four, at 2.45/5 for the winning
     * method, and the reason it names is structural rather than fixable by a better summary: a
     * running list of side effects is state, and a summariser is asked to write prose.
     */
    id: 'artifact-files-touched',
    kind: 'artifact',
    plantedAtStep: 8,
    askedAtStep: 45,
    question: 'List every file this task has written or modified so far.',
    reference: ARTIFACT_PATHS.join(', '),
    evidence: ARTIFACT_PATHS,
    // Recovering the set means listing the workspace and diffing it, not re-running one call.
    reworkChars: 4_000
  }
];

export interface Trajectory {
  readonly id: string;
  readonly why: string;
  readonly contextTokens: number;
  readonly steps: number;
  /** The step at which the agent declares a phase finished, as the two `long-` eval fixtures do. */
  readonly declaredCompactionStep: number | null;
  readonly probes: readonly Probe[];
}

/** The preamble `agent.ts:8586-8799` assembles, in its order and at its sizes. */
export const preambleFor = (): ModelMessage[] => [
  { role: 'system', content: BASE_SYSTEM_PROMPT },
  {
    role: 'system',
    content: `WORKSPACE BRIEF (user-visible persistent project context)\n${text(2_400, 'brief')}`
  },
  {
    role: 'system',
    content: `CURATED ENCRYPTED KNOWLEDGE (user-visible and review-controlled; frozen for this run)\n${text(3_600, 'knowledge')}`
  },
  {
    role: 'system',
    content: `RECALLED MEMORY PACK (retrieved once at task start)\n${text(3_250, 'pack')}`
  },
  {
    role: 'user',
    content: `Move every service off the direct database role and onto a connection pooler. ${OWNER_GOAL_CONSTRAINT}. ${text(400, 'goal')}`
  }
];

/** One step's assistant turn and the result that answers it, identical for every configuration. */
export interface TrajectoryStep {
  readonly assistant: ModelMessage;
  readonly result: ModelMessage;
}

/**
 * The seeded size sequence, reproduced exactly for every configuration.
 *
 * Drawn per step from one seed rather than from a shared generator, so a run that scores a subset
 * of steps produces the same sizes as a run that scores all of them.
 */
const sizeAt = (step: number): number => {
  let seed = 20_260_303;
  for (let index = 0; index <= step; index += 1)
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return RESULT_SIZES[Math.floor((seed / 2_147_483_648) * RESULT_SIZES.length)] ?? 6_400;
};

export const stepAt = (step: number): TrajectoryStep => {
  const plant = PLANTS.get(step);
  const write = plant?.write;
  let prose = text(420, `answer-${step}`);
  if (plant?.prose) prose = embed(prose, plant.prose, 0.2);
  let reasoning = text(1_200, `thinking-${step}`);
  if (plant?.reasoning) reasoning = embed(reasoning, plant.reasoning, 0.3);

  const assistant: ModelMessage = {
    role: 'assistant',
    content: prose,
    reasoning,
    reasoningDetails: [{ type: 'reasoning.text', text: text(900, `detail-${step}`) }],
    toolCalls: [
      write
        ? {
            id: `call-${step}`,
            name: 'file_write',
            arguments: { path: write.path, content: text(write.bytes, `written-${step}`) }
          }
        : // Every seventh call carries arguments past COMPACTED_TOOL_ARGUMENT_CHARS, so the
          // argument half of the detail boundary is crossed as well as the reasoning half.
          step % 7 === 6
          ? {
              id: `call-${step}`,
              name: 'code_search',
              arguments: {
                pattern: `connect\\(${step}\\)`,
                note: text(6_000, `why-${step}`)
              }
            }
          : {
              id: `call-${step}`,
              name: 'file_read',
              arguments: {
                path: `workspace/logs/service-${step}.log`,
                note: text(180, `why-${step}`)
              }
            }
    ]
  };

  const chars = write ? write.resultChars : sizeAt(step);
  let body = text(chars, write ? `wrote-${step}` : `log-${step}`);
  if (plant?.resultHead) body = embed(body, plant.resultHead, 0.05);
  if (plant?.resultMiddle) body = embed(body, plant.resultMiddle, 0.5);

  const result: ModelMessage = {
    role: 'tool',
    toolCallId: `call-${step}`,
    content: serializeToolResultForModel(
      write
        ? { ok: true, path: write.path, bytesWritten: write.bytes, content: body }
        : {
            ok: true,
            path: `workspace/logs/service-${step}.log`,
            lines: Math.floor(chars / 80),
            content: body
          }
    )
  };
  return { assistant, result };
};

/**
 * The same sixty-step script on both shipped context windows, and once with nothing declared.
 *
 * The two window sizes disagree on purpose: the small window's older-result floor descends all the
 * way to 2,000 characters and re-cuts every older result on the way, the large one's barely moves.
 * A configuration that costs quality on one and nothing on the other is exactly the shape the last
 * three briefed changes to `context.ts` turned out to have.
 *
 * The undeclared row separates the two mechanisms. With a declaration the window is condensed into
 * the running brief - content leaves the window and only what the summariser wrote survives. With
 * none, nothing is condensed and every loss is truncation. They fail differently and a single row
 * would report their sum.
 */
export const TRAJECTORIES: readonly Trajectory[] = [
  {
    id: 'pool-migration-131k',
    why: 'The smallest shipped window, where the older-result floor descends all the way. Both mechanisms run.',
    contextTokens: 131_072,
    steps: 60,
    declaredCompactionStep: 30,
    probes: PROBES
  },
  {
    id: 'pool-migration-1m',
    why: 'The largest shipped window, where the floor barely moves and the detail boundary is almost the only thing cutting.',
    contextTokens: 1_000_000,
    steps: 60,
    declaredCompactionStep: 30,
    probes: PROBES
  },
  {
    id: 'pool-migration-131k-uncompacted',
    why: 'The same job with the phase never declared, so nothing is condensed and every loss is truncation alone.',
    contextTokens: 131_072,
    steps: 60,
    declaredCompactionStep: null,
    probes: PROBES
  }
];
