import type { RelayReport } from './types.js';

/**
 * The relay, in the owner's words.
 *
 * Most owners never need it: a box on a public address, or one with a dynamic-DNS name, is reached
 * directly. It exists for a box behind carrier-grade NAT, and turning it on puts a third party in
 * the path of every connection — so the screen leads with "you probably do not need this" and the
 * state it reports has to be unambiguous about whether traffic is flowing right now.
 */
export interface RelayStatusLine {
  tone: 'off' | 'working' | 'online' | 'attention';
  text: string;
}

const RELAY_HOST_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/** Reject an address literal client-side: the relay routes on a name, so a dotted quad never works. */
const isAddressLiteral = (value: string): boolean =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':');

/** The same rule the server applies, said before the round trip rather than after it. */
export const relayHostProblem = (host: string): string | undefined => {
  const value = host.trim().toLowerCase();
  if (!value) return 'Enter the relay’s hostname.';
  // Checked before the shape: an IPv6 literal fails the hostname pattern too, and being told to
  // use a hostname "such as relay.example.com" does not explain why an address was refused.
  if (isAddressLiteral(value)) return 'Use the relay’s hostname, not an address.';
  if (value.length < 3 || value.length > 253 || !RELAY_HOST_PATTERN.test(value))
    return 'Use the relay’s hostname, such as relay.example.com';
  return undefined;
};

export const relayStatusLine = (report: RelayReport): RelayStatusLine => {
  if (!report.label) return { tone: 'off', text: 'Not enrolled with a relay.' };
  if (!report.enabled) return { tone: 'off', text: 'Enrolled, and switched off.' };
  switch (report.status.state) {
    case 'online':
      return {
        tone: 'online',
        text: `Connected · ${report.status.openStreams} open ${
          report.status.openStreams === 1 ? 'connection' : 'connections'
        }`
      };
    case 'connecting':
      return { tone: 'working', text: 'Connecting to the relay…' };
    case 'waiting':
      return {
        tone: 'working',
        text: report.status.nextAttemptAtMs
          ? `Not connected. Trying again ${describeRetry(report.status.nextAttemptAtMs)}.`
          : 'Not connected. Trying again shortly.'
      };
    case 'revoked':
      return {
        tone: 'attention',
        text: 'The relay refused this box. Enroll again with a new token.'
      };
    default:
      return { tone: 'off', text: 'Switched off.' };
  }
};

const describeRetry = (atMs: number): string => {
  const seconds = Math.round((atMs - Date.now()) / 1_000);
  if (seconds <= 1) return 'now';
  if (seconds < 60) return `in ${seconds}s`;
  return `in ${Math.round(seconds / 60)} min`;
};

/** Where this box is reachable over the relay, ready to be copied into another device. */
export const relayAddress = (report: RelayReport): string | null =>
  report.hostname ? `https://${report.hostname}` : null;

/** Quota is only worth a line when it is about to change what the owner experiences. */
export const relayQuotaNote = (report: RelayReport): string | undefined => {
  switch (report.status.quota) {
    case 'warn':
      return 'Approaching this relay’s traffic allowance.';
    case 'shaped':
      return 'Over this relay’s allowance — traffic through it is being slowed.';
    case 'blocked':
      return 'Over this relay’s allowance — it has stopped carrying traffic.';
    default:
      return undefined;
  }
};
