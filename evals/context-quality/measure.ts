/**
 * Drives one trajectory through athanor's production context path at one configuration, and comes
 * back with both axes: what the prompt cache got, and what the model lost.
 *
 * The loop below is the step loop `agent.ts:9249-9337` runs, in its order: the runtime block is
 * removed and re-pushed at the tail, a declared phase or an over-budget window is compacted first,
 * `prepareModelContext` is given the previous step's older-result floor, and it is the PREPARED
 * size - not the raw window - that the compaction trigger is measured against. Getting that order
 * wrong is how a rig reports automatic compaction firing on a run where production would not fire
 * it once, which is the state the plan's own numbers were quoted from.
 *
 * Both axes come off the same run, deliberately. Wave 0 priced the cache side and this step was
 * briefed to price the quality side, and two numbers measured on two different fixtures cannot be
 * put in one table honestly - the shred fixture's 20 kB-uniform results are why the plan's tool
 * boundary looked like the dominant one and the detail boundary turned out to be. So the cache
 * measurement here is Wave 0's, reproduced against this fixture, and a row's cache gain and its
 * quality cost are always the same sixty requests.
 *
 * ── tokens per task, which is the number that decides anything ────────────────────────────────
 *
 * Compression ratio is a misleading target: a configuration that saves 20% per request and forces
 * three more round trips is a loss. So the headline cost is the whole task - every request's
 * prompt summed, plus what re-obtaining a lost fact costs.
 *
 * The rework model is deliberately small and stated rather than tuned: a probe whose evidence is
 * gone at the step the task needed it costs one extra round trip, priced at that step's whole
 * prompt plus the re-read result. It is a model, not a measurement, and it is charged ONLY for
 * losses a tool call can actually repair. A decision the model reasoned its way to and no longer
 * has is not a re-read at any price; those are counted separately as unrecoverable, and no token
 * figure should ever be allowed to imply they were paid for.
 */
import {
  MAX_CACHE_BREAKPOINTS,
  type ModelMessage
} from '../../packages/model-gateway/src/index.js';

import { agentToolsFor } from '../../apps/worker/src/tools.js';
import type { ContextBrief } from '../../apps/worker/src/context.js';
import { contextModuleFor, type ContextConfiguration } from './configurations.js';
import {
  judgeCeiling,
  readProbe,
  readableWindow,
  type Probe,
  type ProbeReading
} from './probes.js';
import {
  activePlanBlock,
  isPlanStep,
  preambleFor,
  stepAt,
  type Trajectory
} from './trajectories.js';

/**
 * Mirrors `BLOCK_CONTENT_ROLES` at `openai-compatible.ts:91`, which is private to the adapter. If
 * the two ever disagree this rig is measuring a request no adapter would send, so the copy is
 * named for what it is rather than quietly inlined.
 */
const CACHE_MARKER_ROLES = new Set<ModelMessage['role']>(['system', 'user', 'tool']);

/** One message in the shape `openai-compatible.ts:716-744` puts it on the wire. */
const onTheWire = (message: ModelMessage, marked: boolean): Record<string, unknown> => ({
  role: message.role,
  content: marked
    ? [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }]
    : message.content,
  ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
  ...(message.reasoning ? { reasoning: message.reasoning } : {}),
  ...(message.reasoningDetails?.length ? { reasoning_details: message.reasoningDetails } : {}),
  ...(message.toolCalls?.length
    ? {
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) }
        }))
      }
    : {})
});

const commonPrefix = (left: string, right: string): number => {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
};

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

/**
 * The summariser every configuration compacts with.
 *
 * Extractive and deterministic on purpose. A compaction calls a model in production, and a rig
 * that called one here would make every row's brief a different sample - so two configurations
 * would differ for a reason that has nothing to do with either of them, and the comparison would
 * be worthless. What it does is what a summariser's bias actually is: it keeps the front of every
 * transcript line and drops the rest, so agent prose and tool-call arguments survive and the
 * middle of a tool result does not.
 *
 * It is never given the probes, the questions or the answers. Judged mode replaces it with the
 * real summarising model, which is where the quality of athanor's actual brief is measured; this
 * is the floor beneath it.
 */
