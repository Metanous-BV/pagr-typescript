import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * A loopback HTTP server for client-level tests — mirrors the Java SDK's
 * `com.sun.net.httpserver`-based `ClientTest` harness. Scripts the next
 * response (`respond`/`respondBytes`) and records the last request's
 * method/path/query/headers/body so tests can assert real request
 * construction, not just parsed results.
 */
interface ScriptedResponse {
  status: number;
  body: Buffer;
  contentType: string;
}

export class TestServer {
  private sticky: ScriptedResponse = {
    status: 200,
    body: Buffer.alloc(0),
    contentType: 'application/json',
  };
  private queue: ScriptedResponse[] = [];
  private queueIndex = 0;
  private extraHeaders: Record<string, string> = {};
  private lastRequest: RecordedRequest | undefined;
  private responseDelayMs = 0;
  private requests = 0;

  private constructor(private readonly server: http.Server) {}

  static start(): Promise<TestServer> {
    return new Promise((resolve, reject) => {
      const server = http.createServer();
      const instance = new TestServer(server);
      server.on('request', (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          instance.requests += 1;
          instance.lastRequest = {
            method: req.method ?? '',
            path: url.pathname,
            query: url.search,
            headers: req.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          };
          const scripted = instance.nextResponse();
          const send = (): void => {
            res.writeHead(scripted.status, {
              'Content-Type': scripted.contentType,
              ...instance.extraHeaders,
            });
            res.end(scripted.body);
          };
          if (instance.responseDelayMs > 0) {
            setTimeout(send, instance.responseDelayMs);
          } else {
            send();
          }
        });
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(instance));
    });
  }

  private nextResponse(): ScriptedResponse {
    if (this.queue.length === 0) {
      return this.sticky;
    }
    // Consume in order; the last scripted response repeats for any extra requests.
    const index = Math.min(this.queueIndex, this.queue.length - 1);
    this.queueIndex += 1;
    return this.queue[index]!;
  }

  get baseUrl(): string {
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  respond(status: number, body: string, contentType = 'application/json'): void {
    this.queue = [];
    this.queueIndex = 0;
    this.sticky = { status, body: Buffer.from(body, 'utf-8'), contentType };
  }

  respondBytes(status: number, body: Uint8Array, contentType: string): void {
    this.queue = [];
    this.queueIndex = 0;
    this.sticky = { status, body: Buffer.from(body), contentType };
  }

  /** Scripts a sequence of responses consumed in order; the last one repeats for extra requests. */
  respondSequence(
    responses: readonly { status: number; body: string; contentType?: string }[],
  ): void {
    this.queue = responses.map((r) => ({
      status: r.status,
      body: Buffer.from(r.body, 'utf-8'),
      contentType: r.contentType ?? 'application/json',
    }));
    this.queueIndex = 0;
  }

  /** Extra response headers merged into every response (e.g. `X-Pagr-*`, `Content-Disposition`). */
  setResponseHeaders(headers: Record<string, string>): void {
    this.extraHeaders = headers;
  }

  /** Delays every subsequent response — used to exercise client-side timeouts. */
  delayNextResponse(ms: number): void {
    this.responseDelayMs = ms;
  }

  get last(): RecordedRequest {
    if (!this.lastRequest) {
      throw new Error('No request has been recorded yet.');
    }
    return this.lastRequest;
  }

  /** Total number of requests received since the server started. */
  get requestCount(): number {
    return this.requests;
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
