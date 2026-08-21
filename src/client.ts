import { setTimeout as sleep } from 'node:timers/promises';
import { PagrTimeoutError } from './errors.js';
import { DOCUMENT_FILTERS, TEMPLATE_FILTERS, TEMPLATE_VERSION_FILTERS } from './filters.js';
import { HttpTransport, type HttpTransportOptions, type QueryParams } from './http.js';
import { buildListQuery, type ListOptions } from './list-options.js';
import {
  BatchRenderResult,
  OrgStats,
  PagedResult,
  PdfDocument,
  PdfRenderResult,
  RenderDocument,
  RenderJob,
  RenderJobStatus,
  RenderResult,
  Template,
  TemplateVersion,
  ValidationResponse,
} from './models/index.js';

/**
 * Base URL of the hosted Pagr Public API, used when the caller does not pass an
 * explicit `baseUrl`.
 */
export const DEFAULT_BASE_URL = 'https://api.pagr.eu';

/**
 * Default overall deadline for `waitForJob`, in milliseconds (5 minutes).
 * Pass `timeoutMs: Infinity` to opt out of any deadline and poll
 * unboundedly — `undefined`/omitted always means "use this default", never
 * "unbounded", so the sentinel is a distinct value rather than overloading
 * the option's absence.
 */
export const DEFAULT_WAIT_FOR_JOB_TIMEOUT_MS = 300_000;

/** Document data: a JSON string, or any JSON-serialisable value (plain object, array, etc.). */
export type DocumentInput = string | object;

/** Options shared by `render`/`renderBatch`/`renderPdf`/`enqueueBatchRender`. */
export interface RenderOptions {
  /** A specific version number, or omitted for the latest published version. */
  version?: number;
  /** Whether to return the rendered bytes inline (Base64). Defaults to `false`. Ignored by `renderPdf`. */
  includeDocument?: boolean;
  /** Language variant to render (for multilingual templates). */
  language?: string;
  /** When `false`, the render is not stored server-side. Defaults to `true`. */
  persist?: boolean;
  /**
   * Per-request timeout override in milliseconds for this call only; falls back
   * to the client's configured default (30s). Use a larger value for a document
   * that may approach the server's 60-second render budget.
   */
  timeoutMs?: number;
  /**
   * Aborts this call when the signal fires. A caller-initiated abort rejects
   * with the native `AbortError` `DOMException`, never wrapped in a
   * `PagrError` — distinct from a timeout, which still surfaces as
   * `PagrTimeoutError`.
   */
  signal?: AbortSignal;
}

function toPayload(data: DocumentInput): unknown {
  return typeof data === 'string' ? JSON.parse(data) : data;
}

/**
 * A JSON array payload is a batch (one document per element); anything else
 * is a single document. Array elements that are themselves JSON-encoded
 * strings are parsed into documents. Only used for the single-value
 * `validate` input — an explicitly-passed array of documents is mapped
 * directly, without this per-element re-expansion.
 */
function expandSingleValue(payload: unknown): unknown[] {
  if (!Array.isArray(payload)) {
    return [payload];
  }
  return payload.map((element: unknown) =>
    typeof element === 'string' ? toPayload(element) : element,
  );
}

function readStringProperty(data: unknown, key: string): string | null {
  if (typeof data === 'object' && data !== null) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return null;
}

/**
 * Builds a render endpoint path. `version` omitted targets the latest
 * published version; otherwise the specific version.
 */
function renderPath(templateId: string, version: number | undefined, suffix = ''): string {
  const base =
    version !== undefined
      ? `v1/render/${templateId}/versions/${version}`
      : `v1/render/${templateId}`;
  return `${base}${suffix}`;
}

/** `language` is sent only when set; `persist` is always sent, as a lowercase boolean. */
function renderQuery(language: string | undefined, persist: boolean): QueryParams {
  const query: [string, string][] = [];
  if (language !== undefined) {
    query.push(['language', language]);
  }
  query.push(['persist', persist ? 'true' : 'false']);
  return query;
}

/**
 * Client for the Pagr document-rendering API (`/v1`).
 *
 * Provides methods for managing templates and versions, rendering documents
 * (synchronously, or via fire-and-forget jobs with webhook callbacks or
 * polling), validating data, browsing rendered documents and fonts, and
 * retrieving organisation statistics.
 *
 * API error responses (4xx/5xx) are thrown as subclasses of `PagrError`
 * (see `errors.ts`), mapped by status: 401 `AuthenticationError`, 403
 * `ForbiddenError`, 404 `NotFoundError`, 413 `PayloadTooLargeError`, 422
 * `ValidationFailedError`, 429 `RateLimitError`, anything else `ApiError`.
 * Business outcomes (failed validation, insufficient credit, per-document
 * render failures) are surfaced as data on the result objects, never as
 * exceptions.
 *
 * Requests are rate limited per organisation over a sliding 60-second window;
 * exceeding it throws `RateLimitError`.
 */
