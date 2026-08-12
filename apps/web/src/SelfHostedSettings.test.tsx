/**
 * The second list in the memory section: what the computer wrote down on its own.
 *
 * Everything asserted here is about the owner being able to see it and take it back — the excerpt
 * that says what is actually stored, the time it was observed, and a delete that is one press away
 * from happening rather than behind a dialog.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RememberedList, SpendCeilingField, spendCeilingRequest } from './SelfHostedSettings.js';
import { BASE_MONTHLY_CEILING_USD } from './usage-model.js';
import type { MemoryItem } from './api.js';

const items: MemoryItem[] = [
  {
    id: 'a1',
    kind: 'episode',
    status: 'active',
    excerpt: 'Goal: Prepare the quarterly numbers',
    observedAt: '2026-02-01T09:00:00.000Z'
  },
  {
    id: 'b2',
    kind: 'fact',
    status: 'superseded',
    excerpt: 'Reports open with an executive summary',
    observedAt: '2026-01-04T18:30:00.000Z'
  }
];

const render = (list: MemoryItem[], more = false): string =>
  renderToStaticMarkup(
    <RememberedList
      items={list}
      more={more}
      onShowOlder={() => undefined}
      onForget={() => undefined}
    />
  );

describe('the list of what the computer remembers by itself', () => {
  it('shows what is stored rather than a description of it', () => {
    const markup = render(items);
    expect(markup).toContain('Goal: Prepare the quarterly numbers');
    expect(markup).toContain('Reports open with an executive summary');
  });

  /* A row the agent has stopped believing is still a row about the owner, and says which it is. */
  it('names the tier in the owner’s words and marks a row that is no longer live', () => {
    const markup = render(items);
    expect(markup).toContain('Conversation');
    expect(markup).toContain('Fact · superseded');
  });

  it('offers a delete on every row, and no dialog', () => {
    const markup = render(items);
    expect(markup.match(/aria-label="Delete what was remembered"/gu)).toHaveLength(2);
    expect(markup).not.toContain('role="dialog"');
    /* Armed by the first press, so the destructive word is not in the markup until it is. */
    expect(markup).not.toContain('Delete for good');
  });

  /* One sentence carries both how much is shown and how the rest is reached. */
  it('says how the list is ordered, and offers older rows only when there may be some', () => {
    expect(render(items)).toContain('Written down on its own as work finished, newest first.');
    expect(render(items)).not.toContain('Show older');
    expect(render(items, true)).toContain('Show older');
  });

  it('draws nothing at all when the computer has written nothing down', () => {
    expect(render([])).toBe('');
  });
});

/*
 * The ceiling asked for while the key is being pasted.
 *
 * Every cap shipped unset and an unset cap refuses nothing, so a box nobody had been through the
 * settings of had the whole spending guard switched off. What is asserted here is that the question
 * is answerable in one field, that the number is already in it, and that saying no is a real answer
 * rather than a silence the server cannot tell from never having asked.
 */
describe('the spending ceiling asked for with the key', () => {
  const field = (value: string): string =>
    renderToStaticMarkup(<SpendCeilingField value={value} onChange={() => undefined} />);

  it('arrives with a number in it that can be accepted without thinking', () => {
    const markup = field(String(BASE_MONTHLY_CEILING_USD));
    expect(markup).toContain('value="50"');
    expect(markup).toContain('Stop at, per month');
  });

  it('says what one number buys and that it can be refused', () => {
    const markup = field('50');
    expect(markup).toContain('A quarter of it is the most any one day may spend');
    expect(markup).toContain('Leave it blank for no ceiling');
  });

  it('sends the accepted number with the owner’s own zone', () => {
    expect(spendCeilingRequest('50', 'Europe/Lisbon')).toEqual({
      monthlyCapUsd: 50,
      timeZone: 'Europe/Lisbon'
    });
  });

  /* An empty field is a decision, and it is sent as one: the server records that it asked. */
  it('sends an explicit no rather than nothing when the field is cleared', () => {
    expect(spendCeilingRequest('   ', 'UTC')).toEqual({ monthlyCapUsd: null, timeZone: 'UTC' });
  });

  /* A key is worth more than a tidy form, so text nobody can price is dropped, not refused. */
  it('withholds an answer it cannot read as money', () => {
    expect(spendCeilingRequest('later', 'UTC')).toBeUndefined();
    expect(spendCeilingRequest('-5', 'UTC')).toBeUndefined();
  });
});
