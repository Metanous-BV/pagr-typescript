// Fire-and-forget batch render with signed webhook callbacks, plus job status
// polling.
//
// This SDK ships a webhook *parser/verifier* only, not a bundled HTTP server —
// bring your own (node:http, Express, Fastify, ...). Every callback carries
// X-Pagr-Signature (HMAC proof it came from Pagr), X-Pagr-Event and
// X-Pagr-Delivery. Verify before acting on a payload: anyone who finds your
// callback URL can POST to it. parseSignedCallback verifies and parses in one
// step — prefer it over the unauthenticated parseCallback:
//
//   import { PagrSignatureError, RenderCompletion, RenderProgress, parseSignedCallback } from 'pagr-sdk';
//
//   const SECRET = process.env.PAGR_WEBHOOK_SECRET!; // Settings → API keys in the web app
//
//   http.createServer((req, res) => {
//     const chunks: Buffer[] = [];
//     req.on('data', (chunk: Buffer) => chunks.push(chunk));
//     req.on('end', () => {
//       let callback;
//       try {
//         // Buffer.concat: the RAW bytes as POSTed. A body parsed to an object
//         // and re-serialized will not verify, even though the JSON value is
//         // identical — key order and separators change the signed bytes.
//         callback = parseSignedCallback(Buffer.concat(chunks), req.headers['x-pagr-signature'], SECRET);
//       } catch (err) {
//         if (err instanceof PagrSignatureError) return res.writeHead(400).end(); // not from Pagr
//         throw err;
//       }
//       if (callback instanceof RenderProgress) {
//         console.log(`${callback.processed}/${callback.requestedCount} — ${callback.document.documentName}`);
//       } else if (callback instanceof RenderCompletion) {
//         console.log(`done: ${callback.status} (${callback.renderedCount}/${callback.requestedCount})`);
//       }
//       res.writeHead(204).end();
//     });
//   }).listen(8765);
//
// Deliveries are retried (up to 5 attempts, exponential backoff from 2s, 30s
// per attempt) and run with bounded parallelism, so callbacks can arrive out of
// order AND more than once — keep the handler idempotent and deduplicate on the
// X-Pagr-Delivery header, which is stable across retries of one delivery.
//
// Polling (demonstrated below) needs no public server and is the authoritative
// signal — a reliable alternative to, or complement for, webhooks.
import { createClient } from './env.js';
import { pickPublishedTemplate } from './pick-template.js';

async function main(): Promise<void> {
  const client = createClient();
  if (!client) {
    return;
  }
  const picked = await pickPublishedTemplate(client);
  if (!picked) {
    return;
  }
  const { template, version } = picked;
  const dataSets = Array.from({ length: 5 }, () => version.sampleData);

  // A publicly reachable URL the Pagr server POSTs webhooks to. For local
  // experiments, a https://webhook.site inbox works well.
  const callbackUrl = process.env['PAGR_WEBHOOK_URL'] ?? 'https://example.invalid/pagr-callback';

  const job = await client.enqueueBatchRender(template.id, dataSets, callbackUrl, {
    version: version.versionNumber,
  });
  console.log(`Enqueued job ${job.jobId}: ${job.requestedCount} document(s), state=${job.state}`);

  // The server POSTs N+1 callbacks to callbackUrl: one RenderProgress per
  // rendered document plus a final RenderCompletion, each signed with the
  // organisation's webhook secret (see the module comment above for a
  // verifying handler sketch). Poll here as the reliable alternative:
  // waitForJob wraps getJobStatus in a poll loop bounded by a default
  // 5-minute deadline (it throws PagrTimeoutError if that elapses), so it
  // can never spin forever on a stuck job.
  const status = await client.waitForJob(job.jobId, { pollIntervalMs: 1000 });
  console.log(
    status.ok
      ? `Job completed at ${status.completedAt?.toISOString()}`
      : `Job failed: ${status.failureReason}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
