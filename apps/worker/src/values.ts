/**
 * Reading a value out of something a model wrote.
 *
 * Every tool argument, every tool result and every field of a connector's reply arrives as
 * `unknown`: the model was asked for a shape, not held to one. Nine tool arms and the turn loop
 * each need the same three answers - what is this as text, is this an object at all, and how many
 * times does this string occur - and before Wave 6 put those arms in adjacent files nobody could
 * see that they were being answered three different ways.
 *
 * `canonicalJson` is here rather than beside either of its two callers because they are in
 * different modules and both depend on it agreeing with itself: the approval hash and the failing
 * call key both key on this exact serialisation, and two copies would be two keys.
 *
 * Lifted out of `agent.ts` unchanged by Wave 7.1.
 */
import { randomUUID } from 'node:crypto';
import type { TaskPlanStep } from '@athanor/contracts';
import { AthanorError } from '@athanor/core';
import type { ModelMessage } from '@athanor/model-gateway';
import { SKILL_BODY_HEADINGS } from './skills.js';

/**
 * A scalar a model or a runner wrote, read as text - and the only function in this package that
 * answers that question.
 *
 * There were three of it, all spelled `textValue`, all with the same signature, and they did not
 * agree:
 *
 *   - here: string, number, boolean, bigint -> text; anything else -> the fallback
 *   - `surface-actions.ts`: the same minus bigint, so a bigint became the fallback
 *   - `acceptance.ts`: string and number only, so a **boolean became the fallback**
 *
 * The split ran straight through the approval path. `approval-policy.ts`, `approval-cards.ts`,
 * `write-classification.ts` and `command-classification.ts` - the four modules that decide what
 * card the owner is shown and what the floor does about a call - read arguments through the
 * surface-actions copy, while every arm that then *performs* the call read them through this one.
 * A verb the card resolved to `''` resolved to `'7'` for the arm. Nothing on the wire produces a
 * bigint today, so that half was latent rather than live; it was latent by luck, because the two
 * halves of one decision were being computed by two functions that nobody had put side by side.
 *
 * The acceptance copy was not latent. `parseAcceptanceChecks` coerces `args` with it and hands
 * the result both to the refusal gate and to the executor, so a check declared as
 * `{executable:'pytest', args:['--maxfail', false]}` ran as `pytest --maxfail ''` - the model's
 * own JSON, silently losing an argument at the moment the model claims the work is done.
 *
 * The widest reading wins because the narrow ones lose information without saying so: a scalar the
 * caller was handed becomes a fallback that looks exactly like an absent field. Nothing that reads
 * a value it was given should be able to disagree with anything else that reads the same value.
 */
export const textValue = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  return fallback;
};

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const previewUrl = (
  base: string,
  slug: string,
  accessToken?: string,
  entryPath?: string | null
): string => {
  const url = new URL(base);
  const basePath = url.pathname.replace(/\/+$/, '');
  if (basePath) {
    url.pathname = `${basePath}/${slug}/`;
  } else {
    url.hostname = `${slug}.${url.hostname}`;
    url.pathname = '/';
  }
  // Where the owner lands. A preview whose port really does serve its own root has none.
  if (entryPath)
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${entryPath.replace(/^\/+/, '')}`;
  url.search = '';
  url.hash = '';
  if (accessToken) url.searchParams.set('access', accessToken);
  return url.toString();
};

export const countOccurrences = (source: string, value: string): number => {
  if (!value) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(value, offset)) !== -1) {
    count += 1;
    offset += value.length;
  }
  return count;
};

export const boundedKnowledge = (value: unknown, maximum = 4_000): string => {
  const content = textValue(value).normalize('NFKC').trim();
  if (!content) throw new AthanorError('knowledge_empty', 'Knowledge content cannot be empty');
  if (content.length > maximum)
    throw new AthanorError(
      'knowledge_too_large',
      `Knowledge content must be ${maximum.toLocaleString()} characters or less`
    );
  if (
    [...content].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
    }) ||
    /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u.test(content)
  )
    throw new AthanorError(
      'knowledge_unsafe_text',
      'Knowledge cannot contain hidden control or bidirectional text'
    );
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S{12,}/i.test(
      content
    )
  )
    throw new AthanorError(
      'knowledge_secret_detected',
      'Keep credentials out of memory and skills; use a scoped connected service instead'
    );
  return content;
};

const skillName = (value: unknown): string => {
  const name = textValue(value).trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
    throw new AthanorError(
      'skill_name_invalid',
      'Skill names use lowercase words separated by hyphens and are at most 64 characters'
    );
  return name;
};

export const skillDocument = (
  input: Record<string, unknown>
): { name: string; description: string; content: string } => {
  const name = skillName(input.name);
  const description = boundedKnowledge(input.description, 240).replace(/\s+/g, ' ');
  const content = boundedKnowledge(input.content, 24_000);
  const missing = SKILL_BODY_HEADINGS.filter(
    (heading) => !new RegExp(`^#{1,3}\\s+${heading}\\s*$`, 'im').test(content)
  );
  if (missing.length)
    throw new AthanorError('skill_structure_invalid', `Skill is missing: ${missing.join(', ')}`);
  return { name, description, content };
};

