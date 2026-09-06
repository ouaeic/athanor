import type { ModelRelease, TaskReasoningEffort } from '@athanor/contracts';
import { AthanorError } from '@athanor/core';
import { assertReasoningEffort } from '@athanor/model-gateway';

/** Validate an owner choice before creating work or reserving its spend. */
export const validateTaskReasoning = (
  preference: TaskReasoningEffort,
  model: Pick<ModelRelease, 'reasoning'>
): TaskReasoningEffort => {
  if (preference === 'auto') return preference;
  if (model.reasoning?.supportedEfforts === undefined)
    throw new AthanorError(
      'reasoning_options_unknown',
      'This model does not advertise selectable reasoning effort. Choose Auto.'
    );
  try {
    assertReasoningEffort(preference, model.reasoning);
  } catch (error) {
    throw new AthanorError(
      'reasoning_effort_unsupported',
      error instanceof Error ? error.message : 'Unsupported reasoning effort'
    );
  }
  return preference;
};
