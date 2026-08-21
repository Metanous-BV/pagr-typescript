import { mkdir } from 'node:fs/promises';
import type { RawResponse } from '../http.js';
import {
  asRecord,
  optionalString,
  parseDate,
  requireDate,
  requireField,
  saveDocumentBytes,
} from './_common.js';

/** Category of a {@link RenderIssue}, mirroring the API's `RenderIssueType`. */
export type RenderIssueType =
  | 'Unknown'
  | 'InvalidJson'
  | 'SchemaInvalid'
  | 'DangerousContent'
  | 'MissingBinding'
  | 'UnresolvedImage'
  | 'UnresolvedFont'
  | 'InvalidColor'
  | 'InvalidCondition'
  | 'DataSourceNotEnumerable'
  | 'InvalidChartConfig'
  | 'InvalidPageBackground'
  | 'BindingFailedAtRender'
  | 'RenderTimeout'
  | 'RenderLayoutDegraded'
  | 'InvalidLayout'
  | 'UnformattedValue';

const RENDER_ISSUE_TYPES: readonly RenderIssueType[] = [
  'Unknown',
  'InvalidJson',
  'SchemaInvalid',
  'DangerousContent',
  'MissingBinding',
  'UnresolvedImage',
  'UnresolvedFont',
  'InvalidColor',
  'InvalidCondition',
  'DataSourceNotEnumerable',
  'InvalidChartConfig',
  'InvalidPageBackground',
  'BindingFailedAtRender',
  'RenderTimeout',
  'RenderLayoutDegraded',
  'InvalidLayout',
  'UnformattedValue',
];

/** Parses the API's string value case-insensitively; unknown/missing values fail OPEN to `'Unknown'`. */
export function parseRenderIssueType(value: unknown): RenderIssueType {
  if (typeof value === 'string') {
    const match = RENDER_ISSUE_TYPES.find((t) => t.toLowerCase() === value.toLowerCase());
    if (match) {
      return match;
    }
  }
  return 'Unknown';
}

/**
 * How much a {@link RenderIssue} blocks rendering. Ordered by severity:
 * production blocks any issue at or above `'Warning'`; test/preview blocks
 * only `'Error'`. This is a string-literal union, so `>=` would compare
 * alphabetically (wrong) — use {@link isRenderIssueSeverityAtLeast} (or the
 * {@link isRenderIssueSeverityBlockingProduction} shortcut) for ordered
 * comparisons.
 */
export type RenderIssueSeverity = 'Information' | 'Warning' | 'Error';

const RENDER_ISSUE_SEVERITIES: readonly RenderIssueSeverity[] = ['Information', 'Warning', 'Error'];

/** Rank used for ordering comparisons (higher = more severe). */
const RENDER_ISSUE_SEVERITY_RANK: Readonly<Record<RenderIssueSeverity, number>> = {
  Information: 0,
  Warning: 1,
  Error: 2,
};

/**
 * `true` when `severity` is `other` or more severe, per the explicit rank
 * (`Information < Warning < Error`). The ordered replacement for a
 * `severity >= other` comparison, which would compare the union's members
 * alphabetically instead.
 */
export function isRenderIssueSeverityAtLeast(
  severity: RenderIssueSeverity,
  other: RenderIssueSeverity,
): boolean {
  return RENDER_ISSUE_SEVERITY_RANK[severity] >= RENDER_ISSUE_SEVERITY_RANK[other];
}

/**
 * `true` when an issue of this severity blocks a production render (i.e. it
 * is `'Warning'` or `'Error'`).
 */
export function isRenderIssueSeverityBlockingProduction(severity: RenderIssueSeverity): boolean {
  return isRenderIssueSeverityAtLeast(severity, 'Warning');
}

/** Parses the API's string value case-insensitively; unknown/missing values fail CLOSED to `'Error'`. */
export function parseRenderIssueSeverity(value: unknown): RenderIssueSeverity {
  if (typeof value === 'string') {
    const match = RENDER_ISSUE_SEVERITIES.find((s) => s.toLowerCase() === value.toLowerCase());
    if (match) {
      return match;
    }
  }
  return 'Error';
}

