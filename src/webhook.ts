import { createHmac, timingSafeEqual } from 'node:crypto';

import { PagrDecodeError, PagrSignatureError } from './errors.js';
import {
  RenderIssue,
  RenderedDocument,
  parseRenderJobState,
  parseRenderOutcome,
  type RenderJobState,
  type RenderOutcome,
} from './models/render.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface RenderProgressWire {
  jobId?: string;
  processed?: number;
  requestedCount?: number;
  documentIndex?: number;
  document?: unknown;
}

/**
 * A per-document progress webhook delivered during an async render. One is
 * sent for each document that successfully renders. `processed` is how many
 * have completed so far (completion order) and `requestedCount` is the batch
 * size. Documents render in parallel, so callbacks arrive out of input order —
 * `documentIndex` correlates this document back to its input.
 */
export class RenderProgress {
  readonly jobId: string;
  readonly processed: number;
  readonly requestedCount: number;
  /** Zero-based position of this document in the request's data array. */
  readonly documentIndex: number;
  /** The document that was just rendered. Always present on a progress callback. */
  readonly document: RenderedDocument;

  private constructor(fields: {
    jobId: string;
    processed: number;
    requestedCount: number;
    documentIndex: number;
    document: RenderedDocument;
  }) {
    this.jobId = fields.jobId;
    this.processed = fields.processed;
    this.requestedCount = fields.requestedCount;
    this.documentIndex = fields.documentIndex;
    this.document = fields.document;
  }

  static fromApi(data: unknown): RenderProgress {
    const wire = data as RenderProgressWire;
    if (wire.document === null || wire.document === undefined) {
      throw new PagrDecodeError('Progress webhook payload has no document.');
    }
    return new RenderProgress({
      jobId: wire.jobId ?? '',
      processed: wire.processed ?? 0,
      requestedCount: wire.requestedCount ?? 0,
      documentIndex: wire.documentIndex ?? 0,
      document: RenderedDocument.fromApi(wire.document),
    });
  }

  /** Progress through the job as a percentage (0-100). */
  get progressPct(): number {
    return this.requestedCount !== 0 ? (this.processed / this.requestedCount) * 100 : 0;
  }

  toString(): string {
    return `RenderProgress ${this.processed}/${this.requestedCount} — ${this.document.documentName}`;
  }
}

interface RenderCompletionWire {
  jobId?: string;
  state?: string;
  status?: string;
  renderedCount?: number;
  requestedCount?: number;
  missingCount?: number;
  message?: string | null;
  issues?: unknown[];
}

/**
 * The final webhook delivered once an async render job finishes. `state` is
 * the terminal lifecycle value (`'completed'` or `'failed'`; never `'pending'`
 * here). `status` is the render outcome. `missingCount` is
 * `requestedCount − renderedCount` (every document not rendered, whatever the
 * reason); `issues` carries the per-document diagnostics.
 */
export class RenderCompletion {
  readonly jobId: string;
  readonly state: RenderJobState;
  readonly status: RenderOutcome;
  readonly renderedCount: number;
  readonly requestedCount: number;
  readonly missingCount: number;
  readonly message: string | null;
  readonly issues: readonly RenderIssue[];

  private constructor(fields: {
    jobId: string;
    state: RenderJobState;
    status: RenderOutcome;
    renderedCount: number;
    requestedCount: number;
    missingCount: number;
    message: string | null;
    issues: readonly RenderIssue[];
  }) {
    this.jobId = fields.jobId;
    this.state = fields.state;
    this.status = fields.status;
    this.renderedCount = fields.renderedCount;
    this.requestedCount = fields.requestedCount;
    this.missingCount = fields.missingCount;
    this.message = fields.message;
    this.issues = fields.issues;
  }

  static fromApi(data: unknown): RenderCompletion {
    const wire = data as RenderCompletionWire;
    return new RenderCompletion({
      jobId: wire.jobId ?? '',
      state: parseRenderJobState(wire.state),
      status: parseRenderOutcome(wire.status),
      renderedCount: wire.renderedCount ?? 0,
      requestedCount: wire.requestedCount ?? 0,
      missingCount: wire.missingCount ?? 0,
      message: wire.message ?? null,
      issues: (wire.issues ?? []).map(RenderIssue.fromApi),
    });
  }

  /** `true` when every document in the job rendered. */
  get ok(): boolean {
    return this.status === 'ok';
  }

  /** `true` when the job stopped early because the organisation is out of credit. */
  get insufficientCredit(): boolean {
    return this.status === 'insufficient_credit';
  }

  toString(): string {
    return `RenderCompletion ${this.jobId} — state=${this.state}, status=${this.status}, ${this.renderedCount}/${this.requestedCount} rendered`;
  }
}

