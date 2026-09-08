import { useEffect, useState } from 'react';
import {
  ProjectModelPreferences,
  type ModelPurpose,
  type ProjectModelChoices,
  type PurposeModelChoice
} from '@athanor/contracts';
import { get, put } from './client.js';
import { Field } from './ui.js';

export const purposeLabels: Record<ModelPurpose, string> = {
  main: 'Main agent',
  specialist: 'Research specialists',
  coding: 'Coding agents',
  image: 'Images',
  audio: 'Speech',
  transcription: 'Transcription',
  video: 'Video'
};

const automatic: PurposeModelChoice = { automatic: true, preference: 'balanced', modelId: '' };

/**
 * Per-prompt model tuning: the same purpose choices the project dialog owns, scoped to the
 * direction being written and living in an advanced disclosure inside the composer.
 *
 * A choice made here is stored against the conversation (or, for a first prompt, against the
 * project root the conversation is about to become), so it is a durable instruction to the run -
 * the same mechanism the project view uses - rather than a widget that silently evaporates after
 * one send. Inheriting is always the first option: nothing here is a requirement.
 */
export default function PromptModelChoices({
  taskId,
  disabled
}: {
  taskId: string;
  disabled?: boolean;
}) {
  const [state, setState] = useState<{
    revision: number;
    choices: ProjectModelChoices;
    purposes: ProjectModelPreferences['purposes'];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    if (loadedFor === taskId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void get<ProjectModelPreferences>(`/v1/tasks/${taskId}/model-preferences`)
      .then((current) => {
        if (cancelled) return;
        setState({
          revision: current.revision,
          choices: current.choices,
          purposes: current.purposes
        });
        setLoadedFor(taskId);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Choices unavailable');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, loadedFor]);

  const change = (purpose: ModelPurpose, choice: PurposeModelChoice | undefined) => {
    if (!state) return;
    const next = { ...state.choices };
    if (choice) next[purpose] = choice;
    else delete next[purpose];
    setSaving(true);
    void put<unknown>(`/v1/tasks/${taskId}/model-preferences`, {
      expectedRevision: state.revision,
      choices: next
    })
      .then((raw) => {
        const current = ProjectModelPreferences.parse(raw);
        setState({
          revision: current.revision,
          choices: current.choices,
          purposes: current.purposes
        });
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Choices not saved')
      )
      .finally(() => setSaving(false));
  };

  if (!state) {
    if (loading && !error) return <p className="muted">Loading model choices…</p>;
    return error ? <p className="muted">{error}</p> : null;
  }
  return (
    <div className="stack garden-prompt-models">
      {state.purposes.map((item) => {
        const selected = state.choices[item.purpose];
        const value = !selected ? 'inherit' : selected.automatic ? 'automatic' : selected.modelId;
        const effective =
          value === 'inherit' || value === 'automatic'
            ? item.effective
            : (item.options.find((option) => option.id === value) ?? null);
        return (
          <Field
            key={item.purpose}
            label={purposeLabels[item.purpose]}
            hint={
              effective && value !== 'inherit' && value !== 'automatic'
                ? `${effective.displayName}${'modality' in effective ? (effective.usdPerImage != null ? ' · priced per image' : effective.usdPerMinute != null ? ' · priced per minute' : '') : effective.inputUsdPerMillionTokens != null ? ` · about ${effective.inputUsdPerMillionTokens.toFixed(2)} per million tokens in` : ''}`
                : item.reason && value === 'inherit' && !item.available
                  ? item.reason
                  : ''
            }
          >
            <select
              value={value}
              disabled={disabled || saving}
              onChange={(event) =>
                change(
                  item.purpose,
                  event.target.value === 'inherit'
                    ? undefined
                    : event.target.value === 'automatic'
                      ? {
                          ...automatic,
                          preference: selected?.preference ?? item.choice.preference
                        }
                      : {
                          automatic: false,
                          preference: selected?.preference ?? item.choice.preference,
                          modelId: event.target.value
                        }
                )
              }
            >
              <option value="inherit">
                Inherit ({item.effective?.displayName ?? 'the usual choice'})
              </option>
              <option value="automatic">Automatic for this work</option>
              {selected &&
                !selected.automatic &&
                !item.options.some((option) => option.id === selected.modelId) && (
                  <option value={selected.modelId}>{selected.modelId} · unavailable</option>
                )}
              {item.options.map((option) => (
                <option
                  key={option.id}
                  value={option.id}
                  disabled={
                    'modality' in option
                      ? Boolean(option.unavailableReason)
                      : option.availability !== 'available'
                  }
                >
                  {option.displayName}
                  {'modality' in option
                    ? option.usdPerImage != null
                      ? ` · ${option.usdPerImage.toFixed(3)} / image`
                      : option.usdPerMinute != null
                        ? ` · up to ${option.usdPerMinute.toFixed(3)} / min`
                        : ''
                    : option.inputUsdPerMillionTokens != null
                      ? ` · ${option.inputUsdPerMillionTokens.toFixed(2)} / M in`
                      : ''}
                </option>
              ))}
            </select>
          </Field>
        );
      })}
      {error && (
        <small className="muted" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
