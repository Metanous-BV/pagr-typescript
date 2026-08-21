# Pagr TypeScript SDK

TypeScript/Node.js client for the Pagr document rendering API: manage
templates, render documents (single, batch, or fire-and-forget with
webhooks), validate data, and read organisation usage stats.

## Installation

Not yet published to npm — for now, install straight from GitHub.

```bash
npm install git+https://github.com/Metanous-BV/pagr-typescript.git
```

## Quickstart

```ts
import { PagrApiClient } from 'pagr-sdk';

const client = new PagrApiClient('YOUR_API_KEY');
// or, to target another instance: new PagrApiClient('YOUR_API_KEY', 'https://api.pagr.example')

const templates = await client.getTemplates();
const template = templates.items[0];

// Single render
const result = await client.render(template.id, { Title: 'Hello' });
console.log(result.document?.documentName);
```

The client is fully typed and zero-dependency (native `fetch` and Node
builtins, no runtime packages). All API errors derive from `PagrError`
(`AuthenticationError`, `ForbiddenError`, `NotFoundError`,
`PayloadTooLargeError`, `ValidationFailedError`, `RateLimitError`, or a generic
`ApiError`). Business outcomes — a failed validation or insufficient credit —
come back as data on the result object, not as exceptions.

Async-render callbacks are signed. Verify and parse one in a single call, from
the **raw** request body:

```ts
import { parseSignedCallback } from 'pagr-sdk';

const callback = parseSignedCallback(rawBodyBytes, req.headers['x-pagr-signature'], SECRET);
```

It throws `PagrSignatureError` for anything short of a proven-genuine callback.
The secret comes from Settings → API keys in the Pagr web app. See the
[user guide](docs/user-guide.md#async-render-fire-and-forget) for why the raw
bytes matter and how to deduplicate retried deliveries.

## Documentation

- [Quickstart](https://docs.pagr.eu/for-developers/quickstart/) — the official Pagr developer docs.
- [User guide](docs/user-guide.md) — the full walkthrough.
- [Docs index](docs/README.md)
- [Contributing](CONTRIBUTING.md)
- [Examples](examples/README.md)

Runnable scripts are in [`examples/`](examples/) — one per topic, from
[`getting-started.ts`](examples/getting-started.ts) to batch rendering,
webhooks, validation, and error handling. See the
[examples README](examples/README.md) for the full list and setup.

## Scope

This SDK targets Node.js (>=18) only, not the browser — the API key is a
secret bearer token, and browser usage would expose it.

## License

Apache-2.0 — see [LICENSE](LICENSE).

[Repository](https://github.com/Metanous-BV/pagr-typescript) ·
[Issues](https://github.com/Metanous-BV/pagr-typescript/issues)
