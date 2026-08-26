/**
 * Search over the owner's own history, against an index nothing but this box can read.
 */

import {
  conversationNamePrefixTokens,
  decryptJson,
  memoryExcerpt,
  memoryIndexKey,
  planMemoryQuery,
  unwrapDataKey
} from '@athanor/core';
import type { TaskRecord, WorkspaceRecord } from '@athanor/data';
import { z } from 'zod';
import { SEARCH_EXCERPT_CHARS } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export const registerSearchRoutes = (context: RouteContext): void => {
  const { app, store, masterKey, openPrompt, openName } = context;
  /**
   * Search over the owner's own history.
   *
   * This used to read all of it. Every conversation in every workspace, every event in every
   * conversation, decrypted and stringified in this process to be matched with `includes` - and
   * tool results are stored whole, so one browser tree or one megabyte of shell output was in that
   * total verbatim. It was instant in week one and seconds of blocked event loop by month three,
   * which on a single-threaded API also stalls the stream feeding the live conversation. Nothing
   * announced the change: it degraded exactly in step with using the computer.
   *
   * The bodies are already indexed. Every captured turn is chunked, sealed and blind-indexed on the
   * write path, and `searchMemorySources` is a bounded BM25 probe over that index - stemming, so
   * "restarted" finds "restart"; document frequency, so the rare word in the question decides;
   * length normalisation, so the longest transcript stops winning everything. The agent has
   * searched this way since the memory runtime landed. Now the owner does.
   *
   * The names are indexed the same way and searched separately, because they answer a different
   * question: a conversation is findable by what the owner called it from the moment it is created,
   * before any turn has finished and therefore before anything has been captured. That used to be
   * a decrypt of the newest few hundred names, which was bounded but wrong at the far end - the
   * owner's own words for a conversation are in no transcript, so a thread renamed in March was
   * findable by that name in April and gone by December. `name_tsv` carries those words as keyed
   * tokens now, so the age of the conversation stops being a factor in either pass.
   */
  app.get<{
    Querystring: { q?: string; workspaceId?: string; limit?: string };
  }>('/v1/search', async (request) => {
    const user = requireUser(request.user);
    const input = z
      .object({
        q: z.string().trim().min(2).max(500),
        workspaceId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20)
      })
      .parse(request.query);
    const workspaces = input.workspaceId
      ? [await store.getWorkspace(user.id, input.workspaceId)].filter(
          (workspace): workspace is WorkspaceRecord => Boolean(workspace?.wrappedKey)
        )
      : (await store.listWorkspaces(user.id)).filter((workspace) => Boolean(workspace.wrappedKey));
    const keys = new Map(
      workspaces.map((workspace) => [
        workspace.id,
        unwrapDataKey(workspace.wrappedKey!, masterKey, workspace.id)
      ])
    );
    // One plan per workspace, because the tokens are keyed to the workspace: the same word is a
    // different token in each one, and both passes have to ask with the token the writer used.
    const indexKeys = new Map(
      workspaces.map((workspace) => [workspace.id, memoryIndexKey(keys.get(workspace.id)!)])
    );
    const plans = new Map(
      workspaces.map((workspace) => [
        workspace.id,
        planMemoryQuery(input.q, indexKeys.get(workspace.id)!)
      ])
    );
    /*
     * The word the owner has not finished typing, keyed the same way, for the pass that can use it.
     *
     * Only names carry prefixes: a name is a line, and typing the first letters of one is how a
     * person looks through their own history, where the transcript pass is answering a question
     * that was finished being asked. While the box answers, the client stands in for it by matching
     * the titles this device has already loaded as substrings, and then replaces that list with
     * this one - so until the box could make the same match, a conversation the client had just
     * listed under `grimbold` disappeared the moment the answer arrived, and one past the loaded
     * band never appeared at all.
     */
    const prefixes = new Map(
      workspaces.map((workspace) => [
        workspace.id,
        conversationNamePrefixTokens(input.q, indexKeys.get(workspace.id)!)
      ])
    );

    type Found = {
      workspaceId: string;
      title: string;
      updatedAt: string;
      /** How much of the request the conversation's own name and opening account for. */
      named: number;
      /** The best passage the index found inside the conversation. */
      said: { excerpt: string; score: number } | null;
      /** Shown when nothing inside the conversation matched, so a hit is never excerptless. */
      opening: string | null;
    };
    const found = new Map<string, Found>();

    /*
     * A conversation whose name will not open takes the placeholder an unreadable row carries
     * everywhere else on this box, rather than failing the search that found it. The passage pass
     * below already skips a row it cannot decrypt; a name matched by the index and then refused
     * here would be the same state answered with a 500, and the conversation is a real one the
     * owner can still open.
     */
    const openTask = (
      task: Pick<
        TaskRecord,
        'workspaceId' | 'titleCiphertext' | 'legacyTitle' | 'promptCiphertext'
      >,
      key: Uint8Array
    ) => ({ title: openName(task, key) || 'Private task', prompt: openPrompt(task, key) });

    /*
     * Only the page that is going to be shown is decrypted, which is what makes this affordable at
     * any age. Ranking by name before opening request happens in the database, so a thread the
     * owner called "Berlin flights" is chosen over one that mentions the words in a paragraph
     * before either of them is opened here.
     */
    const namedHits = (
      await Promise.all(
        workspaces.map(async (workspace) =>
          store.searchTaskNames(user.id, {
            lexemes: plans.get(workspace.id)!.lexemes,
            prefixes: prefixes.get(workspace.id)!,
            workspaceId: workspace.id,
            limit: input.limit
          })
        )
      )
    )
      .flat()
      // The database ranked each workspace; this only interleaves them, on the same four keys.
      .sort(
        (left, right) =>
          Number(right.wholeName) - Number(left.wholeName) ||
          Number(right.inName) - Number(left.inName) ||
          Number(right.namePrefix) - Number(left.namePrefix) ||
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      )
      .slice(0, input.limit);
    for (const hit of namedHits) {
      const key = keys.get(hit.workspaceId);
      if (!key) continue;
      const { title, prompt } = openTask(hit, key);
      found.set(hit.id, {
        workspaceId: hit.workspaceId,
        title,
        updatedAt: hit.updatedAt,
        // The same four tiers the database ordered by, in a single number, and one rather than
        // zero for the weakest of them: the two passes are ordered rather than added, so a
        // conversation that opened by asking this still goes above one that only mentioned it
        // somewhere in the middle.
        named: (hit.wholeName ? 4 : 0) + (hit.inName ? 2 : 0) + (hit.namePrefix ? 1 : 0) + 1,
        said: null,
        opening: memoryExcerpt(prompt || title, input.q, { maxChars: SEARCH_EXCERPT_CHARS })
      });
    }

    /*
     * One passage per conversation, ranked across workspaces before any of them is opened.
     *
     * The number of conversations this route reads is therefore the number of results asked for
     * rather than the number of boxes owned. `perTask` is the other half of that: the index returns
     * several passages from one thread by default, which is right for an agent reading around a
     * subject and wrong here, where every row past the first is a duplicate of a result the owner
     * can already see. Asking for one apiece is what keeps a request for twenty conversations from
     * being answered with seven.
     */
    const hits = (
      await Promise.all(
        workspaces.map(async (workspace) =>
          (
            await store.searchMemorySources({
              workspaceId: workspace.id,
              plan: plans.get(workspace.id)!,
              limit: input.limit,
              perTask: 1
            })
          ).map((hit) => ({ hit, workspaceId: workspace.id }))
        )
      )
    )
      .flat()
      // A capture that belongs to no conversation has nothing to open, and this route's whole
      // answer is a conversation to open, so it is dropped before it can take up a place.
      .filter(({ hit }) => Boolean(hit.taskId))
      .sort((left, right) => right.hit.score - left.hit.score)
      .slice(0, input.limit);

    for (const { hit, workspaceId } of hits) {
      const taskId = hit.taskId!;
      const key = keys.get(workspaceId)!;
      if (hit.bodyCiphertext.aad !== `memory-source:${workspaceId}`) continue;
      let body: string;
      try {
        body = decryptJson<{ body: string }>(hit.bodyCiphertext, key).body;
      } catch {
        // A row sealed under a key this server no longer holds is skipped rather than reported.
        continue;
      }
      const said = {
        excerpt: memoryExcerpt(body, input.q, { maxChars: SEARCH_EXCERPT_CHARS }),
        score: hit.score
      };
      const held = found.get(taskId);
      if (held) {
        // Held rows keep their name ordering; this only ever gives them a better excerpt, which the
        // name match does not have. Best-scoring rather than last-seen: one row per conversation
        // makes that the same thing today, and it stops being the same thing the moment anyone
        // widens `perTask` above.
        if (!held.said || held.said.score < said.score) held.said = said;
        continue;
      }
      const task = await store.getTask(user.id, taskId);
      if (!task) continue;
      found.set(taskId, {
        workspaceId,
        title: openTask(task, key).title,
        updatedAt: task.updatedAt,
        named: 0,
        said,
        opening: null
      });
    }

    /*
     * Two passes, two questions, and their scores do not share a scale, so they are ordered rather
     * than added. A conversation whose name or opening request carries the query is what the owner
     * was looking for often enough that it goes first; everything found inside a conversation
     * follows in the order the index ranked it.
     */
    return [...found]
      .sort(
        ([, left], [, right]) =>
          right.named - left.named ||
          (right.said?.score ?? 0) - (left.said?.score ?? 0) ||
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      )
      .slice(0, input.limit)
      .map(([taskId, result]) => ({
        taskId,
        workspaceId: result.workspaceId,
        title: result.title,
        excerpt: result.said?.excerpt ?? result.opening ?? result.title,
        updatedAt: result.updatedAt
      }));
  });
};
