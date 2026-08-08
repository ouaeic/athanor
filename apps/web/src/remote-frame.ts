/**
 * Which streamed frames are still needed, and which are safe to destroy.
 *
 * A frame arrives as bytes, becomes a blob URL, and is handed to an <img>. The URL has to be
 * revoked eventually or the tab leaks a blob per frame - but revoking the one the element is
 * currently painting does not blank it politely: the element keeps the src, decodes nothing,
 * reports naturalWidth 0, and paints black. Frames arrive faster than React commits, so "revoke
 * the previous URL as soon as the next one arrives" revokes the URL still on screen, and the live
 * view spends most of its time black with an occasional frame flashing through.
 *
 * Holding one extra frame fixes it. When frame N+2 arrives, the element has long since stopped
 * painting frame N, so frame N is safe. At most two URLs are ever outstanding, so nothing
 * accumulates and no load callback has to be threaded through the render.
 */
export interface FrameSlots {
  /** The newest frame, which is the one the element is being asked to paint. */
  readonly current: string;
  /** The frame before it, still held because the element may not have moved off it yet. */
  readonly prior: string;
}

export const emptyFrameSlots: FrameSlots = { current: '', prior: '' };

/**
 * Takes the next frame, and names the one URL that is now safe to revoke.
 *
 * `revoke` is empty for the first two frames of a stream, when nothing has aged out yet.
 */
export const advanceFrame = (
  slots: FrameSlots,
  next: string
): { slots: FrameSlots; revoke: string } => ({
  slots: { current: next, prior: slots.current },
  revoke: slots.prior
});

/**
 * Gives up every URL still held, for a teardown or a blackout.
 *
 * Used when the socket closes, when the surface changes, and when secure input starts - where a
 * stale frame left on screen would be a promise that nothing is watching, broken.
 */
export const drainFrames = (slots: FrameSlots): { slots: FrameSlots; revoke: string[] } => ({
  slots: emptyFrameSlots,
  revoke: [slots.current, slots.prior].filter((url) => url !== '')
});
