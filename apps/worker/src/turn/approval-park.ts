/**
 * Parking a turn on an approval card: the card, the calls behind it, and the saved state.
 *
 * Three things have to happen together and in this order, which is why they are one function.
 *
 * The **card** carries an encrypted preview and a hash of the exact arguments. The hash is what the
 * resume checks against on the way back in (`turn/resume.ts`), so an approval the owner gave for
 * one action cannot be inherited by a different one.
 *
 * The **calls behind it** are answered in writing before anything is saved. A model routinely
 * proposes several actions at once; a tool call with no tool result is a malformed window, and
 * nothing behind a decision may run before the decision is made.
 *
 * The **state** is written with `clearLease`, which is what actually parks the task. This is also
 * why the eval rig structurally cannot count cards per task: a card ends the run.
 *
 * Lifted out of `AgentWorker.run()`'s batch loop unchanged.
 */
import { encryptJson } from '@athanor/core';
import type { DataStore, TaskRecord } from '@athanor/data';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { AgentState, AgentWorkerConfig } from '../agent-state.js';
import { approvalPreviewHash, type AgentApprovalRequirement } from '../approval-state.js';
import { event } from '../tool-recording.js';
import { approvalOrigin } from '../turn-bounds.js';
import { textValue } from '../values.js';

/** What parking a turn on a card needs from the worker that owns it. */
export interface ApprovalParkDeps {
  readonly store: DataStore;
  readonly config: AgentWorkerConfig;
}

export const parkForApproval = async (
  deps: ApprovalParkDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  call: ModelToolCall,
  approval: AgentApprovalRequirement,
  /** The rest of this step's batch, answered in writing so the saved window is well formed. */
  deferredCalls: readonly ModelToolCall[]
): Promise<void> => {
  const origin = approvalOrigin(state);
  const approvalId = await deps.store.createApproval({
    userId: task.userId,
    taskId: task.id,
    action: approval.handoffOnly ? 'secure_input_handoff' : call.name,
    ...(origin === undefined ? {} : { origin }),
    sideEffect: approval.sideEffect,
    previewCiphertext: encryptJson(
      {
        action: approval.action,
        preview: approval.preview,
        tool: call.name,
        arguments: approval.handoffOnly
          ? { action: textValue(call.arguments.action, 'secure_input') }
          : call.arguments
      },
      key,
      `approval:${task.id}`
    ),
    previewHash: approvalPreviewHash(key, call.name, call.arguments),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
  });
  state.pending = {
    approvalId,
    toolCall: call,
    ...(approval.handoffOnly ? { handoffOnly: true } : {})
  };
  for (const deferred of deferredCalls) {
    state.messages.push({
      role: 'tool',
      toolCallId: deferred.id,
      content:
        'Deferred because an earlier action requires user approval. Request it again if still needed.'
    });
  }
  await event(deps.store, task, key, 'approval_requested', approval.action, {
    approvalId,
    sideEffect: approval.sideEffect,
    preview: approval.preview
  });
  await deps.store.updateTask({
    id: task.id,
    workerId: deps.config.WORKER_ID,
    status: 'awaiting_user',
    actualComputeCredits: state.credits,
    agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`),
    clearLease: true
  });
};