interface RenderIssueWire {
  type?: string | null;
  severity?: string | null;
  description?: string;
  elementId?: string | null;
  documentIndex?: number | null;
}

/**
 * A single render or validation issue. The category is carried by `type`
 * and the blocking-ness by `severity`. `documentIndex` is the zero-based
 * position of the document the issue pertains to in a batch, or `null` for
 * single-document operations and batch-wide issues.
 */
export class RenderIssue {
  readonly type: RenderIssueType;
  readonly severity: RenderIssueSeverity;
  readonly description: string;
  readonly elementId: string | null;
  readonly documentIndex: number | null;

  private constructor(wire: RenderIssueWire) {
    this.type = parseRenderIssueType(wire.type);
    this.severity = parseRenderIssueSeverity(wire.severity);
    this.description = wire.description ?? '';
    this.elementId = wire.elementId ?? null;
    this.documentIndex = wire.documentIndex ?? null;
  }

  static fromApi(data: unknown): RenderIssue {
    return new RenderIssue(data as RenderIssueWire);
  }

  /** The synthetic issue used for a batch slot left with neither a document nor an issue. */
  static notRendered(documentIndex: number): RenderIssue {
    return new RenderIssue({
      type: 'Unknown',
      severity: 'Error',
      description: 'not rendered',
      documentIndex,
    });
  }

  /** `true` when this issue has `'Error'` severity (blocks the document). */
  get isError(): boolean {
    return this.severity === 'Error';
  }

  toString(): string {
    const location = this.elementId !== null ? ` [${this.elementId}]` : '';
    return `${this.severity}: ${this.type}${location} — ${this.description}`;
  }
}

interface RenderedDocumentFields {
  id: string | null;
  documentName: string;
  templateId: string;
  versionNumber: number;
  environment: string;
  fileSizeBytes: number;
  pageCount: number;
  renderedAt: Date;
  renderDuration: number;
  viewUrl: string | null;
  documentType: string;
  documentBase64: string | null;
  language: string | null;
  documentIndex: number | null;
}

/**
 * A single rendered document returned by the API. `documentBase64` is only
 * populated when the render was requested with `includeDocument: true`;
 * otherwise only metadata (id, name, view URL, etc.) is present.
 */
export class RenderedDocument {
  /**
   * The stored document's id, or `null` when the render was made with
   * `persist: false` — nothing was stored, so there is nothing to reference.
   * Deliberately `null` rather than an empty-string or zero-GUID placeholder,
   * so "not persisted" stays distinguishable from "blank".
   */
  readonly id: string | null;
  /** Generated from the version's document-name template; carries no file extension. */
  readonly documentName: string;
  readonly templateId: string;
  readonly versionNumber: number;
  /** `"test"` or `"production"`, decided by the API key that rendered it. */
  readonly environment: string;
  readonly fileSizeBytes: number;
  readonly pageCount: number;
  readonly renderedAt: Date;
  /** Server-side render time in milliseconds. */
  readonly renderDuration: number;
  /** The document's web-app link, or `null` when the render was not persisted. */
  readonly viewUrl: string | null;
  /** `"Template"` or `"Invoice"`. */
  readonly documentType: string;
  /**
   * The PDF, Base64-encoded. Present when rendered with
   * `includeDocument: true` — and always when `persist: false`, where the
   * server forces it on because the inline bytes are then the only copy.
   */
  readonly documentBase64: string | null;
  /** The language variant the document was rendered in, or `null`. */
  readonly language: string | null;
  /**
   * Zero-based position of this document in the render request's data array,
   * so it can be correlated with the input that produced it; `null` outside a
   * render response (e.g. the document-listing endpoints).
   */
  readonly documentIndex: number | null;

  private constructor(fields: RenderedDocumentFields) {
    this.id = fields.id;
    this.documentName = fields.documentName;
    this.templateId = fields.templateId;
    this.versionNumber = fields.versionNumber;
    this.environment = fields.environment;
    this.fileSizeBytes = fields.fileSizeBytes;
    this.pageCount = fields.pageCount;
    this.renderedAt = fields.renderedAt;
    this.renderDuration = fields.renderDuration;
    this.viewUrl = fields.viewUrl;
    this.documentType = fields.documentType;
    this.documentBase64 = fields.documentBase64;
    this.language = fields.language;
    this.documentIndex = fields.documentIndex;
  }

