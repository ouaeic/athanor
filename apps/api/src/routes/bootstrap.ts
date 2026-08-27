/**
 * One request that answers everything a client needs to draw its first screen.
 *
 * It exists so a cold start is one round-trip rather than nine, and so the answers cannot
 * disagree with each other: the model list, the spend, the search route and the conversation page
 * are all read inside it.
 */

import { decryptJson, unwrapDataKey } from '@athanor/core';
import type { WorkspaceRecord } from '@athanor/data';
import { workspaceResponse } from '../context.js';
import type { HostStorage } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { currentPeriod, serverLimits } from '../plans.js';

export const registerBootstrapRoutes = (context: RouteContext): void => {
  const {
    app,
    store,
    masterKey,
    cachedHostStorage,
    privateTaskResponse,
    privateScheduleResponse,
    providerSpend,
    requiresZeroDataRetention,
    modelsForUser,
    webSearchRouteFor,
    ensurePrimaryWorkspace,
    config
  } = context;
  app.get('/v1/bootstrap', async (request) => {
    const user = requireUser(request.user);
    const { start: periodStart, end: periodEnd } = currentPeriod();
    /**
     * What the owner was part-way through typing, on whichever device they typed it. Opened here
     * rather than by the client, because the client has no key and never sees one; a draft whose
     * workspace key cannot be unwrapped is simply left out rather than failing the whole load.
     *
     * Takes the workspaces as a promise so it can be started in the same wave as everything else
     * and still be the one thing that waits for them.
     */
    const openDrafts = async (pending: Promise<WorkspaceRecord[]>) =>
      (
        await Promise.all(
          (await pending).map(async (workspace) => {
            if (!workspace.wrappedKey) return [];
            try {
              const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
              const rows = await store.listMessageDrafts(user.id, workspace.id);
              return rows.map((row) => {
                // `attachments` is absent from a draft written before they travelled with one, so
                // it reads as none rather than as a decryption failure that would drop the
                // sentence too.
                const opened = decryptJson<{
                  body: string;
                  attachments?: Array<{
                    path: string;
                    name: string;
                    sizeBytes: number;
                    mimeType: string;
                  }>;
                }>(row.bodyCiphertext, key);
                return {
                  workspaceId: workspace.id,
                  taskId: row.taskId,
                  body: opened.body,
                  attachments: opened.attachments ?? [],
                  updatedAt: row.updatedAt
                };
              });
            } catch {
              return [];
            }
          })
        )
      ).flat();
    /*
     * Everything in one wave, because none of it was ever waiting on anything else.
     *
     * This request gates first paint, and it used to be twelve database round trips deep for
     * eighteen queries - the workspaces, then the page, then the catalogue, then the totals, then
     * the drafts, then, one at a time in the order they happened to be written in the returned
     * object, the retention flag, the search route and the provider spend. An object literal
     * awaits its properties in source order, so three of those hops were paid because of where the
     * lines sat on the page. Only the drafts genuinely depend on anything: they need the owner's
     * workspace keys, so they wait on `ensurePrimaryWorkspace` and nothing else does.
     *
     * The second `listWorkspaces` is gone with them. `ensurePrimaryWorkspace` already ends in that
     * exact query and hands the rows back, so reading them again was a round trip spent to learn
     * what the previous line had already returned - and a window in which the two copies could
     * disagree about a computer that had just been provisioned.
     */
    const workspacesRead = ensurePrimaryWorkspace(user);
    const [
      workspaces,
      tasks,
      schedules,
      models,
      providerCredential,
      usage,
      drafts,
      enforceZeroDataRetention,
      webSearch,
      spend
    ] = await Promise.all([
      workspacesRead,
      store.listTaskPage(user.id),
      store.listTaskSchedules(user.id),
      modelsForUser(user),
      store.getManagedProviderCredential(user.id, 'inference'),
      store.usageTotals(user.id, periodStart, periodEnd),
      openDrafts(workspacesRead),
      requiresZeroDataRetention(user.id),
      webSearchRouteFor(user.id),
      providerSpend(user.id)
    ]);
    const hostStorage = new Map(
      workspaces
        .map((workspace) => [workspace.id, cachedHostStorage(workspace)] as const)
        .filter((entry): entry is readonly [string, HostStorage & { storageBytes: number }] =>
          Boolean(entry[1])
        )
    );
    return {
      user,
      drafts,
      workspaces: workspaces.map((workspace) =>
        workspaceResponse(
          {
            ...workspace,
            storageBytes: hostStorage.get(workspace.id)?.storageBytes ?? workspace.storageBytes
          },
          hostStorage.get(workspace.id)
        )
      ),
      tasks: await Promise.all(
        tasks.tasks.map((task) =>
          privateTaskResponse(
            task,
            workspaces.find((workspace) => workspace.id === task.workspaceId)
          )
        )
      ),
      /** Where GET /v1/tasks resumes from, so the sidebar can reach past this first page. */
      tasksCursor: tasks.nextCursor,
      /** How many runs each schedule above really has, which is not how many of them fitted. */
      scheduleRunCounts: tasks.scheduleRunCounts,
      schedules: await Promise.all(
        schedules.map((schedule) =>
          privateScheduleResponse(
            schedule,
            workspaces.find((workspace) => workspace.id === schedule.workspaceId)
          )
        )
      ),
      /*
       * The catalogue as the picker needs it, not as the router needs it.
       *
       * This is the request that gates first paint: nothing renders until it returns. It was 426 kB
       * on a box with a provider connected, and 424.5 kB of that was the model catalogue - 341
       * models with forty-three fields each, including benchmark populations, cache pricing, price
       * tiers, uptime percentages and knowledge cutoffs. Everything else in the payload together
       * came to 1.7 kB. The web client reads five of those fields; the rest went to every device on
       * every launch and was never looked at. The full record is still one request away for anyone
       * who needs it - `GET /v1/models` - and the router reads it server-side where it lives.
       */
      models: models.map((model) => ({
        id: model.id,
        providerModelId: model.providerModelId,
        displayName: model.displayName,
        // Kept although no screen reads it: it is how "this box exposes only hosted routes" is
        // checked at the surface the client actually receives, and a boundary that can only be
        // asserted server-side is one nobody notices breaking.
        provider: model.provider,
        availability: model.availability,
        privacyRoute: model.privacyRoute
      })),
      instance: {
        mode: 'self_hosted',
        providerConfigured: Boolean(
          providerCredential?.status === 'active' ||
          config.AI_API_KEY ||
          config.OPENROUTER_API_KEY ||
          (config.AI_PROVIDER === 'openai-compatible' && config.AI_DEFAULT_MODEL)
        ),
        enforceZeroDataRetention,
        /**
         * Where a web search on this box is answered, so the client can say "this query leaves the
         * computer" beside the box it is typed in without asking again.
         */
        webSearch
      },
      legal: {
        applicationLicense: 'AGPL-3.0-only',
        sourceUrl: config.PUBLIC_SOURCE_URL ?? null,
        privacyUrl: config.PUBLIC_PRIVACY_URL ?? null
      },
      usage: {
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        consumedCredits: usage.settled,
        reservedCredits: usage.reserved,
        storageBytes: workspaces.reduce((sum, workspace) => sum + workspace.storageBytes, 0),
        storageLimitBytes: serverLimits.storageBytes,
        providerSpend: spend
      }
    };
  });
};
