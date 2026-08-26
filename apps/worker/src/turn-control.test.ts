/**
 * The third question a turn asks between steps: is the request about to go out the one this turn's
 * own log accounts for?
 *
 * This repository's named signature defect is a control wired to nothing - a gate that computes the
 * right verdict and is never consulted, a set that is built and never read, a withdrawal decided
 * and then not applied. The audit found that shape more than thirty times, and every one of them was
 * found by a person reading two files against each other, because nothing in the product ever
 * re-derived what it was about to do from what it had recorded.
 *
 * The model request is the largest such control there is: it is the whole of what the model sees, it
 * is assembled from four independent inputs at three points in the loop, and a divergence in it is
 * silent - a provider answers a wrong window exactly as readily as a right one, and the answer looks
 * like an ordinary reply.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ModelMessage } from '@athanor/model-gateway';
import { describe, expect, it } from 'vitest';
import { requestDerivationBreach } from './turn-control.js';

const window = (): ModelMessage[] => [
  { role: 'system', content: 'ATHANOR RUNTIME CONTEXT (dynamic)' },
  { role: 'user', content: 'fix the importer' },
  {
    role: 'assistant',
    content: 'looking',
    toolCalls: [{ id: 'call-1', name: 'shell', arguments: { command: 'pytest' } }]
  },
  { role: 'tool', content: 'exit 0', toolCallId: 'call-1' }
];

const tools = (): Array<{ name: string }> => [
  { name: 'file_read' },
  { name: 'file_write' },
  { name: 'shell' },
  { name: 'compact_context' }
];

const request = (
  overrides: Partial<Parameters<typeof requestDerivationBreach>[0]> = {}
): Parameters<typeof requestDerivationBreach>[0] => ({
  prepared: window(),
  rederived: window(),
  sent: tools(),
  entitled: tools(),
  reservedTokens: 1_200,
  reservedTokensOfSent: 1_200,
  ...overrides
});

describe('the request athanor is about to send', () => {
  it('says nothing about a request the log derives', () => {
    expect(requestDerivationBreach(request())).toBeNull();
  });

  /**
   * The class the programme names: anything that edits `state.messages` after the window is
   * prepared - a taint notice, a pushback, a compaction re-entered on a retry path - produces a
   * request the persisted trajectory cannot account for, and a resume then replays a different
   * conversation than the one that was billed.
   */
  it('catches a window edited after it was prepared', () => {
    const edited = window();
    edited.push({ role: 'system', content: 'A notice that arrived after the window was built.' });
    const breach = requestDerivationBreach(request({ rederived: edited }));
    expect(breach).toContain('4 messages');
    expect(breach).toContain('5');
  });

  it('catches a message whose content moved without the count changing', () => {
    const rewritten = window();
    rewritten[1] = { role: 'user', content: 'fix the importer, and then deploy it' };
    expect(requestDerivationBreach(request({ rederived: rewritten }))).toContain(
      'message 1 (user)'
    );
  });

  it('catches a message whose role or addressee moved', () => {
    const reroled = window();
    reroled[3] = { role: 'tool', content: 'exit 0', toolCallId: 'call-2' };
    expect(requestDerivationBreach(request({ rederived: reroled }))).toContain('message 3');
  });

  it('catches a tool call appearing on a message the log does not carry one on', () => {
    const extra = window();
    extra[2] = {
      role: 'assistant',
      content: 'looking',
      toolCalls: [
        { id: 'call-1', name: 'shell', arguments: { command: 'pytest' } },
        { id: 'call-2', name: 'shell', arguments: { command: 'rm -rf /' } }
      ]
    };
    expect(requestDerivationBreach(request({ rederived: extra }))).toContain('tool calls');
  });

  /**
   * The withdrawal class. The set is built once for the whole run precisely so the catalogue stays
   * byte-identical across steps; a later rebuild that forgets a withdrawal restores a tool the box
   * cannot honour, and moves the head of the cached prefix while doing it.
   */
  it('catches a tool the run withdrew being sent anyway', () => {
    const breach = requestDerivationBreach(
      request({ sent: [...tools(), { name: 'connector_action' }] })
    );
    expect(breach).toContain('withdrew');
    expect(breach).toContain('5');
  });

  it('catches the same tools in a different order, because the prefix is bytes and not a set', () => {
    expect(requestDerivationBreach(request({ sent: [...tools()].reverse() }))).toContain('tools');
  });

  /**
   * The budget class. `reservedTokens` is computed in three places from three arrays, and it is the
   * number the input budget, the compaction trigger and the handoff's own floor are all derived
   * from. A drift there is a window sized against a request nobody is sending.
   */
  it('catches a budget computed against a different catalogue than the one going out', () => {
    const breach = requestDerivationBreach(request({ reservedTokensOfSent: 1_900 }));
    expect(breach).toContain('1200');
    expect(breach).toContain('1900');
  });

  it('reports the tools before the window, because a wrong catalogue explains a wrong window', () => {
    const both = requestDerivationBreach(
      request({ sent: [...tools(), { name: 'connector_action' }], rederived: [] })
    );
    expect(both).toContain('withdrew');
  });
});

/**
 * And that it is consulted, which is the half a unit test cannot reach.
 *
 * Read from the source for `preamble-ownership.test.ts`'s stated reason, and it applies here more
 * strongly: the failure is an *ordering* inside one method - the check must sit past every branch
 * that can still edit the window and in front of the one call that spends the owner's money - and
 * there is deliberately no live mutation between those two points today, so a driven turn can only
 * observe this by arranging one, which measures the arrangement rather than the program.
 */
describe('and it is asked before the request goes out', () => {
  const source = readFileSync(fileURLToPath(new URL('./agent.ts', import.meta.url)), 'utf8').split(
    '\n'
  );
  const lineOf = (needle: string, from = 0): number => {
    const index = source.findIndex((line, at) => at >= from && line.includes(needle));
    if (index < 0) throw new Error(`anchor not found in agent.ts: ${needle}`);
    return index + 1;
  };

  it('sits between the window being prepared and the step being sent', () => {
    const prepared = lineOf('const preparedContext = prepareModelContext(');
    const asked = lineOf('const derivationBreach = requestDerivationBreach({', prepared);
    const sent = lineOf('gateway.chat(provider, {', asked);
    expect(asked).toBeGreaterThan(prepared);
    expect(sent).toBeGreaterThan(asked);
  });

  /**
   * And that the raise is guarded by the answer, which is a stronger claim than that a `throw`
   * exists somewhere below the question - and it had to be, because it did not start out that way.
   * The first version of this test asserted only that the throw was present in the following thirty
   * lines, and the mutation it was written to catch - `if (false as boolean)` in front of an
   * otherwise untouched raise, which is this repository's signature defect exactly - walked straight
   * past it. A gate that has never been seen to fail is a gate nobody knows works, and that goes for
   * the test as much as for the code it watches.
   */
  it('raises on the answer itself, so a request this side cannot account for is never billed', () => {
    const asked = lineOf('const derivationBreach = requestDerivationBreach({');
    const guard = lineOf('if (derivationBreach)', asked);
    // The condition is the breach and nothing else: not a constant, not a flag, not a negation.
    expect(source[guard - 1]?.trim()).toBe('if (derivationBreach)');
    // And the next two statements are the raise, so nothing can be inserted between the two.
    expect(source[guard]?.trim()).toBe('throw new AthanorError(');
    expect(source[guard + 1]?.trim()).toBe("'request_not_derivable',");
  });
});
