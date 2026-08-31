/**
 * The facts behind the settings screen, held to what the routes actually answer.
 *
 * Three of the things asserted here were controls that lied rather than controls that were missing:
 * a form that wrote a default over the owner's own number on every save, a row that told an owner
 * to enable something they had already enabled, and an expiry column nothing could fill. A lie of
 * that shape survives because nothing ever asserted the round trip, so the round trip is what these
 * cases are about — the value the server sends, back out as the value the form shows.
 */
import { describe, expect, it } from 'vitest';
import type { ModelRelease } from '@athanor/contracts';
import type { ProviderSettings } from './api.js';
import {
  backupTimerLine,
  DEFAULT_CONTEXT_TOKENS,
  enrollmentLine,
  enrollmentRevocable,
  memoryExpiryField,
  memoryExpiryIso,
  memoryPatch,
  memoryProvenance,
  memoryScope,
  modelDetailLine,
  modelOpennessLine,
  ownerBlockDraft,
  providerModelFields,
  timerStateKnown,
  updateTimerLine,
  workspaceDeletionArmed
} from './settings-facts.js';

const saved: ProviderSettings = {
  configured: true,
  source: 'encrypted_database',
  provider: 'openai-compatible',
  baseUrl: 'https://models.example/v1',
  modelId: 'big-one',
  hasApiKey: true,
  enforceZeroDataRetention: true
};

describe('the two provider fields that used to be write-only', () => {
  /*
   * The regression this whole item exists for. Rotating a key is a save, and every save re-sent
   * whatever the form was holding: 128,000 and no vision, because nothing had put the real answer
   * back. The owner saw no error at all; the first symptom was an image refused weeks later.
   */
  it('puts a saved 200k context window back into the form after a reload', () => {
    expect(
      providerModelFields({
        ...saved,
        contextTokens: 200_000,
        capabilities: ['chat', 'tools', 'reasoning', 'vision'],
        modalities: ['text', 'image']
      })
    ).toEqual({ contextTokens: 200_000, vision: true });
  });

  it('does not invent vision for a model whose capabilities do not name it', () => {
    expect(
      providerModelFields({
        ...saved,
        contextTokens: 32_000,
        capabilities: ['chat', 'tools']
      })
    ).toEqual({ contextTokens: 32_000, vision: false });
  });

  /* A box older than the route that returns these keeps what this screen has always assumed. */
  it('falls back to the old defaults when the server says nothing about the model', () => {
    expect(providerModelFields(saved)).toEqual({
      contextTokens: DEFAULT_CONTEXT_TOKENS,
      vision: false
    });
  });

  /* Both halves of the same answer are written by the save; either alone is enough to read it. */
  it('reads vision off the modality list when a server sends only that half', () => {
    expect(providerModelFields({ ...saved, modalities: ['text', 'image'] }).vision).toBe(true);
  });
});

describe('the expiry a durable memory could never be given', () => {
  it('carries a stored instant into the control and back out again unchanged', () => {
    const iso = new Date('2027-03-04T15:30:00.000Z').toISOString();
    const field = memoryExpiryField(iso);
    expect(field).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u);
    expect(memoryExpiryIso(field)).toBe(iso);
  });

  it('shows an empty control for a fact that was never given an expiry', () => {
    expect(memoryExpiryField(null)).toBe('');
    expect(memoryExpiryIso('')).toBeUndefined();
  });

  /*
   * The route tells "leave this alone" from "there should be no expiry" and so does this: an owner
   * looking at an empty box has just said the fact is permanent, and omitting the key would keep
   * whatever expiry they were trying to remove.
   */
  it('clears an expiry with an explicit null rather than by staying silent', () => {
    expect(memoryPatch({ content: 'Reports open with a summary', expiry: '' })).toEqual({
      ok: true,
      body: { content: 'Reports open with a summary', validUntil: null }
    });
  });

  it('sends the chosen instant when there is one', () => {
    const patch = memoryPatch({ content: 'Contract ends soon', expiry: '2030-01-02T09:00' });
    expect(patch.ok).toBe(true);
    if (patch.ok) expect(Date.parse(patch.body.validUntil ?? '')).toBeGreaterThan(Date.now());
  });

  /* Said here rather than after a round trip, because the failure is the owner's typo. */
  it('refuses an expiry that has already gone by, and says why', () => {
    const patch = memoryPatch({ content: 'Anything', expiry: '2001-01-02T09:00' });
    expect(patch.ok).toBe(false);
    if (!patch.ok) expect(patch.message).toContain('already passed');
  });

  it('refuses an empty memory', () => {
    expect(memoryPatch({ content: '   ', expiry: '' }).ok).toBe(false);
  });
});

