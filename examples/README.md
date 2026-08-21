# Examples

Runnable, single-topic scripts — each is self-contained and doubles as
idiomatic-usage documentation. They hit a **live** Pagr API, so run them
manually; they are never part of the automated test suite (`npm test`).

| Script                                     | Covers                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| [`getting-started.ts`](getting-started.ts) | Connect, pick a template, render, save the PDF                                 |
| [`templates.ts`](templates.ts)             | Listing/paging templates, versions, filters, preview images                    |
| [`render-single.ts`](render-single.ts)     | Single render: with/without inline bytes, `persist: false`                     |
| [`render-pdf.ts`](render-pdf.ts)           | Raw-PDF render (`Accept: application/pdf`) via `renderPdf`                     |
| [`render-batch.ts`](render-batch.ts)       | Batch rendering and per-input correlation                                      |
| [`batch-async.ts`](batch-async.ts)         | Fire-and-forget batch render, signed-webhook verification/parsing, and polling |
| [`validate.ts`](validate.ts)               | Validating data without rendering                                              |
| [`documents.ts`](documents.ts)             | Browsing rendered documents, fonts, downloading bytes                          |
| [`account.ts`](account.ts)                 | Organisation usage/credit statistics                                           |
| [`error-handling.ts`](error-handling.ts)   | The `PagrError` hierarchy and business-outcome-vs-exception rule               |

## Setup

Set these environment variables (e.g. via a `.env` file loaded with Node's
built-in `--env-file` flag, Node 20.6+):

```
PAGR_BASE_URL=https://your-instance   # optional — defaults to the hosted Pagr API if unset
PAGR_API_KEY=pagr_test_...            # required — examples print setup instructions if unset
PAGR_OUTPUT_DIR=./output              # where rendered PDFs get saved; defaults to ./output
PAGR_WEBHOOK_URL=https://webhook.site/your-inbox   # only used by batch-async.ts
```

Never commit a real API key — read it from the environment, as every
example already does.

## Running an example

This package has no example-runner dependency of its own (kept out of the
published SDK's dependency tree). The simplest zero-install way to run a
`.ts` file directly is [`tsx`](https://github.com/privatenumber/tsx) via
`npx` (downloads on first use, nothing added to `package.json`):

```bash
npx tsx examples/getting-started.ts
```

Alternatively, build the SDK once (`npm run build`) and compile the example
with `tsc`, or adapt it to import from `pagr-sdk` instead of `../src/index.js`
once the package is installed from npm.
