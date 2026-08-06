import { randomBytes } from 'node:crypto';
import { constants as http2, type ServerHttp2Session, type ServerHttp2Stream } from 'node:http2';
import type { Socket } from 'node:net';
import { encodeCbor } from './cbor.js';
import type { RelayConfig } from './config.js';
import { TokenBucket } from './limits.js';
import type { Logger } from './log.js';
import { METRIC_NAMES, type Metrics } from './metrics.js';
import { NdjsonReader } from './ndjson.js';
import {
  PARK_READY_MARKER,
  PROTOCOL_VERSION,
  type BindFrame,
  type GoawayReason,
  type QuotaState,
  type RelayToBoxMessage
} from './protocol.js';
import type { PeerRecord, Registry } from './registry.js';
import { Throttle } from './throttle.js';

export interface TunnelSessionDeps {
  readonly config: RelayConfig;
  readonly registry: Registry;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly onClosed: (session: TunnelSession) => void;
  /** True while the relay as a whole is over its shaping threshold. */
  readonly globalShaping: () => boolean;
  readonly globalBlocked: () => boolean;
}

export type BindFailure =
  | 'closed'
  | 'quota-blocked'
  | 'stream-limit'
  | 'stream-rate'
  | 'no-parked-stream';

export interface BindRequest {
  readonly socket: Socket;
  /** Bytes already consumed from the client while peeking; the box's stack needs them. */
  readonly initial: Buffer;
  readonly sni: string;
  readonly port: 443 | 80;
}

export type BindResult = { ok: true; cid: string } | { ok: false; reason: BindFailure };

const QUOTA_TICK_MS = 5000;
const USAGE_FLUSH_BYTES = 1024 * 1024;
const WARN_FRACTION = 0.8;
const BLOCK_FRACTION = 1.5;
/** Parked streams beyond this multiple of parkTarget are refused; the box is misbehaving. */
const PARK_POOL_SLACK = 2;

/**
 * One authenticated box: its HTTP/2 session, its pool of parked streams, and its quota state.
 *
 * Idle cost is deliberately small - one TLS connection, one h2 session, `parkTarget` open-but-idle
 * streams and two timers. There is no per-peer buffering at rest.
 */
export class TunnelSession {
  readonly label: string;
  private readonly deps: TunnelSessionDeps;
  private readonly h2: ServerHttp2Session;
  private readonly peer: PeerRecord;
  private readonly logger: Logger;
  private readonly bucket: TokenBucket;
  private readonly streamRate: TokenBucket;
  private readonly parked: ServerHttp2Stream[] = [];
  private controlStream: ServerHttp2Stream | null = null;
  private boundStreams = 0;
  private pendingBytes = 0;
  private quotaState: QuotaState = 'ok';
  private closed = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private quotaTimer: NodeJS.Timeout | null = null;
  private helloTimer: NodeJS.Timeout | null = null;

  constructor(deps: TunnelSessionDeps, h2: ServerHttp2Session, peer: PeerRecord) {
    this.deps = deps;
    this.h2 = h2;
    this.peer = peer;
    this.label = peer.label;
    this.logger = deps.logger.child({ label: peer.label });
    this.bucket = new TokenBucket(peer.quota.rateBps, deps.config.limits.perPeer.burstBytes);
    this.streamRate = new TokenBucket(
      deps.config.limits.perPeer.newStreamsPerMinute / 60,
      deps.config.limits.perPeer.newStreamsPerMinute
    );

    h2.setTimeout(0);
    h2.on('close', () => this.close('restart', false));
    h2.on('error', (error: Error) => {
      this.logger.debug('session error', { error: error.message });
      this.close('restart', false);
    });

    // A box that authenticates and then never says hello holds a session for free; time it out.
    this.helloTimer = setTimeout(() => {
      if (this.controlStream === null) {
        this.logger.warn('no control stream before deadline');
        this.close('protocol', true);
      }
    }, deps.config.enrollTimeoutMs);
    this.helloTimer.unref();
  }

  get isReady(): boolean {
    return !this.closed && this.controlStream !== null;
  }

  get parkedCount(): number {
    return this.parked.length;
  }

