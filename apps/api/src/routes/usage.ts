/**
 * What has been spent, and the ceilings the owner has set on spending it.
 *
 * Reading is `usage:read`; raising a ceiling is not something an automation token gets to do at
 * all - that is the owner deciding how much of their own money the agent may spend.
 */

import { UpdateSpendLimitsRequest } from '@athanor/contracts';
import { AthanorError, storageThreshold } from '@athanor/core';
import { ownerPriceCeiling } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { currentPeriod, serverLimits } from '../plans.js';

export const registerUsageRoutes = (context: RouteContext): void => {
  const { app, store, meterWorkspace, providerSpend, requireRecentStepUp, idempotent } = context;
  app.get('/v1/usage', async (request) => {
    const user = requireUser(request.user);
    const period = currentPeriod();
    const workspaces = await store.listWorkspaces(user.id);
    await Promise.all(workspaces.map(meterWorkspace));
    const totals = await store.usageTotals(user.id, period.start, period.end);
    // Re-read after metering: the records above were fetched before the walk, so summing them
    // reported the figure from the previous visit to this pane rather than the one just measured.
    const storageBytes = (await store.listWorkspaces(user.id)).reduce(
      (sum, item) => sum + item.storageBytes,
      0
    );
    return {
      period: { start: period.start.toISOString(), end: period.end.toISOString() },
      totals,
      providerSpend: await providerSpend(user.id),
      storageBytes,
      storageLimitBytes: serverLimits.storageBytes,
      storageThreshold: storageThreshold(storageBytes, serverLimits.storageBytes),
      history: await store.usageHistory(user.id)
    };
  });

  /**
   * Compute credits are a scheduling unit whose dollar value moves with the model class, so they
   * can never answer "stop before this costs me more than X". These three routes are that answer:
   * what the caps are, what has been spent against them, and where it went.
   */
  app.get('/v1/spend-limits', async (request) =>
    store.effectiveSpendLimits(requireUser(request.user).id)
  );

  app.put('/v1/spend-limits', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = UpdateSpendLimitsRequest.parse(request.body);
      /*
       * A passkey to loosen the brake, nothing to tighten it.
       *
       * Adding a device needs a passkey and reading an export needs a passkey, while removing the
       * one control standing between the owner and an unbounded provider bill needed only an
       * unlocked browser. Asking on every edit would be friction on a routine adjustment, and the
       * direction is what matters: raising a ceiling or clearing it is the escalation, lowering one
       * cannot hurt. A cap that was null is already unlimited, so setting a number there is a
       * tightening even though it "changes" the value.
       *
       * And a ceiling nobody has chosen is not one the owner is loosening.
       *
       * `current` is `effectiveSpendLimits`, so since the monthly cap acquired a default, `was` on a
       * fresh box is this box's own guess rather than the owner's decision - and the first answer to
       * the ceiling question, which is a decline, is sent as explicit nulls. Without the exemption
       * below that answer is a clearing, and saying "no ceiling, thank you" on a box that has never
       * been asked anything else costs a biometric prompt. The epoch stamp is the test, and it is
       * the same one the question itself uses to decide it is still owed.
       *
       * The exemption cannot cost anything, and the reason is arithmetic rather than judgement: a
       * box that has never saved a limit had no cap at all until this default existed, and this PUT
       * asked for no passkey then either. Waving it through cannot leave such a box worse off than
       * the version that shipped without a default. One saved answer in either direction moves
       * `updatedAt` off the epoch, and from then on every loosening asks, exactly as it does now.
       */
      const stored = await store.effectiveSpendLimits(user.id);
      const current = { ...stored, ...ownerPriceCeiling(stored) };
      const everAnswered = Date.parse(stored.updatedAt) > 0;
      const loosens = (was: number | null, next: number | null | undefined): boolean =>
        next !== undefined && (next === null ? was !== null : was !== null && next > was);
      if (
        everAnswered &&
        (loosens(current.dailyCapUsd, input.dailyCapUsd) ||
          loosens(current.monthlyCapUsd, input.monthlyCapUsd) ||
          loosens(current.defaultTaskCapUsd, input.defaultTaskCapUsd) ||
          // The price ceiling is the same brake read the other way round, so it is the same test: a
          // ceiling that was null admits every route already, and raising one admits routes that were
          // refused a moment ago. Both are the escalation, and `loosens` computes exactly that
          // without a new predicate.
          loosens(current.maxInputUsdPerMillionTokens, input.maxInputUsdPerMillionTokens) ||
          loosens(current.maxOutputUsdPerMillionTokens, input.maxOutputUsdPerMillionTokens))
      )
        await requireRecentStepUp(request, user);
      try {
        // An omitted field is left alone and an explicit null clears that cap, so an absent key is
        // forwarded as an absent key rather than as undefined.
        await store.setSpendLimits({
          userId: user.id,
          ...(input.dailyCapUsd !== undefined ? { dailyCapUsd: input.dailyCapUsd } : {}),
          ...(input.monthlyCapUsd !== undefined ? { monthlyCapUsd: input.monthlyCapUsd } : {}),
          ...(input.defaultTaskCapUsd !== undefined
            ? { defaultTaskCapUsd: input.defaultTaskCapUsd }
            : {}),
          ...(input.warnAtPercent !== undefined ? { warnAtPercent: input.warnAtPercent } : {}),
          ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
          // Never `?? null`: for a ceiling, zero is a real setting - "only a route that publishes no
          // charge" - and an explicit null is the owner removing the ceiling. Collapsing the two
          // here is how a PUT stores a value and answers without it.
          ...(input.maxInputUsdPerMillionTokens !== undefined
            ? { maxInputUsdPerMillionTokens: input.maxInputUsdPerMillionTokens }
            : {}),
          ...(input.maxOutputUsdPerMillionTokens !== undefined
            ? { maxOutputUsdPerMillionTokens: input.maxOutputUsdPerMillionTokens }
            : {})
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Unknown IANA time zone'))
          throw new AthanorError('invalid_time_zone', 'Choose a valid IANA time zone');
        throw error;
      }
      return store.effectiveSpendLimits(user.id);
    });
  });

  app.get('/v1/spend', async (request) => store.spendSummary(requireUser(request.user).id));
};
