/**
 * Prometheus text exposition. Bound to localhost by default and never exposed publicly: per-label
 * byte counters are exactly the traffic-analysis material the relay promises not to hand out.
 */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, () => number>();

  counter(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  /** Registers the counter at zero so it appears in the output before anything happens. */
  declareCounter(name: string): void {
    if (!this.counters.has(name)) this.counters.set(name, 0);
  }

  gauge(name: string, read: () => number): void {
    this.gauges.set(name, read);
  }

  read(name: string): number {
    return this.counters.get(name) ?? this.gauges.get(name)?.() ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, value] of [...this.counters].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# TYPE ${name} counter`, `${name} ${value}`);
    }
    for (const [name, read] of [...this.gauges].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# TYPE ${name} gauge`, `${name} ${read()}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

export const METRIC_NAMES = {
  connectionsAccepted: 'athanor_relay_connections_accepted_total',
  connectionsRejected: 'athanor_relay_connections_rejected_total',
  connectionsBound: 'athanor_relay_connections_bound_total',
  handshakeTimeouts: 'athanor_relay_handshake_timeouts_total',
  unknownLabel: 'athanor_relay_unknown_label_total',
  quotaBlocked: 'athanor_relay_quota_blocked_total',
  rateLimited: 'athanor_relay_rate_limited_total',
  enrollSucceeded: 'athanor_relay_enroll_succeeded_total',
  enrollRejected: 'athanor_relay_enroll_rejected_total',
  sessionsRejected: 'athanor_relay_sessions_rejected_total',
  bytesRelayed: 'athanor_relay_bytes_relayed_total',
  peersOnline: 'athanor_relay_peers_online',
  peersRegistered: 'athanor_relay_peers_registered',
  parkedStreams: 'athanor_relay_parked_streams',
  activeStreams: 'athanor_relay_active_streams',
  openConnections: 'athanor_relay_open_connections'
} as const;
