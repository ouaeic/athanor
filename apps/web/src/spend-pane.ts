import { meterPercent, type SpendMeter, type SpendRow } from './usage-model.js';
import type { SpendSummary, SpendWindowState } from './types.js';

/*
 * The two figures the usage pane grew, kept out of `usage-model.ts` on purpose.
 *
 * That module is reached by the first paint - the sidebar, the composer strip and the transcript
 * all read a formatter out of it - so everything declared there is eager whether the screen that
 * uses it is or not. Nothing here is: the pane is behind Settings, which is behind `lazy`, and this
 * module has exactly one importer. The rule the whole wave runs under is that a new surface costs
 * the first paint nothing, and this is what that costs to keep.
 */

/**
 * What the conversation in front of the owner is spending, and the ceiling it is spending under.
 *
 * A task row carries both, which is why nothing here is added up from the transcript: `spentUsd` is
 * the server's settled total for that conversation, and `maxSpendUsd` is the ceiling
 * `resolveSpendCeiling` wrote when the work was created — so an account-wide per-conversation cap
 * is already folded into it, and a null means there is genuinely nothing bounding this run rather
 * than that the account sets no default.
 */
export interface ConversationSpend {
  spentUsd: number;
  maxSpendUsd: number | null;
}

/**
 * The state a window is in, for the one window the server does not evaluate for this pane.
 *
 * It is the rule `evaluateSpendCaps` applies, in the single case this pane is ever in: nothing in
 * flight and nothing being asked about, so what is projected is what has already been spent. The
 * server remains the authority — this decides which of three words a card is drawn in, not whether
 * any work runs.
 */
const meterState = (
  spentUsd: number,
  capUsd: number | null,
  warnAtPercent: number
): SpendWindowState => {
  if (capUsd === null) return 'ok';
  if (spentUsd > capUsd) return 'exceeded';
  return spentUsd >= (capUsd * warnAtPercent) / 100 ? 'warning' : 'ok';
};

/**
 * The conversation's own window, to stand beside the wall-clock three.
 *
 * Two sources, ordered by which is authoritative rather than by which usually answers. `/v1/spend`
 * asks the guard without a conversation (`packages/data/src/store/billing.ts`), so no summary
 * carries a `task` window today — but the shape allows one, and a server that starts sending it has
 * counted the money still in flight and evaluated the state itself, neither of which can be done as
 * well from here. The task row is what answers now: the same two figures, read off the conversation
 * the pane already has in hand.
 */
export const conversationMeter = (
  spend: SpendSummary | null,
  conversation: ConversationSpend | null
): SpendMeter | null => {
  const label = 'This conversation';
  const task = spend?.windows.find((item) => item.name === 'task');
  if (task)
    return {
      id: 'task',
      label,
      spentUsd: task.spentUsd,
      capUsd: task.capUsd,
      pendingUsd: task.pendingUsd,
      state: task.state,
      percent: meterPercent(task.spentUsd, task.capUsd),
      resetsAt: task.endsAt
    };
  if (!conversation) return null;
  return {
    id: 'task',
    label,
    spentUsd: conversation.spentUsd,
    capUsd: conversation.maxSpendUsd,
    // Nothing here knows what this conversation has promised and not yet spent; the summary that
    // would is the branch above. Zero is what the card then leaves unsaid rather than a claim.
    pendingUsd: 0,
    // A hundred rather than a warn threshold invented here: without the owner's own percentage
    // there is no soft line to draw, so only the hard one is.
    state: meterState(
      conversation.spentUsd,
      conversation.maxSpendUsd,
      spend?.limits.warnAtPercent ?? 100
    ),
    percent: meterPercent(conversation.spentUsd, conversation.maxSpendUsd),
    // A conversation's window is bounded by the conversation and not by the clock, so it never
    // resets and the card says nothing about when it does.
    resetsAt: null
  };
};

/**
 * A `YYYY-MM-DD` key out of the server's daily series, as a date a person reads.
 *
 * The parts are pulled apart and handed to a local `Date` rather than parsed from the string,
 * because `new Date('2026-08-01')` is UTC midnight by specification - which renders as 31 July for
 * every owner west of Greenwich, on the one surface whose whole job is to say which day the money
 * went on.
 */
export const dayLabel = (key: string): string => {
  const [year, month, day] = key.split('-').map(Number);
  if (!year || !month || !day) return key;
  const at = new Date(year, month - 1, day);
  return Number.isNaN(at.getTime())
    ? key
    : at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/**
 * The day-by-day series the server already computes, newest first and cut to what a pane can read.
 *
 * `store.spendByDay` groups in the owner's own zone, which is what makes a day here the same day
 * the daily cap is measured over; the series runs a month back and this shows the near end of it,
 * because the question it answers is whether last night was unlike the nights before it.
 *
 * Days with nothing billed are absent from the series rather than present at zero, and none is
 * invented for them: a run of empty days is the shape of a box that was idle, and a bar drawn for
 * each would be this pane making up a figure the server did not send.
 */
export const spendDays = (spend: SpendSummary | null, limit = 14): SpendRow[] =>
  spend
    ? [...spend.byDay]
        .reverse()
        .slice(0, limit)
        .map((bucket) => ({ ...bucket, label: dayLabel(bucket.key) }))
    : [];
