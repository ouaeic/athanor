import { type TaskPlanStep } from '@athanor/contracts';
import { decryptJson, encryptJson, AthanorError } from '@athanor/core';
import { type ModelToolCall } from '@athanor/model-gateway';
import { event } from '../tool-recording.js';
import { planStepsFromArguments, textValue } from '../values.js';
import { type ToolContext } from '../tool-dispatch.js';

/**
 * The plan tool: the one arm that writes the document the owner reads back.
 *
 * On its own rather than folded in with the workspace tools because a plan is not a change to the
 * computer - it is the agent's account of what it is doing, versioned against the owner's own edits,
 * and the conflict handling below is the only place in the table that answers a model with a
 * correction rather than a result.
 */
export async function executePlanTool(context: ToolContext, call: ModelToolCall): Promise<unknown> {
  const { task, key, state } = context;
  switch (call.name) {
    case 'set_plan': {
      const current = await context.store.getLatestTaskPlan(task.id);
      const previous =
        current?.stepsCiphertext.aad === `task-plan:${task.id}`
          ? decryptJson<{ steps: TaskPlanStep[] }>(current.stepsCiphertext, key).steps
          : [];
      const steps = planStepsFromArguments(call.arguments.steps, previous);
      if (!steps.length)
        /*
         * Says what shape would have worked. It used to say only that a step was needed, which
         * is the one thing the model already knew - and the failure is almost always a step
         * whose title arrived under another key or as an empty string, so a model told only
         * "needs at least one step" sends the same thing again. Seen twice in one run.
         */
        throw new AthanorError(
          'invalid_plan',
          'A plan needs at least one step with a title. Send steps as ["Read the brief", …] or [{"title":"Read the brief","status":"in_progress"}, …]; a step with no title is dropped. To retire a step, keep its title and set its status to skipped rather than removing it.'
        );
      const branchName = textValue(call.arguments.branchName, 'Main').slice(0, 80);
      // From here the plan is the model's, and the hold on finish means what it says again.
      state.planIsFallback = false;
      try {
        const created = await context.store.createTaskPlan({
          taskId: task.id,
          expectedVersion: current?.version ?? 0,
          branchName,
          stepsCiphertext: encryptJson({ steps, branchName }, key, `task-plan:${task.id}`),
          createdBy: 'agent'
        });
        await event(context.store, task, key, 'plan', `Plan version ${created.version}`, {
          planId: created.id,
          version: created.version,
          branchName,
          steps
        });
        return { version: created.version, steps };
      } catch (cause) {
        if (cause instanceof Error && cause.message === 'plan_version_conflict')
          return {
            changedByUser: true,
            instruction: 'Reload and follow the newer user-edited plan before continuing.'
          };
        throw cause;
      }
    }
    default:
      /*
       * Unreachable: the table in `tool-dispatch.ts` is what chooses this module, and it only
       * names the tools above. Kept so that a tool added to the table and forgotten here fails
       * loudly on the first call rather than returning `undefined` to the model.
       */
      throw new Error(`Unknown tool ${call.name}`);
  }
}
