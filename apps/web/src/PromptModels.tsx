import type {
  ProjectModelChoices,
  ProjectModelPreferences,
  PrivacyRoute
} from '@athanor/contracts';
import { ResourceState, useResource } from './management.js';
import ModelChoiceFields from './ModelChoiceFields.js';
import ProjectModels from './ProjectModels.js';

export default function PromptModelChoices({
  taskId,
  disabled = false,
  choices,
  onChange,
  privacyRoute
}: {
  taskId: string;
  disabled?: boolean;
  choices: ProjectModelChoices;
  onChange: (choices: ProjectModelChoices) => void;
  privacyRoute: PrivacyRoute;
}) {
  if (taskId) return <ProjectModels taskId={taskId} disabled={disabled} />;
  return (
    <NewPromptChoices
      choices={choices}
      onChange={onChange}
      disabled={disabled}
      privacyRoute={privacyRoute}
    />
  );
}
function NewPromptChoices({
  choices,
  onChange,
  disabled,
  privacyRoute
}: {
  choices: ProjectModelChoices;
  onChange: (choices: ProjectModelChoices) => void;
  disabled?: boolean;
  privacyRoute: PrivacyRoute;
}) {
  const resource = useResource<ProjectModelPreferences>(
    `/v1/workspace-model-preferences?privacyRoute=${privacyRoute}`
  );
  return (
    <div className="stack">
      <p className="muted">
        Choose models before you begin. These choices are saved with your draft and become this
        project's defaults when you send it.
      </p>
      <ResourceState resource={resource} />
      {resource.value && (
        <ModelChoiceFields
          purposes={resource.value.purposes}
          choices={choices}
          onChange={onChange}
          disabled={disabled}
        />
      )}
    </div>
  );
}
