import { describe, expect, it } from 'vitest';
import {
  botTokenProblem,
  destinationsFromResponse,
  pairingOfferFromResponse,
  phoneStatusLine
} from './phone-transport.js';
describe('destinationsFromResponse', () => {
  it('reads the phone transport the box describes and nothing it does not', () => {
    const [phone] = destinationsFromResponse([
      {
        kind: 'telegram',
        botUsername: 'athanor_bot',
        paired: true,
        verifiedAt: '2026-09-01T10:00:00.000Z',
        disabledAt: null,
        redact: false,
        pairingPending: false,
        pairingExpiresAt: null
      },
      { kind: 'carrier_pigeon', paired: true }
    ]);
    expect(phone).toEqual({
      kind: 'telegram',
      botUsername: 'athanor_bot',
      paired: true,
      verifiedAt: '2026-09-01T10:00:00.000Z',
      disabledAt: null,
      redact: false,
      pairingPending: false,
      pairingExpiresAt: null
    });
    expect(destinationsFromResponse([{ kind: 'carrier_pigeon' }])).toEqual([]);
    expect(destinationsFromResponse({ not: 'a list' })).toEqual([]);
  });

  it('defaults to redacted, unpaired and enabled when a field is missing', () => {
    expect(destinationsFromResponse([{ kind: 'telegram' }])).toEqual([
      {
        kind: 'telegram',
        botUsername: null,
        paired: false,
        verifiedAt: null,
        disabledAt: null,
        redact: true,
        pairingPending: false,
        pairingExpiresAt: null
      }
    ]);
  });
});

describe('pairingOfferFromResponse', () => {
  it('needs all three of the link, the bot and the expiry', () => {
    const offer = {
      botUsername: 'athanor_bot',
      pairingUrl: 'https://t.me/athanor_bot?start=abc',
      expiresAt: '2026-09-01T10:10:00.000Z'
    };
    expect(pairingOfferFromResponse(offer)).toEqual(offer);
    expect(pairingOfferFromResponse({ ...offer, pairingUrl: undefined })).toBeNull();
    expect(pairingOfferFromResponse(null)).toBeNull();
  });
});

describe('botTokenProblem', () => {
  it('accepts a token of the right shape and says what is wrong with anything else', () => {
    expect(botTokenProblem(` 1234567:${'A'.repeat(35)} `)).toBeNull();
    expect(botTokenProblem('')).toBe('Paste the token BotFather gave you.');
    expect(botTokenProblem('not a token')).toContain('does not look like a bot token');
    expect(botTokenProblem('1234567:short')).toContain('does not look like a bot token');
  });
});

describe('phoneStatusLine', () => {
  const base = destinationsFromResponse([{ kind: 'telegram', botUsername: 'athanor_bot' }])[0]!;
  it('says where the pairing stands', () => {
    expect(phoneStatusLine(null)).toBe('No phone is paired yet.');
    expect(phoneStatusLine({ ...base, pairingPending: true })).toBe(
      'Waiting for your phone to open the link for @athanor_bot.'
    );
    expect(phoneStatusLine({ ...base, paired: true })).toBe(
      'Paired to @athanor_bot. Approvals and questions reach your phone.'
    );
    expect(phoneStatusLine({ ...base, paired: true, disabledAt: '2026-09-01T00:00:00.000Z' })).toBe(
      'Paired to @athanor_bot, and switched off.'
    );
    expect(phoneStatusLine(base)).toBe(
      '@athanor_bot is set up, but no phone is paired to it. Make a new link.'
    );
  });
});