  get activeCount(): number {
    return this.boundStreams;
  }

  get state(): QuotaState {
    return this.quotaState;
  }

  /**
   * Attaches the control stream. The box speaks first (`hello`) so the relay can refuse a version
   * mismatch before committing any state to it.
   */
  attachControl(stream: ServerHttp2Stream): void {
    if (this.controlStream !== null) {
      stream.close(http2.NGHTTP2_REFUSED_STREAM);
      return;
    }
    this.controlStream = stream;
    stream.setTimeout(0);
    const reader = new NdjsonReader();
    let greeted = false;

    stream.on('data', (chunk: Buffer) => {
      try {
        for (const message of reader.push(chunk)) {
          if (!greeted) {
            greeted = true;
            this.onHello(stream, message);
          }
        }
      } catch (error) {
        this.logger.warn('bad control frame', {
          error: error instanceof Error ? error.message : 'unknown'
        });
        this.close('protocol', true);
      }
    });
    stream.on('error', () => this.close('restart', false));
    stream.on('close', () => this.close('restart', false));
  }

  private onHello(stream: ServerHttp2Stream, message: unknown): void {
    const hello = message as { t?: unknown; proto?: unknown };
    if (hello.t !== 'hello' || hello.proto !== PROTOCOL_VERSION) {
      this.logger.warn('unsupported control hello', { proto: String(hello.proto) });
      stream.respond({ ':status': 400 }, { endStream: true });
      this.close('protocol', true);
      return;
    }
    if (this.helloTimer !== null) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
    stream.respond({ ':status': 200, 'content-type': 'application/x-ndjson' });
    this.deps.registry.markSeen(this.label);
    this.refreshQuota(true);
    this.send({
      t: 'welcome',
      label: this.label,
      serverTimeMs: Date.now(),
      parkTarget: this.deps.config.parkTarget,
      limits: {
        maxConcurrentStreams: this.peer.quota.maxConcurrentStreams,
        rateBps: this.peer.quota.rateBps,
        monthlyBytes: this.peer.quota.monthlyBytes,
        periodEndMs: this.periodEndMs()
      }
    });
    this.requestPark();
    this.startTimers();
    this.logger.info('tunnel ready');
  }

  /** Accepts a parked stream once the box has flushed its ready marker. */
  attachPark(stream: ServerHttp2Stream): void {
    if (this.closed || this.controlStream === null) {
      stream.close(http2.NGHTTP2_REFUSED_STREAM);
      return;
    }
    if (this.parked.length >= this.deps.config.parkTarget * PARK_POOL_SLACK) {
      stream.close(http2.NGHTTP2_REFUSED_STREAM);
      return;
    }
    stream.setTimeout(0);
    const onReadable = (): void => {
      const marker = stream.read(1) as Buffer | null;
      if (marker === null) return;
      stream.removeListener('readable', onReadable);
      if (marker.readUInt8(0) !== PARK_READY_MARKER) {
        stream.close(http2.NGHTTP2_PROTOCOL_ERROR);
        return;
      }
      this.parked.push(stream);
    };
    stream.on('readable', onReadable);
    stream.on('error', () => this.dropParked(stream));
    stream.on('close', () => this.dropParked(stream));
  }

  private dropParked(stream: ServerHttp2Stream): void {
    const index = this.parked.indexOf(stream);
    if (index !== -1) this.parked.splice(index, 1);
  }

