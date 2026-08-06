/**
 * Its own module so failure handling can be reasoned about — and tested — without pulling in the
 * whole API surface and the browser-only WebAuthn library behind it.
 */
export class ApiFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** The HTTP status, so a caller can tell "this server has no such route" from "this failed". */
    readonly status = 0
  ) {
    super(message);
  }
}