  static fromApi(data: unknown): RenderedDocument {
    const wire = asRecord(data, 'a rendered document');
    return new RenderedDocument({
      // id/viewUrl come back null for a persist=false render (nothing was
      // stored); everything else the envelope always carries.
      id: optionalString(wire, 'id'),
      documentName: requireField(wire, 'documentName'),
      templateId: requireField(wire, 'templateId'),
      versionNumber: requireField(wire, 'versionNumber'),
      environment: requireField(wire, 'environment'),
      fileSizeBytes: requireField(wire, 'fileSizeBytes'),
      pageCount: requireField(wire, 'pageCount'),
      renderedAt: requireDate(wire, 'renderedAt'),
      renderDuration: requireField(wire, 'renderDuration'),
      viewUrl: optionalString(wire, 'viewUrl'),
      documentType: requireField(wire, 'documentType'),
      documentBase64: optionalString(wire, 'documentBase64'),
      language: optionalString(wire, 'language'),
      documentIndex: typeof wire['documentIndex'] === 'number' ? wire['documentIndex'] : null,
    });
  }

  /** `true` if inline document bytes are available. */
  get hasContent(): boolean {
    return this.documentBase64 !== null;
  }

  /** Returns the decoded document bytes. Only available when rendered with `includeDocument: true`. */
  toBytes(): Uint8Array {
    if (this.documentBase64 === null) {
      throw new Error('This document has no inline content — render with includeDocument: true.');
    }
    return new Uint8Array(Buffer.from(this.documentBase64, 'base64'));
  }

  /** Writes the document to disk. See {@link saveDocumentBytes} for path semantics. */
  save(destinationPath: string): Promise<string> {
    return saveDocumentBytes(destinationPath, this.documentName, this.id, this.toBytes());
  }

  toString(): string {
    return `${this.documentName} (${this.id ?? 'not persisted'})`;
  }
}

/** The raw `{status, documents, issues, ...}` envelope shared by render/batch-render responses. */
interface RenderApiResponseWire {
  status?: string;
  renderedCount?: number;
  requestedCount?: number;
  missingCount?: number;
  message?: string | null;
  documents?: unknown[];
  issues?: unknown[];
}

interface RenderResultFields {
  document: RenderedDocument | null;
  status: string;
  renderedCount: number;
  requestedCount: number;
  missingCount: number;
  message: string | null;
  issues: readonly RenderIssue[];
}

/**
 * Result of a single-document render. `document` is `null` when the
 * document did not render — e.g. it failed validation or the organisation
 * had insufficient credit. Inspect `ok`, `issues` and `status` to find out
 * why. Business outcomes here are data, never exceptions.
 */
export class RenderResult {
  readonly document: RenderedDocument | null;
  readonly status: string;
  readonly renderedCount: number;
  readonly requestedCount: number;
  readonly missingCount: number;
  readonly message: string | null;
  readonly issues: readonly RenderIssue[];

  private constructor(fields: RenderResultFields) {
    this.document = fields.document;
    this.status = fields.status;
    this.renderedCount = fields.renderedCount;
    this.requestedCount = fields.requestedCount;
    this.missingCount = fields.missingCount;
    this.message = fields.message;
    this.issues = fields.issues;
  }

  static fromApi(data: unknown): RenderResult {
    const wire = data as RenderApiResponseWire;
    const documents = wire.documents ?? [];
    const document = documents.length > 0 ? RenderedDocument.fromApi(documents[0]) : null;
    return new RenderResult({
      document,
      status: wire.status ?? 'ok',
      renderedCount: wire.renderedCount ?? (document !== null ? 1 : 0),
      requestedCount: wire.requestedCount ?? 1,
      missingCount: wire.missingCount ?? (document !== null ? 0 : 1),
      message: wire.message ?? null,
      issues: (wire.issues ?? []).map(RenderIssue.fromApi),
    });
  }

  /** `true` when the document rendered successfully. */
  get ok(): boolean {
    return this.document !== null;
  }

  /** `true` when the render stopped because the organisation is out of credit. */
  get insufficientCredit(): boolean {
    return this.status === 'insufficient_credit';
  }

