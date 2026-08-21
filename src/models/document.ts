import {
  asRecord,
  optionalString,
  requireDate,
  requireField,
  saveDocumentBytes,
} from './_common.js';

interface PagedResultWire {
  items?: unknown[];
  total?: number;
  skip?: number;
  take?: number;
}

/**
 * A page of results returned by a list endpoint. Iterable over {@link items}.
 * `total` is the total number of matching records across all pages, not just
 * this page; use {@link hasMore} to drive `skip`/`take` paging.
 */
export class PagedResult<T> implements Iterable<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly skip: number;
  readonly take: number;

  private constructor(items: readonly T[], total: number, skip: number, take: number) {
    this.items = items;
    this.total = total;
    this.skip = skip;
    this.take = take;
  }

  /**
   * Parses the API's `{items,total,skip,take}` object, mapping each item with
   * `itemFactory`.
   *
   * An absent `total`/`take` defaults to `0`, not to `items.length`: on a
   * truncated response, defaulting `total` to the page size makes `hasMore`
   * report `false` and quietly ends the caller's paging loop early. `0` is
   * Python's default and the shared reference behaviour.
   */
  static fromApi<T>(data: unknown, itemFactory: (raw: unknown) => T): PagedResult<T> {
    const wire = data as PagedResultWire;
    const items = (wire.items ?? []).map(itemFactory);
    return new PagedResult<T>(items, wire.total ?? 0, wire.skip ?? 0, wire.take ?? 0);
  }

  /** `true` when more pages follow this one. */
  get hasMore(): boolean {
    return this.skip + this.items.length < this.total;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.items[Symbol.iterator]();
  }

  toString(): string {
    return `PagedResult[${this.items.length} of ${this.total}, skip=${this.skip}, take=${this.take}]`;
  }
}

interface RenderDocumentFields {
  id: string;
  documentName: string;
  templateId: string;
  versionNumber: number;
  environment: string;
  fileSizeBytes: number;
  pageCount: number;
  renderedAt: Date;
  renderDuration: number;
  viewUrl: string;
  documentType: string;
  isPdfDeleted: boolean;
  language: string | null;
  documentBase64: string | null;
}

/**
 * Metadata for a persisted rendered document, as returned by the
 * document-browsing endpoints (`getDocuments`/`getDocument`).
 * `documentBase64` contains the PDF bytes only when the document was
 * rendered with `includeDocument: true`; otherwise call `downloadDocument`
 * to fetch them separately.
 *
 * These endpoints only ever list documents the API actually stored, so
 * `id`/`viewUrl` are always real here — unlike `RenderedDocument`, where a
 * non-persisted render leaves both `null`.
 */
export class RenderDocument {
  readonly id: string;
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
  readonly viewUrl: string;
  /** `"Template"` or `"Invoice"`. */
  readonly documentType: string;
  /**
   * `true` once the stored PDF has been purged by retention; this metadata
   * stays available, but `downloadDocument` then fails with HTTP 410
   * (`code === 'PdfDeleted'`).
   */
  readonly isPdfDeleted: boolean;
  readonly language: string | null;
  readonly documentBase64: string | null;

  private constructor(fields: RenderDocumentFields) {
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
    this.isPdfDeleted = fields.isPdfDeleted;
    this.language = fields.language;
    this.documentBase64 = fields.documentBase64;
  }

  static fromApi(data: unknown): RenderDocument {
    const wire = asRecord(data, 'a document');
    return new RenderDocument({
      id: requireField(wire, 'id'),
      documentName: requireField(wire, 'documentName'),
      templateId: requireField(wire, 'templateId'),
      versionNumber: requireField(wire, 'versionNumber'),
      environment: requireField(wire, 'environment'),
      fileSizeBytes: requireField(wire, 'fileSizeBytes'),
      pageCount: requireField(wire, 'pageCount'),
      renderedAt: requireDate(wire, 'renderedAt'),
      renderDuration: requireField(wire, 'renderDuration'),
      viewUrl: requireField(wire, 'viewUrl'),
      documentType: requireField(wire, 'documentType'),
      isPdfDeleted: wire['isPdfDeleted'] === true,
      language: optionalString(wire, 'language'),
      documentBase64: optionalString(wire, 'documentBase64'),
    });
  }

  /** `true` if inline document bytes are available. */
  get hasContent(): boolean {
    return this.documentBase64 !== null;
  }

  /** Returns the decoded document bytes. Only available when rendered with `includeDocument: true`. */
  toBytes(): Uint8Array {
    if (this.documentBase64 === null) {
      throw new Error('This document has no inline content — fetch it with downloadDocument().');
    }
    return new Uint8Array(Buffer.from(this.documentBase64, 'base64'));
  }

  /** Writes the document to disk. See {@link saveDocumentBytes} for path semantics. */
  save(destinationPath: string): Promise<string> {
    return saveDocumentBytes(destinationPath, this.documentName, this.id, this.toBytes());
  }

  toString(): string {
    return `${this.documentName} (${this.id})`;
  }
}