/** Throws `PagrDecodeError` if `payload` is missing any of `keys`. */
function requireKeys(
  payload: Record<string, unknown>,
  keys: readonly string[],
  shape: string,
): void {
  const missing = keys.filter((k) => !(k in payload));
  if (missing.length > 0) {
    throw new PagrDecodeError(
      `webhook payload looks like a ${shape} callback but is missing ` +
        `required field(s): ${missing.join(', ')}`,
    );
  }
}

/**
 * Parses an incoming async-render webhook body into the right typed object.
 * Accepts either the raw JSON string POSTed to your callback URL, or an
 * already-parsed payload (e.g. from a framework's JSON body-parsing
 * middleware). A progress callback carries a `document` (plus `processed` /
 * `documentIndex`); the final completion callback does not (it carries
 * `state` / `status`). The full expected shape is validated before dispatch,
 * so a payload matching neither shape throws `PagrDecodeError` rather than
 * being silently mis-parsed into a bogus-but-valid-looking completion.
 *
 * Prefer {@link parseSignedCallback} for an endpoint Pagr POSTs to: it verifies
 * the `X-Pagr-Signature` header before decoding, so an unverified payload never
 * reaches application code. `parseCallback` itself authenticates **nothing** —
 * anyone who discovers your callback URL can POST to it — so reach for it only
 * where provenance is already established: a body you verified yourself with
 * {@link verifySignature}, a payload replayed from your own store, or a test.
 *
 * Every delivery carries three headers: `X-Pagr-Signature` (see
 * {@link verifySignature}), `X-Pagr-Event` (`render.progress`,
 * `render.completed` or `render.failed`) and `X-Pagr-Delivery`. Delivery is
 * retried — up to 5 attempts, exponential backoff from 2s, 30s timeout per
 * attempt — and runs with bounded parallelism (16 concurrent), so callbacks
 * arrive out of order *and* can arrive more than once. Keep the handler
 * idempotent and deduplicate on `X-Pagr-Delivery`, which is stable across
 * retries of one logical delivery. Respond quickly, and treat polling
 * (`getJobStatus`/`waitForJob`) as the authoritative signal. This SDK ships a
 * parser only, not a bundled receiver server; bring your own HTTP framework.
 *
 * @throws {PagrDecodeError} If `payload` is not a JSON object, is a malformed
 *   JSON string, or matches neither the progress nor the completion shape.
 */
export function parseCallback(payload: unknown): RenderProgress | RenderCompletion {
  let parsed: unknown;
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      throw new PagrDecodeError('webhook payload is not valid JSON', undefined, { cause: error });
    }
  } else {
    parsed = payload;
  }
  if (!isRecord(parsed)) {
    throw new PagrDecodeError('webhook payload must be a JSON object');
  }
  if (parsed['document'] !== null && parsed['document'] !== undefined) {
    // Progress: must carry the per-document correlation fields.
    requireKeys(parsed, ['jobId', 'processed', 'requestedCount', 'documentIndex'], 'progress');
    return RenderProgress.fromApi(parsed);
  }
  // Completion: must carry the terminal-state fields.
  requireKeys(parsed, ['jobId', 'state', 'status'], 'completion');
  return RenderCompletion.fromApi(parsed);
}

/** Name of the header carrying the signature. */
export const SIGNATURE_HEADER = 'X-Pagr-Signature';

/**
 * Name of the header carrying the event type of the delivery:
 * `render.progress`, `render.completed` or `render.failed`.
 */
export const EVENT_HEADER = 'X-Pagr-Event';

/**
 * Name of the header carrying a stable id for one logical delivery. Retries
 * repeat the id, so a receiver deduplicates on it — deliveries are retried and
 * can arrive more than once.
 */
export const DELIVERY_HEADER = 'X-Pagr-Delivery';

/**
 * How far the signed timestamp may drift from local time, in milliseconds
 * (5 minutes). Bounds how long a captured callback stays replayable; wide
 * enough to absorb clock skew and the sender's retry backoff, and what the
 * Pagr server assumes receivers enforce.
 */
export const DEFAULT_SIGNATURE_TOLERANCE_MS = 300_000;

/** Optional settings for {@link verifySignature} / {@link parseSignedCallback}. */
export interface VerifySignatureOptions {
  /**
   * Maximum accepted difference between the signed timestamp and `nowMs`, in
   * either direction. Defaults to {@link DEFAULT_SIGNATURE_TOLERANCE_MS}.
   */
  toleranceMs?: number;
  /**
   * Current time as Unix milliseconds; defaults to `Date.now()`. Present for
   * tests and for callers with their own clock.
   */
  nowMs?: number;
}

