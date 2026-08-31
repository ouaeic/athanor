/**
 * The ways this rig breaks the reach, so that the number can be watched moving.
 *
 * An instrument nobody has seen fall is not an instrument, and a committed number that only ever
 * goes up is a ratchet wearing an instrument's clothes. Each fault below is a **defect this
 * repository actually had**, put back:
 *
 * 1. `no-citation` - `memory-capture.ts:92` mapping the completion's evidence to `item.claim`, so
 *    the `toolCallId` the model was made to cite went no further than the line that read it. This
 *    is the state of the tree at `00a2168` and it is the rig's red baseline: nothing is wired
 *    wrong, the edge is simply never written, and no ranking, no `maxResults` and no model can
 *    move the number off the floor.
 * 2. `pointer-only` - `listMemoryEvidence` selecting `source_id, span, occurred_at` and **not**
 *    `body_ciphertext`, which is what it did before this wave: a method that can name the exact
 *    character range of the exact stored turn and hands back a reference nothing can dereference.
 *    Applied here to both provenance readers at once, because the same defect on the citation side
 *    is a `mem.cited_call` row whose `task_events` payload is never opened.
 * 3. `span-shifted` - the half-open `int4range` Postgres stores read as though it were closed. The
 *    control for it is `span-exact`, the same arithmetic done right, because a fall is only a fall
 *    against something.
 *
 * Faults 1 and 3 are seeded: the store is stood up the way the defective writer would have left
 * it, and the shipped reader reads it. Fault 2 is a decorator over the store the shipped reader
 * holds, because that defect was in the SELECT rather than in the data - there is no way to write
 * a row that arrives without its body. Neither touches a file outside `evals/`, which is what lets
 * this rig break a mechanism another lane owns without editing it.
 */
import type { EncryptedEnvelope } from '../../packages/core/src/index.js';
import type { DataStore } from '../../packages/data/src/index.js';
import type { SeededStore, SeedShape } from './seed.js';

export type Fault = 'none' | 'pointer-only';

export const seedShapeOf = (name: string): SeedShape => {
  switch (name) {
    case 'no-citation':
      return { citations: 'dropped', spans: 'absent', cite: 'gold' };
    case 'span-exact':
      return { citations: 'kept', spans: 'exact', cite: 'gold' };
    case 'span-shifted':
      return { citations: 'kept', spans: 'shifted', cite: 'gold' };
    case 'cite-all':
      return { citations: 'kept', spans: 'absent', cite: 'all' };
    case 'production':
      return { citations: 'kept', spans: 'absent', cite: 'gold' };
    default:
      throw new Error(`evals/reach: no seeded shape called ${name}`);
  }
};

/**
 * An envelope that is still a pointer and no longer a body.
 *
 * The context is rewritten rather than the ciphertext, so nothing is corrupted and no exception is
 * thrown: both readers check the declared context before they try the key - `openTaskEventPayload`
 * returns early on a mismatched `task-event:<id>`, and the evidence loop `continue`s on a
 * mismatched `memory-source:<id>` - so what comes back is the row minus its words, which is
 * precisely the shape the old SELECT produced.
 */
const withoutBody = (envelope: EncryptedEnvelope): EncryptedEnvelope => ({
  ...envelope,
  aad: 'pointer-only'
});

/**
 * The store as the reach's reader sees it, with one fault applied.
 *
 * A `Proxy` binding every other method straight through to the real `DataStore`: the class holds
 * private fields, so a method lifted off it and called on a copy would throw, and binding is what
 * keeps the ninety-odd untouched methods behaving exactly as they do in production.
 */
export const breakStore = (seeded: SeededStore, fault: Fault): SeededStore => {
  if (fault === 'none') return seeded;
  const real = seeded.store;
  const store = new Proxy(real, {
    get(target, property, receiver) {
      if (property === 'listMemoryCitedCalls')
        return async (...args: Parameters<DataStore['listMemoryCitedCalls']>) =>
          (await target.listMemoryCitedCalls(...args)).map((row) => ({
            ...row,
            payloadCiphertext: withoutBody(row.payloadCiphertext)
          }));
      if (property === 'listMemoryEvidence')
        return async (...args: Parameters<DataStore['listMemoryEvidence']>) =>
          (await target.listMemoryEvidence(...args)).map((row) => ({
            ...row,
            bodyCiphertext: withoutBody(row.bodyCiphertext)
          }));
      const value: unknown = Reflect.get(target, property, receiver);
      // Bound to the target rather than the proxy, so a method that calls a sibling reaches the
      // real one instead of re-entering the fault above and injecting the same fault twice.
      return typeof value === 'function'
        ? (value as (...args: never[]) => unknown).bind(target)
        : value;
    }
  });
  return { ...seeded, store };
};

/** One arrangement of the store and what it is meant to demonstrate. */
export interface FallRow {
  readonly name: string;
  readonly note: string;
  readonly shape: SeedShape;
  readonly fault: Fault;
}

/**
 * The table `--fall` runs, in the order it is meant to be read: what the tree does now, then the
 * three defects, then the two sensitivities that are not defects at all.
 */
export const FALL_TABLE: readonly FallRow[] = [
  {
    name: 'shipped',
    note: 'the reach as the tree has it: citations kept, spans as the writer leaves them (NULL)',
    shape: seedShapeOf('production'),
    fault: 'none'
  },
  {
    name: 'no-citation',
    note: 'memory-capture.ts:92 as it was - the toolCallId dropped one line before it is stored',
    shape: seedShapeOf('no-citation'),
    fault: 'none'
  },
  {
    name: 'pointer-only',
    note: 'listMemoryEvidence as it was - source_id and span returned, body_ciphertext not selected',
    shape: seedShapeOf('production'),
    fault: 'pointer-only'
  },
  {
    name: 'span-exact',
    note: 'the span nothing writes, written correctly: [0,len) over each cited chunk',
    shape: seedShapeOf('span-exact'),
    fault: 'none'
  },
  {
    name: 'span-shifted',
    note: 'that same arithmetic one out - the half-open range read as though it were closed',
    shape: seedShapeOf('span-shifted'),
    fault: 'none'
  },
  {
    name: 'cite-all',
    note: 'not a defect: every call of the turn cited, so one reach budget covers all of them',
    shape: seedShapeOf('cite-all'),
    fault: 'none'
  }
];