  toString(): string {
    if (this.document !== null) {
      return this.document.toString();
    }
    const errors = this.issues.filter((i) => i.isError).map((i) => i.description);
    const reason =
      errors.length > 0 ? errors.join('; ') : (this.message ?? (this.status || 'not rendered'));
    return `RenderResult FAILED — ${reason}`;
  }
}

/**
 * The outcome of a single document within a batch render. Correlates one
 * submitted input (by position) to its rendered document or the issues that
 * prevented it from rendering.
 */
export class BatchItem {
  readonly index: number;
  /** The originally submitted input for this position, or `null` when inputs were not supplied for correlation. */
  readonly input: unknown | null;
  /** The rendered document for this position, or `null` if it did not render. Populated during correlation. */
  document: RenderedDocument | null;
  /** The issues reported for this document, if any. Populated during correlation. */
  readonly issues: RenderIssue[];

  constructor(index: number, input: unknown | null) {
    this.index = index;
    this.input = input;
    this.document = null;
    this.issues = [];
  }

  /** `true` when this document rendered successfully. */
  get ok(): boolean {
    return this.document !== null;
  }

  toString(): string {
    if (this.document !== null) {
      return `[${this.index}] OK — ${this.document.documentName}`;
    }
    const errors = this.issues.filter((i) => i.isError).map((i) => i.description);
    const reason = errors.length > 0 ? errors.join('; ') : 'not rendered';
    return `[${this.index}] FAILED — ${reason}`;
  }
}

interface BatchRenderResultFields {
  items: readonly BatchItem[];
  status: string;
  message: string | null;
  requestedCount: number;
  renderedCount: number;
  missingCount: number;
}

/**
 * Result of a synchronous batch render. Iterable over the per-input
 * {@link BatchItem}s: each submitted document is correlated (by the
 * `documentIndex` the server reports on it) to its rendered document or the
 * errors that prevented it from rendering.
 *
 * `missingCount` is `requestedCount - renderedCount` — that subtraction *is*
 * its definition, so it is computed here rather than read from the response,
 * and {@link BatchRenderResult.ok} is derived from it.
 */
export class BatchRenderResult implements Iterable<BatchItem> {
  readonly items: readonly BatchItem[];
  readonly status: string;
  readonly message: string | null;
  readonly requestedCount: number;
  readonly renderedCount: number;
  readonly missingCount: number;

  private cachedSucceeded: readonly BatchItem[] | undefined;
  private cachedFailed: readonly BatchItem[] | undefined;
  private cachedDocuments: readonly RenderedDocument[] | undefined;

  private constructor(fields: BatchRenderResultFields) {
    this.items = fields.items;
    this.status = fields.status;
    this.message = fields.message;
    this.requestedCount = fields.requestedCount;
    this.renderedCount = fields.renderedCount;
    this.missingCount = fields.missingCount;
  }