/** Splits `t=…` / `v1=…` pairs out of a signature header, ignoring anything else. */
function parseSignatureHeader(header: string): {
  timestamp: string | undefined;
  candidates: string[];
} {
  let timestamp: string | undefined;
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    const key = eq === -1 ? trimmed : trimmed.slice(0, eq);
    const value = eq === -1 ? '' : trimmed.slice(eq + 1).trim();
    if (key === 't') {
      timestamp = value;
    } else if (key === 'v1') {
      candidates.push(value);
    }
    // Any other scheme version is ignored, so a future v2 alongside v1 does
    // not make an otherwise-verifiable callback look malformed.
  }
  return { timestamp, candidates };
}

/**
 * Verifies the `X-Pagr-Signature` header of an async-render callback.
 *
 * Every callback carries
 *
 * ```text
 * X-Pagr-Signature: t=1754899200,v1=<hex>[,v1=<hex>]
 * ```
 *
 * where each `v1` is lowercase-hex `HMAC-SHA256(secret, "{t}.{rawBody}")`.
 * Verifying it is how a receiver tells a genuine callback from any POST that
 * reaches the listening URL. The timestamp is *inside* the signed material, so
 * rejecting an old `t` also rejects replays of a captured delivery.
 *
 * **Pass the raw body bytes.** This is the single most common cause of a
 * signature that "should" match but doesn't: the digest covers the exact bytes
 * Pagr POSTed, so a body your framework parsed to an object and you
 * re-serialized will not verify even though the JSON *value* is identical — key
 * order, separators and whitespace all change the bytes. Read the body as a
 * `Buffer`/`Uint8Array` (or the undecoded UTF-8 string) *before* any JSON
 * middleware touches it. In Express that means
 * `express.raw({ type: 'application/json' })` on the callback route — or
 * `express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })` — not
 * `express.json()` alone.
 *
 * Returns `void` and throws on every failure, so a caller who forgets to check
 * a return value still fails closed:
 *
 * ```ts
 * try {
 *   verifySignature(rawBody, req.headers['x-pagr-signature'], SECRET);
 * } catch (err) {
 *   if (err instanceof PagrSignatureError) return res.writeHead(400).end();
 *   throw err;
 * }
 * const callback = parseCallback(rawBody.toString('utf-8'));
 * ```
 *
 * Prefer {@link parseSignedCallback}, which does the above in one call and
 * cannot be called in the wrong order.
 *
 * The signing secret is per organisation: copy it from **Settings → API keys**
 * in the Pagr web app and keep it wherever you keep credentials. It is not
 * available on the `/v1` API, so no client method fetches it. More than one
 * `v1` appears only while a rotated-out secret is still inside its 24-hour
 * grace period — verification succeeds when *any* `v1` matches, so a receiver
 * can move to a new secret without dropping deliveries.
 *
 * @param body The **raw** request body, exactly as received — the bytes (or
 *   undecoded string) your web framework read off the wire.
 * @param signatureHeader The `X-Pagr-Signature` header value, or
 *   `null`/`undefined` when the request carried none (itself a failure).
 * @param secret The organisation's webhook signing secret.
 * @throws {PagrSignatureError} If the header is absent, malformed, carries a
 *   timestamp outside the tolerance, or if no signature in it matches `secret`
 *   — i.e. anything short of a proven-genuine callback.
 * @throws {TypeError} If `secret` is empty. That is a misconfiguration in the
 *   receiver (an unset environment variable, typically), not an untrustworthy
 *   callback, so it is deliberately *not* a `PagrSignatureError` — and not a
 *   `PagrError` at all, so a `catch (PagrError)` around your handler cannot
 *   quietly turn a broken deployment into "callbacks look forged".
 */
