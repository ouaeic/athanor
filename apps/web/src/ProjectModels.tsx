import { useState } from 'react';
import type {
  ModelPurpose,
  ProjectModelChoices,
  ProjectModelPreferences,
  PurposeModelChoice
} from '@athanor/contracts';
import { put } from './client.js';
import { ActionFeedback, ResourceState, useAction, useResource } from './management.js';
import { Button, Field } from './ui.js';
import { money } from './model.js';

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
export default function ProjectModels({
  taskId,
  onChange
}: {
  taskId: string;
  onChange?: () => void;
}) {
  const resource = useResource<ProjectModelPreferences>(`/v1/tasks/${taskId}/model-preferences`);
  const [draft, setDraft] = useState<{
    taskId: string;
    revision: number;
    choices: ProjectModelChoices;
  } | null>(null);
  const action = useAction(() => {
    setDraft(null);
    resource.refresh();
    onChange?.();
  });
  const current = resource.value;
  const choices =
    draft?.taskId === taskId && draft.revision === current?.revision
      ? draft.choices
      : (current?.choices ?? {});
  const change = (purpose: ModelPurpose, choice: PurposeModelChoice | undefined) => {
    if (!current) return;
    const next = { ...choices };
    if (choice) next[purpose] = choice;
    else delete next[purpose];
    setDraft({ taskId, revision: current.revision, choices: next });
  };
  return (
    <section className="stack" aria-label="Project models">
      <p className="muted">
        Model choices for this project and its related work. Each purpose inherits your global
        choice unless you override it here.
      </p>
      <ResourceState resource={resource} />
      {current && (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run(
              () =>
                put(`/v1/tasks/${taskId}/model-preferences`, {
                  expectedRevision: current.revision,
                  choices
                }),
              'Project model choices saved'
            );
          }}
        >
          {current.purposes.map((item) => {
            const selected = choices[item.purpose];
            const value = !selected
              ? 'inherit'
              : selected.automatic
                ? 'automatic'
                : selected.modelId;
            const changed =
              JSON.stringify(selected) !== JSON.stringify(current.choices[item.purpose]);
            const automaticPending = changed && (value === 'inherit' || value === 'automatic');
            const effective = automaticPending
              ? null
              : value === 'inherit' || value === 'automatic'
                ? item.effective
                : item.options.find((option) => option.id === value);
            return (
              <div className="stack" key={item.purpose}>
                <Field label={purposeLabels[item.purpose]}>
                  <select
                    value={value}
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
                    <option value="inherit">Use global choice</option>
                    <option value="automatic">Automatic for this project</option>
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
                      </option>
                    ))}
                  </select>
                </Field>
                {selected?.automatic && (
                  <Field label={`${purposeLabels[item.purpose]} preference`}>
                    <select
                      value={selected.preference}
                      onChange={(event) =>
                        change(item.purpose, {
                          ...selected,
                          preference: event.target.value as PurposeModelChoice['preference']
                        })
                      }
                    >
                      <option value="balanced">Balanced</option>
                      <option value="fast">Faster</option>
                      <option value="best">Higher quality</option>
                    </select>
                  </Field>
                )}
                <p className="muted">
                  {effective
                    ? `${effective.displayName}${'modality' in effective ? (effective.usdPerImage != null ? ` · ${money(effective.usdPerImage)} per image` : effective.usdPerMinute != null ? ` · up to ${money(effective.usdPerMinute)} per minute` : effective.usdPerSecond != null ? ` · from ${money(effective.usdPerSecond)} per second` : effective.usdPerMillionCharacters != null ? ` · ${money(effective.usdPerMillionCharacters)} per million characters` : '') : ''}`
                    : automaticPending
                      ? 'Save to resolve the current model and price for this choice.'
                      : (item.reason ?? 'No available model.')}
                </p>
                {effective &&
                  'requiresRetentionApproval' in effective &&
                  effective.requiresRetentionApproval && (
                    <p className="muted">
                      Each request requires approval for temporary provider retention.
                    </p>
                  )}
              </div>
            );
          })}
          <Button type="submit" disabled={action.busy}>
            Save project choices
          </Button>
        </form>
      )}
      <ActionFeedback action={action} />
    </section>
  );
}