  /**
   * Builds a result from the API response, correlating inputs to outcomes.
   * The API returns a flat `documents[]` and a flat `issues[]` list. Each
   * rendered document now carries its own `documentIndex`, so it is placed at
   * exactly the slot for the input that produced it — no positional guessing.
   * Each issue likewise attaches to its item via `documentIndex` (batch-wide
   * issues, whose `documentIndex` is `null`/omitted, attach to every item).
   * That index is the only correlation: a document whose index is absent or
   * out of range is dropped, never guessed onto a slot by position. A slot
   * that ends up with neither a document nor an issue is marked failed with a
   * synthetic "not rendered" issue.
   */
  static fromApi(data: unknown, inputs?: readonly unknown[]): BatchRenderResult {
    const wire = data as RenderApiResponseWire;
    const status = wire.status ?? 'ok';
    const message = wire.message ?? null;

    const docs = (wire.documents ?? []).map(RenderedDocument.fromApi);
    const allIssues = (wire.issues ?? []).map(RenderIssue.fromApi);

    // Falsy-fallback (not nullish, on purpose): a literal `requestedCount: 0`
    // from the server falls through to the inputs/documents-derived count.
    const requestedCountRaw = wire.requestedCount ?? 0;
    const n = requestedCountRaw !== 0 ? requestedCountRaw : (inputs?.length ?? docs.length);

    const items: BatchItem[] = [];
    for (let i = 0; i < n; i++) {
      items.push(new BatchItem(i, inputs && i < inputs.length ? inputs[i] : null));
    }

    // Distribute issues to their document. Batch-wide issues (documentIndex
    // null/omitted) attach to every item — checked with `== null` so an
    // omitted key (`undefined` after JSON.parse) is treated the same as an
    // explicit `null`.
    for (const issue of allIssues) {
      if (issue.documentIndex == null) {
        for (const item of items) {
          item.issues.push(issue);
        }
      } else if (issue.documentIndex >= 0 && issue.documentIndex < items.length) {
        items[issue.documentIndex].issues.push(issue);
      }
      // An out-of-range documentIndex is silently dropped, never thrown or misfiled.
    }

    // Place each rendered document at the slot it reports via documentIndex.
    // The API guarantees that index on every document, and it is the only
    // correlation: a document whose index is absent or out of range is
    // dropped, never guessed onto a slot by position.
    for (const doc of docs) {
      const idx = doc.documentIndex;
      if (idx !== null && idx >= 0 && idx < items.length) {
        items[idx].document = doc;
      }
    }

    // Anything left without a document or a reason is a silent render failure.
    for (const item of items) {
      if (item.document === null && item.issues.length === 0) {
        item.issues.push(RenderIssue.notRendered(item.index));
      }
    }

    const renderedCountRaw = wire.renderedCount ?? 0;
    const requestedCount = requestedCountRaw !== 0 ? requestedCountRaw : n;
    const renderedCount = renderedCountRaw !== 0 ? renderedCountRaw : docs.length;
    return new BatchRenderResult({
      items,
      status,
      message,
      requestedCount,
      renderedCount,
      // By definition, not a value read from the response — see the class
      // doc. Clamped at 0 so a server sending rendered > requested can never
      // produce a negative count.
      missingCount: Math.max(0, requestedCount - renderedCount),
    });
  }

  /** The items that rendered successfully. */
  get succeeded(): readonly BatchItem[] {
    if (this.cachedSucceeded === undefined) {
      this.cachedSucceeded = this.items.filter((item) => item.ok);
    }
    return this.cachedSucceeded;
  }

  /** The items that failed to render. */
  get failed(): readonly BatchItem[] {
    if (this.cachedFailed === undefined) {
      this.cachedFailed = this.items.filter((item) => !item.ok);
    }
    return this.cachedFailed;
  }

  /** All successfully rendered documents. */
  get documents(): readonly RenderedDocument[] {
    if (this.cachedDocuments === undefined) {
      this.cachedDocuments = this.items
        .filter(
          (item): item is BatchItem & { document: RenderedDocument } => item.document !== null,
        )
        .map((item) => item.document);
    }
    return this.cachedDocuments;
  }

  /** `true` when the batch stopped because the organisation is out of credit. */
  get insufficientCredit(): boolean {
    return this.status === 'insufficient_credit';
  }

  /** `true` when every requested document rendered and credit was sufficient. */
  get ok(): boolean {
    return this.missingCount === 0 && !this.insufficientCredit;
  }

  [Symbol.iterator](): Iterator<BatchItem> {
    return this.items[Symbol.iterator]();
  }

  /** Writes every rendered document (that carries inline content) to a directory; created if missing. */
  async saveAll(directory: string): Promise<string[]> {
    await mkdir(directory, { recursive: true });
    const written: string[] = [];
    for (const item of this.items) {
      if (item.document?.hasContent) {
        written.push(await item.document.save(directory));
      }
    }
    return written;
  }
}

/**
 * Lifecycle state of an async render job.
 *
 * `'queued'` (just enqueued) and `'pending'` (queued or rendering) are
 * non-terminal; `'completed'` (documents produced, including partial/
 * credit-stopped runs) and `'failed'` (nothing produced) are terminal.
 * `'unknown'` is a client-side fail-open fallback, not a server value: an
 * unrecognised state parses to it rather than throwing, and is treated as
 * terminal (see {@link isRenderJobStateTerminal}) so a new server state can
 * never trap a `while (!done)` poll loop in an infinite wait.
 */
export type RenderJobState = 'queued' | 'pending' | 'completed' | 'failed' | 'unknown';