export class PagrApiClient {
  private readonly http: HttpTransport;

  /**
   * @param apiKey The organisation API key, sent as a bearer token on every
   *   request. The key prefix selects the mode: `pagr_test_` keys render with
   *   test restrictions (watermarked output, batches capped at 10 documents
   *   per request), `pagr_prod_` keys render fully and consume credit.
   * @param baseUrl Base URL of the Pagr API. Defaults to the hosted API
   *   ({@link DEFAULT_BASE_URL}); pass this only to target another instance.
   * @param options Optional settings: request `timeoutMs` (default 30s) and
   *   `maxRetries` (default 2; 0 disables retries on idempotent GETs).
   */
  constructor(apiKey: string, baseUrl?: string, options?: HttpTransportOptions) {
    this.http = new HttpTransport(baseUrl?.trim() ? baseUrl : DEFAULT_BASE_URL, apiKey, options);
  }

  /** Replaces the API key used for subsequent requests. */
  setApiKey(apiKey: string): void {
    this.http.setApiKey(apiKey);
  }

  // ── Templates ────────────────────────────────────────────────────────────

  /** Lists templates available to the authenticated organisation, optionally scoped to a project. */
  async getTemplates(
    options?: ListOptions & { projectId?: string },
  ): Promise<PagedResult<Template>> {
    const path = options?.projectId ? `v1/projects/${options.projectId}/templates` : 'v1/templates';
    const raw = await this.http.get(path, buildListQuery(options, TEMPLATE_FILTERS));
    return PagedResult.fromApi(raw.json(), Template.fromApi);
  }

  /** Fetches a single template by ID. */
  async getTemplate(templateId: string): Promise<Template> {
    const raw = await this.http.get(`v1/templates/${templateId}`);
    return Template.fromApi(raw.json());
  }

  /** Lists the versions of a template. */
  async getTemplateVersions(
    templateId: string,
    options?: ListOptions,
  ): Promise<PagedResult<TemplateVersion>> {
    const raw = await this.http.get(
      `v1/templates/${templateId}/versions`,
      buildListQuery(options, TEMPLATE_VERSION_FILTERS),
    );
    return PagedResult.fromApi(raw.json(), TemplateVersion.fromApi);
  }

  /** Fetches a specific template version, or the latest published one when `version` is omitted. */
  async getTemplateVersion(templateId: string, version?: number): Promise<TemplateVersion> {
    const suffix = version !== undefined ? String(version) : 'latest';
    const raw = await this.http.get(`v1/templates/${templateId}/versions/${suffix}`);
    return TemplateVersion.fromApi(raw.json());
  }

  /**
   * Updates a version's document-name template. Pass `null` (not
   * `undefined`) to clear it — `JSON.stringify` drops an `undefined` key
   * entirely, which would silently fail to clear the value server-side.
   */
  async updateDocumentNameTemplate(
    templateId: string,
    versionNumber: number,
    documentNameTemplate: string | null,
  ): Promise<TemplateVersion> {
    const raw = await this.http.patchJson(
      `v1/templates/${templateId}/versions/${versionNumber}/document-name-template`,
      { documentNameTemplate },
    );
    return TemplateVersion.fromApi(raw.json());
  }

  /** Returns the URL of a version's preview image, or `null` when it has none. */
  async getPreviewImageUrl(templateId: string, versionNumber: number): Promise<string | null> {
    const raw = await this.http.get(
      `v1/templates/${templateId}/versions/${versionNumber}/preview-image`,
    );
    return readStringProperty(raw.json(), 'url');
  }

  // ── Render ───────────────────────────────────────────────────────────────

