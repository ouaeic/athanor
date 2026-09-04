/**
 * The fire in the mark, driven by the event stream rather than by a clock.
 *
 * A spinner spins identically whether a turn is producing tokens or has been dead for eleven
 * minutes, and the eleven-minute one is the turn this product exists for - it happens on somebody's
 * own box, overnight, with nobody watching (see `live-activity.ts`). So the flame's motion is not a
 * loop. It is the arriving events, summed and decayed: every event puffs the draught up, and every
 * quarter-second takes a fixed fraction of that puff away again. Forty seconds of silence lets it
 * fall to the floor for whatever state the box is in and stay there.
 *
 * That is the whole signal, and it is the half no spinner can carry: **a high, perfectly still
 * flame during a running turn is a stall.** The floors say what the box thinks it is doing; the
 * movement above them says whether anything is actually coming out of it.
 *
 * `--draught` is written on the registered `<svg>`s only and never on `:root`, because an inherited
 * custom property on the root element invalidates style for the whole document and this one moves
 * four times a second while an answer is arriving. The pattern is `main.tsx`'s: coalesced onto a
 * frame, and an unchanged value written nowhere.
 */
export type FireState = 'cold' | 'banked' | 'drawing' | 'calling';

/**
 * Where the flame sits when nothing has happened for a while, per state. `cold` is out; `banked` is
 * the pilot light of a box that is up and idle; `drawing` and `calling` are close together on
 * purpose - the difference between them is carried by the door rim and by a word, not by height.
 */
export const FLOOR: Record<FireState, number> = {
  cold: 0,
  banked: 0.18,
  drawing: 0.52,
  calling: 0.62
};

/**
 * The tuning, and it is the part `fire.test.ts` holds. `DECAY` at 0.86 every 250ms is a half-life
 * of about 1.1s, so a burst is gone inside ten seconds and forty seconds of silence is
 * indistinguishable from never having happened. `CEILING` is what stops a catch-up of six hundred
 * buffered events from pinning the flame at full height for a minute.
 */
export const PUFF = 0.09;
export const DECAY = 0.86;
export const CEILING = 0.3;

const nodes = new Set<SVGSVGElement>();
let frame = 0;
let draught = FLOOR.banked;
let puff = 0;
let state: FireState = 'banked';
let calm = false;

const write = (): void => {
  frame = 0;
  const height = draught.toFixed(3);
  for (const node of nodes) node.style.setProperty('--draught', height);
};

/** A hundredth of a flame is invisible and a style recalculation, so it is not worth having. */
const publish = (next: number): void => {
  if (Math.abs(next - draught) < 0.01) return;
  draught = next;
  if (!frame) frame = requestAnimationFrame(write);
};

/**
 * Takes the current height immediately, because a mark that mounts mid-turn must not start banked
 * and animate up to the truth. Returns the unregister, which every caller owes: three marks mount
 * on the sign-in screen alone, and a `Set` of detached nodes is a leak that writes to nothing.
 */
/**
 * The current draught, for anything that DRAWS the fire rather than styling one.
 *
 * The mark takes its height from a custom property because it is an SVG and that is how an SVG is
 * animated. The room's fire is painted by a shader, which cannot read a custom property without a
 * layout flush per frame - so it reads the number instead. Same signal, same source, and still the
 * one that says a turn is running but nothing is coming out of it.
 */
export const readDraught = (): number => draught;

export const registerFire = (node: SVGSVGElement | null): (() => void) | undefined => {
  if (!node) return undefined;
  nodes.add(node);
  node.style.setProperty('--draught', draught.toFixed(3));
  return () => void nodes.delete(node);
};

/** One event, one puff. Called from the place events actually land, not from a render. */
export const bumpFire = (amount = PUFF): void => {
  if (!calm) puff = Math.min(CEILING, puff + amount);
};

export const setFire = (next: FireState): void => {
  state = next;
  document.documentElement.dataset.fire = next;
  publish(FLOOR[state] + puff);
};

export const startFire = (): (() => void) => {
  /*
   * The still form is not a frozen animation, it is the absence of one: four discrete heights,
   * written once per state change. A reader who asked for less motion gets no flicker at all,
   * rather than the same flicker in hard 250ms steps - which is what a naive version gives, because
   * the global reduced-motion policy can only shorten a transition, not stop the value under it
   * from moving. The four heights still say which of the four states the box is in, so the still
   * form carries the same information as the moving one; what it drops is the throughput reading,
   * which is the part that cannot exist without movement.
   */
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    calm = true;
    puff = 0;
    publish(FLOOR[state]);
    return () => {};
  }
  const ticking = setInterval(() => {
    // A backgrounded tab is not a tab anybody is reading a flame in, and this is the one timer in
    // the client that would otherwise run in a pocket.
    if (document.visibilityState !== 'visible') return;
    puff *= DECAY;
    publish(FLOOR[state] + puff);
  }, 250);
  return () => clearInterval(ticking);
};
