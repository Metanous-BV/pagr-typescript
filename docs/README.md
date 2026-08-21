# Pagr TypeScript SDK — Documentation

`pagr-sdk` is the official TypeScript/Node.js client for the Pagr document-rendering
API. You give it a template and some JSON data; it returns rendered PDFs — one
at a time, in batches, or as fire-and-forget background jobs with webhook
callbacks.

```ts
import { PagrApiClient } from 'pagr-sdk';

const client = new PagrApiClient('pagr_prod_…');
const result = await client.render(templateId, { Title: 'Hello' }, { includeDocument: true });
if (result.ok) {
  await result.document!.save('./out');
}
```

## Where to go next

| Doc                               | For                                     | Read it if you…                                   |
| --------------------------------- | --------------------------------------- | ------------------------------------------------- |
| **[User Guide](./user-guide.md)** | Application developers using the SDK    | …want to render documents from your own Node app. |
| **[Examples](../examples/)**      | Anyone who prefers running working code | …want a runnable script per topic to copy from.   |

## What it covers

- **Templates** — list templates and versions, read sample data, update the
  document-name template, fetch preview images.
- **Rendering** — single, raw-PDF, synchronous batch, and asynchronous
  (webhook or polling) renders.
- **Validation** — check data against a template without rendering or spending
  credit.
- **Documents** — list, fetch metadata for, and download previously rendered
  PDFs.
- **Fonts, org stats and meta** — list available fonts, read the organisation's
  usage and credit, and check API health and version.

## Key facts at a glance

- **Zero runtime dependencies.** Native `fetch`, native `Date`, no packages
  pulled into your tree.
- **Node.js 18 or later, not the browser.** The API key is a secret bearer
  token; see [Scope](./user-guide.md#scope-node-only).
- **Auth is a bearer API key** prefixed `pagr_test_` or `pagr_prod_` — the
  prefix decides test versus production mode server-side.
- **HTTP and transport failures throw typed errors**, all extending `PagrError`.
- **Business outcomes are data, not errors.** A render that fails validation or
  runs out of credit comes back as a normal result object you inspect; it does
  _not_ throw.
- **No disposal needed.** The client owns no pool of its own to close — it
  calls the global `fetch`, so there's nothing on the `PagrApiClient` object
  to dispose. That is not the same as "no pooling exists": Node's
  process-global undici agent keeps sockets alive underneath `fetch`
  regardless, which this SDK neither owns nor can configure. Construct one
  client and reuse it for the lifetime of your process.

## Source layout

```
src/
  index.ts         # curated public exports
  client.ts        # PagrApiClient — the full method surface
  http.ts          # HttpTransport — fetch wrapper, error mapping, retries (internal)
  errors.ts        # PagrError hierarchy
  filters.ts       # canonical per-endpoint filter field/operator tables
  list-options.ts  # ListOptions / Filter / FilterOp / SortDirection
  webhook.ts       # RenderProgress / RenderCompletion / parseCallback,
                   #   plus signature verification (verifySignature /
                   #   parseSignedCallback)
  models/          # one file per resource area
    template.ts    # Template, TemplateVersion
    render.ts      # RenderResult, BatchRenderResult, RenderJob, issues, enums
    document.ts    # RenderDocument, PagedResult<T>
    validation.ts  # ValidationResponse
    organisation.ts# OrgStats
tests/             # Vitest suite, mirroring src/
examples/          # 10 runnable topic scripts (see examples/README.md)
```

`src/index.ts` is the authoritative list of public exports; anything not
re-exported there (such as `HttpTransport`) is internal and may change without
a major version bump.