  /**
   * Renders a single document.
   *
   * This path negotiates `Accept: application/json`, for which the API always
   * returns the JSON envelope — including when `persist: false`, where the
   * document's `id`/`viewUrl` come back `null` (nothing was stored) and its
   * Base64 bytes are forced on, since they are then the only copy. Every other
   * field is real. To stream the raw PDF binary instead, use {@link renderPdf},
   * the only method that sends `Accept: application/pdf`.
   *
   * The document data is limited, per document, to at most 50 MB of JSON
   * nested at most 32 levels deep.
   *
   * `result.status` is one of `'ok'`, `'partial'`, `'failed'` or
   * `'insufficient_credit'`, and `result.ok` is `true` when a document was
   * produced. Reasons a document did not render are reported as `RenderIssue`
   * data in `result.issues`, not thrown — for example an overrun of the
   * per-document 60-second render budget surfaces as a `RenderTimeout` issue,
   * and disallowed content in the data as `DangerousContent`.
   *
   * @throws {NotFoundError} The template or version does not exist, or no version is published.
   * @throws {PayloadTooLargeError} The document exceeds the 50 MB limit.
   * @throws {ValidationFailedError} The request body cannot be bound.
   */
  async render(
    templateId: string,
    data: DocumentInput,
    options?: RenderOptions,
  ): Promise<RenderResult> {
    const raw = await this.http.postJson(
      renderPath(templateId, options?.version),
      { documents: [toPayload(data)], includeDocument: options?.includeDocument ?? false },
      {
        query: renderQuery(options?.language, options?.persist ?? true),
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
      },
    );
    return RenderResult.fromApi(raw.json());
  }

  /**
   * Renders a single document and returns the raw PDF via the opt-in
   * `Accept: application/pdf` path. Instead of the JSON envelope `render`
   * returns, the API streams the PDF binary directly, carrying document
   * metadata in `X-Pagr-*` response headers. Single-document only.
   *
   * When the document is blocked or fails to render there is no PDF to stream,
   * so the API returns HTTP 422 with a JSON envelope; that is surfaced as a
   * failed `PdfRenderResult` (`result.ok === false`, reasons in
   * `result.issues`/`result.status`) — a business outcome, not an exception.
   * `options.includeDocument` is ignored (the bytes are always streamed).
   *
   * @throws {NotFoundError} The template or version does not exist, or no version is published.
   * @throws {PayloadTooLargeError} The document exceeds the 50 MB limit.
   */
  async renderPdf(
    templateId: string,
    data: DocumentInput,
    options?: RenderOptions,
  ): Promise<PdfRenderResult> {
    const raw = await this.http.postJson(
      renderPath(templateId, options?.version),
      { documents: [toPayload(data)] },
      {
        query: renderQuery(options?.language, options?.persist ?? true),
        headers: { Accept: 'application/pdf' },
        nonRaisingStatuses: new Set([422]),
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
      },
    );
    if (raw.status === 422) {
      return PdfRenderResult.fromErrorEnvelope(raw.json());
    }
    return PdfRenderResult.ofDocument(PdfDocument.fromResponse(raw));
  }

  /**
   * Renders multiple documents in a single request. Unlike `render`, this
   * never sniffs for a raw-PDF response — the API always returns the JSON
   * envelope for a batch. Returns a result correlating each submitted input
   * (by position) to its rendered document or issues.
   */
  async renderBatch(
    templateId: string,
    dataSets: readonly DocumentInput[],
    options?: RenderOptions,
  ): Promise<BatchRenderResult> {
    const payloads = dataSets.map((item) => toPayload(item));
    const raw = await this.http.postJson(
      renderPath(templateId, options?.version),
      { documents: payloads, includeDocument: options?.includeDocument ?? false },
      {
        query: renderQuery(options?.language, options?.persist ?? true),
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
      },
    );
    return BatchRenderResult.fromApi(raw.json(), payloads);
  }

  /**
   * Enqueues a fire-and-forget batch render. Returns immediately with a job
   * reference; the server renders in the background and POSTs progress and
   * completion webhooks to `callbackUrl` (parse them with `parseCallback`).
   * You can also poll `getJobStatus`.
   */
  async enqueueBatchRender(
    templateId: string,
    dataSets: readonly DocumentInput[],
    callbackUrl: string,
    options?: RenderOptions,
  ): Promise<RenderJob> {
    const raw = await this.http.postJson(
      renderPath(templateId, options?.version, '/async'),
      {
        documents: dataSets.map((item) => toPayload(item)),
        callbackUrl,
        includeDocument: options?.includeDocument ?? false,
      },
      {
        query: renderQuery(options?.language, options?.persist ?? true),
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
      },
    );
    return RenderJob.fromApi(raw.json());
  }

  /** Polls the status of an async render job. Poll until `status.done`, or use `waitForJob`. */
  async getJobStatus(jobId: string, options?: { signal?: AbortSignal }): Promise<RenderJobStatus> {
    const raw = await this.http.get(`v1/render/jobs/${jobId}`, undefined, {
      signal: options?.signal,
    });
    return RenderJobStatus.fromApi(raw.json());
  }

