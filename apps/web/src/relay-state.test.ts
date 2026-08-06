import { describe, expect, it } from 'vitest';
import type { RelayReport } from './types.js';
import { relayAddress, relayHostProblem, relayQuotaNote, relayStatusLine } from './relay-state.js';

const report = (patch: Partial<RelayReport> = {}, status: Partial<RelayReport['status']> = {}) =>
  ({
    enabled: true,
    host: 'relay.example.com',
    address: null,
    port: 443,
    label: 'brave-otter',
    hostname: 'brave-otter.relay.example.com',
    pinnedRelaySpkiSha256: 'abc',
    enrolledAt: '2026-07-30T09:00:00.000Z',
    ...patch,
    status: {
      state: 'online',
      label: 'brave-otter',
      hostname: 'brave-otter.relay.example.com',
      openStreams: 2,
      usedBytes: 1_000,
      quota: 'ok',
      lastError: null,
      nextAttemptAtMs: null,
      ...status
    }
  }) as RelayReport;

describe('relay hostname', () => {
  it('accepts a hostname and explains anything else before the round trip', () => {
    expect(relayHostProblem('relay.example.com')).toBeUndefined();
    expect(relayHostProblem('  RELAY.Example.com ')).toBeUndefined();
    expect(relayHostProblem('')).toBe('Enter the relay’s hostname.');
    expect(relayHostProblem('localhost')).toBe(
      'Use the relay’s hostname, such as relay.example.com'
    );
    expect(relayHostProblem('-bad.example.com')).toBe(
      'Use the relay’s hostname, such as relay.example.com'
    );
  });

  it('refuses an address literal, which the relay cannot issue a certificate for', () => {
    expect(relayHostProblem('203.0.113.10')).toBe('Use the relay’s hostname, not an address.');
    expect(relayHostProblem('2001:db8::1')).toBe('Use the relay’s hostname, not an address.');
  });
});

describe('relay status', () => {
  it('separates never-enrolled from enrolled-and-off', () => {
    expect(relayStatusLine(report({ label: null, hostname: null, enabled: false }))).toEqual({
      tone: 'off',
      text: 'Not enrolled with a relay.'
    });
    expect(relayStatusLine(report({ enabled: false }))).toEqual({
      tone: 'off',
      text: 'Enrolled, and switched off.'
    });
  });

  it('says whether traffic is actually flowing right now', () => {
    expect(relayStatusLine(report())).toEqual({
      tone: 'online',
      text: 'Connected · 2 open connections'
    });
    expect(relayStatusLine(report({}, { state: 'connecting' })).tone).toBe('working');
    expect(
      relayStatusLine(report({}, { state: 'waiting', nextAttemptAtMs: Date.now() + 30_000 })).text
    ).toMatch(/Trying again in \d+s\./);
    expect(relayStatusLine(report({}, { state: 'revoked' }))).toEqual({
      tone: 'attention',
      text: 'The relay refused this box. Enroll again with a new token.'
    });
  });

  it('gives the address a device can be pointed at, or nothing at all', () => {
    expect(relayAddress(report())).toBe('https://brave-otter.relay.example.com');
    expect(relayAddress(report({ hostname: null }))).toBeNull();
  });

  it('mentions the allowance only when it changes what the owner will experience', () => {
    expect(relayQuotaNote(report())).toBeUndefined();
    expect(relayQuotaNote(report({}, { quota: null }))).toBeUndefined();
    expect(relayQuotaNote(report({}, { quota: 'shaped' }))).toBe(
      'Over this relay’s allowance — traffic through it is being slowed.'
    );
    expect(relayQuotaNote(report({}, { quota: 'blocked' }))).toBe(
      'Over this relay’s allowance — it has stopped carrying traffic.'
    );
  });
});
