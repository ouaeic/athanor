import {
  decryptJson,
  encryptJson,
  executeConnectorAction,
  AthanorError,
  type ConnectorSecret
} from '@athanor/core';
import { type ModelToolCall } from '@athanor/model-gateway';
import { connectorHostAllowance, performConnectorAction } from '../connector-call.js';
import { asRecord, textValue } from '../values.js';
import { type ToolContext } from '../tool-dispatch.js';

/**
 * The connector tools: reaching a service the owner has connected on their behalf.
 *
 * The two arms are deliberately adjacent: the list is what the model is allowed to know about a
 * connection, and the action is what it is allowed to do with one, and the difference between those
 * two answers is the whole of the connector scope model.
 */
export async function executeConnectorTool(
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> {
  const { task } = context;
  switch (call.name) {
    case 'connector_list':
      return (await context.store.listConnectors(task.userId))
        .filter((connector) => connector.enabled)
        .map((connector) => ({
          id: connector.id,
          kind: connector.kind,
          label: connector.label,
          scopes: connector.scopes,
          lastUsedAt: connector.lastUsedAt
        }));
    case 'connector_action': {
      const connectorId = textValue(call.arguments.connectorId);
      const operation = textValue(call.arguments.action, 'unknown_connector_action');
      const connector = await context.store.getConnector(task.userId, connectorId);
      if (!connector)
        throw new AthanorError('connector_not_found', 'Connected service is unavailable');
      if (connector.secretCiphertext.aad !== `connector:${task.userId}:${connector.id}`)
        throw new AthanorError(
          'connector_secret_context',
          'Connector secret encryption context is invalid'
        );
      const secret = decryptJson<ConnectorSecret>(connector.secretCiphertext, context.masterKey);
      const requested = asRecord(call.arguments.input) ?? {};
      try {
        return await performConnectorAction({
          kind: connector.kind,
          action: operation,
          requested,
          readFile: (path) => context.runner.readBytes(task.workspaceId, task.id, path),
          writeFile: (path, bytes) =>
            context.runner.writeBytes(task.workspaceId, task.id, path, bytes),
          execute: async (actionInput) => {
            const executed = await executeConnectorAction({
              kind: connector.kind,
              baseUrl: connector.baseUrl,
              scopes: connector.scopes,
              secret,
              action: actionInput,
              allowedHostSuffixes: connectorHostAllowance(
                context.config.CONNECTOR_ALLOWED_HOST_SUFFIXES,
                connector
              ),
              onSecretUpdated: async (updatedSecret) => {
                const saved = await context.store.updateConnectorSecret(
                  task.userId,
                  connector.id,
                  encryptJson(
                    updatedSecret,
                    context.masterKey,
                    `connector:${task.userId}:${connector.id}`
                  )
                );
                if (!saved)
                  throw new AthanorError(
                    'connector_secret_update_failed',
                    'The refreshed connector authorization could not be saved'
                  );
              }
            });
            await context.store.recordConnectorAudit({
              connectorId: connector.id,
              userId: task.userId,
              taskId: task.id,
              operation: executed.action,
              outcome: 'succeeded',
              statusCode: executed.statusCode,
              requestBytes: executed.requestBytes,
              responseBytes: executed.responseBytes,
              durationMs: executed.durationMs
            });
            return executed.result;
          }
        });
      } catch (error) {
        await context.store.recordConnectorAudit({
          connectorId: connector.id,
          userId: task.userId,
          taskId: task.id,
          operation,
          outcome:
            error instanceof AthanorError && error.code === 'connector_scope_denied'
              ? 'denied'
              : 'failed'
        });
        throw error;
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
