/**
 * The second list in the memory section: what the computer wrote down on its own.
 *
 * Everything asserted here is about the owner being able to see it and take it back — the excerpt
 * that says what is actually stored, the time it was observed, and a delete that is one press away
 * from happening rather than behind a dialog.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ContextWindowField,
  MemoryList,
  RememberedList,
  SkillList,
  SpendCeilingField,
  spendCeilingRequest
} from './SelfHostedSettings.js';
import { BASE_MONTHLY_CEILING_USD } from './usage-model.js';
import { providerModelFields, skillStateNotice, skillSwitch } from './settings-facts.js';
import type { MemoryItem, ProviderSettings } from './api.js';
import type { WorkspaceMemory, WorkspaceSkill } from './types.js';

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

/*
 * The durable facts: the list that is read back into every task.
 *
 * It was add-and-delete. Correcting one word meant deleting the row and typing it again, losing
 * `createdAt` and any expiry with it — and it printed the row's *scope* where a reader looks for its
 * provenance, so a fact the agent decided about the owner and one the owner typed read identically.
 * Both of those facts have been served and typed since the list existed and were drawn by nothing.
 */
describe('the durable memory list', () => {
  const memories: WorkspaceMemory[] = [
    {
      id: 'm1',
      target: 'workspace',
      scope: 'workspace',
      content: 'Deploys go out on Thursdays',
      status: 'active',
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: null,
      source: 'agent',
      sourceTaskId: 't-99',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'm2',
      target: 'user',
      scope: 'user',
      content: 'Call me Dan',
      status: 'active',
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2026-11-03T00:00:00.000Z',
      source: 'owner',
      sourceTaskId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
  ];

  const list = (props: Partial<Parameters<typeof MemoryList>[0]> = {}): string =>
    renderToStaticMarkup(
      <MemoryList
        items={memories}
        onEdit={() => undefined}
        onForget={() => undefined}
        onOpenTask={() => undefined}
        {...props}
      />
    );

  /* The whole edit path is opening the row into the form above, exactly as a skill row does. */
  it('offers every row as something to open and change', () => {
    const markup = list();
    expect(markup.match(/class="settings-list-open"/gu)).toHaveLength(2);
    expect(markup).toContain('Open this memory to change it');
  });

  it('says where the form’s contents came from while a row is being edited', () => {
    expect(list({ editingId: 'm1' })).toContain('being edited above');
    expect(list()).not.toContain('being edited above');
  });

  /* Two different questions that had one answer between them on the row. */
  it('tells a fact the agent decided from one the owner typed, apart from the scope', () => {
    const markup = list();
    expect(markup).toContain('About this computer');
    expect(markup).toContain('the agent decided this');
    expect(markup).toContain('About you, everywhere');
    expect(markup).toContain('you wrote this');
  });

  it('says plainly when a fact has no expiry, and shows the date when it has one', () => {
    const markup = list();
    expect(markup).toContain('no expiry');
    expect(markup).toContain('used until');
  });

  /* Judging a fact used to mean deleting it blind: the id was served and read by nothing. */
  it('offers the conversation that wrote a row, and only where there is one', () => {
    expect(list().match(/aria-label="Open the conversation that wrote this"/gu)).toHaveLength(1);
  });

  it('offers no link at all when the screen has nowhere to send the reader', () => {
    expect(list({ onOpenTask: undefined })).not.toContain('Open the conversation that wrote this');
  });
});

/*
 * The learned procedures, and the timer that retires them.
 *
 * Curation runs at every task start: thirty days unused makes a skill stale, ninety archives it,
 * and anything not active and not pinned is dropped from the index the model sees. The row printed
 * the resulting word and offered nothing, so the only recovery was to re-open the skill in the
 * editor and press Save — which resets the status through the upsert by accident.
 */
describe('the learned skills list', () => {
  const skill = (over: Partial<WorkspaceSkill> = {}): WorkspaceSkill => ({
    id: 's1',
    name: 'release-a-website',
    description: 'Ship the static site',
    content: '## When to use',
    version: 3,
    enabled: true,
    status: 'active',
    pinned: false,
    useCount: 2,
    lastUsedAt: '2026-06-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over
  });

  const list = (items: WorkspaceSkill[]): string =>
    renderToStaticMarkup(
      <SkillList
        items={items}
        busy={false}
        onOpen={() => undefined}
        onSetState={() => undefined}
        onDelete={() => undefined}
      />
    );

  it('offers a pin on every row and says what pinning is for', () => {
    const markup = list([skill()]);
    expect(markup).toContain('aria-label="Pin the release-a-website skill"');
    expect(markup).toContain('never retired for going unused');
  });

  it('shows a pinned skill as pinned, and offers to unpin it', () => {
    const markup = list([skill({ pinned: true })]);
    expect(markup).toContain('· pinned');
    expect(markup).toContain('aria-label="Unpin the release-a-website skill"');
  });

  /* The one thing an archived row could not do, on the row that says it was archived. */
  it('offers a retired skill a way back, with the reason it went', () => {
    const markup = list([skill({ status: 'archived' })]);
    expect(markup).toContain('Make active');
    expect(markup).toContain('· archived');
    expect(markup).toContain('Retired for not being used');
  });

  it('does not offer to reactivate a skill that is already active', () => {
    expect(list([skill()])).not.toContain('Make active');
  });

  /*
   * The one axis of a skill that had a reader and no writer.
   *
   * `enabled` is checked first of the three in the resident index — `apps/worker/src/window.ts`
   * drops a disabled skill before it looks at status or pinning — and the row's `onSetState` prop
   * could only carry `{ pinned?, status? }`, so nothing in the product could set it. The approval
   * card for a skill upsert has meanwhile been telling the owner "You had turned X off. Approving
   * this switches it back on."
   */
  it('offers an off switch on a skill that is on', () => {
    const markup = list([skill()]);
    expect(markup).toContain('aria-label="Turn the release-a-website skill off"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it('shows a skill that is off as off, and offers to turn it back on', () => {
    const markup = list([skill({ enabled: false })]);
    expect(markup).toContain('· off');
    expect(markup).toContain('aria-label="Turn the release-a-website skill on"');
    expect(markup).toContain('aria-pressed="false"');
  });

  /* The upsert forces `enabled=TRUE` on conflict, and the Save button on this screen is one. */
  it('warns on the row that saving a skill of the same name switches it back on', () => {
    expect(list([skill({ enabled: false })])).toContain('switches it back on');
    expect(list([skill()])).not.toContain('switches it back on');
  });

  /* Off and retired are different axes and a row can be both; neither may hide the other. */
  it('keeps the way back from retirement on a row that is also switched off', () => {
    const markup = list([skill({ enabled: false, status: 'archived' })]);
    expect(markup).toContain('Make active');
    expect(markup).toContain('aria-label="Turn the release-a-website skill on"');
  });
});

/*
 * What the switch sends, which is the whole of the hole.
 *
 * `renderToStaticMarkup` runs no effects and this package has no DOM, so the press cannot be
 * staged. `skillSwitch` is the press: the row's onClick is `onSetState(item, skillSwitch(item).patch)`
 * and nothing else, so asking this function what it would send is asking the control.
 */
describe('what the skill on/off control sends', () => {
  it('sends enabled false from a skill that is on, which no control could send before', () => {
    expect(skillSwitch({ name: 'release-a-website', enabled: true }).patch).toEqual({
      enabled: false
    });
  });

  it('sends enabled true from a skill that is off', () => {
    expect(skillSwitch({ name: 'release-a-website', enabled: false }).patch).toEqual({
      enabled: true
    });
  });

  /* The label is what pressing does, not what the row currently is. */
  it('names the act rather than the state, in both directions', () => {
    expect(skillSwitch({ name: 'invoices', enabled: true }).label).toBe(
      'Turn the invoices skill off'
    );
    expect(skillSwitch({ name: 'invoices', enabled: false }).label).toBe(
      'Turn the invoices skill on'
    );
  });
});

/*
 * The sentence afterwards, which used to be a three-armed ternary over pinning.
 *
 * A skill turned off while pinned would have fallen through to "is pinned. It is no longer retired
 * for going unused." — true, and an answer to a question nobody asked.
 */
describe('what the screen says after a skill’s state changes', () => {
  it('speaks about the axis that was changed, not the one that happens to be set', () => {
    const notice = skillStateNotice(
      'invoices',
      { enabled: false },
      { enabled: false, pinned: true }
    );
    expect(notice).toContain('is off');
    expect(notice).not.toContain('pinned');
  });

  it('says that the next save of the same name undoes it, because the upsert forces it on', () => {
    expect(
      skillStateNotice('invoices', { enabled: false }, { enabled: false, pinned: false })
    ).toContain('switches it back on');
  });

  it('reports the state the route answered with rather than the one that was asked for', () => {
    expect(
      skillStateNotice('invoices', { enabled: true }, { enabled: true, pinned: false })
    ).toContain('is on');
  });

  /* The two sentences that were already there, unchanged by the new arm in front of them. */
  it('still says what pinning and reactivating did', () => {
    expect(
      skillStateNotice('invoices', { status: 'active' }, { enabled: true, pinned: false })
    ).toContain('is active again');
    expect(
      skillStateNotice('invoices', { pinned: true }, { enabled: true, pinned: true })
    ).toContain('is pinned');
    expect(
      skillStateNotice('invoices', { pinned: false }, { enabled: true, pinned: false })
    ).toContain('is unpinned');
  });
});

/*
 * The context window, which was write-only.
 *
 * Saved into the model catalogue, never returned by the provider read, and re-initialised to
 * 128,000 on every open — so the next save of anything, a key rotation included, silently wrote
 * that default back over a 200k model. This is the round trip, end to end: what the server holds,
 * through the restore, into the number the field actually shows.
 */
describe('the provider form after a reload', () => {
  const saved: ProviderSettings = {
    configured: true,
    source: 'encrypted_database',
    provider: 'openai-compatible',
    baseUrl: 'https://models.example/v1',
    modelId: 'big-one',
    hasApiKey: true,
    enforceZeroDataRetention: true
  };

  it('re-renders a saved 200k context window rather than the default', () => {
    const fields = providerModelFields({
      ...saved,
      contextTokens: 200_000,
      capabilities: ['chat', 'tools', 'vision']
    });
    const markup = renderToStaticMarkup(
      <ContextWindowField value={fields.contextTokens} onChange={() => undefined} />
    );
    expect(markup).toContain('value="200000"');
    expect(markup).not.toContain('value="128000"');
    expect(fields.vision).toBe(true);
  });

  it('falls back to 128k only when the server genuinely said nothing', () => {
    const markup = renderToStaticMarkup(
      <ContextWindowField
        value={providerModelFields(saved).contextTokens}
        onChange={() => undefined}
      />
    );
    expect(markup).toContain('value="128000"');
  });
});
