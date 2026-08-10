/**
 * Which single thing is allowed to sit above the composer.
 *
 * Seven conditions each rendered their own strip there, guarded by whatever ad-hoc exclusion the
 * change that added them happened to write: `!error && !notice && !showBlock` on storage, `!offline`
 * on the degraded stream, and nothing at all on the rest. So a box near its disk ceiling that also
 * dropped its connection painted storage, offline and an error at once - three alarm colours, in
 * three different reds and ambers, over a composer that is already 176px tall. On a 375px phone
 * that stack is most of the screen.
 *
 * One answer instead, in one order, so the guards cannot drift apart again as conditions are added.
 */
export type ComposerStripKind =
  | 'approval'
  | 'block'
  | 'offline'
  | 'storage'
  | 'error'
  | 'degraded'
  | 'notice';

export interface ComposerStripState {
  /** An agent is waiting on a decision. Unbounded on purpose: it is the owner's turn to act. */
  approval: boolean;
  /** Something must be repaired before the typed message can go anywhere. */
  block: boolean;
  /** This device cannot reach the box at all. */
  offline: boolean;
  /** The disk is past the floor the box keeps free, so writes are already being refused. */
  storage: boolean;
  error: boolean;
  streamDegraded: boolean;
  notice: boolean;
}

/**
 * The order, and why it is this order.
 *
 * An approval is the only item that is the owner's turn rather than the machine's report, so it
 * wins outright. A send block comes next because it is the answer to a keystroke that was just
 * pressed. A lost connection means this screen has stopped being a picture of the box at all, so it
 * outranks a full disk, which outranks a failed request - a request fails *because* the disk is
 * full, so showing the cause beats showing the symptom. A degraded stream is a slower version of
 * offline and never competes with it, and a notice is the one item nobody has to read.
 *
 * Only conditions something actually raises are ranked here. A slot kept warm for one that nothing
 * produces is a kind the switch in App cannot draw, so raising it would blank the strip and silence
 * everything under it - a worse failure than the stack this replaced.
 */
export const composerStrip = (state: ComposerStripState): ComposerStripKind | undefined => {
  if (state.approval) return 'approval';
  if (state.block) return 'block';
  if (state.offline) return 'offline';
  if (state.storage) return 'storage';
  if (state.error) return 'error';
  if (state.streamDegraded) return 'degraded';
  if (state.notice) return 'notice';
  return undefined;
};
