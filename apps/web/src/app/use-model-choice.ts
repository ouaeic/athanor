import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { api, type ModelTaskKind } from '../api.js';
import { readModelChoice, writeModelChoice } from '../client-state.js';
import { modelDisplayName } from '../model-names.js';
import type { CatalogueModel } from '../types.js';

/** What the box has stored for this owner, adopted once per bootstrap. */
export interface SavedModelChoice {
  automatic: boolean;
  preference: 'fast' | 'balanced' | 'best';
  modelId?: string;
}

/**
 * Which model answers, why, and what the picker is allowed to offer.
 *
 * Six cells that are one decision. The privacy route follows the chosen model, the catalogue is
 * filtered by that route, the ranking within it comes from the router, and the chosen model has to
 * stay inside the filtered list — so changing any one of them moves the others. Held apart, that
 * loop was five effects in a 3,203-line function with no name on it.
 */
export const useModelChoice = (input: {
  auth: 'loading' | 'required' | 'ready';
  models: CatalogueModel[] | undefined;
  /** What this turn is going to be, which only the browser can know: an image on the tray. */
  taskKind: ModelTaskKind | undefined;
  /** Until the box has answered, a save would be this browser's stale copy overwriting the shared one. */
  serverPreferencesLoaded: RefObject<boolean>;
}) => {
  const { auth, models: catalogue, taskKind, serverPreferencesLoaded } = input;
  // The device's own copy, kept only so the first paint has something and so a box that cannot be
  // reached still offers the last choice. The server's copy is the real one and replaces it below.
  const stored = useRef(readModelChoice());
  const [preference, setPreference] = useState<'fast' | 'balanced' | 'best'>(
    stored.current?.preference ?? 'balanced'
  );
  const [automatic, setAutomatic] = useState(stored.current?.automatic ?? true);
  const [recommendedIds, setRecommendedIds] = useState<string[]>([]);
  /**
   * The router's argument for the placements it explains, which this client used to discard.
   *
   * `/v1/models/recommend` returns `reasons` for the top eight — its comment says "what it needs
   * from the front is the argument" — and the only caller mapped the answer to `entry.modelId` and
   * threw the rest away. So the picker silently reordered itself and never said why.
   */
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [modelId, setModelId] = useState(stored.current?.modelId ?? '');

  useEffect(() => {
    const choice = { automatic, preference, modelId };
    writeModelChoice(choice);
    // And to the box, because this is a choice about the owner rather than about the browser they
    // happened to make it in. Debounced: dragging through the preference list is one decision, not
    // three. A failed save leaves the device's copy in place and the next change tries again -
    // there is nothing here worth interrupting the owner over.
    if (!serverPreferencesLoaded.current) return;
    const timer = window.setTimeout(() => {
      void api.savePreferences({ model: choice }).catch(() => undefined);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [automatic, preference, modelId]);

  const privacyRoute =
    catalogue?.find((model) => model.id === modelId)?.privacyRoute ??
    catalogue?.find((model) => model.availability === 'available')?.privacyRoute ??
    'provider_zdr';

  const models = useMemo(
    () =>
      (
        catalogue?.filter(
          (model) => model.privacyRoute === privacyRoute && model.availability === 'available'
        ) ?? []
      ).sort((left, right) => {
        const ranked = (model: CatalogueModel) => {
          const index = recommendedIds.indexOf(model.id);
          return index === -1 ? Number.MAX_SAFE_INTEGER : index;
        };
        return ranked(left) - ranked(right) || left.displayName.localeCompare(right.displayName);
      }),
    [catalogue, privacyRoute, recommendedIds]
  );
  const unavailableModels = useMemo(
    () =>
      (catalogue ?? [])
        .filter(
          (model) => model.privacyRoute === privacyRoute && model.availability !== 'available'
        )
        .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    [catalogue, privacyRoute]
  );
  const namedModel = useCallback(
    (id: string): string => modelDisplayName(catalogue ?? [], id),
    [catalogue]
  );

  useEffect(() => {
    if (auth !== 'ready') return;
    let active = true;
    void api
      // What this turn is going to be, where this client is the only party that can know it. The
      // route's five profiles were unreachable from the only entry point that ranks anything
      // because nothing ever named one; an image on the tray is the signal the browser holds and
      // the prompt does not carry, and it is the first thing the server's own classifier reads.
      .recommendModels(privacyRoute, preference, taskKind)
      .then((ranked) => {
        if (!active) return;
        setRecommendedIds(ranked.map((entry) => entry.modelId));
        setReasons(
          Object.fromEntries(
            ranked.flatMap((entry) =>
              entry.reasons?.[0] ? [[entry.modelId, entry.reasons[0]]] : []
            )
          )
        );
        if (automatic) setModelId(ranked[0]?.modelId ?? '');
      })
      .catch(() => {
        if (active) {
          setRecommendedIds([]);
          setReasons({});
        }
      });
    return () => {
      active = false;
    };
  }, [auth, privacyRoute, preference, automatic, catalogue, taskKind]);

  useEffect(() => {
    if (!models.some((model) => model.id === modelId)) setModelId(models[0]?.id ?? '');
  }, [models, modelId]);

  const applySaved = useCallback((saved: SavedModelChoice) => {
    setPreference(saved.preference);
    setAutomatic(saved.automatic);
    if (saved.modelId) setModelId(saved.modelId);
  }, []);

  /** One control, one decision: automatic with a preference, or a model named outright. */
  const choose = useCallback(
    (
      choice:
        | { automatic: true; preference: 'fast' | 'balanced' | 'best' }
        | { automatic: false; modelId: string }
    ) => {
      setAutomatic(choice.automatic);
      if (choice.automatic) setPreference(choice.preference);
      else setModelId(choice.modelId);
    },
    []
  );

  return {
    modelId,
    automatic,
    preference,
    privacyRoute,
    models,
    unavailableModels,
    reasons,
    namedModel,
    choose,
    applySaved
  };
};
