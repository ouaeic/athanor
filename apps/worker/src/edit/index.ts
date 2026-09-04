/**
 * The line-addressed edit vertical: the read that numbers, the dialect, and the applier.
 *
 * One feature, one directory, and deliberately whole - the previous attempt at this format was
 * built as an applier with no read side and no catalogue entry, measured beautifully, and sat on a
 * shelf because nothing could reach it. `apps/worker/src/tools/workspace.ts` is the only caller and
 * it uses all of it: `renderNumbered` on the way out, `recordRead` to remember what was shown,
 * `applyEdit` on the way back, `boundRepeatedRefusal` on the way back a second time, and
 * `checkSyntax` on what landed.
 *
 * The ruling and the measurements are in `docs/design/edit/BUILD.md`.
 */
export {
  applyEdit,
  NO_ANCHOR_NOTE,
  type EditRefusal,
  type EditResult,
  type RefusalKind
} from './apply.js';
export { blockAt } from './block.js';
export {
  anchorPrefixes,
  foldAnchor,
  isWeakAnchor,
  looksNumbered,
  normaliseLine,
  numberedWindow,
  renderNumbered,
  sameLine,
  sameLines,
  sayRange,
  STRONG_ANCHOR_CHARS,
  stripLeakedPrefix,
  toLines
} from './format.js';
export { parseEdit, type EditOp, type ParseOptions, type ParseResult } from './parse.js';
export { EDIT_FORMAT_SPEC } from './prompt.js';
export {
  boundRepeatedRefusal,
  forgetRefusal,
  forgetRefusals,
  WHOLE_FILE_FALLBACK_LINES
} from './refusals.js';
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
export { checkSyntax, type SyntaxFault } from './syntax.js';