describe('who put a memory in the box, and who it is about', () => {
  /* The row printed the scope where a reader looks for provenance, so the two read identically. */
  it('tells a fact the owner typed from one the agent decided', () => {
    expect(memoryProvenance({ source: 'owner' })).toBe('you wrote this');
    expect(memoryProvenance({ source: 'agent' })).toBe('the agent decided this');
  });

  it('says the scope as a scope rather than as a person', () => {
    expect(memoryScope({ target: 'user', scope: 'user' })).toBe('About you, everywhere');
    expect(memoryScope({ target: 'workspace', scope: 'workspace' })).toBe('About this computer');
  });

  /*
   * The label used to read off `target` alone, which is what made it a claim the row could not
   * keep: an owner-tier entry written before the tier had a key of its own is still sealed under a
   * workspace key and still dies with that workspace, however it is labelled. Saying "everywhere"
   * over such a row is the failure this whole tier exists to stop, so the third state has to be
   * distinguishable from the first by reading, not by knowing.
   */
  it('does not promise everywhere for an owner row still tied to one computer', () => {
    expect(memoryScope({ target: 'user', scope: 'workspace' })).not.toBe('About you, everywhere');
    expect(memoryScope({ target: 'user', scope: 'workspace' })).toContain('this computer');
  });
});

/**
 * The counter under the owner's block, which has one job: agree with the server to the byte.
 *
 * A counter that disagrees is worse than no counter, because it is an invitation to keep typing
 * into a refusal. Two things make agreement non-obvious and both are asserted rather than assumed:
 * the count is of UTF-8 bytes, not characters, and the server trims and NFKC-normalises before it
 * counts.
 */
describe('the owner block editor', () => {
  const block = { text: '- You are the lead.', bytes: 19, limit: 2_000 };

  it('counts UTF-8 bytes the way the server does, not characters', () => {
    // An em dash is one character and three bytes. Counting characters would tell an owner they had
    // 2,000 to spend and let the route refuse them at roughly 700.
    expect(ownerBlockDraft('—', block).bytes).toBe(3);
    expect(ownerBlockDraft('abc', block).bytes).toBe(3);
    // The same trim and normalisation the route applies, in the same order, so the number shown and
    // the number checked are the same number.
    expect(ownerBlockDraft('  abc  ', block).bytes).toBe(3);
    expect(ownerBlockDraft('\u0065\u0301', block).bytes).toBe(
      new TextEncoder().encode('\u0065\u0301'.normalize('NFKC')).length
    );
  });

  it('states the bound before it is reached, and says what happens at it', () => {
    expect(ownerBlockDraft('abc', block).counter).toBe('3 of 2,000 bytes');
    const over = ownerBlockDraft('x'.repeat(2_050), block);
    expect(over.counter).toContain('50 over');
    expect(over.savable).toBe(false);
    // The refusal names the surface, the number and what does NOT happen - because the alternative
    // design, dropping the end to fit, is the one the owner would never see.
    expect(over.refusal).toContain('nothing here is dropped to make room');
  });

  /*
   * The bound comes off the answer, not out of this file. A client with its own copy of the number
   * disagrees with the server the moment the server changes it, and both directions are bad: a
   * stale smaller number refuses text the box would have taken, a stale larger one invites the
   * owner to type into a refusal.
   */
  it('takes the bound from what the server said, not from a constant of its own', () => {
    expect(ownerBlockDraft('x'.repeat(600), { text: '', bytes: 0, limit: 500 }).savable).toBe(
      false
    );
    expect(ownerBlockDraft('x'.repeat(600), { text: '', bytes: 0, limit: 500 }).counter).toContain(
      'of 500'
    );
    expect(ownerBlockDraft('x'.repeat(600), { text: '', bytes: 0, limit: 4_000 }).savable).toBe(
      true
    );
  });

  it('offers to save only what differs from what is stored', () => {
    expect(ownerBlockDraft(block.text, block).savable).toBe(false);
    expect(ownerBlockDraft(`${block.text}\n`, block).savable).toBe(false);
    expect(ownerBlockDraft(`${block.text}\n- British spelling.`, block).savable).toBe(true);
    // Emptying it is a change like any other, so the owner can clear the block from this screen.
    expect(ownerBlockDraft('', block).savable).toBe(true);
    expect(ownerBlockDraft('', { text: '', bytes: 0, limit: 2_000 }).savable).toBe(false);
  });

  /*
   * The one state where an empty draft is not an empty block.
   *
   * When this box can no longer decrypt the row, the route answers with empty `text` and the row's
   * real `bytes` - and a screen counting only the draft renders that identically to having no block
   * at all, with Save disabled because empty matches empty. The owner is then holding a surface
   * that is silently occupied and offers them no way to clear it. Both halves are asserted against
   * the genuinely-empty case beside them, which must keep saying the opposite.
   */
  it('says when bytes are stored that this computer can no longer read, and lets them go', () => {
    const unreadable = { text: '', bytes: 41, limit: 2_000 };
    expect(ownerBlockDraft('', unreadable).counter).toBe(
      '0 of 2,000 bytes — 41 stored bytes this computer can no longer read'
    );
    // Save with nothing typed clears the row, which is the honest thing to do with bytes nobody
    // can read. It is enabled for exactly that.
    expect(ownerBlockDraft('', unreadable).savable).toBe(true);
    expect(ownerBlockDraft('typed again', unreadable).savable).toBe(true);

    // A block that is genuinely empty still says nothing is there and still refuses a no-op save.
    const empty = { text: '', bytes: 0, limit: 2_000 };
    expect(ownerBlockDraft('', empty).counter).toBe('0 of 2,000 bytes');
    expect(ownerBlockDraft('', empty).savable).toBe(false);
  });
});