export const extractiveSummariser = ({ transcript }: { transcript: string }): Promise<string> => {
  const lines: string[] = [];
  let budget = 3_000;
  for (const line of transcript.split('\n')) {
    if (budget <= 0) break;
    const kept = line.slice(0, Math.min(240, budget));
    lines.push(kept);
    budget -= kept.length + 1;
  }
  return Promise.resolve(lines.join('\n'));
};

export interface StepMeasurement {
  readonly step: number;
  /** Prompt tokens for this request: the prepared window plus the catalogue in front of it. */
  readonly promptTokens: number;
  /** Byte-common prefix with the previous request, catalogue included. */
  readonly prefixShare: number;
  /** The share of this request a provider could serve at the breakpoints the request carries. */
  readonly cacheReadShare: number;
  readonly floor: number;
  readonly cacheBreakpoints: number;
  /** Whether the newest assistant turn still carries the thinking that produced it. */
  readonly newestReasoningPresent: boolean;
  /** How far from the tail that assistant message sits once the tail blocks are pushed. */
  readonly newestAssistantFromTail: number;
  readonly compactedFirst: boolean;
}

export interface ProbeOutcome {
  readonly probe: Probe;
  /** Availability at the step the trajectory needed it. */
  readonly atAsk: ProbeReading;
  /** Mean availability over every step from planting to the end of the run. */
  readonly survival: number;
  /** Steps after planting for which the evidence was still wholly present. */
  readonly survivedSteps: number;
  /** The window this probe was asked against, kept for judged mode. */
  readonly windowAtAsk: readonly ModelMessage[];
}

export interface Measurement {
  readonly trajectoryId: string;
  readonly configurationId: string;
  readonly steps: readonly StepMeasurement[];
  readonly probes: readonly ProbeOutcome[];
  readonly compactions: number;
  readonly budgetCompactions: number;
  readonly promptTokensTotal: number;
  readonly peakPromptTokens: number;
  readonly meanPrefixShare: number;
  readonly meanCacheReadShare: number;
  readonly reservedTokens: number;
  /** Steps on which the current turn's own thinking was still in the request. */
  readonly newestReasoningSteps: number;
  /** Extra prompt the task pays to fetch back what it lost. See the header. */
  readonly reworkTokens: number;
  /** Losses no tool call can repair, counted rather than priced. */
  readonly unrecoverableLosses: number;
}

export const tokensPerTask = (measurement: Measurement): number =>
  measurement.promptTokensTotal + measurement.reworkTokens;

/** Mean availability at the asked step, on the judge's 0-5 scale. See `judgeCeiling`. */
export const meanCeiling = (measurement: Measurement, kind?: Probe['kind']): number => {
  const chosen = measurement.probes.filter((outcome) => !kind || outcome.probe.kind === kind);
  if (!chosen.length) return Number.NaN;
  return (
    Math.round(mean(chosen.map((outcome) => judgeCeiling(outcome.atAsk.retained))) * 100) / 100
  );
};