const RENDER_JOB_STATES: readonly RenderJobState[] = [
  'queued',
  'pending',
  'completed',
  'failed',
  'unknown',
];

/** Parses the API's string value case-insensitively; unknown/missing values fail OPEN to `'unknown'`. */
export function parseRenderJobState(value: unknown): RenderJobState {
  if (typeof value === 'string') {
    const match = RENDER_JOB_STATES.find((s) => s.toLowerCase() === value.toLowerCase());
    if (match) {
      return match;
    }
  }
  return 'unknown';
}

/**
 * Whether a job has stopped advancing. `'unknown'` counts as terminal
 * (fail-open) so an unrecognised server state ends a poll loop rather than
 * spinning forever.
 */
export function isRenderJobStateTerminal(state: RenderJobState): boolean {
  return state !== 'queued' && state !== 'pending';
}

/**
 * Render outcome of a job/callback, mirroring the sync envelope's status
 * vocabulary. `null` (not this type) is used while a job is still pending;
 * once decided it is one of these. `'unknown'` is a client-side fail-open
 * fallback for an unrecognised server value, so new outcomes never crash an
 * older client.
 */
export type RenderOutcome = 'ok' | 'partial' | 'failed' | 'insufficient_credit' | 'unknown';

const RENDER_OUTCOMES: readonly RenderOutcome[] = [
  'ok',
  'partial',
  'failed',
  'insufficient_credit',
  'unknown',
];

/** Parses the API's string value case-insensitively; unknown/missing values fail OPEN to `'unknown'`. */
export function parseRenderOutcome(value: unknown): RenderOutcome {
  if (typeof value === 'string') {
    const match = RENDER_OUTCOMES.find((o) => o.toLowerCase() === value.toLowerCase());
    if (match) {
      return match;
    }
  }
  return 'unknown';
}

interface RenderJobWire {
  jobId?: string;
  requestedCount?: number;
  state?: string;
}

/** A reference to an enqueued async render job, returned by `enqueueBatchRender`. */
export class RenderJob {
  readonly jobId: string;
  /** Number of documents the job was enqueued to render. */
  readonly requestedCount: number;
  /** Job lifecycle state, normally `'queued'` on creation. */
  readonly state: RenderJobState;

  private constructor(wire: RenderJobWire) {
    this.jobId = wire.jobId ?? '';
    this.requestedCount = wire.requestedCount ?? 0;
    this.state = parseRenderJobState(wire.state);
  }

  static fromApi(data: unknown): RenderJob {
    return new RenderJob(data as RenderJobWire);
  }

  toString(): string {
    return `RenderJob ${this.jobId} — ${this.requestedCount} doc(s), state=${this.state}`;
  }
}

interface RenderJobStatusWire {
  jobId?: string;
  state?: string;
  status?: string | null;
  renderedCount?: number;
  requestedCount?: number;
  missingCount?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  failureReason?: string | null;
  issues?: unknown[];
}

interface RenderJobStatusFields {
  jobId: string;
  state: RenderJobState;
  status: RenderOutcome | null;
  renderedCount: number;
  requestedCount: number;
  missingCount: number;
  startedAt: Date | null;
  completedAt: Date | null;
  failureReason: string | null;
  issues: readonly RenderIssue[];
}

/**
 * Status of an async render job, returned by the polling endpoint
 * `getJobStatus`. Lifecycle (`state`) and outcome (`status`) are separate
 * fields: poll until `done`, then check `ok` / `failureReason`. A reliable
 * alternative to webhook callbacks.
 */
export class RenderJobStatus {
  readonly jobId: string;
  /** Job lifecycle: `'pending'`/`'completed'`/`'failed'` (or `'unknown'`). */
  readonly state: RenderJobState;
  /** Render outcome (same vocabulary as the sync envelope), or `null` while pending. */
  readonly status: RenderOutcome | null;
  /** Number of documents rendered so far. */
  readonly renderedCount: number;
  readonly requestedCount: number;
  readonly missingCount: number;
  /** When the job began processing, or `null` while still queued. */
  readonly startedAt: Date | null;
  /** When the job finished, or `null` while still running. */
  readonly completedAt: Date | null;
  /** Failure detail, populated only when the job failed. */
  readonly failureReason: string | null;
  /** Per-document diagnostics (capped at 100 server-side); the counts stay exact. */
  readonly issues: readonly RenderIssue[];

