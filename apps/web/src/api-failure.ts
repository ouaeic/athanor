/**
 * Its own module so failure handling can be reasoned about — and tested — without pulling in the
 * whole API surface and the browser-only WebAuthn library behind it.
 */
export class ApiFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** The HTTP status, so a caller can tell "this server has no such route" from "this failed". */
    readonly status = 0,
    /**
     * The id the server minted for this request, which it also wrote to its own log line.
     *
     * `apps/api/src/http/errors.ts` has put it on every error body all along — "the client is
     * handed a requestId and told to quote it" — and this client dropped it before anything could
     * read it. An owner reporting a failure on their own box had the sentence and no way to find
     * the line behind it, which on a self-hosted machine is the only support channel there is.
     * Absent rather than empty when the answer came from something that is not this API: a proxy,
     * a route Fastify answered in its own shape, or a transport that never reached the box.
     */
    readonly requestId?: string
  ) {
    super(message);
  }
}
