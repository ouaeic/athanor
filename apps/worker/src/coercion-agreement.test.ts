import { describe, expect, it } from 'vitest';
import { parseAcceptanceChecks } from './acceptance.js';
import { surfaceActionRequest, surfaceActionVerb } from './surface-actions.js';
import { textValue } from './values.js';

/**
 * The card that describes an action and the arm that performs it read one value the same way.
 *
 * There were three functions called `textValue` in this package with three different answers, and
 * the split ran through the approval path: the four modules that build a card and run the floor
 * (`approval-policy`, `approval-cards`, `write-classification`, `command-classification`) read
 * arguments through the copy in `surface-actions.ts`, and every arm that then performed the call
 * read them through `values.ts`. `acceptance.ts` had a third, narrower still.
 *
 * Two shapes separated them, and both are asserted here rather than described:
 *
 *   - a bigint verb: the card's copy answered `''` and the arm's answered `'7'`, so the gate and
 *     the executor disagreed about what the call even was. Nothing on today's wire produces a
 *     bigint - a tool call is `JSON.parse`d - so this half was latent. It was latent by luck.
 *   - a boolean acceptance argument: the acceptance copy answered `''`, so a check declared as
 *     `{executable:'pytest', args:['--maxfail', false]}` ran as `pytest --maxfail ''`. That half
 *     was live, reachable from the model's own JSON, and silent.
 *
 * These are the two shapes, not two examples of a family: `textValue` differs from `textValue` on
 * exactly `bigint` and `boolean` and nowhere else, which is why two cases are the whole of it.
 *
 * The structural guarantee is that `values.ts` now holds the only copy. This file is what notices
 * if a second one comes back, because a second one would have to disagree on one of these two
 * shapes to be worth writing.
 */
describe('one reading of a value, for the card and for the arm', () => {
  it('a bigint verb resolves to the same string for the gate and for the runner request', () => {
    const bag: Record<string, unknown> = { action: 7n, x: 10, y: 20 };
    // What the approval floor and the card are told the verb is.
    const gateVerb = surfaceActionVerb(bag);
    // What the runner is actually sent.
    const executedVerb = surfaceActionRequest(bag).type;
    // What an arm reading the same field gets.
    const armVerb = textValue(bag.action);
    expect(gateVerb).toBe('7');
    expect(executedVerb).toBe(gateVerb);
    expect(armVerb).toBe(gateVerb);
  });

  it('a boolean acceptance argument survives into the command the harness runs', () => {
    const parsed = parseAcceptanceChecks([
      {
        kind: 'command',
        label: 'the suite passes',
        executable: 'pytest',
        args: ['--maxfail', false]
      }
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const check = parsed.checks[0];
    expect(check?.kind).toBe('command');
    if (check?.kind !== 'command') return;
    // Not `['--maxfail', '']`, which is what the third copy produced and nothing reported.
    expect(check.args).toEqual(['--maxfail', 'false']);
  });
});
