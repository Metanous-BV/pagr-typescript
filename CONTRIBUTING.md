# Contributing

We welcome bug reports, feature requests, and code contributions in a pull
request.

For most pull requests, please open an
[issue](https://github.com/Metanous-BV/pagr-typescript/issues/new) first so we
can agree on an approach before you put in the work. Fixing typos or
documentation issues doesn't need one; anything that introduces substantial
code changes, changes the public interface, or if you're not sure — please
open an issue first.

This document covers the maintainer side: how to build the SDK, the testing
conventions the suite follows, and the release process. If you only want to
*use* the SDK, read the [User Guide](docs/user-guide.md) instead.

## Compatibility

This SDK targets **Node.js 18 or later**. We can't accept a contribution that
requires a newer minimum version without discussing it in the issue first —
see [Versioning policy](#versioning-policy) below.

## Set up your dev environment

From the repository root:

```bash
npm install
npm run build
```

The library has **no runtime dependencies** — only native `fetch` and Node
builtins. `typescript`, `tsup`, and `vitest` are dev-only and never reach
consumers.

### Running tests

```bash
npm test
```

No live API is needed — the suite is fully self-contained. HTTP is exercised
against a real loopback `http.Server` (see `tests/helpers/test-server.ts`),
scripted per test, rather than mocked at any abstraction layer.

## Testing conventions

- **Mock at the HTTP layer** with the local `TestServer` fixture, never by
  stubbing or subclassing `PagrApiClient`. This exercises path building,
  query-parameter cleaning and error mapping for real.
- **Assert the request**, not just the parsed result — a route regression is
  easy to miss otherwise. `TestServer#last` captures the last path, query,
  headers and body for exactly this.
- **Cover both paths:** the happy JSON response *and* at least one error
  status mapping to its typed exception. Every `PagrError` subclass should
  have a test that provokes it.
- **Binary/PDF branches get their own test.** Streaming bytes, `X-Pagr-*`
  header metadata and `save()` path handling do not share a code path with
  the JSON branch.
- **Business outcomes are not exceptions.** A failed validation or
  insufficient credit comes back as data on the result object; assert that
  it does *not* throw.
- Model tests should assert camelCase mapping, fail-open enum behaviour (an
  unknown value becomes `'unknown'`, never a thrown error unless a field is
  genuinely malformed) and nullable-vs-default handling.
- A field that is **present but the wrong shape** must raise a typed decode
  error, exactly like a missing field — never a raw `JSON.parse`/runtime
  exception.

`examples/` hits a **live** API and needs a real API key. The scripts are run
manually only (see [`examples/README.md`](examples/README.md)) and are never
part of an automated test run — CI does not execute them.

## Build & release

```bash
npm run typecheck
npm test
npm run build
```

Inspect what gets published before tagging:

```bash
npm pack --dry-run
```

The published package (`files` in `package.json`) must contain only
`dist/`, `README.md`, and `LICENSE` — no test or example sources.

Release checklist:

1. Bump the version in `package.json` (SemVer) — the single source of truth.
2. Update `README.md` and the [User Guide](docs/user-guide.md) if the surface
   changed.
3. Add a `CHANGELOG.md` entry.
4. `npm test` green in CI (Node 18+, Linux and Windows).
5. `npm run build`, then inspect the package as above.
6. Tag the release and publish to npm.

## Getting help

Working on the SDK and stuck? Join us on our
[Discord server](https://discord.gg/GajJxfKXZ5) — Pagr engineers are there.
Bugs and feature requests belong in
[GitHub issues](https://github.com/Metanous-BV/pagr-typescript/issues).
