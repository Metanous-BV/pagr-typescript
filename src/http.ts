import { setTimeout as sleep } from 'node:timers/promises';
import {
  ApiError,
  PagrConnectionError,
  PagrDecodeError,
  PagrError,
  PagrTimeoutError,
  RateLimitError,
  STATUS_TO_ERROR,
} from './errors.js';

/** An ordered `[key, value]` query-parameter list (order matters — see `list-options.ts`). */
export type QueryParams = readonly (readonly [string, string])[];

/**
 * A raw HTTP response: status, content-type, response headers and the
 * undecoded body bytes. Bodies are transported as raw bytes so a binary
 * response (the `application/pdf` `renderPdf` opts into, or a document
 * download) can be surfaced alongside the usual JSON — decide "PDF vs JSON"
 * from `contentType`/`isPdf` before choosing `.text()`/`.json()`, since a
 * `fetch` `Response` body can only be consumed once.
 */
export class RawResponse {
  private cachedText: string | undefined;

  constructor(
    readonly status: number,
    readonly contentType: string,
    readonly bytes: Uint8Array,
    readonly headers: Headers,
  ) {}

  /** The body decoded as UTF-8 text. */
  text(): string {
    if (this.cachedText === undefined) {
      this.cachedText = Buffer.from(this.bytes).toString('utf-8');
    }
    return this.cachedText;
  }

  /**
   * The body parsed as JSON. A non-JSON or empty body (e.g. a redirect that
   * was followed to an HTML page, or an unexpected `204`) would make
   * `JSON.parse` throw a bare `SyntaxError`; callers are promised they only
   * ever see `PagrError` subclasses, so that is wrapped in a `PagrDecodeError`.
   */
  json(): unknown {
    try {
      return JSON.parse(this.text());
    } catch (error) {
      throw new PagrDecodeError(
        'the Pagr API returned a response whose body was not valid JSON',
        this.status,
        { cause: error },
      );
    }
  }

  /** A response header value, or `null` when absent (case-insensitive lookup). */
  header(name: string): string | null {
    return this.headers.get(name);
  }

  /** Whether the response carried a PDF body. */
  get isPdf(): boolean {
    return this.contentType.toLowerCase().includes('application/pdf');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Whether `error` is a native `AbortError` `DOMException` — the shape a
 * `fetch()` call rejects with when the signal that aborted it carries an
 * `AbortError`-named `.reason` (the default reason for a bare
 * `controller.abort()`, and what `combineSignals` forwards verbatim when a
 * caller-supplied signal is the one that fired). Used to keep a caller
 * cancellation from ever being retried or wrapped in a `PagrError`.
 */
function isAbortError(error: unknown): boolean {
  return isRecord(error) && error['name'] === 'AbortError';
}

/**
 * Combines two abort signals into one, without `AbortSignal.any` (Node 20+;
 * this SDK keeps the Node >=18 floor). The returned signal aborts as soon as
 * EITHER input fires, forwarding whichever signal's `.reason` triggered it —
 * so a caller-initiated abort (`.reason` is an `AbortError` DOMException) and
 * an internal `AbortSignal.timeout()` firing (`.reason` is a `TimeoutError`
 * DOMException) stay distinguishable downstream by inspecting the resulting
 * error's `.name`, exactly as a bare `AbortSignal.timeout()` already was.
 *
 * `cleanup()` removes the listener left on whichever input did NOT fire; call
 * it once the operation finishes (success or failure) so a long-lived
 * caller-supplied signal reused across many calls (e.g. `waitForJob` polling)
 * never accumulates listeners.
 */
function combineSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): { signal: AbortSignal; cleanup: () => void } {
  if (!a) {
    return { signal: b ?? new AbortController().signal, cleanup: () => {} };
  }
  if (!b) {
    return { signal: a, cleanup: () => {} };
  }
  const signalA = a;
  const signalB = b;
  if (signalA.aborted) {
    return { signal: signalA, cleanup: () => {} };
  }
  if (signalB.aborted) {
    return { signal: signalB, cleanup: () => {} };
  }

  const controller = new AbortController();
  const cleanup = (): void => {
    signalA.removeEventListener('abort', onAbortA);
    signalB.removeEventListener('abort', onAbortB);
  };
  const onAbortA = (): void => {
    controller.abort(signalA.reason);
    cleanup();
  };
  const onAbortB = (): void => {
    controller.abort(signalB.reason);
    cleanup();
  };
  signalA.addEventListener('abort', onAbortA);
  signalB.addEventListener('abort', onAbortB);
  return { signal: controller.signal, cleanup };
}

function optString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parses a `Retry-After` header value expressed as an integer number of
 * seconds. Returns `undefined` when absent or not an integer (e.g. an
 * HTTP-date), since the SDK does not interpret the date form.
 */
export function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  return Number(trimmed);
}

