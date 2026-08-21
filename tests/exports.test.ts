/**
 * Guards the package entry point. `src/index.ts` is the only module a consumer
 * imports from, so a symbol that exists in `src/client.ts` but is not re-exported
 * here is unreachable no matter what the docs say — which is exactly how
 * `DEFAULT_WAIT_FOR_JOB_TIMEOUT_MS` came to be referenced by `waitForJob`'s JSDoc
 * while being impossible to import.
 */
import { describe, expect, it } from 'vitest';

import * as pagr from '../src/index.js';
import { DEFAULT_WAIT_FOR_JOB_TIMEOUT_MS } from '../src/client.js';

describe('public exports', () => {
  it('re-exports the documented client constants', () => {
    expect(pagr.DEFAULT_BASE_URL).toBeTypeOf('string');
    expect(pagr.DEFAULT_WAIT_FOR_JOB_TIMEOUT_MS).toBe(DEFAULT_WAIT_FOR_JOB_TIMEOUT_MS);
  });

  it('exports the client, the error tree and the models', () => {
    for (const name of [
      'PagrApiClient',
      'PagrError',
      'PagrSignatureError',
      'PagrTimeoutError',
      'PagedResult',
      'PdfDocument',
      'RenderResult',
      'TemplateVersion',
      'ValidationResponse',
      'parseCallback',
      'parseSignedCallback',
      'verifySignature',
      'validateFilter',
    ]) {
      expect(pagr, `index.ts does not export ${name}`).toHaveProperty(name);
    }
  });
});
