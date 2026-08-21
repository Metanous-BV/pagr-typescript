import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WAIT_FOR_JOB_TIMEOUT_MS, PagrApiClient } from '../src/client.js';
import { PagrDecodeError, PagrError } from '../src/errors.js';
import { TestServer } from './helpers/test-server.js';

function docNode(name: string, documentIndex?: number) {
  return {
    ...(documentIndex === undefined ? {} : { documentIndex }),
    id: `doc-${name}`,
    documentName: name,
    templateId: 'tmpl-1',
    versionNumber: 1,
    environment: 'test',
    fileSizeBytes: 10,
    pageCount: 1,
    renderedAt: '2024-01-01T00:00:00Z',
    renderDuration: 1,
    viewUrl: 'https://example.test',
    documentType: 'pdf',
  };
}

describe('PagrApiClient', () => {
  let server: TestServer;
  let client: PagrApiClient;

  beforeEach(async () => {
    server = await TestServer.start();
    client = new PagrApiClient('test-key', server.baseUrl);
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('templates', () => {
    it('getTemplates hits /v1/templates with no query by default', async () => {
      server.respond(200, JSON.stringify({ items: [], total: 0, skip: 0, take: 0 }));
      await client.getTemplates();
      expect(server.last.path).toBe('/v1/templates');
      expect(server.last.query).toBe('');
    });

    it('getTemplates scopes to a project when projectId is given', async () => {
      server.respond(200, JSON.stringify({ items: [] }));
      await client.getTemplates({ projectId: 'proj-1', take: 10 });
      expect(server.last.path).toBe('/v1/projects/proj-1/templates');
      expect(server.last.query).toBe('?take=10');
    });

    it('getTemplates parses items into Template instances', async () => {
      server.respond(
        200,
        JSON.stringify({ items: [{ id: 't1', name: 'Invoice' }], total: 1, skip: 0, take: 25 }),
      );
      const page = await client.getTemplates();
      expect(page.items[0]?.name).toBe('Invoice');
      expect(page.total).toBe(1);
    });

    it('getTemplate fetches by id', async () => {
      server.respond(200, JSON.stringify({ id: 't1', name: 'Invoice' }));
      const template = await client.getTemplate('t1');
      expect(server.last.path).toBe('/v1/templates/t1');
      expect(template.name).toBe('Invoice');
    });

    it('getTemplateVersions applies list options', async () => {
      server.respond(200, JSON.stringify({ items: [] }));
      await client.getTemplateVersions('t1', { sortBy: 'versionNumber', sortDirection: 'desc' });
      expect(server.last.path).toBe('/v1/templates/t1/versions');
      expect(server.last.query).toBe('?sortBy=versionNumber&sortDirection=desc');
    });

    it('getTemplateVersion omitted version hits the /versions/latest path', async () => {
      server.respond(200, JSON.stringify({ id: 'v1', versionNumber: 3 }));
      await client.getTemplateVersion('t1');
      expect(server.last.path).toBe('/v1/templates/t1/versions/latest');
    });

    it('getTemplateVersion with an explicit version hits /versions/{n}', async () => {
      server.respond(200, JSON.stringify({ id: 'v1', versionNumber: 2 }));
      await client.getTemplateVersion('t1', 2);
      expect(server.last.path).toBe('/v1/templates/t1/versions/2');
    });

    it('updateDocumentNameTemplate sends an explicit null to clear it', async () => {
      server.respond(200, JSON.stringify({ id: 'v1' }));
      await client.updateDocumentNameTemplate('t1', 2, null);
      expect(server.last.method).toBe('PATCH');
      expect(server.last.path).toBe('/v1/templates/t1/versions/2/document-name-template');
      expect(JSON.parse(server.last.body)).toEqual({ documentNameTemplate: null });
    });

    it('updateDocumentNameTemplate sends the new value when set', async () => {
      server.respond(200, JSON.stringify({ id: 'v1' }));
      await client.updateDocumentNameTemplate('t1', 2, 'Invoice {{number}}');
      expect(JSON.parse(server.last.body)).toEqual({ documentNameTemplate: 'Invoice {{number}}' });
    });

    it('getPreviewImageUrl reads the url property', async () => {
      server.respond(200, JSON.stringify({ url: 'https://example.test/preview.png' }));
      const url = await client.getPreviewImageUrl('t1', 2);
      expect(url).toBe('https://example.test/preview.png');
    });

    it('getPreviewImageUrl returns null when absent', async () => {
      server.respond(200, JSON.stringify({}));
      expect(await client.getPreviewImageUrl('t1', 2)).toBeNull();
    });
  });

  describe('render', () => {
    it('omitted version uses the versionless path', async () => {
      server.respond(200, JSON.stringify({ status: 'ok', documents: [docNode('Doc 0')] }));
      const result = await client.render('t1', '{"Title":"x"}');
      expect(server.last.path).toBe('/v1/render/t1');
      expect(result.ok).toBe(true);
    });

    it('an explicit version uses the versioned path', async () => {
      server.respond(200, JSON.stringify({ status: 'ok', documents: [docNode('Doc 0')] }));
      await client.render('t1', '{}', { version: 3 });
      expect(server.last.path).toBe('/v1/render/t1/versions/3');
    });

    it('sends persist and language as query params', async () => {
      server.respond(200, JSON.stringify({ status: 'ok', documents: [] }));
      await client.render('t1', '{}', { language: 'nl' });
      expect(server.last.query).toBe('?language=nl&persist=true');

      await client.render('t1', '{}');
      expect(server.last.query).toBe('?persist=true');

      await client.render('t1', '{}', { persist: false });
      expect(server.last.query).toBe('?persist=false');
    });

    it('reads persist:false as the same JSON envelope, with id/viewUrl null and bytes forced inline', async () => {
      server.respond(
        200,
        JSON.stringify({
          status: 'ok',
          renderedCount: 1,
          requestedCount: 1,
          documents: [
            {
              ...docNode('Draft', 0),
              id: null,
              viewUrl: null,
              documentBase64: Buffer.from('%PDF-1.7 fake').toString('base64'),
            },
          ],
        }),
      );
      const result = await client.render('t1', '{}', { persist: false });
      expect(result.ok).toBe(true);
      expect(result.document?.id).toBeNull();
      expect(result.document?.viewUrl).toBeNull();
      // Every other field is real — no placeholders.
      expect(result.document?.environment).toBe('test');
      expect(result.document?.toBytes()).toEqual(new Uint8Array(Buffer.from('%PDF-1.7 fake')));
    });

    it('never sniffs content-type: a raw PDF body on the JSON path is a decode error', async () => {
      // `render` negotiates Accept: application/json and the API never answers it
      // with a PDF. Sniffing one and fabricating a placeholder-filled document
      // (templateId: '', environment: '') is what parity-contract.md §1 forbids —
      // so an unexpected binary body must surface as a decode failure instead.
      server.respondBytes(200, new Uint8Array(Buffer.from('%PDF-1.7 fake')), 'application/pdf');
      await expect(client.render('t1', '{}', { persist: false })).rejects.toThrow(PagrDecodeError);
    });

    it('surfaces insufficient_credit as data, not a thrown error', async () => {
      server.respond(
        200,
        JSON.stringify({
          status: 'insufficient_credit',
          message: 'out of credit',
          renderedCount: 0,
          requestedCount: 1,
          missingCount: 1,
          documents: [],
        }),
      );
      const result = await client.render('t1', '{}', { version: 1 });
      expect(result.insufficientCredit).toBe(true);
      expect(result.ok).toBe(false);
    });

    it('accepts a plain object as document data, not just a JSON string', async () => {
      server.respond(200, JSON.stringify({ status: 'ok', documents: [] }));
      await client.render('t1', { Title: 'x' }, { version: 1 });
      expect(JSON.parse(server.last.body)).toEqual({
        documents: [{ Title: 'x' }],
        includeDocument: false,
      });
    });

    it('renderBatch posts every document and correlates the response', async () => {
      server.respond(
        200,
        JSON.stringify({
          status: 'ok',
          renderedCount: 2,
          requestedCount: 2,
          missingCount: 0,
          documents: [docNode('Doc 0', 0), docNode('Doc 1', 1)],
        }),
      );
      const result = await client.renderBatch('t1', ['{"Title":"a"}', '{"Title":"b"}']);
      expect(JSON.parse(server.last.body).documents).toEqual([{ Title: 'a' }, { Title: 'b' }]);
      expect(result.ok).toBe(true);
      expect(result.documents).toHaveLength(2);
    });

    it('renderBatch never sniffs content-type — always parses as JSON', async () => {
      // A misleading content-type header with a genuinely JSON body: renderBatch
      // must still parse it as JSON, unlike the single-document render() path.
      server.respond(200, JSON.stringify({ status: 'ok', documents: [] }), 'application/pdf');
      const result = await client.renderBatch('t1', ['{}']);
      expect(result.status).toBe('ok');
    });

    it('enqueueBatchRender posts callbackUrl and returns a RenderJob', async () => {
      server.respond(200, JSON.stringify({ jobId: 'job-1', requestedCount: 2, state: 'queued' }));
      const job = await client.enqueueBatchRender(
        't1',
        ['{}', '{}'],
        'https://example.test/callback',
        {
          version: 1,
        },
      );
      expect(server.last.path).toBe('/v1/render/t1/versions/1/async');
      expect(JSON.parse(server.last.body).callbackUrl).toBe('https://example.test/callback');
      expect(job.jobId).toBe('job-1');
      expect(job.requestedCount).toBe(2);
      expect(job.state).toBe('queued');
    });

    it('getJobStatus polls the job endpoint, separating state from outcome', async () => {
      server.respond(
        200,
        JSON.stringify({
          jobId: 'job-1',
          state: 'completed',
          status: 'ok',
          renderedCount: 2,
          requestedCount: 2,
          startedAt: '2024-01-01T00:00:00Z',
        }),
      );
      const status = await client.getJobStatus('job-1');
      expect(server.last.path).toBe('/v1/render/jobs/job-1');
      expect(status.done).toBe(true);
      expect(status.ok).toBe(true);
      expect(status.state).toBe('completed');
      expect(status.status).toBe('ok');
    });

    it('renderPdf returns a PdfRenderResult from a streamed PDF and its X-Pagr headers', async () => {
      const pdfBytes = new Uint8Array(Buffer.from('%PDF-1.7 pdf'));
      server.respondBytes(200, pdfBytes, 'application/pdf');
      server.setResponseHeaders({
        'Content-Disposition': 'attachment; filename="Invoice-42.pdf"',
        'X-Pagr-Document-Id': 'doc-99',
        'X-Pagr-Page-Count': '3',
        'X-Pagr-Render-Duration-Ms': '12.5',
        'X-Pagr-View-Url': 'https://example.test/doc-99',
        'X-Pagr-Issue-Count': '0',
      });
      const result = await client.renderPdf('t1', '{}', { persist: true });
      expect(server.last.headers['accept']).toBe('application/pdf');
      expect(result.ok).toBe(true);
      expect(result.document?.toBytes()).toEqual(pdfBytes);
      expect(result.document?.documentName).toBe('Invoice-42');
      expect(result.document?.documentId).toBe('doc-99');
      expect(result.document?.pageCount).toBe(3);
    });

    it('renderPdf surfaces a 422 business-outcome envelope as a failed result, not a throw', async () => {
      server.respond(
        422,
        JSON.stringify({
          status: 'failed',
          message: 'blocked',
          issues: [{ type: 'SchemaInvalid', severity: 'Error', description: 'bad' }],
        }),
      );
      const result = await client.renderPdf('t1', '{}');
      expect(result.ok).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.issues).toHaveLength(1);
    });

    it('waitForJob polls until the job reaches a terminal state', async () => {
      // First poll pending, second poll completed.
      server.respondSequence([
        { status: 200, body: JSON.stringify({ jobId: 'job-1', state: 'pending' }) },
        {
          status: 200,
          body: JSON.stringify({ jobId: 'job-1', state: 'completed', status: 'ok' }),
        },
      ]);
      const status = await client.waitForJob('job-1', { pollIntervalMs: 1 });
      expect(status.done).toBe(true);
      expect(status.ok).toBe(true);
    });

    it('waitForJob throws PagrTimeoutError when the overall deadline elapses', async () => {
      server.respond(200, JSON.stringify({ jobId: 'job-1', state: 'pending' }));
      await expect(client.waitForJob('job-1', { pollIntervalMs: 5, timeoutMs: 1 })).rejects.toThrow(
        /did not finish/,
      );
    });

    it('waitForJob defaults to a 5-minute overall deadline (rule 3), not unbounded polling', () => {
      // The real 5-minute deadline itself is exercised via a short *override*
      // above ("throws PagrTimeoutError when the overall deadline elapses"),
      // per the same deadline-check code path — this only pins the default's
      // value so it can't silently drift back to "unbounded".
      expect(DEFAULT_WAIT_FOR_JOB_TIMEOUT_MS).toBe(300_000);
    });

    it('waitForJob keeps polling past the default deadline when timeoutMs: Infinity opts out', async () => {
      server.respondSequence([
        { status: 200, body: JSON.stringify({ jobId: 'job-1', state: 'pending' }) },
        { status: 200, body: JSON.stringify({ jobId: 'job-1', state: 'pending' }) },
        { status: 200, body: JSON.stringify({ jobId: 'job-1', state: 'completed', status: 'ok' }) },
      ]);
      const status = await client.waitForJob('job-1', { pollIntervalMs: 1, timeoutMs: Infinity });
      expect(status.done).toBe(true);
      expect(server.requestCount).toBe(3);
    });

    it('waitForJob rejects with the native AbortError (not a PagrError) when the caller aborts', async () => {
      server.respond(200, JSON.stringify({ jobId: 'job-1', state: 'pending' }));
      const controller = new AbortController();
      const promise = client.waitForJob('job-1', {
        pollIntervalMs: 50_000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 15);
      await expect(promise).rejects.toSatisfy((err: unknown) => {
        expect(err).not.toBeInstanceOf(PagrError);
        expect((err as Error).name).toBe('AbortError');
        return true;
      });
    });

    it('waitForJob returns promptly on caller abort during the poll sleep, not the full interval', async () => {
      server.respond(200, JSON.stringify({ jobId: 'job-1', state: 'pending' }));
      const controller = new AbortController();
      const start = Date.now();
      const promise = client.waitForJob('job-1', {
        pollIntervalMs: 10_000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 15);
      await expect(promise).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(2_000);
    });
  });

  describe('filter validation', () => {
    it('rejects an unknown filter field client-side before any request', async () => {
      await expect(
        client.getDocuments({ filters: [{ field: 'documentNam', value: 'x' }] }),
      ).rejects.toThrow(/unknown field 'documentNam'/);
    });

    it('rejects an operator not allowed for a field', async () => {
      await expect(
        client.getTemplates({ filters: [{ field: 'name', op: 'gt', value: 'x' }] }),
      ).rejects.toThrow(/operator 'gt' is not valid/);
    });

    it('accepts a valid field/operator combination', async () => {
      server.respond(200, JSON.stringify({ items: [] }));
      await client.getDocuments({
        filters: [{ field: 'documentName', op: 'contains', value: 'inv' }],
      });
      expect(server.last.query).toContain('filters%5B0%5D.field=documentName');
    });
  });

  describe('validate', () => {
    it('wraps a single document in a one-element documents array', async () => {
      server.respond(200, JSON.stringify({ issues: [] }));
      await client.validate('t1', { Title: 'x' });
      expect(JSON.parse(server.last.body)).toEqual({ documents: [{ Title: 'x' }] });
    });

    it('treats an explicit array of documents as a batch, one document per element', async () => {
      server.respond(200, JSON.stringify({ issues: [] }));
      await client.validate('t1', [{ Title: 'a' }, { Title: 'b' }]);
      expect(JSON.parse(server.last.body)).toEqual({ documents: [{ Title: 'a' }, { Title: 'b' }] });
    });

    it('treats a single JSON-array-encoding string as a batch', async () => {
      server.respond(200, JSON.stringify({ issues: [] }));
      await client.validate('t1', '[{"Title":"a"},{"Title":"b"}]');
      expect(JSON.parse(server.last.body)).toEqual({ documents: [{ Title: 'a' }, { Title: 'b' }] });
    });

    it('applies the version in the path when given', async () => {
      server.respond(200, JSON.stringify({ issues: [] }));
      await client.validate('t1', {}, { version: 4 });
      expect(server.last.path).toBe('/v1/render/t1/versions/4/validate');
    });

    it('parses returned issues and isValid', async () => {
      server.respond(
        200,
        JSON.stringify({
          issues: [{ type: 'SchemaInvalid', severity: 'Error', description: 'bad' }],
        }),
      );
      const response = await client.validate('t1', {});
      expect(response.isValid).toBe(false);
      expect(response.errors).toHaveLength(1);
    });
  });

  describe('documents', () => {
    it('getDocuments applies list options', async () => {
      server.respond(200, JSON.stringify({ items: [] }));
      await client.getDocuments({ take: 10, search: 'invoice' });
      expect(server.last.path).toBe('/v1/documents');
      expect(server.last.query).toBe('?take=10&search=invoice');
    });

    it('getDocument fetches by id', async () => {
      server.respond(200, JSON.stringify(docNode('Doc 0')));
      const doc = await client.getDocument('doc-1');
      expect(server.last.path).toBe('/v1/documents/doc-1');
      expect(doc.documentName).toBe('Doc 0');
    });

    it('downloadDocument returns raw bytes', async () => {
      const pdfBytes = new Uint8Array(Buffer.from('%PDF-1.7 downloaded'));
      server.respondBytes(200, pdfBytes, 'application/pdf');
      const bytes = await client.downloadDocument('doc-1');
      expect(server.last.path).toBe('/v1/documents/doc-1/file');
      expect(bytes).toEqual(pdfBytes);
    });
  });

  describe('fonts', () => {
    it('getFonts returns the font name list', async () => {
      server.respond(200, JSON.stringify(['Arial', 'Times New Roman']));
      const fonts = await client.getFonts();
      expect(server.last.path).toBe('/v1/fonts');
      expect(fonts).toEqual(['Arial', 'Times New Roman']);
    });
  });

  describe('organisation', () => {
    it('getOrgStats parses usage stats', async () => {
      server.respond(200, JSON.stringify({ organisationName: 'Acme', tier: 'pro', userCount: 3 }));
      const stats = await client.getOrgStats();
      expect(server.last.path).toBe('/v1/organisation/stats');
      expect(stats.organisationName).toBe('Acme');
    });
  });

  describe('meta', () => {
    it('getStatus resolves true when healthy', async () => {
      server.respond(200, '{}');
      await expect(client.getStatus()).resolves.toBe(true);
      expect(server.last.path).toBe('/v1/meta/status');
    });

    it('getStatus throws when the service reports unhealthy', async () => {
      server.respond(
        503,
        JSON.stringify({ error: { code: 'ServiceUnavailable', message: 'down' } }),
      );
      await expect(client.getStatus()).rejects.toThrow('down');
    });

    it('getVersion reads the version property', async () => {
      server.respond(200, JSON.stringify({ version: '1.4.0' }));
      expect(await client.getVersion()).toBe('1.4.0');
    });

    it('getVersion returns null when the API does not report one', async () => {
      server.respond(200, '{}');
      expect(await client.getVersion()).toBeNull();
    });
  });

  describe('auth', () => {
    it('attaches the API key as a Bearer token', async () => {
      server.respond(200, JSON.stringify({ items: [] }));
      await client.getTemplates();
      expect(server.last.headers['authorization']).toBe('Bearer test-key');
    });

    it('setApiKey swaps the bearer token used on the next request', async () => {
      server.respond(200, JSON.stringify({ items: [] }));
      await client.getTemplates();
      expect(server.last.headers['authorization']).toBe('Bearer test-key');

      client.setApiKey('rotated-key');
      await client.getTemplates();
      expect(server.last.headers['authorization']).toBe('Bearer rotated-key');
    });
  });
});
