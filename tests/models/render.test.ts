import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PagrDecodeError } from '../../src/errors.js';
import { RawResponse } from '../../src/http.js';
import {
  BatchRenderResult,
  PdfDocument,
  PdfRenderResult,
  RenderIssue,
  RenderJob,
  RenderJobStatus,
  RenderResult,
  RenderedDocument,
  isRenderIssueSeverityAtLeast,
  isRenderIssueSeverityBlockingProduction,
  isRenderJobStateTerminal,
  parseRenderIssueSeverity,
  parseRenderIssueType,
  parseRenderJobState,
  parseRenderOutcome,
} from '../../src/models/render.js';

function docNode(name: string, documentIndex?: number) {
  return {
    id: `doc-${name}`,
    documentName: name,
    templateId: 'tmpl-1',
    versionNumber: 1,
    environment: 'test',
    fileSizeBytes: 100,
    pageCount: 1,
    renderedAt: '2024-01-01T00:00:00Z',
    renderDuration: 10,
    viewUrl: 'https://example.test',
    documentType: 'pdf',
    ...(documentIndex === undefined ? {} : { documentIndex }),
  };
}

function issueNode(
  severity: string,
  type: string,
  description: string,
  documentIndex: number | null = null,
  elementId: string | null = null,
) {
  return { type, severity, description, documentIndex, elementId };
}

describe('RenderIssue enum parsing (forward-compatibility)', () => {
  it('parseRenderIssueType fails OPEN to Unknown for unrecognized values', () => {
    expect(parseRenderIssueType('BrandNewServerThing')).toBe('Unknown');
    expect(parseRenderIssueType(null)).toBe('Unknown');
    expect(parseRenderIssueType(undefined)).toBe('Unknown');
  });

  it('parseRenderIssueType matches case-insensitively', () => {
    expect(parseRenderIssueType('schemainvalid')).toBe('SchemaInvalid');
  });

  it('parseRenderIssueSeverity fails CLOSED to Error for unrecognized/missing values', () => {
    expect(parseRenderIssueSeverity('Catastrophic')).toBe('Error');
    expect(parseRenderIssueSeverity(null)).toBe('Error');
    expect(parseRenderIssueSeverity(undefined)).toBe('Error');
  });

  it('isRenderIssueSeverityAtLeast orders Information < Warning < Error by explicit rank, not alphabetically', () => {
    expect(isRenderIssueSeverityAtLeast('Error', 'Warning')).toBe(true);
    expect(isRenderIssueSeverityAtLeast('Warning', 'Warning')).toBe(true);
    expect(isRenderIssueSeverityAtLeast('Information', 'Warning')).toBe(false);
    expect(isRenderIssueSeverityAtLeast('Warning', 'Error')).toBe(false);
  });

  it('isRenderIssueSeverityBlockingProduction is true for Warning/Error, false for Information', () => {
    expect(isRenderIssueSeverityBlockingProduction('Warning')).toBe(true);
    expect(isRenderIssueSeverityBlockingProduction('Error')).toBe(true);
    expect(isRenderIssueSeverityBlockingProduction('Information')).toBe(false);
  });

  it('RenderIssue.fromApi parses a well-formed issue', () => {
    const issue = RenderIssue.fromApi(
      issueNode('Warning', 'MissingBinding', 'customerName not bound', 2, 'e1'),
    );
    expect(issue.type).toBe('MissingBinding');
    expect(issue.severity).toBe('Warning');
    expect(issue.description).toBe('customerName not bound');
    expect(issue.elementId).toBe('e1');
    expect(issue.documentIndex).toBe(2);
    expect(issue.isError).toBe(false);
  });
});

describe('RenderResult', () => {
  it('reads issues and counts as provided', () => {
    const result = RenderResult.fromApi({
      status: 'ok',
      requestedCount: 1,
      renderedCount: 0,
      missingCount: 1,
      documents: [],
      issues: [issueNode('Error', 'SchemaInvalid', 'bad')],
    });
    expect(result.ok).toBe(false);
    expect(result.missingCount).toBe(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.isError).toBe(true);
  });

  it('infers missing counts when the body omits them', () => {
    const withDoc = RenderResult.fromApi({ status: 'ok', documents: [docNode('Doc')] });
    expect(withDoc.renderedCount).toBe(1);
    expect(withDoc.requestedCount).toBe(1);
    expect(withDoc.missingCount).toBe(0);

    const empty = RenderResult.fromApi({ status: 'failed', documents: [] });
    expect(empty.renderedCount).toBe(0);
    expect(empty.missingCount).toBe(1);
  });

  it('surfaces insufficient_credit as data, not an exception', () => {
    const result = RenderResult.fromApi({
      status: 'insufficient_credit',
      message: 'out of credit',
      documents: [],
    });
    expect(result.insufficientCredit).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.message).toBe('out of credit');
  });
});

