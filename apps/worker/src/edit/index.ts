/**
 * The line-addressed edit vertical: the read that numbers, the dialect, and the applier.
 *
 * One feature, one directory, and deliberately whole - the previous attempt at this format was
 * built as an applier with no read side and no catalogue entry, measured beautifully, and sat on a
 * shelf because nothing could reach it. `apps/worker/src/tools/workspace.ts` is the only caller and
 * it uses all of it: `renderNumbered` on the way out, `recordRead` to remember what was shown, and
 * `applyEdit` on the way back.
 *
 * The ruling and the measurements are in `docs/design/edit/BUILD.md`.
 */
export { applyEdit, type EditRefusal, type EditResult } from './apply.js';
export { blockAt } from './block.js';
export {
  normaliseLine,
  numberedWindow,
  renderNumbered,
  sameLine,
  sameLines,
  sayRange,
  toLines
} from './format.js';
export { parseEdit, type EditOp, type ParseResult } from './parse.js';
export { EDIT_FORMAT_SPEC } from './prompt.js';
export {
  displayedRanges,
  firstUnshownLine,
  forgetPath,
  forgetReads,
  readsOf,
  recordRead,
  recordWrite,
  SNAPSHOTS_PER_PATH,
  SNAPSHOT_HORIZON_MS,
  type LineChange,
  type LineRange,
  type Snapshot
} from './snapshots.js';