  /**
   * Attaches a client connection to a parked stream and starts forwarding.
   *
   * Nothing is written to the client before this point, and the relay never dials an address a
   * client supplied - the only reachable destinations are labels registered by an authenticated
   * peer. That is what keeps this from being an open proxy.
   */
  bind(request: BindRequest): BindResult {
    if (this.closed || this.controlStream === null) return { ok: false, reason: 'closed' };
    // Re-evaluated per inbound connection, not only on the timer: a burst inside one tick would
    // otherwise sail past a quota the peer has already blown.
    this.refreshQuota();
    if (this.quotaState === 'blocked' || this.deps.globalBlocked()) {
      return { ok: false, reason: 'quota-blocked' };
    }
    if (this.boundStreams >= this.peer.quota.maxConcurrentStreams) {
      return { ok: false, reason: 'stream-limit' };
    }
    if (!this.streamRate.tryConsume(1)) return { ok: false, reason: 'stream-rate' };

    const stream = this.parked.shift();
    if (stream === undefined) {
      this.requestPark();
      return { ok: false, reason: 'no-parked-stream' };
    }

    const cid = randomBytes(16);
    const cidHex = cid.toString('hex');
    const { socket, initial } = request;

    const frame: BindFrame = {
      cid,
      l: this.label,
      sni: request.sni,
      port: request.port,
      // ADVISORY ONLY. A relay can forge these; the box must use them for display and coarse
      // rate-limiting heuristics and never for authorization or session binding.
      ip: socket.remoteAddress ?? '',
      sport: socket.remotePort ?? 0,
      t: Date.now()
    };
    const body = encodeCbor({ ...frame });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);

    this.boundStreams += 1;
    this.deps.metrics.counter(METRIC_NAMES.connectionsBound);

    stream.respond({ ':status': 200 });
    stream.write(Buffer.concat([header, body]));
    if (initial.length > 0) {
      // The ClientHello bytes we consumed while reading SNI. Forgetting these is the classic bug:
      // the box's TLS stack cannot complete a handshake whose first record it never saw.
      this.meter(initial.length);
      stream.write(initial);
    }

    const meter = (bytes: number): void => this.meter(bytes);
    const upstream = new Throttle({ bucket: this.bucket, onBytes: meter });
    const downstream = new Throttle({ bucket: this.bucket, onBytes: meter });

    let released = false;
    let linger: NodeJS.Timeout | null = null;
    const release = (): void => {
      if (released) return;
      released = true;
      if (linger !== null) clearTimeout(linger);
      linger = null;
      this.boundStreams -= 1;
      this.flushUsage();
      upstream.destroy();
      downstream.destroy();
    };

    /**
     * Bounds a half-closed connection. A client that vanishes without a clean shutdown leaves the
     * relay holding a socket and one of this peer's stream slots, and the box may never notice -
     * so the relay reclaims it rather than trusting the box to.
     */
    const startLinger = (): void => {
      if (linger !== null || released) return;
      linger = setTimeout(() => {
        this.logger.debug('reclaimed half-closed connection', { cid: cidHex });
        socket.destroy();
        if (!stream.closed) stream.close(http2.NGHTTP2_CANCEL);
      }, this.deps.config.halfCloseLingerMs);
      linger.unref();
    };

    // .pipe() rather than pipeline() because half-close must survive: END_STREAM from the box means
    // FIN toward the client and vice versa, and pipeline() would tear both directions down at once.
    socket.on('error', () => socket.destroy());
    upstream.on('error', () => socket.destroy());
    downstream.on('error', () => socket.destroy());
    stream.on('error', () => socket.destroy());
    stream.on('close', () => {
      release();
      socket.destroy();
    });
    socket.on('close', () => {
      release();
      if (!stream.closed) stream.close(http2.NGHTTP2_CANCEL);
    });
    socket.on('end', startLinger);
    stream.on('end', startLinger);

    socket.pipe(upstream).pipe(stream);
    stream.pipe(downstream).pipe(socket);

