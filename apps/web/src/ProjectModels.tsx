import { useRef, useState } from 'react';
import type { ProjectModelChoices, ProjectModelPreferences } from '@athanor/contracts';
import { put } from './client.js';
import { ActionFeedback, ResourceState, useAction, useResource } from './management.js';
import { Button } from './ui.js';
import ModelChoiceFields from './ModelChoiceFields.js';

export default function ProjectModels({
  taskId,
  onChange,
  disabled
}: {
  taskId: string;
  onChange?: () => void;
  disabled?: boolean;
}) {
  const resource = useResource<ProjectModelPreferences>(`/v1/tasks/${taskId}/model-preferences`);
  const [draft, setDraft] = useState<{
    taskId: string;
    revision: number;
    choices: ProjectModelChoices;
  } | null>(null);
  const action = useAction();
  const operation = useRef<{ signature: string; key: string } | null>(null);
  const current = resource.value;
  const editing = draft?.taskId === taskId ? draft : null;
  const choices = editing?.choices ?? current?.choices ?? {};
  const dirty = current && JSON.stringify(choices) !== JSON.stringify(current.choices);
  const save = () => {
    if (!current) return;
    const payload = { expectedRevision: editing?.revision ?? current.revision, choices };
    const signature = JSON.stringify([taskId, payload]);
    if (operation.current?.signature !== signature)
      operation.current = { signature, key: crypto.randomUUID() };
    const idempotencyKey = operation.current.key;
    void action.run(async () => {
      const saved = await put<ProjectModelPreferences>(
        `/v1/tasks/${taskId}/model-preferences`,
        payload,
        { idempotencyKey }
      );
      resource.setValue(saved);
      setDraft(null);
      window.dispatchEvent(new CustomEvent('garden-model-preferences', { detail: saved }));
      onChange?.();
    }, 'Project model choices saved');
  };
  return (
    <section className="stack" aria-label="Project models">
      <p className="muted">
        Saved choices apply to this project and its related work. Each purpose can follow your
        global default or use its own model.
      </p>
      <ResourceState resource={resource} />
      {current && (
        <>
          <ModelChoiceFields
            purposes={current.purposes}
            choices={choices}
            disabled={disabled || action.busy}
            onChange={(next) =>
              setDraft({ taskId, revision: editing?.revision ?? current.revision, choices: next })
            }
          />
          <div className="model-choice-actions">
            <Button
              className="primary"
              busy={action.busy}
              disabled={disabled || !dirty}
              onClick={save}
            >
              Save project choices
            </Button>
            {dirty && (
              <Button disabled={action.busy} onClick={() => setDraft(null)}>
                Discard changes
              </Button>
            )}
            {dirty && (
              <small className="muted" role="status">
                Unsaved changes
              </small>
            )}
            {action.error != null && (
              <Button
                disabled={action.busy}
                onClick={() => {
                  setDraft(null);
                  resource.refresh();
                }}
              >
                Reload saved choices
              </Button>
            )}
          </div>
        </>
      )}
      <ActionFeedback action={action} />
    </section>
  );
}