/**
 * Extracts a `{code, message}` pair from an error body, reading the API's
 * `{"error":{"code","message"}}` envelope and falling back to the raw body
 * (or a generic message) when it is not the expected JSON.
 */
function parseErrorEnvelope(
  bodyText: string,
  fallbackMessage: string,
): { code: string | undefined; message: string } {
  if (!bodyText.trim()) {
    return { code: undefined, message: fallbackMessage };
  }
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const err = isRecord(parsed) ? parsed['error'] : undefined;
    if (isRecord(err)) {
      return { code: optString(err, 'code'), message: optString(err, 'message') ?? bodyText };
    }
  } catch {
    // Not JSON; keep the raw body as the message.
  }
  return { code: undefined, message: bodyText };
}

export interface HttpTransportOptions {
  /** Per-request timeout, covering the full request/response exchange. Defaults to 30 seconds. */
  timeoutMs?: number;
  /**
   * Maximum retries for transient failures on idempotent (GET) requests.
   * Defaults to 2; set to 0 to disable retries. Writes (POST/PATCH) are never
   * retried regardless of this value.
   */
  maxRetries?: number;
  /** Base delay (ms) for exponential backoff. Internal test seam. */
  backoffBaseMs?: number;
  /** Ceiling (ms) for a single computed backoff delay. Internal test seam. */
  backoffMaxMs?: number;
  /** Defensive ceiling (ms) on an honored `Retry-After` value. Internal test seam. */
  retryAfterMaxMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_BACKOFF_BASE_MS = 500;
export const DEFAULT_BACKOFF_MAX_MS = 8_000;
export const DEFAULT_RETRY_AFTER_MAX_MS = 60_000;

/**
 * HTTP statuses worth retrying on an idempotent (GET) request: transient
 * server/gateway failures (500/502/504) and a full render queue (503
 * `QueueFull`). 4xx statuses are deterministic and never retried — including
 * 429: rate limiting reflects the caller's own request volume, so it surfaces
 * as `RateLimitError` for the caller to handle, not retried silently.
 */
const RETRIABLE_STATUS: ReadonlySet<number> = new Set([500, 502, 503, 504]);

/** Options for a single request. */
interface SendOptions {
  query?: QueryParams;
  body?: unknown;
  /** Extra headers merged over the default auth (+ `Content-Type` for a body). */
  headers?: Record<string, string>;
  /** Whether transient failures should be retried (GET only). */
  retriable?: boolean;
  /** Per-request timeout override (ms); falls back to the client default. */
  timeoutMs?: number;
  /**
   * Status codes to return as-is instead of raising, letting the caller parse
   * the response body itself (e.g. a 422 that carries a business-outcome
   * envelope rather than a bind error).
   */
  nonRaisingStatuses?: ReadonlySet<number>;
  /**
   * Aborts this call (including any queued retry backoff) when the signal
   * fires. Rejects with the native `AbortError` `DOMException`, never
   * wrapped in a `PagrError` and never retried — distinct from a timeout,
   * which still surfaces as `PagrTimeoutError`.
   */
  signal?: AbortSignal;
}

/**
 * Internal HTTP transport shared by `PagrApiClient`: request building,
 * authentication, error mapping, retries and byte-level (de)serialisation.
 * Not part of the public API surface.
 *
 * Idempotent GET requests are retried on transient failures (see
 * `RETRIABLE_STATUS` plus timeouts and connection errors) with capped
 * exponential backoff and full jitter, honoring a `Retry-After` header if
 * present. Writes (POST/PATCH) are never retried: the API has no idempotency
 * keys, so a request that was applied but whose response was lost must not be
 * repeated (it would render/charge twice).
 */
export class HttpTransport {
  private readonly baseUrl: string;
  private apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly retryAfterMaxMs: number;

