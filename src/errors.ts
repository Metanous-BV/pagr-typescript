/**
 * Base type for every error raised by the Pagr SDK. All API errors derive
 * from this class, so a single `catch (err) { if (err instanceof PagrError) }`
 * handles every failure mode. Where the failure originated from an HTTP
 * response, `statusCode`/`code` carry the HTTP status and the API error code
 * (read from the `{"error":{"code","message"}}` envelope) respectively.
 * Network/parse failures also raise a bare `PagrError` with neither set.
 *
 * Subclasses below add only their `name` (and, where relevant, an extra field);
 * this constructor does the shared work for all of them.
 */
export class PagrError extends Error {
  readonly statusCode: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, statusCode?: number, code?: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'PagrError';
    this.statusCode = statusCode;
    this.code = code;
    // Assigned conditionally rather than passed to `super(message, options)`:
    // the `Error` constructor installs an own `cause` property whenever the
    // options object merely *has* the key, so forwarding `{cause: undefined}`
    // would leave `'cause' in err === true` on errors that have no cause.
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
    // Defensive: restores the prototype chain so `instanceof` holds across
    // tsup's dual CJS/ESM output and any downlevel target, however a consumer
    // imports this module. `new.target` is the most-derived constructor, so
    // this single call covers every subclass.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 401 — invalid or missing API key. */
export class AuthenticationError extends PagrError {
  override readonly name: string = 'AuthenticationError';
}

/** 403 — authenticated but not allowed to access this resource. */
export class ForbiddenError extends PagrError {
  override readonly name: string = 'ForbiddenError';
}

/** 404 — template, version, document or job not found. */
export class NotFoundError extends PagrError {
  override readonly name: string = 'NotFoundError';
}

/** 413 — a submitted document exceeds the maximum payload size. */
export class PayloadTooLargeError extends PagrError {
  override readonly name: string = 'PayloadTooLargeError';
}

/** 422 — the request body could not be bound/validated. */
export class ValidationFailedError extends PagrError {
  override readonly name: string = 'ValidationFailedError';
}

/** Any other unexpected API error (4xx/5xx) — 400, 410 PdfDeleted, 503 QueueFull, etc. */
export class ApiError extends PagrError {
  override readonly name: string = 'ApiError';
}

/**
 * 429 — too many requests; sliding 60-second window per organisation.
 *
 * `retryAfter` is the number of seconds the server asked the caller to wait
 * before retrying, parsed from the `Retry-After` response header when it
 * carries an integer number of seconds. `undefined` when the header is absent
 * or not an integer (e.g. an HTTP-date) — the API does not currently send one
 * on 429s, so treat `undefined` as "back off using your own policy". 429 is
 * never retried automatically (see `http.ts`); it reflects the caller's own
 * request volume.
 */
export class RateLimitError extends PagrError {
  override readonly name: string = 'RateLimitError';
  readonly retryAfter: number | undefined;

  constructor(message: string, statusCode?: number, code?: string, retryAfter?: number) {
    super(message, statusCode, code);
    this.retryAfter = retryAfter;
  }
}

/**
 * The request never produced an HTTP response — the transport failed before or
 * during the request (connection refused, DNS failure, TLS handshake error,
 * connection reset, protocol error). `statusCode`/`code` are always
 * `undefined`. The underlying error is available via the standard `cause`.
 */
export class PagrConnectionError extends PagrError {
  override readonly name: string = 'PagrConnectionError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, undefined, undefined, options);
  }
}

/**
 * A response was received but could not be parsed into the expected shape — a
 * non-JSON or empty body where JSON was expected, or a payload missing a
 * required field. Keeps callers to the "only ever catch `PagrError`" contract
 * (a raw `SyntaxError` would otherwise escape). `statusCode` carries the HTTP
 * status when it stems from an HTTP response; `code` is `undefined`.
 */
export class PagrDecodeError extends PagrError {
  override readonly name: string = 'PagrDecodeError';

  constructor(message: string, statusCode?: number, options?: { cause?: unknown }) {
    super(message, statusCode, undefined, options);
  }
}

/**
 * An async-render webhook callback could not be proven to come from Pagr.
 *
 * Thrown by `verifySignature`/`parseSignedCallback` when the
 * `X-Pagr-Signature` header is absent or malformed, when its timestamp falls
 * outside the accepted replay window, or when no signature it carries matches
 * the configured signing secret. Every case means the same thing to a
 * receiver: do not act on the payload — answer the POST with a 4xx and drop
 * it. `statusCode`/`code` are always `undefined`; this is a local verification
 * failure, not an API response.
 *
 * A missing/empty secret is *not* this error — that is a receiver
 * misconfiguration and throws `TypeError`, so it stays distinguishable from a
 * forged callback.
 */
export class PagrSignatureError extends PagrError {
  override readonly name: string = 'PagrSignatureError';
}

/**
 * The request exceeded its timeout (the client default, or a per-call
 * override). `statusCode`/`code` are always `undefined`. The underlying abort
 * is available via the standard `cause`.
 */
export class PagrTimeoutError extends PagrError {
  override readonly name: string = 'PagrTimeoutError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, undefined, undefined, options);
  }
}

type PagrErrorConstructor = new (message: string, statusCode?: number, code?: string) => PagrError;

/** HTTP status → typed exception. */
export const STATUS_TO_ERROR: Readonly<Record<number, PagrErrorConstructor>> = {
  401: AuthenticationError,
  403: ForbiddenError,
  404: NotFoundError,
  413: PayloadTooLargeError,
  422: ValidationFailedError,
  429: RateLimitError,
};