  private constructor(fields: RenderJobStatusFields) {
    this.jobId = fields.jobId;
    this.state = fields.state;
    this.status = fields.status;
    this.renderedCount = fields.renderedCount;
    this.requestedCount = fields.requestedCount;
    this.missingCount = fields.missingCount;
    this.startedAt = fields.startedAt;
    this.completedAt = fields.completedAt;
    this.failureReason = fields.failureReason;
    this.issues = fields.issues;
  }

  static fromApi(data: unknown): RenderJobStatus {
    const wire = data as RenderJobStatusWire;
    const rawStatus = wire.status;
    return new RenderJobStatus({
      jobId: wire.jobId ?? '',
      state: parseRenderJobState(wire.state),
      // null (not 'unknown') while the job is pending and has no outcome yet.
      status: rawStatus !== undefined && rawStatus !== null ? parseRenderOutcome(rawStatus) : null,
      renderedCount: wire.renderedCount ?? 0,
      requestedCount: wire.requestedCount ?? 0,
      missingCount: wire.missingCount ?? 0,
      startedAt: parseDate(wire.startedAt),
      completedAt: parseDate(wire.completedAt),
      failureReason: wire.failureReason ?? null,
      issues: (wire.issues ?? []).map(RenderIssue.fromApi),
    });
  }

  /**
   * `true` once the job reached a terminal state. `'unknown'` counts as
   * terminal (fail-open), so an unrecognised server state ends a
   * `while (!status.done)` poll loop rather than spinning forever.
   */
  get done(): boolean {
    return isRenderJobStateTerminal(this.state);
  }

  /** `true` when the job completed and every document rendered. */
  get ok(): boolean {
    return this.state === 'completed' && this.status === 'ok';
  }

  /** `true` when the job stopped early because the organisation ran out of credit. */
  get insufficientCredit(): boolean {
    return this.status === 'insufficient_credit';
  }

  toString(): string {
    return `RenderJobStatus ${this.jobId} — state=${this.state} status=${this.status} (${this.renderedCount} rendered)`;
  }
}

/**
 * Extracts a bare document name (no `.pdf`) from a `Content-Disposition` header.
 *
 * The `filename=` marker is matched case-insensitively: HTTP header parameter
 * names are case-insensitive (RFC 6266), so a `Filename=` would otherwise fall
 * back to `'document'` and silently lose the name. All six SDKs match this way.
 */
function filenameFromContentDisposition(header: string | null): string {
  if (header) {
    const marker = 'filename=';
    const at = header.toLowerCase().indexOf(marker);
    if (at !== -1) {
      let name = header
        .slice(at + marker.length)
        .split(';')[0]
        .trim();
      name = name.replace(/^"+|"+$/g, '');
      if (name.toLowerCase().endsWith('.pdf')) {
        name = name.slice(0, -4);
      }
      if (name) {
        return name;
      }
    }
  }
  return 'document';
}

interface PdfDocumentFields {
  documentName: string;
  content: Uint8Array;
  documentId: string | null;
  pageCount: number;
  renderDuration: number;
  viewUrl: string | null;
  issueCount: number;
}

/**
 * A single document returned as a raw PDF stream, produced only by
 * `PagrApiClient.renderPdf` (the opt-in `Accept: application/pdf` path).
 * Unlike {@link RenderedDocument} (built from the JSON envelope), this carries
 * only what the raw-PDF response provides — the bytes plus the metadata the
 * server puts in `X-Pagr-*` headers. `documentId`/`viewUrl` are `null` when
 * the render was not persisted (`persist: false`).
 */
export class PdfDocument {
  readonly documentName: string;
  readonly content: Uint8Array;
  readonly documentId: string | null;
  readonly pageCount: number;
  readonly renderDuration: number;
  readonly viewUrl: string | null;
  readonly issueCount: number;

  private constructor(fields: PdfDocumentFields) {
    this.documentName = fields.documentName;
    this.content = fields.content;
    this.documentId = fields.documentId;
    this.pageCount = fields.pageCount;
    this.renderDuration = fields.renderDuration;
    this.viewUrl = fields.viewUrl;
    this.issueCount = fields.issueCount;
  }

