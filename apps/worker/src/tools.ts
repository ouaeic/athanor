/*
 * The address every caller of the tool layer has ever had.
 *
 * There is no code here any more. The catalogue is in ./tool-catalogue.js, the wording of an
 * approval card in ./approval-cards.js, and the approval floor itself in ./approval-policy.js;
 * the classifiers left in an earlier wave, to ./surface-actions.js, ./command-classification.js
 * and ./write-classification.js. What is left is a re-export list, kept because agent.ts and four
 * test files import through it and none of them is in the lane that split this file - deleting it
 * here would have meant editing agent.ts in the same commit as the move, which is precisely the
 * mixed change these waves exist to avoid.
 *
 * It is narrowed to exactly what still has a caller. Fifteen names that used to be re-exported
 * from here had none - the shim outlived the callers it was written for - and a re-export nobody
 * reads is a second address for a symbol, which is how two copies of an import list drift.
 *
 * This file can go entirely once agent.ts imports ./tool-catalogue.js, ./approval-policy.js,
 * ./surface-actions.js, ./command-classification.js and ./write-classification.js directly.
 */
export { agentTools, agentToolsFor } from './tool-catalogue.js';
export { approvalRequirement, type ApprovalContext } from './approval-policy.js';
export { surfaceActionRequest } from './surface-actions.js';
export {
  callDestinations,
  isQuarantinedDownloadPath,
  untrustedShellOrigin
} from './command-classification.js';
export {
  isMutatingToolCall,
  writesOnlyDurableInstructions,
  writesOnlyProse
} from './write-classification.js';
