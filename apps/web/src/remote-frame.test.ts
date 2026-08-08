import { describe, expect, it } from 'vitest';
import { advanceFrame, drainFrames, emptyFrameSlots } from './remote-frame.js';

describe('which streamed frames are safe to destroy', () => {
  /**
   * The bug this exists for: the live view of the agent computer was black. Frames were arriving
   * the whole time - the blob id changed between two reads of the page - but each new frame revoked
   * the URL the <img> was still painting, so the element decoded nothing and showed nothing.
   */
  it('never revokes the frame the element is being asked to paint', () => {
    let slots = emptyFrameSlots;
    const revoked: string[] = [];
    for (const url of ['blob:1', 'blob:2', 'blob:3', 'blob:4', 'blob:5']) {
      const step = advanceFrame(slots, url);
      slots = step.slots;
      if (step.revoke) revoked.push(step.revoke);
      // The invariant, checked on every single frame rather than at the end: whatever was just
      // handed to the element is still alive.
      expect(revoked).not.toContain(slots.current);
    }
    // And the one before it, which the element may not have finished painting, is alive too.
    expect(revoked).not.toContain(slots.prior);
    // Everything older is gone, so a long-running stream does not leak a blob per frame.
    expect(revoked).toEqual(['blob:1', 'blob:2', 'blob:3']);
  });

  it('holds nothing back on the first two frames, when nothing has aged out yet', () => {
    const first = advanceFrame(emptyFrameSlots, 'blob:1');
    expect(first.revoke).toBe('');
    const second = advanceFrame(first.slots, 'blob:2');
    expect(second.revoke).toBe('');
    expect(second.slots).toEqual({ current: 'blob:2', prior: 'blob:1' });
  });

  it('gives up both held frames on teardown', () => {
    const first = advanceFrame(emptyFrameSlots, 'blob:1');
    const second = advanceFrame(first.slots, 'blob:2');
    const drained = drainFrames(second.slots);
    expect(drained.revoke).toEqual(['blob:2', 'blob:1']);
    expect(drained.slots).toEqual(emptyFrameSlots);
  });

  it('drains a stream that never produced a frame without revoking an empty url', () => {
    expect(drainFrames(emptyFrameSlots).revoke).toEqual([]);
  });
});