describe('RenderedDocument', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pagr-sdk-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('has no raw-bytes factory — there is no way to fabricate a document', () => {
    // `RenderedDocument` is only ever built from the JSON envelope. A
    // `fromPdfBytes` factory existed to back `render`'s content-type sniff and
    // filled templateId/environment with '' to do it, which
    // parity-contract.md §1 and CLAUDE.md both forbid. Both are gone.
    expect('fromPdfBytes' in RenderedDocument).toBe(false);
    expect('ofDocument' in RenderResult).toBe(false);
  });

  it('leaves id/viewUrl null for a non-persisted render instead of blanking them', () => {
    // persist=false: the server returns the envelope with id/viewUrl null.
    const doc = RenderedDocument.fromApi({ ...docNode('Draft'), id: null, viewUrl: null });
    expect(doc.id).toBeNull();
    expect(doc.viewUrl).toBeNull();
    expect(doc.documentName).toBe('Draft');
    expect(String(doc)).toBe('Draft (not persisted)');
  });

  it('throws PagrDecodeError rather than defaulting a missing required field', () => {
    for (const key of [
      'documentName',
      'templateId',
      'versionNumber',
      'environment',
      'fileSizeBytes',
      'pageCount',
      'renderedAt',
      'renderDuration',
      'documentType',
    ]) {
      const payload: Record<string, unknown> = docNode('Doc');
      delete payload[key];
      expect(() => RenderedDocument.fromApi(payload), `omitting ${key}`).toThrow(PagrDecodeError);
    }
  });

  it('save() writes bytes to disk and returns the path', async () => {
    const doc = RenderedDocument.fromApi({
      ...docNode('Report'),
      documentBase64: Buffer.from('%PDF-1.7 fake').toString('base64'),
    });
    const written = await doc.save(dir);
    expect(written).toBe(join(dir, 'Report.pdf'));
  });

  it('save() still appends .pdf when the document name ends in a numeric segment', async () => {
    // 'Invoice 2024.10' has a path-style extension of '.10' — it is not a PDF
    // extension, so the file must still be written as 'Invoice 2024.10.pdf'.
    const doc = RenderedDocument.fromApi({
      ...docNode('Invoice 2024.10'),
      documentBase64: Buffer.from('%PDF-1.7 fake').toString('base64'),
    });
    const written = await doc.save(dir);
    expect(written).toBe(join(dir, 'Invoice 2024.10.pdf'));
  });
});