  /**
   * Polls `getJobStatus` until the job reaches a terminal state. A convenience
   * wrapper over the hand-rolled `while (!status.done)` loop. Because `done`
   * treats an unrecognised state as terminal (fail-open), this never spins
   * forever on a server state the SDK does not know about.
   *
   * @param jobId The job returned by `enqueueBatchRender`.
   * @param options `pollIntervalMs` (default 2000) between polls; `timeoutMs`
   *   an overall deadline across all polls, defaulting to
   *   {@link DEFAULT_WAIT_FOR_JOB_TIMEOUT_MS} (5 minutes) — pass `Infinity` to
   *   poll unboundedly instead; `signal` aborts the wait (and the in-flight
   *   poll/sleep), rejecting with the native `AbortError`, never wrapped.
   * @throws {PagrTimeoutError} If `timeoutMs` elapses before the job finishes.
   * @throws {NotFoundError} If no job with this ID exists.
   */
  async waitForJob(
    jobId: string,
    options?: { pollIntervalMs?: number; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<RenderJobStatus> {
    const pollIntervalMs = options?.pollIntervalMs ?? 2000;
    const overallTimeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_FOR_JOB_TIMEOUT_MS;
    // `overallTimeoutMs: Infinity` (the documented "no deadline" opt-out)
    // flows straight through this arithmetic: `deadline` becomes `Infinity`,
    // `remaining` is always positive, and `Math.min(pollIntervalMs, remaining)`
    // collapses to `pollIntervalMs` — no separate unbounded-mode branch needed.
    const deadline = Date.now() + overallTimeoutMs;
    for (;;) {
      const status = await this.getJobStatus(jobId, { signal: options?.signal });
      if (status.done) {
        return status;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new PagrTimeoutError(`job ${jobId} did not finish within ${overallTimeoutMs}ms`);
      }
      await sleep(Math.min(pollIntervalMs, remaining), undefined, { signal: options?.signal });
    }
  }

  // ── Validate ─────────────────────────────────────────────────────────────

  /**
   * Validates document data against a template without rendering; consumes
   * no credit. A single document whose value is itself a JSON array (or a
   * JSON string encoding one) is treated as a batch. Passing an explicit
   * array of documents validates exactly that set, one document per element.
   */
  async validate(
    templateId: string,
    data: DocumentInput | readonly DocumentInput[],
    options?: { version?: number },
  ): Promise<ValidationResponse> {
    const documents: unknown[] = Array.isArray(data)
      ? data.map((item: DocumentInput) => toPayload(item))
      : expandSingleValue(toPayload(data as DocumentInput));
    const raw = await this.http.postJson(renderPath(templateId, options?.version, '/validate'), {
      documents,
    });
    return ValidationResponse.fromApi(raw.json());
  }

  // ── Documents ────────────────────────────────────────────────────────────

  /** Lists rendered documents for the authenticated organisation. */
  async getDocuments(options?: ListOptions): Promise<PagedResult<RenderDocument>> {
    const raw = await this.http.get('v1/documents', buildListQuery(options, DOCUMENT_FILTERS));
    return PagedResult.fromApi(raw.json(), RenderDocument.fromApi);
  }

  /** Fetches a single rendered document's metadata by ID. */
  async getDocument(documentId: string): Promise<RenderDocument> {
    const raw = await this.http.get(`v1/documents/${documentId}`);
    return RenderDocument.fromApi(raw.json());
  }

  /**
   * Downloads a rendered document's PDF bytes. `timeoutMs` overrides the
   * per-request timeout for this call; `signal` aborts it, rejecting with
   * the native `AbortError`, never wrapped in a `PagrError`.
   */
  async downloadDocument(
    documentId: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Uint8Array> {
    const raw = await this.http.get(`v1/documents/${documentId}/file`, undefined, {
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
    return raw.bytes;
  }

  // ── Fonts ────────────────────────────────────────────────────────────────

  /** Lists the font family names available for rendering. */
  async getFonts(): Promise<string[]> {
    const raw = await this.http.get('v1/fonts');
    return raw.json() as string[];
  }

  // ── Organisation ─────────────────────────────────────────────────────────

  /** Fetches usage and credit statistics for the authenticated organisation. */
  async getOrgStats(): Promise<OrgStats> {
    const raw = await this.http.get('v1/organisation/stats');
    return OrgStats.fromApi(raw.json());
  }

  // ── Meta ─────────────────────────────────────────────────────────────────

  /** Checks API health. Resolves `true` when healthy; a 503 throws a `PagrError`. */
  async getStatus(): Promise<boolean> {
    await this.http.get('v1/meta/status');
    return true;
  }

  /** Returns the deployed API version string, or `null` when the API does not report one. */
  async getVersion(): Promise<string | null> {
    const raw = await this.http.get('v1/meta/version');
    return readStringProperty(raw.json(), 'version');
  }
}
