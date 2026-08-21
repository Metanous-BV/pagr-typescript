# User Guide

## Installation

Not yet published to npm — for now, install straight from GitHub.

```bash
npm install git+https://github.com/Metanous-BV/pagr-typescript.git
```

Requires Node.js 18 or later (native `fetch`/`AbortSignal.timeout`). Not
tested or supported for browser use — see [Scope](#scope-node-only) below.

## Authentication & the client

```ts
import { PagrApiClient } from 'pagr-sdk';

const client = new PagrApiClient('YOUR_API_KEY'); // targets the hosted API by default
```

- The API key is a static bearer token attached as `Authorization: Bearer <key>`
  on every request. `pagr_test_*` keys cap batches at 10 documents per request
  and do not consume credit; `pagr_prod_*` keys render fully and consume
  organisation credit.
- `baseUrl` is optional and defaults to the hosted API (`DEFAULT_BASE_URL`,
  also exported); pass it only to target another instance.
- Swap the key at runtime with `client.setApiKey(newKey)` — takes effect on
  the next request.
- Options (third argument) — `new PagrApiClient(apiKey, baseUrl, { timeoutMs: 60_000, maxRetries: 2 })`:
  - `timeoutMs` — per-request timeout, default 30 seconds. Most render methods
    (`render`, `renderBatch`, `renderPdf`, `enqueueBatchRender`,
    `downloadDocument`) also accept a per-call `timeoutMs` override for a
    single slow request.
  - `maxRetries` — retries for transient failures on idempotent GETs, default
    2 (0 disables). See below.
- There is no token refresh, by design.
- No explicit disposal is needed: the client owns no pool of its own — it
  calls the global `fetch`, so there is no `dispose`/`close` to call and no
  context manager to enter. That is not the same as "no pooling exists":
  Node's process-global undici agent keeps sockets alive underneath `fetch`
  regardless (which can briefly keep a Node process from exiting), and this
  SDK neither owns nor can configure that agent. Construct one client and
  reuse it for the lifetime of your process.

### Retries & backoff

Idempotent **GET** requests are retried automatically on transient
server-side failures — HTTP 500/502/503/504, timeouts, and connection errors
— with capped exponential backoff and full jitter, honoring a `Retry-After`
header when the server sends one (integer seconds only, and clamped to a
maximum wait so a large or malformed value cannot stall your process).

- **429 is never retried** — it reflects your own request volume, so a
  `RateLimitError` (carrying `retryAfter` when present) surfaces for you to
  handle by slowing down.
- **Writes (POST/PATCH — every render and template edit) are never retried**:
  the API has no idempotency keys, so a request that was applied but whose
  response was lost must not be repeated (it would render/charge twice).
- Configure with `maxRetries` (default 2; `0` disables retries entirely).

## Templates & versions

```ts
const page = await client.getTemplates({ take: 50, sortBy: 'updatedAt', sortDirection: 'desc' });
for (const template of page) {
  console.log(template.name, template.latestVersionNumber);
}

const version = await client.getTemplateVersion(template.id); // omitted = latest published
```

List endpoints (`getTemplates`, `getTemplateVersions`, `getDocuments`) share
a common `ListOptions` shape:

| Field           | Type              | Notes                                             |
| --------------- | ----------------- | ------------------------------------------------- |
| `skip`          | `number`          | Paging offset, defaults to 0 server-side          |
| `take`          | `number`          | Page size, server-clamped to 1-200                |
| `sortBy`        | `string`          | Field name                                        |
| `sortDirection` | `'asc' \| 'desc'` |                                                   |
| `search`        | `string`          | Free-text search                                  |
| `filters`       | `Filter[]`        | `{ field, op?, value }` — `op` defaults to `'eq'` |

`FilterOp` is one of `'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains'`.
Only the fields you set are sent as query params; an omitted/empty options
object sends no query at all. `getTemplates` accepts an optional `projectId`
in the same options object to scope to a project's templates.

Filters are **validated client-side** against the fields and operators each
endpoint actually supports: an unknown field, or an operator not allowed for a
field, throws before any request is sent. This is deliberate — the server
otherwise _ignores_ an unknown filter and returns the **unfiltered** result
set, so a typo such as `documentNam` for `documentName` would silently return
everything rather than failing. Validating up front turns that quiet
wrong-data outcome into an immediate error. The per-endpoint tables are
exported as `TEMPLATE_FILTERS`, `TEMPLATE_VERSION_FILTERS` and
`DOCUMENT_FILTERS` if you need to inspect them.

Use `page.hasMore` (`skip + items.length < total`) to drive manual paging —
there is no auto-paging iterator, matching every other Pagr SDK.

`updateDocumentNameTemplate(templateId, versionNumber, documentNameTemplate)`
takes `string | null` — pass an **explicit `null`**, not `undefined`, to
clear the pattern. `JSON.stringify` drops `undefined` keys entirely, so
`undefined` would silently do nothing.

`getPreviewImageUrl(templateId, versionNumber)` returns the URL of a version's
preview image, or `null` when that version has none.

## Rendering

### Single document

```ts
const result = await client.render(
  template.id,
  { Title: 'Hello' },
  {
    version: 3, // omit for latest published
    includeDocument: true, // inline Base64 bytes vs. metadata-only
    language: 'nl',
    persist: true, // false = do not store server-side
  },
);

if (result.ok) {
  await result.document!.save('./output'); // or result.document!.toBytes()
} else {
  console.log(result.status, result.issues);
}
```

`data` accepts a JSON string or any JSON-serialisable value (plain object,
array).

With `persist: false` nothing is stored server-side. You still get the same
`RenderResult`, but the document's **`id` and `viewUrl` are `null`** — there is
no stored record to reference — and the PDF bytes are always included inline
regardless of `includeDocument`, since they are then the only copy. So
`result.document.toBytes()` and `.save()` work either way:

```ts
const draft = await client.render(template.id, data, { persist: false });
draft.document?.id; // null — nothing was stored
draft.document?.toBytes(); // still works: bytes are forced inline
```

Both are `null` rather than an empty string or a zero GUID, so "not persisted"
stays distinguishable from "blank". `RenderDocument`, returned by the
document-browsing endpoints, always has a real `id`/`viewUrl` — those endpoints
only list documents that were stored.

### Raw PDF render

```ts
const result = await client.renderPdf(template.id, { Title: 'Hello' }, { persist: true });
if (result.ok) {
  await result.document!.save('./output'); // or result.document!.toBytes()
} else {
  console.log(result.status, result.issues); // blocked/failed — a business outcome
}
```

`renderPdf` opts into the `Accept: application/pdf` path: the API streams the
PDF binary directly (carrying metadata in `X-Pagr-*` headers) rather than the
Base64-in-JSON envelope `render` returns. Single-document only. When the
document is blocked or fails there is no PDF to stream, so the API returns a
422 envelope — surfaced as a failed `PdfRenderResult` (`result.ok === false`),
never thrown.

### Batch render

```ts
const result = await client.renderBatch(template.id, [doc1, doc2, doc3], { includeDocument: true });
console.log(`${result.succeeded.length} ok, ${result.failed.length} failed`);
for (const item of result) {
  console.log(item.index, item.ok, item.document?.documentName);
}
await result.saveAll('./output');
```

A batch always comes back as the JSON envelope. The result correlates each submitted
input to its rendered document or the issues that prevented it from rendering.

**Correlation contract:** every rendered document reports its own `documentIndex` — the
zero-based position of the input that produced it — so it lands on exactly that item.
That index is the only correlation: a document whose index is absent or out of range is
dropped, never matched by list position. Issues attach the same way via
`RenderIssue.documentIndex` (batch-wide issues, whose index is `null`, attach to every
item). An item left with neither a document nor an issue gets a synthetic
`'Unknown'`/`'Error'` "not rendered" issue.

`insufficientCredit` (`status === 'insufficient_credit'`) means the batch stopped early
because the organisation ran out of credit. `missingCount` is `requestedCount -
renderedCount` (computed by the SDK, since that subtraction is the field's definition),
and `ok` is `true` only when it is `0` and credit held — so `ok` answers "did the whole
batch render", while `failed` answers it slot by slot.

### Async render (fire-and-forget)

```ts
const job = await client.enqueueBatchRender(template.id, dataSets, callbackUrl, options);
// job.jobId, job.requestedCount, job.state ("queued")
```

The server renders in the background and POSTs webhooks to `callbackUrl`:
one `RenderProgress` per rendered document, plus a final `RenderCompletion`
(N+1 callbacks total). Each delivery carries three headers:

| Header             | Meaning                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| `X-Pagr-Signature` | `t=<unix seconds>,v1=<hex>` — HMAC proof the POST came from Pagr. See below.     |
| `X-Pagr-Event`     | `render.progress`, `render.completed` or `render.failed`.                        |
| `X-Pagr-Delivery`  | Stable id for one logical delivery; **retries repeat it**, so deduplicate on it. |

Delivery is **best-effort with retries** (up to 5 attempts, exponential backoff
from 2s, 30s timeout per attempt) and runs with bounded parallelism (16
concurrent), so callbacks can arrive **out of order and more than once** — keep
your handler idempotent, deduplicate on `X-Pagr-Delivery`, and respond quickly.
Polling (`getJobStatus`/`waitForJob`, below) remains the authoritative signal.

Verify the signature and parse in one step with `parseSignedCallback` — the
preferred entry point, since anyone who discovers your callback URL can POST
to it:

```ts
import { createServer } from 'node:http';
import { PagrSignatureError, RenderCompletion, RenderProgress, parseSignedCallback } from 'pagr-sdk';

const SECRET = process.env.PAGR_WEBHOOK_SECRET!;

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    let callback;
    try {
      callback = parseSignedCallback(
        Buffer.concat(chunks), // the raw bytes, never a re-serialized object
        req.headers['x-pagr-signature'],
        SECRET,
      );
    } catch (err) {
      if (err instanceof PagrSignatureError) return res.writeHead(400).end(); // not from Pagr
      throw err;
    }
    if (callback instanceof RenderProgress) {
      // processed / requestedCount, and documentIndex to correlate back to the input
      console.log(callback.progressPct, callback.documentIndex, callback.document.documentName);
    } else if (callback instanceof RenderCompletion) {
      // state (terminal lifecycle), status (outcome), missingCount, issues
      console.log(callback.state, callback.status, callback.renderedCount, callback.missingCount);
    }
    res.writeHead(204).end();
  });
}).listen(8765);
```

> ⚠️ **Pass the raw body bytes.** The signature covers the exact bytes Pagr
> POSTed. A body your framework parsed to an object and you re-serialized will
> _not_ verify, even though the JSON value is identical — key order, separators
> and whitespace all change the bytes. This is the most common cause of a
> signature that "should" match but doesn't. Read the body before any JSON
> middleware touches it: in Express, `express.raw({ type: 'application/json' })`
> on the callback route (or `express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })`),
> not `express.json()` alone.

Get the secret from **Settings → API keys** in the Pagr web app; it is
per-organisation. It is not exposed on the `/v1` API, so no client method
fetches it — copy it into your receiver's configuration. Rotating it there
keeps the old secret valid for a 24-hour grace period (Pagr signs with both and
verification accepts either), so you can deploy the new value without dropping
deliveries.

`verifySignature(body, header, secret)` is available separately if you need to
verify without parsing — e.g. to reject a bad delivery before queueing the raw
body for later processing. Both throw `PagrSignatureError` on any failure
(missing/malformed header, timestamp outside the 5-minute replay window, no
matching signature) rather than returning a boolean, so a forgotten check cannot
silently let a forged callback through. Widen or narrow the replay window with
`{ toleranceMs }` (default `DEFAULT_SIGNATURE_TOLERANCE_MS`, 300 000 ms) if your
clock skew demands it; `{ nowMs }` injects a clock for tests. An **empty secret
throws `TypeError`, not `PagrSignatureError`** — a misconfigured receiver (unset
env var) stays distinguishable from a forged callback, and there is no
"no secret → pass through" mode.

```ts
import { parseCallback, RenderProgress, RenderCompletion } from 'pagr-sdk';

const callback = parseCallback(requestBody); // a JSON string or pre-parsed object
```

`parseCallback` is the unauthenticated form: it validates the payload shape and
throws `PagrDecodeError` for a body (or malformed JSON string) that matches
neither the progress nor the completion shape — rather than silently mis-parsing
it — but it proves nothing about where the payload came from. Use it only where
provenance is already established (a body you verified yourself, a replay from
your own store, a test); use `parseSignedCallback` on the live endpoint. If you
truly have no secret configured, put an unguessable token in the `callbackUrl`
you register and reject requests that don't carry it.

This SDK ships a parser/verifier only — no bundled HTTP server — bring your own
(node:http, Express, Fastify, ...).

Polling is a reliable alternative or complement to webhooks and needs no
public server. `waitForJob` wraps the poll loop:

```ts
const status = await client.waitForJob(job.jobId, { pollIntervalMs: 1000, timeoutMs: 120_000 });
console.log(status.state, status.ok, status.completedAt, status.failureReason);
```

It polls until the job reaches a terminal state, throwing `PagrTimeoutError`
if the overall `timeoutMs` elapses first.

**`timeoutMs` defaults to `DEFAULT_WAIT_FOR_JOB_TIMEOUT_MS` (300 000 ms — five
minutes)**, so a job that never reaches a terminal state — a stuck server, a
lost webhook, a bug — cannot hang the caller forever. Pass
`timeoutMs: Infinity` to opt out and poll with no deadline at all (still
abortable via `signal`):

```ts
import { DEFAULT_WAIT_FOR_JOB_TIMEOUT_MS } from 'pagr-sdk';

await client.waitForJob(job.jobId); // 5-minute deadline
await client.waitForJob(job.jobId, { timeoutMs: Infinity }); // no deadline
```

If you were previously passing a large sentinel expecting unbounded polling,
this default is a breaking change — use `Infinity` explicitly.

A job's lifecycle `state`
and render `status` (outcome) are separate: `status.done` is `true` at a
terminal `state` — and treats an unrecognised state as terminal (fail-open),
so a new server state can never trap the loop forever. Or drive it yourself
with `getJobStatus` if you prefer.

## Validation

```ts
const response = await client.validate(template.id, data, { version: 3 });
if (!response.isValid) {
  for (const issue of response) console.log(issue.description);
}
```

Consumes no credit. A single document whose value is (or JSON-decodes to)
an array is treated as a batch; passing an explicit array validates exactly
that set, one document per element.

`ValidationResponse` is iterable over every issue, and also exposes
`errors` and `warnings` (filtered by severity) plus `isValid`. `isValid` is
the **production gate**: it is `true` only when no issue has `'Warning'` or
`'Error'` severity. For the narrower, Error-only check, inspect `errors`
directly. Use `response.issuesFor(index)` to get the issues for one document
in a batch — batch-wide issues, whose `documentIndex` is `null`, are
included for every index.

## Understanding render issues

Every render/validate/batch outcome carries a flat list of `RenderIssue`s:
`type` (category, e.g. `'SchemaInvalid'`, `'MissingBinding'`), `severity`
(`'Information' | 'Warning' | 'Error'`), `description`, `elementId?`, and
`documentIndex?` (`null` for single-document/batch-wide issues).

**Forward compatibility is load-bearing**: an unrecognized `type` string
from the server parses to `'Unknown'` (fails open); an unrecognized or
missing `severity` parses to `'Error'` (fails closed — the more blocking
option, so a new severity value never silently passes as harmless). A new
server-side issue type or severity will never crash this SDK.

`'Error'` blocks rendering everywhere; `'Warning'` blocks production
rendering but not test/preview; `'Information'` never blocks. Use
`isRenderIssueSeverityAtLeast`/`isRenderIssueSeverityBlockingProduction` for
ordered severity comparisons — `>=` on the string-literal union would compare
alphabetically, not by blocking severity.

## Documents & fonts

```ts
const page = await client.getDocuments({ take: 20 });
const doc = await client.getDocument(id);
const bytes = await client.downloadDocument(id); // Uint8Array
const fonts = await client.getFonts(); // string[]
```

These endpoints browse documents the API already stored, so they are only
populated for renders made with `persist: true` (the default).

A stored PDF can be purged by the retention policy while its metadata stays
available: such a document has `isPdfDeleted === true`, and
`downloadDocument` then fails with HTTP 410 (an `ApiError` carrying
`code === 'PdfDeleted'`). Check the flag before downloading if you are
walking older documents.

## Organisation stats

```ts
const stats = await client.getOrgStats();
console.log(stats.pagesAvailable, stats.tokensAvailable, stats.tier);
```

"Pages" is the render-credit unit (rendered document pages); "tokens" are AI
tokens spent by AI-assisted template features. Each has an included monthly
allowance, an amount used this period, and an amount remaining, all scoped to
the current billing period (`periodStart`–`periodEnd`).

Every count is **`number | null`**, not `number`: a field the API omits stays
`null` rather than collapsing to `0`, so "the server did not report this" stays
distinguishable from a genuine zero. Null-check before arithmetic. And `-1` in
`pagesAvailable`, `includedTokensPerMonth` or `tokensAvailable` means
_unlimited_ for the tier, so guard for that too:

```ts
const remaining = stats.pagesAvailable;
if (remaining === null) {
  // the API reported no page allowance
} else if (remaining !== -1 && remaining < 10) {
  // running low
}
```

## API health & version

```ts
await client.getStatus(); // true when healthy; throws PagrError otherwise
await client.getVersion(); // deployed API version string, or null
```

`getStatus` resolves `true` for a healthy API and throws (a 503 becomes an
`ApiError`) otherwise, so treat it as an assertion rather than a boolean to
branch on.

## Cancellation

Pass an `AbortSignal` as `signal` to abandon an in-flight call — a user
navigating away, a request your own server no longer needs, a shutdown:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

try {
  const result = await client.render(templateId, data, { signal: controller.signal });
} catch (error) {
  if (error instanceof Error && error.name === 'AbortError') {
    // you cancelled it
  } else if (error instanceof PagrTimeoutError) {
    // the request ran past its own timeout
  }
}
```

**Abort and timeout are different outcomes.** A caller-initiated abort rejects
with the native `AbortError` `DOMException`, deliberately _not_ wrapped in a
`PagrError` — a cancellation you asked for is not an SDK failure. A request
that runs past its `timeoutMs` still rejects with `PagrTimeoutError`, as it
does without a signal. Both distinctions are the same ones the other SDKs
draw for `CancellationToken` (C#), `stop_token` (C++), `cancelled:` (Ruby) and
`asyncio` cancellation (Python).

**An abort interrupts waiting, not just requests.** It breaks a retry backoff
sleep and a `waitForJob` poll sleep immediately rather than letting the delay
run to completion, so cancellation is prompt even mid-backoff. `waitForJob`
also stops between polls, not only during the HTTP call.

**Per-method coverage.** `signal` is accepted by the methods where a call can
be long-running or expensive:

| Accepts `signal`                                                                                             | Does not                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `render`, `renderPdf`, `renderBatch`, `enqueueBatchRender`, `getJobStatus`, `waitForJob`, `downloadDocument` | `validate`, `getTemplates`, `getTemplate`, `getTemplateVersions`, `getTemplateVersion`, `updateDocumentNameTemplate`, `getPreviewImageUrl`, `getDocuments`, `getDocument`, `getFonts`, `getOrgStats`, `getStatus`, `getVersion` |

The right-hand column is short metadata traffic bounded by the client's own
`timeoutMs`; C# takes a `CancellationToken` on every public method, so this is
a deliberate narrower surface, not an oversight. Open an issue if you need
`signal` on one of them.

## Error handling

```ts
import { PagrError, AuthenticationError, NotFoundError } from 'pagr-sdk';

try {
  await client.getTemplate(id);
} catch (err) {
  if (err instanceof NotFoundError) {
    // specific handling
  } else if (err instanceof PagrError) {
    // generic handling — check err.statusCode / err.code
  } else {
    throw err; // not a Pagr error at all
  }
}
```

| HTTP status                         | Error class             |
| ----------------------------------- | ----------------------- |
| 401                                 | `AuthenticationError`   |
| 403                                 | `ForbiddenError`        |
| 404                                 | `NotFoundError`         |
| 413                                 | `PayloadTooLargeError`  |
| 422                                 | `ValidationFailedError` |
| 429                                 | `RateLimitError`        |
| Timeout                             | `PagrTimeoutError`      |
| Connection/DNS/TLS                  | `PagrConnectionError`   |
| Unparseable body                    | `PagrDecodeError`       |
| Response missing a guaranteed field | `PagrDecodeError`       |
| Unverifiable webhook signature      | `PagrSignatureError`    |
| Anything else                       | `ApiError`              |

All extend `PagrError` (itself extends `Error`), so a single
`catch (err) { if (err instanceof PagrError) }` handles every failure the SDK
can produce. HTTP errors carry `statusCode` and `code` (the API's
machine-readable error code, when present — `undefined` if the error body
wasn't the expected `{"error":{...}}` shape). `RateLimitError` additionally
carries `retryAfter` (seconds) when the server sends a `Retry-After` header.

**Transport failures wrap into the same tree** so callers never see a raw
`fetch` exception: a timeout throws `PagrTimeoutError`, any other connection
failure throws `PagrConnectionError`, and a successful response whose body is
not the JSON the SDK expects throws `PagrDecodeError`. The first two carry no
`statusCode`/`code`; `PagrDecodeError` carries the response's status. All three
expose the underlying failure as the standard `cause`.

**Business outcomes are data, never exceptions.** A failed validation,
insufficient credit, or a per-document render failure inside a batch all
surface as fields on the result object (`status`, `.ok`, `.insufficientCredit`,
`.issues`) — they are never thrown. Only transport/HTTP failures throw.

**What is _not_ wrapped**, by design: a malformed JSON _string_ you pass into
`render`/`validate` throws a plain `SyntaxError` before any request is sent
(it is your input, not a Pagr response); and a client-side
filter with an unknown field or operator throws a plain `Error` (see Templates
& versions above); and an empty webhook signing secret passed to
`verifySignature`/`parseSignedCallback` throws `TypeError`. All three are
programming/configuration errors surfaced eagerly, so they are deliberately not
`PagrError`s — in particular, a `catch (err instanceof PagrError)` around a
webhook handler must not turn an unset `PAGR_WEBHOOK_SECRET` into "this callback
looks forged".

## Gotchas

- **Getters do not appear in `JSON.stringify`.** `.ok`, `.hasMore`,
  `.isValid` and friends are class accessors, not own enumerable properties,
  so `JSON.stringify(result)` omits them. Read them directly (`result.ok`)
  rather than round-tripping the result through JSON.
- **`documentNameTemplate: null` vs. omitted.** See the templates section
  above — always pass an explicit `null` to clear it.
- **Timestamps** parse to native `Date`. An offset-less ISO-8601 string from
  the API is assumed UTC (matching every other Pagr SDK) — this SDK does
  not use local/naive date types anywhere.
- **UUIDs are plain strings**, not a typed wrapper — pass/compare them as
  ordinary strings.
- **`RenderedDocument.id`/`viewUrl` are nullable**, and only for
  `persist: false`. See [Single document](#single-document) above.
- **Saving appends `.pdf` by suffix, not by "has an extension".** A document
  name comes from the version's document-name template and often embeds bound
  values, so `Invoice 2024.10` saves as `Invoice 2024.10.pdf` — the trailing
  `.10` is data, not a file extension. Passing `save()` an explicit file path
  (rather than a directory) writes exactly that path, with no extension added.
- **Webhook signatures verify against raw bytes only.** `parseSignedCallback`
  and `verifySignature` need the exact bytes Pagr POSTed; a payload your
  framework parsed and you re-serialized never verifies. `parseCallback` is the
  one that takes an already-parsed object — and it verifies nothing.
- **Callbacks can arrive twice, and out of order.** Deliveries are retried (up
  to 5 attempts) with bounded parallelism, so dedupe on `X-Pagr-Delivery` and
  keep the handler idempotent.
- **A malformed response throws `PagrDecodeError`.** Document models require
  the fields the API guarantees rather than defaulting them, so a truncated or
  wrong-shaped body fails loudly instead of decoding into an object full of
  empty strings and zeros.

## Scope (Node-only)

This SDK targets Node.js only. The API key is a secret bearer token, so using
it directly from a browser would expose it to anyone inspecting the page —
proxy Pagr calls through your own backend instead.

This is enforced structurally as well as advised: `RenderedDocument.save()` and
`RenderDocument.save()` import `node:fs/promises` statically, so a browser
bundler fails at _module load_ time rather than at the moment `.save()` is
called.