export function verifySignature(
  body: Uint8Array | string,
  signatureHeader: string | null | undefined,
  secret: string,
  options: VerifySignatureOptions = {},
): void {
  // Blank, not merely empty: a whitespace-only secret is always a botched
  // config read, and letting it through to fail as a signature mismatch would
  // diagnose a broken receiver as a forged callback.
  if (!secret || secret.trim() === '') {
    throw new TypeError(
      'a webhook signing secret is required to verify a callback; ' +
        'copy it from Settings → API keys in the Pagr web app',
    );
  }

  const toleranceMs = options.toleranceMs ?? DEFAULT_SIGNATURE_TOLERANCE_MS;
  const nowMs = options.nowMs ?? Date.now();

  if (signatureHeader === null || signatureHeader === undefined || signatureHeader.trim() === '') {
    throw new PagrSignatureError(`request carried no ${SIGNATURE_HEADER} header`);
  }

  const { timestamp, candidates } = parseSignatureHeader(signatureHeader);
  if (timestamp === undefined || candidates.length === 0) {
    throw new PagrSignatureError(
      `unparsable ${SIGNATURE_HEADER} header: ${JSON.stringify(signatureHeader)}`,
    );
  }
  if (!/^[+-]?\d+$/.test(timestamp)) {
    throw new PagrSignatureError(
      `${SIGNATURE_HEADER} timestamp is not an integer: ${JSON.stringify(timestamp)}`,
    );
  }
  const signedAt = Number(timestamp);

  const driftMs = Math.abs(nowMs - signedAt * 1000);
  if (driftMs > toleranceMs) {
    throw new PagrSignatureError(
      `callback was signed ${Math.round(driftMs / 1000)}s from now, outside the ` +
        `${Math.round(toleranceMs / 1000)}s tolerance — stale delivery or a replay`,
    );
  }

  const expected = Buffer.from(
    createHmac('sha256', secret)
      .update(`${signedAt}.`, 'utf-8')
      .update(typeof body === 'string' ? Buffer.from(body, 'utf-8') : body)
      .digest('hex'),
    'utf-8',
  );

  // Any match wins: during a secret rotation Pagr signs with both the new and
  // the outgoing secret, so only one of them is the one we hold.
  for (const candidate of candidates) {
    const actual = Buffer.from(candidate, 'utf-8');
    // Length is checked first because timingSafeEqual throws on a mismatch;
    // it leaks only the length of a *rejected* candidate, never its content.
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
      return;
    }
  }

  throw new PagrSignatureError(
    `none of the ${candidates.length} signature(s) in ${SIGNATURE_HEADER} ` +
      'matched the configured secret',
  );
}

/**
 * Verifies a callback's signature and parses it, in one call — the preferred
 * entry point for a webhook endpoint.
 *
 * Better than calling {@link verifySignature} and {@link parseCallback}
 * separately: it takes the raw body (the only form the signature can be checked
 * against) and decodes the JSON itself, so there is no window in which an
 * unverified payload has already been parsed and handed to application code,
 * and no order to get wrong.
 *
 * ```ts
 * import { createServer } from 'node:http';
 * import { PagrSignatureError, RenderCompletion, RenderProgress, parseSignedCallback } from 'pagr';
 *
 * const SECRET = process.env.PAGR_WEBHOOK_SECRET!;
 *
 * createServer((req, res) => {
 *   const chunks: Buffer[] = [];
 *   req.on('data', (chunk: Buffer) => chunks.push(chunk));
 *   req.on('end', () => {
 *     let callback;
 *     try {
 *       // Buffer.concat — the raw bytes, never a re-serialized object.
 *       callback = parseSignedCallback(
 *         Buffer.concat(chunks),
 *         req.headers['x-pagr-signature'],
 *         SECRET,
 *       );
 *     } catch (err) {
 *       if (err instanceof PagrSignatureError) return res.writeHead(400).end();
 *       throw err;
 *     }
 *     if (callback instanceof RenderProgress) {
 *       console.log(callback.processed, callback.documentIndex, callback.document.documentName);
 *     } else if (callback instanceof RenderCompletion) {
 *       console.log(callback.state, callback.status, callback.renderedCount);
 *     }
 *     res.writeHead(204).end();
 *   });
 * }).listen(8765);
 * ```
 *
 * @param body The raw request body, exactly as received. See
 *   {@link verifySignature} for why re-serialized JSON will not verify — that
 *   footgun applies here identically. (`parseCallback` is the one that takes an
 *   already-parsed payload, and it verifies nothing.)
 * @param signatureHeader The `X-Pagr-Signature` header value.
 * @param secret The organisation's webhook signing secret.
 * @throws {PagrSignatureError} If the callback cannot be proven to come from
 *   Pagr. Thrown *before* the body is decoded, so an unverified payload is
 *   never parsed.
 * @throws {PagrDecodeError} If the verified body is not valid JSON, or matches
 *   neither the progress nor the completion shape.
 * @throws {TypeError} If `secret` is empty.
 */
export function parseSignedCallback(
  body: Uint8Array | string,
  signatureHeader: string | null | undefined,
  secret: string,
  options: VerifySignatureOptions = {},
): RenderProgress | RenderCompletion {
  verifySignature(body, signatureHeader, secret, options);

  // Decoded only now that the bytes are proven genuine. `parseCallback` raises
  // PagrDecodeError for a non-JSON string, so JSON.parse is not repeated here.
  return parseCallback(typeof body === 'string' ? body : Buffer.from(body).toString('utf-8'));
}