  /**
   * Builds a `PdfDocument` from a raw `application/pdf` response, reading the
   * document metadata out of its `X-Pagr-*` headers and the name from
   * `Content-Disposition`.
   */
  static fromResponse(raw: RawResponse): PdfDocument {
    const intHeader = (name: string): number => {
      const value = raw.header(name);
      const parsed = value !== null ? Number.parseInt(value, 10) : NaN;
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const floatHeader = (name: string): number => {
      const value = raw.header(name);
      const parsed = value !== null ? Number.parseFloat(value) : NaN;
      return Number.isFinite(parsed) ? parsed : 0;
    };
    // `Headers.get` returns `''` — not `null` — for a present-but-empty header, and a
    // non-persisted render's id/viewUrl are `null`, never `''`: absent and empty must
    // be indistinguishable to the caller.
    const optionalHeader = (name: string): string | null => raw.header(name) || null;
    return new PdfDocument({
      documentName: filenameFromContentDisposition(raw.header('Content-Disposition')),
      content: raw.bytes,
      documentId: optionalHeader('X-Pagr-Document-Id'),
      pageCount: intHeader('X-Pagr-Page-Count'),
      renderDuration: floatHeader('X-Pagr-Render-Duration-Ms'),
      viewUrl: optionalHeader('X-Pagr-View-Url'),
      issueCount: intHeader('X-Pagr-Issue-Count'),
    });
  }

  /** Returns the PDF bytes. */
  toBytes(): Uint8Array {
    return this.content;
  }

  /** Writes the PDF to disk. See {@link saveDocumentBytes} for path semantics. */
  save(destinationPath: string): Promise<string> {
    return saveDocumentBytes(
      destinationPath,
      this.documentName,
      this.documentId ?? '',
      this.content,
    );
  }

  toString(): string {
    return `${this.documentName} (${this.documentId ?? 'not persisted'})`;
  }
}

interface PdfRenderResultFields {
  document: PdfDocument | null;
  status: string;
  message: string | null;
  issues: readonly RenderIssue[];
}

/**
 * Result of a `PagrApiClient.renderPdf` call. `document` is the rendered
 * {@link PdfDocument} on success, or `null` when the render was blocked/failed
 * — inspect `issues` and `status` for why (a business outcome, not an
 * exception). `status` is one of `'ok'`, `'partial'`, `'failed'` or
 * `'insufficient_credit'`.
 */
export class PdfRenderResult {
  readonly document: PdfDocument | null;
  readonly status: string;
  readonly message: string | null;
  readonly issues: readonly RenderIssue[];

  private constructor(fields: PdfRenderResultFields) {
    this.document = fields.document;
    this.status = fields.status;
    this.message = fields.message;
    this.issues = fields.issues;
  }

  /** `true` when a rendered PDF came back. */
  get ok(): boolean {
    return this.document !== null;
  }

  /** `true` when the render was blocked for lack of credit. */
  get insufficientCredit(): boolean {
    return this.status === 'insufficient_credit';
  }

  /** Wraps a successfully streamed PDF. */
  static ofDocument(document: PdfDocument): PdfRenderResult {
    return new PdfRenderResult({ document, status: 'ok', message: null, issues: [] });
  }

  /**
   * Builds a failed result from the JSON envelope the API returns (with HTTP
   * 422) when there is no PDF to stream.
   */
  static fromErrorEnvelope(data: unknown): PdfRenderResult {
    const wire = data as { status?: string; message?: string | null; issues?: unknown[] };
    return new PdfRenderResult({
      document: null,
      status: wire.status ?? 'failed',
      message: wire.message ?? null,
      issues: (wire.issues ?? []).map(RenderIssue.fromApi),
    });
  }

  toString(): string {
    if (this.document !== null) {
      return this.document.toString();
    }
    const errors = this.issues.filter((i) => i.isError).map((i) => i.description);
    const reason =
      errors.length > 0 ? errors.join('; ') : (this.message ?? (this.status || 'failed'));
    return `PdfRenderResult FAILED — ${reason}`;
  }
}
