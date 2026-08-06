/**
 * The only thing this client keeps on the device.
 *
 * Everything the owner authored or chose — the draft they were part-way through, the model they
 * deliberately picked, whether the tools pane was open — lived in React state alone, so a refresh,
 * an iOS tab eviction or the PWA being killed threw it away. On a product about closing the laptop
 * and picking the same work up on a phone, that is the one thing that must not be lost.
 *
 * Deliberately narrow: choices, never content the agent produced. Nothing here is a cache of server
 * state, so there is nothing to invalidate and nothing that can go stale against the box. It is one
 * small module rather than scattered `localStorage` calls so the whole of what this app writes to
 * the device can be read in one sitting.
 */

const DRAFT_PREFIX = 'athanor:draft:';
const MODEL_KEY = 'athanor:model';
const INSPECTOR_KEY = 'athanor:inspector';

/** The API's own prompt ceiling. A draft that cannot be sent is not worth storing. */
export const MAX_DRAFT_LENGTH = 200_000;

/**
 * Storage is optional at runtime: Safari in private browsing throws on access, and an embedded
 * webview may have it disabled outright. Persistence is a convenience, so every path degrades to
 * "this session only" rather than breaking the composer.
 */
const store = (): Storage | undefined => {
  try {
    const candidate = globalThis.localStorage;
    // Touching the object is not enough — quota-denied contexts only throw on a real operation.
    candidate.getItem(MODEL_KEY);
    return candidate;
  } catch {
    return undefined;
  }
};

const read = (key: string): string | undefined => {
  try {
    return store()?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};

const write = (key: string, value: string): void => {
  try {
    store()?.setItem(key, value);
  } catch {
    // A full or denied store is not worth reporting: the draft is still on screen.
  }
};

const remove = (key: string): void => {
  try {
    store()?.removeItem(key);
  } catch {
    // Same reasoning as `write`.
  }
};

const readJson = <T>(key: string, guard: (value: unknown) => T | undefined): T | undefined => {
  const raw = read(key);
  if (raw === undefined) return undefined;
  try {
    return guard(JSON.parse(raw));
  } catch {
    // A value written by a different version of this module is discarded, not repaired.
    return undefined;
  }
};

/** A draft belongs to the conversation it was typed against; `undefined` is the new-conversation box. */
const draftKey = (taskId: string | undefined): string => `${DRAFT_PREFIX}${taskId ?? 'new'}`;

export const readDraft = (taskId: string | undefined): string => read(draftKey(taskId)) ?? '';

/**
 * When this device last wrote that draft, kept in a key of its own.
 *
 * Beside the draft rather than inside it, so the stored value stays the plain string it has always
 * been and a draft written by an older build simply has no time against it. That case reads as
 * "older than anything the box could send", which is the safe way round: an unstamped local draft
 * loses to a dated one from the box rather than silently overwriting it.
 */
const draftStampKey = (taskId: string | undefined): string => `${draftKey(taskId)}:at`;

export const draftWrittenAt = (taskId: string | undefined): number => {
  const stamp = Number(read(draftStampKey(taskId)));
  return Number.isFinite(stamp) && stamp > 0 ? stamp : 0;
};

export const writeDraft = (taskId: string | undefined, draft: string, at = Date.now()): void => {
  if (!draft) {
    remove(draftKey(taskId));
    remove(draftStampKey(taskId));
    return;
  }
  write(draftKey(taskId), draft.slice(0, MAX_DRAFT_LENGTH));
  write(draftStampKey(taskId), String(at));
};

export const clearDraft = (taskId: string | undefined): void => {
  remove(draftKey(taskId));
  remove(draftStampKey(taskId));
};

/**
 * Drops drafts for conversations this device can no longer open.
 *
 * Without it every deleted conversation, and every conversation that has fallen off the end of the
 * bootstrap page, leaves its draft behind forever — a store that only grows, in the one place a
 * browser will silently start refusing writes.
 */
export const pruneDrafts = (liveTaskIds: Iterable<string>): void => {
  const storage = store();
  if (!storage) return;
  const live = new Set(liveTaskIds);
  const stale: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(DRAFT_PREFIX)) continue;
      // A draft's time is stored beside it under the same key with `:at` on the end. Taken
      // literally that suffix reads as part of the conversation id, so every live draft's stamp
      // looked like a draft for a conversation that no longer exists and was swept on the next
      // load - leaving the draft dated by nothing at all.
      const taskId = key.slice(DRAFT_PREFIX.length).replace(/:at$/, '');
      if (taskId !== 'new' && !live.has(taskId)) stale.push(key);
    }
  } catch {
    return;
  }
  for (const key of stale) remove(key);
};

export interface ModelChoice {
  automatic: boolean;
  preference: 'fast' | 'balanced' | 'best';
  modelId: string;
}

const preferences = new Set<ModelChoice['preference']>(['fast', 'balanced', 'best']);

export const readModelChoice = (): ModelChoice | undefined =>
  readJson(MODEL_KEY, (value) => {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    const preference = raw.preference;
    if (typeof preference !== 'string' || !preferences.has(preference as ModelChoice['preference']))
      return undefined;
    return {
      automatic: raw.automatic !== false,
      preference: preference as ModelChoice['preference'],
      modelId: typeof raw.modelId === 'string' ? raw.modelId : ''
    };
  });

export const writeModelChoice = (choice: ModelChoice): void =>
  write(MODEL_KEY, JSON.stringify(choice));

export type InspectorTab = 'files' | 'computer' | 'terminal' | 'preview';

const inspectorTabs = new Set<InspectorTab>(['files', 'computer', 'terminal', 'preview']);

/**
 * Where a pane that no longer exists sends the device that had it open.
 *
 * A returning owner should land on the surface that inherited what they were looking at rather
 * than on whatever the fallback happens to be: the browser is part of the computer's screen now,
 * and what Studio made is saved with the files.
 */
const retiredInspectorTabs: Record<string, InspectorTab> = {
  browser: 'computer',
  studio: 'files',
  usage: 'files'
};

export interface InspectorChoice {
  open: boolean;
  tab: InspectorTab;
}

export const readInspectorChoice = (): InspectorChoice | undefined =>
  readJson(INSPECTOR_KEY, (value) => {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    const tab = raw.tab;
    if (typeof tab !== 'string') return undefined;
    const resolved = inspectorTabs.has(tab as InspectorTab)
      ? (tab as InspectorTab)
      : retiredInspectorTabs[tab];
    if (!resolved) return undefined;
    return { open: raw.open === true, tab: resolved };
  });

export const writeInspectorChoice = (choice: InspectorChoice): void =>
  write(INSPECTOR_KEY, JSON.stringify(choice));
