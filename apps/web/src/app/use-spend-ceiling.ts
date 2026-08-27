import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { describeFailure } from '../failure-text.js';
import {
  formatUsd,
  spendCeilingAnswer,
  spendCeilingAsk,
  type SpendCeilingAsk
} from '../usage-model.js';

/**
 * The one question about money that nothing on an existing box has ever put to its owner.
 *
 * A ceiling is asked for when a provider key is saved, which is the right moment and reaches
 * nobody who saved their key before that existed - so on every box that already had an owner on
 * it, all three caps are null, the guard builds no window for a null cap, and the whole
 * DST-correct machinery refuses nothing while the box spends. The setting is reachable, in
 * Settings under Model & spending; an owner who never opens it never learns the question exists.
 *
 * The evidence is already in the bootstrap this screen has: what the provider charged today and
 * this month. Only when that is more than nothing does this go and ask the caps route whether
 * anybody has ever answered - so a box that has spent nothing makes no request and shows nothing,
 * which is right on both counts, because it has no evidence and therefore nothing to say.
 */
export const useSpendCeiling = (input: {
  spentTodayUsd: number;
  spentThisMonthUsd: number;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) => {
  const { spentTodayUsd, spentThisMonthUsd, onNotice, onError } = input;
  /**
   * The question about a ceiling, when this box owes it, plus what is in its field.
   *
   * Null covers both "not asked yet" and "answered", because the two look the same from here: the
   * question is put once and then never again. See `spendCeilingAsk` for what has to be true for it
   * to exist at all.
   */
  const [ask, setAsk] = useState<SpendCeilingAsk | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  /* Asked at most once a session. The answer can only arrive from here or from the settings screen,
     and that one says so when it closes; polling for it would be this screen waiting to interrupt. */
  const checked = useRef(false);
  const [probe, setProbe] = useState(0);
  useEffect(() => {
    if (checked.current || !(spentThisMonthUsd > 0)) return;
    checked.current = true;
    /*
     * Deliberately without a cleanup that abandons the answer in flight.
     *
     * These figures move whenever a turn settles a charge, which on the box this exists for is
     * while the request is open - and dropping the reply on that would be dropping it for good,
     * because the ref above has already spent the one ask this session gets. Nothing here writes
     * anything that has to be undone, and a state write after this screen is gone is a no-op.
     */
    void api
      .spendLimits()
      .then((limits) => {
        const next = spendCeilingAsk(limits, {
          monthlyUsd: spentThisMonthUsd,
          dailyUsd: spentTodayUsd
        });
        setAsk(next);
        if (next) setDraft(String(next.suggestedUsd));
      })
      // A box too old for the caps route enforces none, and saying so here would be a second
      // strip about a setting this server does not have.
      .catch(() => undefined);
  }, [spentThisMonthUsd, spentTodayUsd, probe]);

  /**
   * The answer, in either direction, written once.
   *
   * Both answers are a tightening as far as the server is concerned - every cap was null - so
   * neither asks for a passkey, and declining lands a row whose timestamp is what stops this being
   * asked again. The zone travels with it because until somebody answers, "today" on this box is a
   * UTC day rather than the owner's, and every daily figure they have been shown was measured in it.
   */
  const answer = async (typed: string) => {
    const body = spendCeilingAnswer(typed, Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (!body) {
      onError('A ceiling is an amount in dollars. Leave it empty for none.');
      return;
    }
    setBusy(true);
    try {
      const saved = await api.updateSpendLimits(body);
      setAsk(null);
      onNotice(
        saved.monthlyCapUsd === null
          ? 'No ceiling. Nothing stops a run on this box; Model & spending is where that changes.'
          : `Work stops at ${formatUsd(saved.monthlyCapUsd)} a month, ${formatUsd(saved.dailyCapUsd ?? 0)} in a day.`
      );
    } catch (cause) {
      onError(describeFailure(cause, 'That ceiling could not be saved'));
    } finally {
      setBusy(false);
    }
  };

  /* Spending caps are on the settings screen, so its closing is the one moment the answer can have
     changed without this being the thing that changed it. */
  const recheck = useCallback(() => {
    setAsk(null);
    checked.current = false;
    setProbe((count) => count + 1);
  }, []);

  return { ask, draft, setDraft, busy, answer, recheck };
};