    this.logger.info('bound', { cid: cidHex, port: request.port });
    return { ok: true, cid: cidHex };
  }

  private meter(bytes: number): void {
    this.pendingBytes += bytes;
    this.deps.metrics.counter(METRIC_NAMES.bytesRelayed, bytes);
    if (this.pendingBytes >= USAGE_FLUSH_BYTES) this.flushUsage();
  }

  private flushUsage(): void {
    if (this.pendingBytes <= 0) return;
    this.deps.registry.recordUsage(this.label, this.pendingBytes);
    this.pendingBytes = 0;
  }

  private periodEndMs(): number {
    const usage = this.deps.registry.peerUsage(this.label);
    const start = usage?.periodStartMs ?? Date.now();
    const date = new Date(start);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }

  /**
   * warn at 80%, shape to `shapedRateBps` at 100%, refuse new connections at 150%.
   *
   * Shaping rather than cutting off at 100% is deliberate: a box that goes dark mid-month is a
   * support ticket, whereas a slow one is a visible nudge that still lets the owner reach their
   * machine to fix whatever is burning the bytes (it is almost always the desktop preview).
   */
  private refreshQuota(silent = false): void {
    this.flushUsage();
    const usage = this.deps.registry.peerUsage(this.label);
    const used = usage?.bytes ?? 0;
    const fraction = used / this.peer.quota.monthlyBytes;
    let next: QuotaState = 'ok';
    if (fraction >= BLOCK_FRACTION) next = 'blocked';
    else if (fraction >= 1) next = 'shaped';
    else if (fraction >= WARN_FRACTION) next = 'warn';

    const shaped = next === 'shaped' || next === 'blocked' || this.deps.globalShaping();
    const rate = shaped
      ? Math.min(this.peer.quota.rateBps, this.deps.config.limits.global.shapedRateBps)
      : this.peer.quota.rateBps;
    if (rate !== this.bucket.rate) {
      this.bucket.setRate(rate, this.deps.config.limits.perPeer.burstBytes);
    }

    if (next !== this.quotaState) {
      this.quotaState = next;
      if (!silent) this.send({ t: 'quota', usedBytes: used, state: next });
    } else {
      this.quotaState = next;
    }
  }

  private startTimers(): void {
    // CGNAT mappings expire at 60-120s and sometimes less, so keepalive is load-bearing, not
    // politeness: without it the tunnel silently dies and the box does not find out until a client
    // tries to use it.
    this.pingTimer = setInterval(() => this.ping(), this.deps.config.pingIntervalMs);
    this.pingTimer.unref();
    this.quotaTimer = setInterval(() => this.refreshQuota(), QUOTA_TICK_MS);
    this.quotaTimer.unref();
  }

  private ping(): void {
    if (this.closed) return;
    let answered = false;
    const timeout = setTimeout(() => {
      if (answered) return;
      this.logger.warn('ping timeout');
      this.close('restart', true);
    }, this.deps.config.pingTimeoutMs);
    timeout.unref();
    const sent = this.h2.ping((error: Error | null) => {
      answered = true;
      clearTimeout(timeout);
      if (error !== null) this.close('restart', true);
    });
    if (!sent) {
      clearTimeout(timeout);
      this.close('restart', true);
    }
  }

  private requestPark(): void {
    const missing = this.deps.config.parkTarget - this.parked.length;
    if (missing > 0) this.send({ t: 'need_park', n: missing });
  }

  send(message: RelayToBoxMessage): void {
    const stream = this.controlStream;
    if (stream === null || stream.destroyed || !stream.writable) return;
    stream.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * Closes the session, optionally telling the box when to come back.
   *
   * The jitter is not cosmetic: without it every registered box reconnects in the same second after
   * a relay restart and the relay dies during boot, repeatedly.
   */
  close(reason: GoawayReason, notify: boolean): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of [this.pingTimer, this.quotaTimer, this.helloTimer]) {
      if (timer !== null) clearTimeout(timer);
    }
    this.pingTimer = null;
    this.quotaTimer = null;
    this.helloTimer = null;
    this.flushUsage();

    if (notify) {
      const jitter = Math.floor(Math.random() * (this.deps.config.goawayJitterMs + 1));
      this.send({ t: 'goaway', reason, reconnectAfterMs: jitter });
    }
    // Deferred out of this call deliberately. close() usually runs from the JS 'close' handler that
    // nghttp2 fires from inside its own receive callback, and closing a parked stream there
    // re-enters SendPendingData and never comes back: one box restarting pegs a core, climbs past a
    // gigabyte of resident memory in seconds, and takes the relay down for every other peer.
    const draining = this.parked.splice(0);
    setImmediate(() => {
      for (const stream of draining) stream.close(http2.NGHTTP2_NO_ERROR);
    });
    this.controlStream?.end();
    // Give the GOAWAY payload a chance to reach the box before the socket goes away.
    setTimeout(() => this.h2.destroy(), notify ? 50 : 0).unref();
    this.h2.close();
    this.deps.onClosed(this);
    this.logger.info('tunnel closed', { reason });
  }
}
