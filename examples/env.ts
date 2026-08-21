import { PagrApiClient } from '../src/index.js';

export const baseUrl = process.env['PAGR_BASE_URL'];
export const apiKey = process.env['PAGR_API_KEY'];
export const outputDir = process.env['PAGR_OUTPUT_DIR'] ?? './output';

/** Builds a client from env vars, or logs setup instructions and returns `null`. */
export function createClient(): PagrApiClient | null {
  if (!apiKey) {
    console.log(
      'Set PAGR_API_KEY (and optionally PAGR_BASE_URL) to run this example against a live API.',
    );
    return null;
  }
  return new PagrApiClient(apiKey, baseUrl);
}