describe('BatchRenderResult.fromApi correlation', () => {
  it('all documents succeed', () => {
    const result = BatchRenderResult.fromApi({
      status: 'ok',
      renderedCount: 2,
      requestedCount: 2,
      missingCount: 0,
      documents: [docNode('Doc 0', 0), docNode('Doc 1', 1)],
    });
    expect(result.ok).toBe(true);
    expect(result.succeeded).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.documents.map((d) => d.documentName)).toEqual(['Doc 0', 'Doc 1']);
  });

  it('an Error-severity issue attaches to its slot; documents land on the index they report', () => {
    const inputs = [{ Title: 'Doc 0' }, { Title: 'Doc 1' }, { Title: 'Doc 2' }];
    const result = BatchRenderResult.fromApi(
      {
        status: 'ok',
        renderedCount: 2,
        requestedCount: 3,
        missingCount: 1,
        documents: [docNode('Doc 0', 0), docNode('Doc 2', 2)],
        issues: [issueNode('Error', 'SchemaInvalid', 'bad field', 1)],
      },
      inputs,
    );

    expect(result.items).toHaveLength(3);
    expect(result.ok).toBe(false);

    expect(result.items[1]?.ok).toBe(false);
    expect(result.items[1]?.issues).toHaveLength(1);
    expect(result.items[1]?.issues[0]?.description).toBe('bad field');
    expect(result.items[1]?.input).toEqual({ Title: 'Doc 1' });

    expect(result.items[0]?.document?.documentName).toBe('Doc 0');
    expect(result.items[2]?.document?.documentName).toBe('Doc 2');
    expect(result.failed.map((it) => it.index)).toEqual([1]);
  });

  it('a batch-wide issue (documentIndex null) attaches to every item', () => {
    const result = BatchRenderResult.fromApi({
      status: 'ok',
      requestedCount: 2,
      documents: [docNode('Doc 0', 0), docNode('Doc 1', 1)],
      issues: [issueNode('Information', 'Unknown', 'org-wide notice', null)],
    });
    expect(result.items[0]?.issues).toHaveLength(1);
    expect(result.items[1]?.issues).toHaveLength(1);
    // Information severity doesn't mark a slot failed.
    expect(result.items[0]?.ok).toBe(true);
    expect(result.items[1]?.ok).toBe(true);
  });

  it('a batch-wide Error issue (documentIndex omitted) fails every item', () => {
    const result = BatchRenderResult.fromApi({
      status: 'failed',
      requestedCount: 2,
      documents: [],
      issues: [{ type: 'Unknown', severity: 'Error', description: 'queue rejected batch' }],
    });
    expect(result.items[0]?.ok).toBe(false);
    expect(result.items[1]?.ok).toBe(false);
    expect(result.items[0]?.issues[0]?.description).toBe('queue rejected batch');
  });

  it('insufficient-credit tail: remaining slots with no document/issue get a synthetic "not rendered" issue', () => {
    const result = BatchRenderResult.fromApi({
      status: 'insufficient_credit',
      requestedCount: 3,
      renderedCount: 1,
      missingCount: 2,
      documents: [docNode('Doc 0', 0)],
      issues: [],
    });
    expect(result.insufficientCredit).toBe(true);
    expect(result.items[0]?.ok).toBe(true);
    expect(result.items[1]?.ok).toBe(false);
    expect(result.items[1]?.issues[0]?.description).toBe('not rendered');
    expect(result.items[2]?.ok).toBe(false);
    expect(result.items[2]?.issues[0]?.description).toBe('not rendered');
  });

  it('falls back to documents.length when neither requestedCount nor inputs are provided', () => {
    const result = BatchRenderResult.fromApi({
      status: 'ok',
      documents: [docNode('Doc 0', 0), docNode('Doc 1', 1)],
    });
    expect(result.items).toHaveLength(2);
    expect(result.items.every((it) => it.input === null)).toBe(true);
  });

  it('treats a literal requestedCount of 0 as "not provided" (falsy fallback, not nullish)', () => {
    const inputs = [{ a: 1 }, { a: 2 }];
    const result = BatchRenderResult.fromApi(
      {
        status: 'ok',
        requestedCount: 0,
        renderedCount: 0,
        documents: [docNode('Doc 0', 0), docNode('Doc 1', 1)],
      },
      inputs,
    );
    expect(result.items).toHaveLength(2);
    expect(result.requestedCount).toBe(2);
    expect(result.renderedCount).toBe(2);
  });

  it('silently drops an out-of-range documentIndex rather than throwing', () => {
    const result = BatchRenderResult.fromApi({
      status: 'ok',
      requestedCount: 2,
      documents: [docNode('Doc 0', 0), docNode('Doc 1', 1)],
      issues: [issueNode('Error', 'Unknown', 'phantom', 99)],
    });
    expect(result.items).toHaveLength(2);
    expect(result.ok).toBe(true);
    expect(result.items.every((it) => it.issues.length === 0)).toBe(true);
  });

  it('an out-of-range documentIndex uses a bounds check, not a throw, even at exactly items.length', () => {
    const result = BatchRenderResult.fromApi({
      status: 'ok',
      requestedCount: 1,
      documents: [docNode('Doc 0', 0)],
      issues: [issueNode('Error', 'Unknown', 'off by one', 1)],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.ok).toBe(true);
  });

  it('drops a document whose documentIndex is absent or out of range', () => {
    // documentIndex is the only correlation — the API guarantees it on every
    // document, so one that arrives without it is never placed by position.
    const result = BatchRenderResult.fromApi(
      {
        status: 'partial',
        renderedCount: 2,
        requestedCount: 3,
        documents: [docNode('Doc 0'), docNode('Doc 2', 99)],
        issues: [issueNode('Error', 'SchemaInvalid', 'bad field', 1)],
      },
      [{ Title: 'Doc 0' }, { Title: 'Doc 1' }, { Title: 'Doc 2' }],
    );

    expect(result.items.map((it) => it.document)).toEqual([null, null, null]);
    expect(result.items[0]?.issues[0]?.description).toBe('not rendered');
    expect(result.items[1]?.issues[0]?.description).toBe('bad field');
  });

  it('ok is derived from the counts, not from the items', () => {
    const result = BatchRenderResult.fromApi({
      status: 'ok',
      renderedCount: 2,
      requestedCount: 2,
      documents: [docNode('Doc 0', 0)],
    });
    expect(result.missingCount).toBe(0);
    expect(result.ok).toBe(true);
    // the per-item view stays honest about the slot that carries no document
    expect(result.failed.map((it) => it.index)).toEqual([1]);
  });

  it('computes missingCount rather than trusting the response field', () => {
    const result = BatchRenderResult.fromApi({
      status: 'ok',
      renderedCount: 2,
      requestedCount: 3,
      missingCount: 0, // inconsistent with the counts above
      documents: [docNode('Doc 0', 0), docNode('Doc 1', 1)],
    });
    expect(result.missingCount).toBe(1);
    expect(result.ok).toBe(false);
  });
});

