import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiError,
  AuthenticationError,
  PagrDecodeError,
  PagrError,
  PagrTimeoutError,
  RateLimitError,
} from '../src/errors.js';
import { HttpTransport } from '../src/http.js';
import { TestServer } from './helpers/test-server.js';

describe('HttpTransport', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('attaches a Bearer Authorization header when an API key is set', async () => {
    server.respond(200, '{}');
    const transport = new HttpTransport(server.baseUrl, 'secret-key');
    await transport.get('v1/templates');
    expect(server.last.headers['authorization']).toBe('Bearer secret-key');
  });

  it('omits the Authorization header when the API key is blank', async () => {
    server.respond(200, '{}');
    const transport = new HttpTransport(server.baseUrl, '');
    await transport.get('v1/templates');
    expect(server.last.headers['authorization']).toBeUndefined();
  });

  it('setApiKey swaps the bearer token used on the next request', async () => {
    server.respond(200, '{}');
    const transport = new HttpTransport(server.baseUrl, 'first-key');
    await transport.get('v1/templates');
    expect(server.last.headers['authorization']).toBe('Bearer first-key');

    transport.setApiKey('second-key');
    await transport.get('v1/templates');
    expect(server.last.headers['authorization']).toBe('Bearer second-key');
  });

  it('builds the query string from ordered pairs, one per entry', async () => {
    server.respond(200, '{}');
    const transport = new HttpTransport(server.baseUrl, 'key');
    await transport.get('v1/templates', [
      ['take', '50'],
      ['sortBy', 'updatedAt'],
      ['filters[0].field', 'name'],
    ]);
    expect(server.last.query).toBe('?take=50&sortBy=updatedAt&filters%5B0%5D.field=name');
  });

  it('sends no query string when query is omitted or empty', async () => {
    server.respond(200, '{}');
    const transport = new HttpTransport(server.baseUrl, 'key');
    await transport.get('v1/templates');
    expect(server.last.query).toBe('');
    await transport.get('v1/templates', []);
    expect(server.last.query).toBe('');
  });

  it('serialises a JSON body on POST with the correct content-type', async () => {
    server.respond(200, '{}');
    const transport = new HttpTransport(server.baseUrl, 'key');
    await transport.postJson('v1/render/abc', {
      documents: [{ title: 'x' }],
      includeDocument: true,
    });
    expect(server.last.method).toBe('POST');
    expect(server.last.headers['content-type']).toBe('application/json');
    expect(JSON.parse(server.last.body)).toEqual({
      documents: [{ title: 'x' }],
      includeDocument: true,
    });
  });

  it('sends PATCH requests, preserving an explicit null in the body', async () => {
    server.respond(200, '{}');
    const transport = new HttpTransport(server.baseUrl, 'key');
    await transport.patchJson('v1/templates/1/versions/1/document-name-template', {
      documentNameTemplate: null,
    });
    expect(server.last.method).toBe('PATCH');
    expect(JSON.parse(server.last.body)).toEqual({ documentNameTemplate: null });
  });

  it('surfaces application/pdf bytes untouched', async () => {
    const pdfBytes = new Uint8Array(Buffer.from('%PDF-1.7 fake'));
    server.respondBytes(200, pdfBytes, 'application/pdf');
    const transport = new HttpTransport(server.baseUrl, 'key');
    const raw = await transport.get('v1/render/abc');
    expect(raw.isPdf).toBe(true);
    expect(raw.bytes).toEqual(pdfBytes);
  });

  it('maps a 401 with the error envelope to AuthenticationError', async () => {
    server.respond(401, JSON.stringify({ error: { code: 'InvalidApiKey', message: 'bad key' } }));
    const transport = new HttpTransport(server.baseUrl, 'bad-key');
    await expect(transport.get('v1/templates')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AuthenticationError);
      expect((err as AuthenticationError).statusCode).toBe(401);
      expect((err as AuthenticationError).code).toBe('InvalidApiKey');
      expect((err as AuthenticationError).message).toBe('bad key');
      return true;
    });
  });

  it('falls back to the raw body as the message when the error body is not JSON', async () => {
    server.respond(500, 'internal server error', 'text/plain');
    const transport = new HttpTransport(server.baseUrl, 'key');
    await expect(transport.get('v1/templates')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(500);
      expect((err as ApiError).code).toBeUndefined();
      expect((err as ApiError).message).toBe('internal server error');
      return true;
    });
  });

  it('falls back to a generic message when the error body is empty', async () => {
    server.respond(503, '');
    const transport = new HttpTransport(server.baseUrl, 'key');
    await expect(transport.get('v1/templates')).rejects.toThrow('Pagr API returned HTTP 503.');
  });

  it('throws PagrTimeoutError (a PagrError with no statusCode) when the request times out', async () => {
    server.delayNextResponse(500);
    const transport = new HttpTransport(server.baseUrl, 'key', { timeoutMs: 20, maxRetries: 0 });
    await expect(transport.get('v1/templates')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(PagrTimeoutError);
      expect(err).toBeInstanceOf(PagrError);
      expect((err as PagrError).statusCode).toBeUndefined();
      return true;
    });
  });

  describe('cancellation', () => {
    it('rejects with the native AbortError (not a PagrError) when the caller aborts', async () => {
      server.delayNextResponse(2000);
      const transport = new HttpTransport(server.baseUrl, 'key', { maxRetries: 0 });
      const controller = new AbortController();
      const promise = transport.get('v1/templates', undefined, { signal: controller.signal });
      setTimeout(() => controller.abort(), 15);
      await expect(promise).rejects.toSatisfy((err: unknown) => {
        expect(err).not.toBeInstanceOf(PagrError);
        expect((err as Error).name).toBe('AbortError');
        return true;
      });
    });

    it('still throws PagrTimeoutError on an internal timeout when a caller signal is also set', async () => {
      server.delayNextResponse(500);
      const transport = new HttpTransport(server.baseUrl, 'key', { timeoutMs: 20, maxRetries: 0 });
      // A caller signal that never fires must not change timeout behavior.
      const controller = new AbortController();
      await expect(
        transport.get('v1/templates', undefined, { signal: controller.signal }),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(PagrTimeoutError);
        expect(err).toBeInstanceOf(PagrError);
        return true;
      });
    });

    it('returns promptly on caller abort during retry backoff, instead of waiting out the full delay', async () => {
      server.respond(503, '{}');
      const transport = new HttpTransport(server.baseUrl, 'key', {
        maxRetries: 2,
        backoffBaseMs: 10_000,
        backoffMaxMs: 10_000,
      });
      const controller = new AbortController();
      const start = Date.now();
      const promise = transport.get('v1/templates', undefined, { signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      await expect(promise).rejects.toSatisfy((err: unknown) => {
        expect(err).not.toBeInstanceOf(PagrError);
        expect((err as Error).name).toBe('AbortError');
        return true;
      });
      expect(Date.now() - start).toBeLessThan(2_000);
    });
  });

  describe('retries', () => {
    const fastRetry = { maxRetries: 2, backoffBaseMs: 0, backoffMaxMs: 0 } as const;

    it('retries an idempotent GET on a transient 5xx, then returns the success', async () => {
      server.respondSequence([
        { status: 503, body: '{}' },
        { status: 500, body: '{}' },
        { status: 200, body: JSON.stringify({ ok: true }) },
      ]);
      const transport = new HttpTransport(server.baseUrl, 'key', fastRetry);
      const raw = await transport.get('v1/templates');
      expect(raw.status).toBe(200);
      expect(server.requestCount).toBe(3);
    });

    it('gives up after maxRetries and throws the mapped error', async () => {
      server.respond(503, JSON.stringify({ error: { code: 'QueueFull', message: 'full' } }));
      const transport = new HttpTransport(server.baseUrl, 'key', fastRetry);
      await expect(transport.get('v1/templates')).rejects.toBeInstanceOf(ApiError);
      expect(server.requestCount).toBe(3); // 1 initial + 2 retries
    });

    it('never retries a 429 — surfaces RateLimitError with a parsed retryAfter', async () => {
      server.respond(429, JSON.stringify({ error: { code: 'RateLimited', message: 'slow down' } }));
      server.setResponseHeaders({ 'Retry-After': '7' });
      const transport = new HttpTransport(server.baseUrl, 'key', fastRetry);
      await expect(transport.get('v1/templates')).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(RateLimitError);
        expect((err as RateLimitError).retryAfter).toBe(7);
        return true;
      });
      expect(server.requestCount).toBe(1);
    });

    it('never retries a write (POST) on a 5xx', async () => {
      server.respond(500, '{}');
      const transport = new HttpTransport(server.baseUrl, 'key', fastRetry);
      await expect(transport.postJson('v1/render/abc', {})).rejects.toBeInstanceOf(ApiError);
      expect(server.requestCount).toBe(1);
    });

    it('does not retry when maxRetries is 0', async () => {
      server.respond(500, '{}');
      const transport = new HttpTransport(server.baseUrl, 'key', { maxRetries: 0 });
      await expect(transport.get('v1/templates')).rejects.toBeInstanceOf(ApiError);
      expect(server.requestCount).toBe(1);
    });
  });

  it('RawResponse.json() throws PagrDecodeError on a non-JSON 2xx body', async () => {
    server.respond(200, 'not json at all', 'text/plain');
    const transport = new HttpTransport(server.baseUrl, 'key');
    const raw = await transport.get('v1/templates');
    expect(() => raw.json()).toThrow(PagrDecodeError);
  });

  it('requires a non-blank base URL', () => {
    expect(() => new HttpTransport('   ', 'key')).toThrow('A base URL is required.');
  });

  it('trims trailing slashes from the base URL', async () => {
    server.respond(200, '{}');
    const transport = new HttpTransport(`${server.baseUrl}/`, 'key');
    await transport.get('v1/templates');
    expect(server.last.path).toBe('/v1/templates');
  });
});