  constructor(baseUrl: string, apiKey: string, options?: HttpTransportOptions) {
    if (!baseUrl.trim()) {
      throw new Error('A base URL is required.');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffBaseMs = options?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = options?.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.retryAfterMaxMs = options?.retryAfterMaxMs ?? DEFAULT_RETRY_AFTER_MAX_MS;
  }

  /** Replaces the API key used for subsequent requests. */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  get(
    path: string,
    query?: QueryParams,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<RawResponse> {
    return this.send('GET', path, {
      query,
      retriable: true,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  postJson(
    path: string,
    body: unknown,
    options?: {
      query?: QueryParams;
      headers?: Record<string, string>;
      timeoutMs?: number;
      nonRaisingStatuses?: ReadonlySet<number>;
      signal?: AbortSignal;
    },
  ): Promise<RawResponse> {
    return this.send('POST', path, {
      query: options?.query,
      body,
      headers: options?.headers,
      retriable: false,
      timeoutMs: options?.timeoutMs,
      nonRaisingStatuses: options?.nonRaisingStatuses,
      signal: options?.signal,
    });
  }

  patchJson(
    path: string,
    body: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<RawResponse> {
    return this.send('PATCH', path, {
      body,
      retriable: false,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
  }

  private buildUrl(path: string, query?: QueryParams): string {
    const url = `${this.baseUrl}/${path}`;
    if (!query || query.length === 0) {
      return url;
    }
    const params = new URLSearchParams();
    for (const [key, value] of query) {
      params.append(key, value);
    }
    return `${url}?${params.toString()}`;
  }

  private async send(method: string, path: string, options: SendOptions): Promise<RawResponse> {
    const retriable = (options.retriable ?? false) && this.maxRetries > 0;
    const maxAttempts = retriable ? this.maxRetries + 1 : 1;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const url = this.buildUrl(path, options.query);

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey.trim()) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    let requestBody: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(options.body);
    }
    if (options.headers) {
      Object.assign(headers, options.headers);
    }

    const callerSignal = options.signal;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      // A fresh combined signal per attempt: the internal timeout budget is
      // per-attempt (matching the existing per-attempt `AbortSignal.timeout`
      // semantics), while the caller's signal spans every attempt.
      const combined = combineSignals(callerSignal, AbortSignal.timeout(timeoutMs));
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: requestBody,
          signal: combined.signal,
        });
      } catch (error) {
        if (isAbortError(error)) {
          // Caller cancellation: rethrow unchanged, never retried.
          throw error;
        }
        if (retriable && attempt < maxAttempts) {
          await this.backoff(attempt, null, callerSignal);
          continue;
        }
        throw this.wrapTransportError(error);
      } finally {
        combined.cleanup();
      }

      if (retriable && attempt < maxAttempts && RETRIABLE_STATUS.has(response.status)) {
        const retryAfter = response.headers.get('Retry-After');
        // Release the socket before sleeping/retrying.
        await response.arrayBuffer().catch(() => undefined);
        await this.backoff(attempt, retryAfter, callerSignal);
        continue;
      }

      const buffer = await response.arrayBuffer();
      const raw = new RawResponse(
        response.status,
        response.headers.get('content-type') ?? '',
        new Uint8Array(buffer),
        response.headers,
      );
      if (options.nonRaisingStatuses?.has(raw.status)) {
        return raw;
      }
      this.raiseForStatus(raw);
      return raw;
    }
  }

  /** Maps a `fetch` transport failure to the typed exception hierarchy. */
  private wrapTransportError(error: unknown): PagrError {
    const name = isRecord(error) ? error['name'] : undefined;
    // `AbortSignal.timeout()` firing surfaces as a `TimeoutError` (undici);
    // anything else (DNS failure, connection refused, TLS/protocol error) is a
    // connection failure that never produced a response.
    if (name === 'TimeoutError') {
      return new PagrTimeoutError('Request to the Pagr API timed out', { cause: error });
    }
    const reason = error instanceof Error ? error.message : String(error);
    return new PagrConnectionError(`Could not reach the Pagr API: ${reason}`, { cause: error });
  }

  /**
   * Sleeps before the next retry, honoring `Retry-After` or using
   * backoff+jitter. `signal` is the caller's own signal (not the per-attempt
   * timeout signal, which does not span the gap between attempts) — aborting
   * it returns promptly instead of waiting out the full delay, rejecting
   * with the native `AbortError` (per `node:timers/promises` `setTimeout`).
   */
  private async backoff(
    attempt: number,
    retryAfter: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const retryAfterSeconds = parseRetryAfterSeconds(retryAfter);
    let delayMs: number;
    if (retryAfterSeconds !== undefined) {
      delayMs = Math.min(retryAfterSeconds * 1000, this.retryAfterMaxMs);
    } else {
      const ceiling = Math.min(this.backoffBaseMs * 2 ** (attempt - 1), this.backoffMaxMs);
      delayMs = Math.random() * ceiling;
    }
    await sleep(delayMs, undefined, { signal });
  }

  private raiseForStatus(raw: RawResponse): void {
    if (raw.status < 400) {
      return;
    }
    const { code, message } = parseErrorEnvelope(
      raw.text(),
      `Pagr API returned HTTP ${raw.status}.`,
    );
    const ErrorType = STATUS_TO_ERROR[raw.status] ?? ApiError;
    if (ErrorType === RateLimitError) {
      throw new RateLimitError(
        message,
        raw.status,
        code,
        parseRetryAfterSeconds(raw.headers.get('Retry-After')),
      );
    }
    throw new ErrorType(message, raw.status, code);
  }
}
