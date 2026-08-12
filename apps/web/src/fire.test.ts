/**
 * The tuning of the fire, which is the whole of whether it is an instrument or a lava lamp.
 *
 * Two of these are the ones the design ruling named, and if either could not be written the idea
 * does not ship: forty seconds of silence during a running turn must leave the flame **exactly on
 * its floor**, because a still flame is how this product says "stalled"; and a catch-up burst of
 * five hundred buffered events must not push it past the ceiling, because a reconnection is not
 * more alive than an answer.
 *
 * Driven through the real module rather than a copy of its arithmetic - the decay is only correct
 * if it is the interval that runs it, the visibility gate only works if it is checked inside that
 * interval, and both have been wrong in exactly that way before. `requestAnimationFrame` is a
 * zero-delay timeout here so the fake clock drives the coalescing too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every value the module has written to a registered mark, in order. */
const written: number[] = [];
const mark = {
  style: {
    setProperty: (_name: string, value: string) => {
      written.push(Number(value));
    }
  }
} as unknown as SVGSVGElement;

let reduced = false;
let visible = true;

const latest = (): number => written[written.length - 1] ?? Number.NaN;

const load = () => import('./fire.js');

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  written.length = 0;
  reduced = false;
  visible = true;
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
  vi.stubGlobal('document', {
    documentElement: { dataset: {} as Record<string, string> },
    get visibilityState() {
      return visible ? 'visible' : 'hidden';
    }
  });
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => setTimeout(run, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the flame as a reading of the event stream', () => {
  it('falls to the floor of a running turn and stays there, so a stall is still', async () => {
    const fire = await load();
    fire.registerFire(mark);
    fire.setFire('drawing');
    const stop = fire.startFire();

    // A turn that was producing, and then stopped producing.
    for (let event = 0; event < 40; event += 1) fire.bumpFire();
    vi.advanceTimersByTime(1000);
    const whileProducing = latest();

    vi.advanceTimersByTime(45_000);
    stop();

    expect(whileProducing).toBeGreaterThan(fire.FLOOR.drawing + 0.1);
    expect(Math.abs(latest() - fire.FLOOR.drawing)).toBeLessThan(0.01);
  });

  it('will not let a reconnection burn hotter than an answer', async () => {
    const fire = await load();
    fire.registerFire(mark);
    fire.setFire('drawing');
    const stop = fire.startFire();

    // The shape a dropped stream comes back in: a page of buffered events inside one second.
    for (let event = 0; event < 500; event += 1) {
      fire.bumpFire();
      if (event % 125 === 124) vi.advanceTimersByTime(250);
    }
    stop();

    // `toFixed(3)` is the only rounding between the model and the mark.
    expect(Math.max(...written)).toBeLessThanOrEqual(fire.FLOOR.drawing + fire.CEILING + 0.0005);
  });

  it('does not run in a pocket', async () => {
    const fire = await load();
    fire.registerFire(mark);
    fire.setFire('drawing');
    const stop = fire.startFire();
    fire.bumpFire(fire.CEILING);
    // 251 rather than 250: the tick schedules the write, and the write is a frame behind it.
    vi.advanceTimersByTime(251);

    visible = false;
    const writes = written.length;
    const heldWhileHidden = latest();
    vi.advanceTimersByTime(30_000);
    expect(written.length).toBe(writes);

    // And picks the decay back up where it left it rather than snapping to where it would have
    // been - half an hour in a pocket is not half an hour of silence from the machine.
    visible = true;
    vi.advanceTimersByTime(2001);
    stop();
    expect(latest()).toBeLessThan(heldWhileHidden);
    expect(latest()).toBeGreaterThan(fire.FLOOR.drawing);
  });

  it('gives a reader who asked for less motion four heights and no flicker', async () => {
    reduced = true;
    const fire = await load();
    fire.registerFire(mark);
    const stop = fire.startFire();

    // Not a frozen animation and not a stopped one: there is no clock at all.
    expect(vi.getTimerCount()).toBe(0);

    const settled = written.length;
    for (let event = 0; event < 200; event += 1) fire.bumpFire();
    vi.advanceTimersByTime(60_000);
    expect(written.length).toBe(settled);

    fire.setFire('drawing');
    vi.advanceTimersByTime(1);
    expect(latest()).toBe(fire.FLOOR.drawing);

    fire.setFire('cold');
    vi.advanceTimersByTime(1);
    expect(latest()).toBe(fire.FLOOR.cold);
    stop();
  });

  it('stops writing to a mark that has gone', async () => {
    const fire = await load();
    const unregister = fire.registerFire(mark);
    fire.setFire('drawing');
    vi.advanceTimersByTime(1);
    expect(written.length).toBeGreaterThan(0);

    unregister?.();
    const afterUnmount = written.length;
    fire.setFire('cold');
    vi.advanceTimersByTime(1);
    expect(written.length).toBe(afterUnmount);
  });

  it('says which state it is in where the stylesheet can read it', async () => {
    const fire = await load();
    fire.setFire('calling');
    expect(document.documentElement.dataset.fire).toBe('calling');
  });
});

/**
 * The word beside the mark, which is the whole of what stops this instrument from being carried by
 * colour, motion or shape alone - and which is also the honest fix to a label that had been saying
 * **Ready** through every turn the box has ever run.
 */
describe('the word beside the fire', () => {
  it('says what the box wants rather than what the computer is', async () => {
    const { hearthLabel } = await import('./workspace-status.js');
    expect(hearthLabel('calling', 'running')).toBe('Your move');
    expect(hearthLabel('drawing', 'running')).toBe('Working');
  });

  it('falls back to the computer for the two states that have nothing else to say', async () => {
    const { hearthLabel } = await import('./workspace-status.js');
    expect(hearthLabel('banked', 'running')).toBe('Ready');
    expect(hearthLabel('cold', 'hibernated')).toBe('Sleeping');
    expect(hearthLabel('cold', 'failed')).toBe('Needs attention');
  });
});
