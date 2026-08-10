import { describe, expect, it } from 'vitest';
import {
  composerStrip,
  type ComposerStripKind,
  type ComposerStripState
} from './composer-strip.js';

const quiet: ComposerStripState = {
  approval: false,
  block: false,
  offline: false,
  storage: false,
  error: false,
  streamDegraded: false,
  notice: false
};

/** The declared order, highest first. Every pair below is generated from it. */
const order: ComposerStripKind[] = [
  'approval',
  'block',
  'offline',
  'storage',
  'error',
  'degraded',
  'notice'
];

const field: Record<ComposerStripKind, keyof ComposerStripState> = {
  approval: 'approval',
  block: 'block',
  offline: 'offline',
  storage: 'storage',
  error: 'error',
  degraded: 'streamDegraded',
  notice: 'notice'
};

const raise = (...kinds: ComposerStripKind[]): ComposerStripState =>
  kinds.reduce<ComposerStripState>((state, kind) => ({ ...state, [field[kind]]: true }), {
    ...quiet
  });

describe('what sits above the composer', () => {
  it('shows nothing when nothing is wrong', () => {
    expect(composerStrip(quiet)).toBeUndefined();
  });

  it('shows each condition on its own', () => {
    for (const kind of order) expect(composerStrip(raise(kind))).toBe(kind);
  });

  /*
   * Every pair, both ways round, so the order is a property of this module rather than of the
   * sequence the conditions happen to be written in. The guards this replaced covered three of the
   * twenty-one pairs.
   */
  for (const [index, higher] of order.entries())
    for (const lower of order.slice(index + 1))
      it(`shows ${higher} rather than ${lower}`, () => {
        expect(composerStrip(raise(higher, lower))).toBe(higher);
        expect(composerStrip(raise(lower, higher))).toBe(higher);
      });

  /*
   * The state this was written for: a box near its disk ceiling drops its connection, so the
   * request in flight fails too. All three used to render at once - three alarm colours over a
   * 176px composer, which on a 375px phone is most of the screen. The connection is the one the
   * owner can do something about, and it is the reason the other two are on screen.
   */
  it('shows one thing when the disk, the connection and a request all fail together', () => {
    expect(composerStrip(raise('storage', 'offline', 'error'))).toBe('offline');
  });

  /* The owner's turn beats everything, including the three-way failure it was raised during. */
  it('never buries an approval under the machine reporting on itself', () => {
    expect(composerStrip(raise('approval', 'offline', 'storage', 'error', 'notice'))).toBe(
      'approval'
    );
  });

  /* A degraded stream is a slower version of offline; it never appeared beside it and must not. */
  it('does not report a degraded stream while there is no connection at all', () => {
    expect(composerStrip(raise('offline', 'degraded'))).toBe('offline');
  });
});
