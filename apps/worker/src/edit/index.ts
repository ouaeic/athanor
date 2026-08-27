/**
 * A line-addressed edit format, built to be measured against the shipped one.
 *
 * Nothing in this directory is on the tool catalogue, in a system prompt, or reachable from the
 * agent loop. It is the candidate half of a comparison whose other half is `file_patch`, and the
 * comparison itself lives in `evals/edit/`. The ruling is in `docs/design/exec3/L2.md`.
 *
 * It is a whole working implementation rather than a sketch because the question being asked is
 * "does this cost fewer output tokens for the same LANDED edit", and only an applier that actually
 * refuses the unsafe cases can answer the second half of that.
 */
export { applyEdit, type EditFailure, type EditOutcome } from './apply.js';
export { blockAt } from './block.js';
export { fileTag, normalise, normaliseLine, renderNumbered, sectionHeader } from './format.js';
export { parseEdit, type EditOp, type EditSection, type ParseResult } from './parse.js';
export { EDIT_FORMAT_SPEC } from './prompt.js';
export { SnapshotStore, SNAPSHOTS_PER_PATH, type Snapshot } from './snapshots.js';