export const measure = async (
  trajectory: Trajectory,
  configuration: ContextConfiguration
): Promise<Measurement> => {
  const context = await contextModuleFor(configuration);
  const tools = [...agentToolsFor(), context.COMPACT_CONTEXT_TOOL];
  const catalogueOnTheWire = JSON.stringify(
    tools.map((tool) => ({ type: 'function', function: tool }))
  );
  const reservedTokens = Math.ceil(JSON.stringify(tools).length / 4);
  const maxOutputTokens = Math.min(
    16_384,
    Math.max(2_048, Math.floor(trajectory.contextTokens * 0.2))
  );
  const budget = context.modelInputBudget(
    trajectory.contextTokens,
    maxOutputTokens,
    reservedTokens
  );

  const messages = preambleFor();
  let brief: ContextBrief | undefined;
  let floor: number | undefined;
  let preparedTokens: number | undefined;
  let previous: { pieces: string[]; bytes: string } | null = null;
  let compactions = 0;
  let budgetCompactions = 0;

  const steps: StepMeasurement[] = [];
  const readings = new Map<string, ProbeReading[]>();
  const atAsk = new Map<string, { reading: ProbeReading; window: ModelMessage[] }>();

  for (let step = 0; step < trajectory.steps; step += 1) {
    // The plan block first, then the runtime block, which is the order agent.ts:9793-9799 pushes
    // them in. A plan step therefore puts the newest assistant one position further from the tail
    // than an ordinary step does, and the detail boundary is counted from the tail.
    if (isPlanStep(step)) {
      for (let index = messages.length - 1; index >= 0; index -= 1)
        if (messages[index]?.content.startsWith('ACTIVE USER-VISIBLE PLAN'))
          messages.splice(index, 1);
      messages.push(activePlanBlock(step));
    }
    // Last of the tail blocks and re-pushed every step, exactly as refreshRuntimeContext does -
    // and the reason the newest assistant message is never the last message in the window.
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const held = messages[index];
      if (held && context.isRuntimeContext(held)) messages.splice(index, 1);
    }
    messages.push({
      role: 'system',
      content: context.runtimeContext(
        { name: 'athanor', securityMode: 'balanced' },
        'https://preview.example.com',
        { now: new Date(Date.UTC(2026, 2, 3, 9, 15) + step * 45_000), timeZone: 'Europe/London' },
        'python3 3.11, typst 0.12, libreoffice 24.2',
        false,
        'in_house'
      )
    });

    const declared = step === trajectory.declaredCompactionStep;
    const overBudget =
      (preparedTokens ?? context.estimatedContextTokens(messages)) >
      context.compactionTrigger(budget);
    let compactedFirst = false;
    if (declared || overBudget) {
      const outcome = await context.compactContext({
        messages,
        ...(brief ? { brief } : {}),
        targetTailTokens: declared
          ? context.declaredCompactionTargetTail(budget, context.estimatedContextTokens(messages))
          : context.compactionTargetTail(budget),
        transcriptChars: 80_000,
        citableFooter: `Citable toolCallIds from this turn, for finish: call-${step - 1} (file_read).`,
        summarise: extractiveSummariser
      });
      if (outcome) {
        messages.splice(0, messages.length, ...outcome.messages);
        brief = outcome.brief;
        compactions += 1;
        if (!declared) budgetCompactions += 1;
        compactedFirst = true;
      }
    }

    const prepared = context.prepareModelContext(
      messages,
      trajectory.contextTokens,
      maxOutputTokens,
      {
        precedingTokens: reservedTokens,
        reservedTokens,
        ...(floor === undefined ? {} : { toolOutputFloor: floor })
      }
    );
    floor = prepared.olderToolOutputChars;
    preparedTokens = prepared.estimatedInputTokens;

    const marked = prepared.messages
      .flatMap((message, index) =>
        message.cacheBreakpoint && CACHE_MARKER_ROLES.has(message.role) && !message.images?.length
          ? [index]
          : []
      )
      .slice(-MAX_CACHE_BREAKPOINTS);
    // Compared without the cache hint: the marker moves without moving the content a provider
    // hashes. The catalogue leads, because that is where it sits in the cached prefix on both
    // routes that bill breakpoints, whatever order the JSON body happens to carry its keys in.
    const pieces = prepared.messages.map((message) => JSON.stringify(onTheWire(message, false)));
    const bytes = catalogueOnTheWire + pieces.join(',');

    // A position, not a byte offset: a readable breakpoint has to be a message index.
    let firstDiffering = 0;
    if (previous)
      while (
        firstDiffering < pieces.length &&
        firstDiffering < previous.pieces.length &&
        pieces[firstDiffering] === previous.pieces[firstDiffering]
      )
        firstDiffering += 1;
    const readableBreakpoint = previous
      ? marked.reduce((found, candidate) => (candidate < firstDiffering ? candidate : found), -1)
      : -1;

    const newestAssistant = prepared.messages.reduce(
      (found, message, index) => (message.role === 'assistant' ? index : found),
      -1
    );
    const newest = newestAssistant < 0 ? undefined : prepared.messages[newestAssistant];

    steps.push({
      step,
      promptTokens: prepared.estimatedInputTokens + reservedTokens,
      prefixShare: previous ? commonPrefix(bytes, previous.bytes) / bytes.length : 0,
      cacheReadShare:
        readableBreakpoint < 0
          ? 0
          : (catalogueOnTheWire + pieces.slice(0, readableBreakpoint + 1).join(',')).length /
            bytes.length,
      floor,
      cacheBreakpoints: prepared.cacheBreakpoints,
      newestReasoningPresent: !!(newest?.reasoning || newest?.reasoningDetails?.length),
      newestAssistantFromTail:
        newestAssistant < 0 ? -1 : prepared.messages.length - newestAssistant,
      compactedFirst
    });
    previous = { pieces, bytes };

    const window = readableWindow(prepared.messages);
    for (const probe of trajectory.probes) {
      if (step < probe.plantedAtStep) continue;
      const reading = readProbe(probe, window, step);
      const list = readings.get(probe.id) ?? [];
      list.push(reading);
      readings.set(probe.id, list);
      if (step === probe.askedAtStep)
        atAsk.set(probe.id, {
          reading,
          window: prepared.messages.map((message) => ({ ...message }))
        });
    }

    const { assistant, result } = stepAt(step);
    messages.push(assistant, result);
  }

  const probes: ProbeOutcome[] = trajectory.probes.map((probe) => {
    const list = readings.get(probe.id) ?? [];
    const asked = atAsk.get(probe.id);
    if (!asked)
      throw new Error(
        `probe ${probe.id} is asked at step ${probe.askedAtStep}, which ${trajectory.id} never reaches`
      );
    let survivedSteps = 0;
    for (const reading of list) {
      if (reading.retained < 1) break;
      survivedSteps += 1;
    }
    return {
      probe,
      atAsk: asked.reading,
      survival: mean(list.map((reading) => reading.retained)),
      survivedSteps,
      windowAtAsk: asked.window
    };
  });

  const promptAt = (step: number): number =>
    steps.find((measurement) => measurement.step === step)?.promptTokens ?? 0;
  let reworkTokens = 0;
  let unrecoverableLosses = 0;
  for (const outcome of probes) {
    if (outcome.atAsk.retained >= 1) continue;
    if (outcome.probe.reworkChars > 0)
      reworkTokens +=
        promptAt(outcome.probe.askedAtStep) + Math.ceil(outcome.probe.reworkChars / 4);
    else unrecoverableLosses += 1;
  }

  return {
    trajectoryId: trajectory.id,
    configurationId: configuration.id,
    steps,
    probes,
    compactions,
    budgetCompactions,
    promptTokensTotal: steps.reduce((sum, measurement) => sum + measurement.promptTokens, 0),
    peakPromptTokens: steps.reduce(
      (peak, measurement) => Math.max(peak, measurement.promptTokens),
      0
    ),
    // The first step has no predecessor, so it has no prefix and no readable breakpoint; including
    // its zeroes would drag both means down by a sixtieth for no reason anyone could act on.
    meanPrefixShare: mean(steps.slice(1).map((measurement) => measurement.prefixShare)),
    meanCacheReadShare: mean(steps.slice(1).map((measurement) => measurement.cacheReadShare)),
    reservedTokens,
    newestReasoningSteps: steps.filter((measurement) => measurement.newestReasoningPresent).length,
    reworkTokens,
    unrecoverableLosses
  };
};