/**
 * Which of the skills a task has opened still have their procedure readable in the window.
 *
 * `openSkill`'s `active` option answers a repeat view with a short `state="already_open"` stub
 * instead of the body, which is only ever the right answer while the body is still there to read.
 * Compaction drops whole messages - and `openedSkillsIn` in context.ts names the ones it took in
 * the brief and tells the model to reopen them, so answering that reopen with a stub would strand
 * the turn on instructions nothing in its window holds.
 *
 * Matched on the view call and the message that answered it rather than on the rendered block,
 * because the block reaches the window inside a JSON tool result with every quote escaped.
 */
export const openedSkillsStillReadable = (
  messages: readonly ModelMessage[],
  opened: readonly string[]
): string[] => {
  if (!opened.length) return [];
  const viewedBy = new Map<string, string>();
  const readable = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        if (call.name !== 'skill' || call.arguments.action !== 'view') continue;
        const id = textValue(call.arguments.id) || textValue(call.arguments.name);
        if (id) viewedBy.set(call.id, id);
      }
      continue;
    }
    if (message.role !== 'tool' || !message.toolCallId) continue;
    const id = viewedBy.get(message.toolCallId);
    // A stub is not a body. It is what a second view of an open skill returns, and it outlives the
    // body whenever a compaction takes the first view and leaves the second.
    if (id && !message.content.includes('already_open')) readable.add(id);
  }
  return opened.filter((name) => readable.has(name));
};

/** Stable key order, so a round trip through encrypted task state cannot change the digest. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${canonicalJson(record[name])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

export const MAX_PLAN_STEPS = 30;
const PLAN_STATUSES: readonly TaskPlanStep['status'][] = [
  'pending',
  'in_progress',
  'completed',
  'skipped'
];

/**
 * The plan panel is what a user watches during a long task, so a step the model reports as done
 * must be recorded as done. Each entry may be a bare title or `{title, status}`; an entry that
 * omits its status inherits the status the same title already had, because a model re-sending the
 * plan to add a step must not silently reset finished work to pending. Step ids are carried across
 * versions for unchanged titles so the panel follows one step instead of replacing the whole list.
 */
export const planStepsFromArguments = (
  value: unknown,
  previous: readonly TaskPlanStep[] = []
): TaskPlanStep[] => {
  const carried = new Map(previous.map((step) => [step.title, step]));
  const steps: TaskPlanStep[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const record =
      entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined;
    const title = textValue(record ? record.title : entry)
      .trim()
      .slice(0, 240);
    if (!title) continue;
    const reported = textValue(record?.status) as TaskPlanStep['status'];
    const inherited = carried.get(title);
    carried.delete(title);
    steps.push({
      id: inherited?.id ?? randomUUID(),
      title,
      status: PLAN_STATUSES.includes(reported) ? reported : (inherited?.status ?? 'pending')
    });
    if (steps.length === MAX_PLAN_STEPS) break;
  }
  return steps;
};