describe('the two timers the box runs on its own', () => {
  /*
   * The row was static copy telling every owner to run `sudo athanor auto-update on`, including
   * the ones who already had. The diagnostics route carried no timer state at all, which is what
   * let a description stand in for a reading.
   */
  it('says the weekly update timer is on when the box says it is', () => {
    const line = updateTimerLine('on');
    expect(line).toContain('Weekly automatic updates are on');
    expect(line).not.toContain('auto-update on');
  });

  it('tells the owner how to enable it only when it is actually off', () => {
    expect(updateTimerLine('off')).toContain('sudo athanor auto-update on');
    expect(updateTimerLine('off')).toContain('Nothing installs itself');
  });

  /* A host that is not Linux has no verdict to give, and "we could not tell" is not "off". */
  it('says it could not tell rather than guessing, on a host with no systemd', () => {
    expect(updateTimerLine('unknown')).toContain('could not say');
    expect(updateTimerLine(undefined)).toContain('could not say');
    expect(timerStateKnown('unknown')).toBe(false);
    expect(timerStateKnown(undefined)).toBe(false);
    expect(timerStateKnown('off')).toBe(true);
  });

  /* The evidence line next door reports the last copy taken; this is whether a next one is due. */
  it('separates a backup that happened from a backup that is scheduled', () => {
    expect(backupTimerLine('on')).toContain('another copy is due');
    expect(backupTimerLine('off')).toContain('only when you run');
    expect(backupTimerLine(undefined)).toContain('could not say');
  });
});

describe('the device links that are still out there', () => {
  const grant = {
    createdAt: '2026-08-01T09:00:00.000Z',
    expiresAt: '2026-08-01T09:10:00.000Z',
    status: 'pending' as const
  };

  it('says an open link is open, and when it stops being one', () => {
    expect(enrollmentLine(grant)).toContain('Still open');
    expect(enrollmentRevocable(grant)).toBe(true);
  });

  /* Only a live grant can be taken back; the rest of the list is the record of what happened. */
  it('offers no kill switch on a link that has already been used or has lapsed', () => {
    expect(enrollmentLine({ ...grant, status: 'used' })).toContain('Redeemed');
    expect(enrollmentLine({ ...grant, status: 'expired' })).toContain('Expired unused');
    expect(enrollmentLine({ ...grant, status: 'revoked' })).toContain('Cancelled');
    expect(enrollmentRevocable({ status: 'used' })).toBe(false);
    expect(enrollmentRevocable({ status: 'expired' })).toBe(false);
  });
});

describe('the catalogue record no client has ever read', () => {
  const model: ModelRelease = {
    id: 'vendor/one',
    providerModelId: 'one',
    displayName: 'One',
    provider: 'vendor',
    revision: '2026-01',
    availability: 'available',
    openness: 'permissive_open_weight',
    license: 'Apache-2.0',
    commercialUse: true,
    privacyRoute: 'provider_zdr',
    contextTokens: 200_000,
    modalities: ['text'],
    capabilities: ['chat', 'tools'],
    usageClass: 'medium',
    recommendationTags: [],
    measuredQuality: 0.82,
    measuredLatencyMs: 900,
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
    benchmarkRank: 4,
    updatedAt: '2026-08-01T00:00:00.000Z'
  };

  /* The media picker one section above prints a price beside every option; this printed none. */
  it('puts a price, a size and a licence beside a chat model', () => {
    const line = modelDetailLine(model);
    expect(line).toContain('$3 in / $15 out per million tokens');
    expect(line).toContain('200k context');
    expect(line).toContain('quality 82/100');
    expect(line).toContain('ranked #4');
    expect(line).toContain('Apache-2.0');
    expect(line).toContain('commercial use allowed');
  });

  /* A price athanor could not read is said as that and never as zero. */
  it('says a price is unpublished rather than showing nothing', () => {
    expect(
      modelDetailLine({
        ...model,
        inputUsdPerMillionTokens: null,
        outputUsdPerMillionTokens: null
      })
    ).toContain('price not published');
  });

  it('reports all four openness grades as what they mean rather than as their enum', () => {
    expect(modelOpennessLine({ openness: 'osaid_open_source' })).toContain('Open source');
    expect(modelOpennessLine({ openness: 'permissive_open_weight' })).toContain('Open weights —');
    expect(modelOpennessLine({ openness: 'restricted_open_weight' })).toContain(
      'restricted licence'
    );
    expect(modelOpennessLine({ openness: 'remote_proprietary' })).toContain('Proprietary');
  });
});

describe('deleting the computer without deleting the account', () => {
  /* The route matches the name exactly, so the control has to arm on the same rule the route uses. */
  it('stays inert until the computer’s own name is typed', () => {
    expect(workspaceDeletionArmed('', 'Athanor')).toBe(false);
    expect(workspaceDeletionArmed('athanor', 'Athanor')).toBe(false);
    expect(workspaceDeletionArmed('  Athanor  ', 'Athanor')).toBe(true);
  });
});
