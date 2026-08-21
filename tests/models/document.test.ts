import { describe, expect, it } from 'vitest';
import { PagrDecodeError } from '../../src/errors.js';
import { PagedResult, RenderDocument } from '../../src/models/document.js';

/** A complete document payload; spread it and override only what a test cares about. */
function docNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    documentName: 'Invoice',
    templateId: 'tmpl-1',
    versionNumber: 3,
    environment: 'production',
    fileSizeBytes: 1024,
    pageCount: 2,
    renderedAt: '2024-01-01T12:00:00Z',
    renderDuration: 42.5,
    viewUrl: 'https://example.test/view',
    documentType: 'Template',
    ...overrides,
  };
}

describe('PagedResult', () => {
  it('defaults total/skip/take to 0 when the response omits them, not to the page size', () => {
    // A truncated response that omits total must not report total === items.length: hasMore
    // would then read false and quietly end the caller's paging loop. 0 is Python's default.
    const page = PagedResult.fromApi(
      { items: [{ n: 1 }, { n: 2 }] },
      (raw) => (raw as { n: number }).n,
    );
    expect(page.items).toEqual([1, 2]);
    expect(page.total).toBe(0);
    expect(page.skip).toBe(0);
    expect(page.take).toBe(0);
  });

  it('exposes explicit total/skip/take and hasMore', () => {
    const page = PagedResult.fromApi(
      { items: [{ n: 1 }], total: 10, skip: 0, take: 1 },
      (raw) => (raw as { n: number }).n,
    );
    expect(page.hasMore).toBe(true);
  });

  it('hasMore is false on the last page', () => {
    const page = PagedResult.fromApi(
      { items: [{ n: 1 }], total: 1, skip: 0, take: 1 },
      (raw) => (raw as { n: number }).n,
    );
    expect(page.hasMore).toBe(false);
  });

  it('is iterable via for...of', () => {
    const page = PagedResult.fromApi(
      { items: [{ n: 1 }, { n: 2 }] },
      (raw) => (raw as { n: number }).n,
    );
    expect([...page]).toEqual([1, 2]);
  });

  it('defaults to an empty page when items is missing', () => {
    const page = PagedResult.fromApi({}, (raw) => raw);
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });
});

describe('RenderDocument', () => {
  it('parses full metadata including isPdfDeleted', () => {
    const doc = RenderDocument.fromApi(
      docNode({ isPdfDeleted: true, language: 'nl', documentBase64: null }),
    );
    expect(doc.documentName).toBe('Invoice');
    expect(doc.isPdfDeleted).toBe(true);
    expect(doc.hasContent).toBe(false);
    expect(doc.language).toBe('nl');
    expect(doc.documentType).toBe('Template');
    expect(doc.renderedAt.getTime()).toBe(Date.parse('2024-01-01T12:00:00Z'));
  });

  it('defaults isPdfDeleted/language/documentBase64 when the body omits them', () => {
    const doc = RenderDocument.fromApi(docNode());
    expect(doc.isPdfDeleted).toBe(false);
    expect(doc.language).toBeNull();
    expect(doc.documentBase64).toBeNull();
  });

  it('decodes documentBase64 via toBytes when present', () => {
    const base64 = Buffer.from('%PDF-1.7 fake').toString('base64');
    const doc = RenderDocument.fromApi(docNode({ documentBase64: base64 }));
    expect(doc.hasContent).toBe(true);
    expect(Buffer.from(doc.toBytes()).toString()).toBe('%PDF-1.7 fake');
  });

  it('toBytes throws when there is no inline content', () => {
    const doc = RenderDocument.fromApi(docNode());
    expect(() => doc.toBytes()).toThrow();
  });

  it('throws PagrDecodeError rather than defaulting a missing required field', () => {
    // A truncated response must not decode into a document full of ''/0.
    for (const key of [
      'id',
      'documentName',
      'templateId',
      'versionNumber',
      'environment',
      'fileSizeBytes',
      'pageCount',
      'renderedAt',
      'renderDuration',
      'viewUrl',
      'documentType',
    ]) {
      const payload: Record<string, unknown> = docNode();
      delete payload[key];
      expect(() => RenderDocument.fromApi(payload), `omitting ${key}`).toThrow(PagrDecodeError);
    }
  });

  it('throws PagrDecodeError for an explicit null in a required field', () => {
    expect(() => RenderDocument.fromApi(docNode({ documentName: null }))).toThrow(PagrDecodeError);
  });

  it('throws PagrDecodeError when the payload is not a JSON object', () => {
    expect(() => RenderDocument.fromApi('nope')).toThrow(PagrDecodeError);
    expect(() => RenderDocument.fromApi(null)).toThrow(PagrDecodeError);
    expect(() => RenderDocument.fromApi([])).toThrow(PagrDecodeError);
  });

  it('throws PagrDecodeError for an unparseable required timestamp', () => {
    expect(() => RenderDocument.fromApi(docNode({ renderedAt: 'not-a-date' }))).toThrow(
      PagrDecodeError,
    );
  });
});
