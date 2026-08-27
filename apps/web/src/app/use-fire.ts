import { useEffect } from 'react';
import { setFire, startFire, type FireState } from '../fire.js';
import { isLiveTask, taskIsGenerating } from '../task-status.js';
import type { Bootstrap, Workspace } from '../types.js';

/**
 * What the fire in the mark is doing, derived from state this screen already holds.
 *
 * No new vocabulary and no new request: a box that cannot be reached or is not up is out; anything
 * waiting on the owner is the one thing they can act on; a turn that can still produce text is
 * drawing. Everything else is the pilot light. The height above those four floors is not decided
 * here - it is the event stream, in `fire.ts`, which is the half that can tell a stall from a run.
 *
 * Every conversation on the box, not the open one: the reason to look at the corner of the screen
 * is to find out whether the machine is doing anything at all.
 *
 * Out means we looked and the fire is not lit. It does not mean we have not looked yet. This runs
 * above the auth gate, so on the splash and the sign-in pair there is no bootstrap and no
 * workspace - and the first version read that as `cold`, which put a grey flame at a third height
 * on the first screen a new owner ever sees. That is the interface asserting something it does not
 * know, which is the fault this whole design exists to remove, and it asserted it about the one
 * thing the owner has not been able to check yet. So the fire rests until the box has answered.
 * Banked is the honest state for "not yet told": the furnace this is named after is never out, it
 * is only ever low.
 */
export const useFire = (input: {
  auth: 'loading' | 'required' | 'ready';
  data: Bootstrap | undefined;
  offline: boolean;
  workspace: Workspace | undefined;
  approvalCount: number;
}): FireState => {
  const { auth, data, offline, workspace, approvalCount } = input;
  const state: FireState =
    auth !== 'ready' || !data
      ? 'banked'
      : offline || !workspace || workspace.status === 'failed' || workspace.status === 'hibernated'
        ? 'cold'
        : approvalCount > 0 || data.tasks.some((item) => item.status === 'awaiting_user')
          ? 'calling'
          : data.tasks.some((item) => isLiveTask(item) && taskIsGenerating(item.status))
            ? 'drawing'
            : 'banked';
  useEffect(() => startFire(), []);
  useEffect(() => setFire(state), [state]);
  return state;
};
