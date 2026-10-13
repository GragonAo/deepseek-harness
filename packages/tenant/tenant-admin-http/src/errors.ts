/**
 * The one request failure the management surface raises from inside a method
 * instead of from its request framing: a status, a machine code, and the
 * message the caller reads. It lives in its own module so both the carrier and
 * the method table can raise it without importing each other.
 * @module @deepseek-ai/dsh-tenant-admin-http/errors
 */

/** A request failure with its HTTP status and machine code. */
export class AdminRequestError extends Error {
  /**
   * @param status - HTTP status the surface answers with.
   * @param code - machine code of the failure body.
   * @param message - human-readable explanation.
   */
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}