describe('RenderJob / RenderJobStatus', () => {
  it('RenderJob parses jobId/requestedCount/state', () => {
    const job = RenderJob.fromApi({ jobId: 'job-1', requestedCount: 5, state: 'queued' });
    expect(job.jobId).toBe('job-1');
    expect(job.requestedCount).toBe(5);
    expect(job.state).toBe('queued');
  });

  it('RenderJobStatus.done is true for terminal states, false for pending/queued', () => {
    expect(RenderJobStatus.fromApi({ state: 'pending' }).done).toBe(false);
    expect(RenderJobStatus.fromApi({ state: 'queued' }).done).toBe(false);
    expect(RenderJobStatus.fromApi({ state: 'completed' }).done).toBe(true);
    expect(RenderJobStatus.fromApi({ state: 'failed' }).done).toBe(true);
  });

  it('RenderJobStatus.done treats an unknown state as terminal (fail-open)', () => {
    const status = RenderJobStatus.fromApi({ state: 'brand-new-state' });
    expect(status.state).toBe('unknown');
    expect(status.done).toBe(true);
  });

  it('RenderJobStatus.ok requires completed state AND ok outcome', () => {
    expect(RenderJobStatus.fromApi({ state: 'completed', status: 'ok' }).ok).toBe(true);
    expect(RenderJobStatus.fromApi({ state: 'completed', status: 'partial' }).ok).toBe(false);
    expect(RenderJobStatus.fromApi({ state: 'failed', status: 'failed' }).ok).toBe(false);
  });

  it('RenderJobStatus.status is null while pending, an outcome once decided', () => {
    expect(RenderJobStatus.fromApi({ state: 'pending' }).status).toBeNull();
    const done = RenderJobStatus.fromApi({ state: 'completed', status: 'insufficient_credit' });
    expect(done.status).toBe('insufficient_credit');
    expect(done.insufficientCredit).toBe(true);
  });

  it('RenderJobStatus carries issues and counts', () => {
    const status = RenderJobStatus.fromApi({
      state: 'completed',
      status: 'partial',
      renderedCount: 1,
      requestedCount: 2,
      missingCount: 1,
      issues: [issueNode('Error', 'SchemaInvalid', 'bad', 1)],
    });
    expect(status.missingCount).toBe(1);
    expect(status.issues).toHaveLength(1);
  });

  it('parses UTC-Z timestamps for startedAt/completedAt', () => {
    const status = RenderJobStatus.fromApi({
      state: 'completed',
      status: 'ok',
      startedAt: '2024-01-01T00:00:00Z',
      completedAt: '2024-01-01T00:05:00Z',
    });
    expect(status.startedAt?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(status.completedAt?.toISOString()).toBe('2024-01-01T00:05:00.000Z');
  });
});

describe('RenderJobState / RenderOutcome parsing (forward-compatibility)', () => {
  it('parseRenderJobState matches case-insensitively and fails OPEN to unknown', () => {
    expect(parseRenderJobState('COMPLETED')).toBe('completed');
    expect(parseRenderJobState('nonsense')).toBe('unknown');
    expect(parseRenderJobState(null)).toBe('unknown');
  });

  it('isRenderJobStateTerminal treats unknown as terminal', () => {
    expect(isRenderJobStateTerminal('queued')).toBe(false);
    expect(isRenderJobStateTerminal('pending')).toBe(false);
    expect(isRenderJobStateTerminal('completed')).toBe(true);
    expect(isRenderJobStateTerminal('unknown')).toBe(true);
  });

  it('parseRenderOutcome fails OPEN and handles the snake_case wire value', () => {
    expect(parseRenderOutcome('ok')).toBe('ok');
    expect(parseRenderOutcome('insufficient_credit')).toBe('insufficient_credit');
    expect(parseRenderOutcome('INSUFFICIENT_CREDIT')).toBe('insufficient_credit');
    expect(parseRenderOutcome('mystery')).toBe('unknown');
  });
});

describe('documentIndex-based batch correlation', () => {
  it('places each document at the slot given by its own documentIndex', () => {
    const result = BatchRenderResult.fromApi({
      status: 'partial',
      requestedCount: 3,
      renderedCount: 2,
      missingCount: 1,
      documents: [
        { ...docNode('Doc 2'), documentIndex: 2 },
        { ...docNode('Doc 0'), documentIndex: 0 },
      ],
      issues: [issueNode('Error', 'SchemaInvalid', 'bad', 1)],
    });
    expect(result.items[0]?.document?.documentName).toBe('Doc 0');
    expect(result.items[1]?.ok).toBe(false);
    expect(result.items[2]?.document?.documentName).toBe('Doc 2');
  });

  it('never fills positionally: documents lacking an index are dropped', () => {
    const result = BatchRenderResult.fromApi({
      status: 'ok',
      requestedCount: 2,
      renderedCount: 2,
      documents: [docNode('Doc 0'), docNode('Doc 1')], // no documentIndex
    });
    expect(result.documents).toEqual([]);
  });
});

describe('PdfDocument / PdfRenderResult', () => {
  it('fromResponse reads X-Pagr-* headers and the Content-Disposition filename', () => {
    const bytes = new Uint8Array(Buffer.from('%PDF-1.7'));
    const raw = new RawResponse(
      200,
      'application/pdf',
      bytes,
      new Headers({
        'Content-Disposition': 'attachment; filename="Report.pdf"',
        'X-Pagr-Document-Id': 'doc-1',
        'X-Pagr-Page-Count': '4',
        'X-Pagr-Render-Duration-Ms': '9.5',
        'X-Pagr-View-Url': 'https://example.test/doc-1',
        'X-Pagr-Issue-Count': '0',
      }),
    );
    const doc = PdfDocument.fromResponse(raw);
    expect(doc.documentName).toBe('Report');
    expect(doc.documentId).toBe('doc-1');
    expect(doc.pageCount).toBe(4);
    expect(doc.renderDuration).toBe(9.5);
    expect(doc.toBytes()).toEqual(bytes);
  });

  it('fromResponse matches the filename marker case-insensitively', () => {
    // HTTP header parameter names are case-insensitive (RFC 6266), so a `Filename=` must not
    // fall back to 'document' and silently lose the name. All six SDKs agree on this.
    for (const marker of ['filename', 'Filename', 'FILENAME', 'fileName']) {
      const raw = new RawResponse(
        200,
        'application/pdf',
        new Uint8Array(),
        new Headers({ 'Content-Disposition': `attachment; ${marker}="Report.pdf"` }),
      );
      expect(PdfDocument.fromResponse(raw).documentName).toBe('Report');
    }
  });

  it('fromResponse falls back to "document" when Content-Disposition is absent', () => {
    const raw = new RawResponse(200, 'application/pdf', new Uint8Array(), new Headers());
    const doc = PdfDocument.fromResponse(raw);
    expect(doc.documentName).toBe('document');
    expect(doc.documentId).toBeNull();
  });

  it('fromResponse normalises present-but-empty id/view-url headers to null', () => {
    // `Headers.get` returns '' for a header sent with an empty value; the contract
    // is `null` for a non-persisted render, never a placeholder ''.
    const raw = new RawResponse(
      200,
      'application/pdf',
      new Uint8Array(),
      new Headers({
        'Content-Disposition': 'attachment; filename="Report.pdf"',
        'X-Pagr-Document-Id': '',
        'X-Pagr-View-Url': '',
      }),
    );
    const doc = PdfDocument.fromResponse(raw);
    expect(doc.documentId).toBeNull();
    expect(doc.viewUrl).toBeNull();
  });

  it('fromErrorEnvelope builds a failed result from the 422 body', () => {
    const result = PdfRenderResult.fromErrorEnvelope({
      status: 'failed',
      message: 'blocked',
      issues: [issueNode('Error', 'SchemaInvalid', 'bad')],
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.issues).toHaveLength(1);
  });
});
