// The exception hierarchy and when to catch what.
//
// Transport and API failures throw PagrError subclasses. Business outcomes
// (failed validation, insufficient credit, per-document render failures) are
// DATA on the result objects — they never throw.
import { AuthenticationError, NotFoundError, PagrApiClient, PagrError } from '../src/index.js';
import { baseUrl, createClient } from './env.js';
import { pickPublishedTemplate } from './pick-template.js';

async function main(): Promise<void> {
  // 401: a bad key throws the most specific type first.
  const badClient = new PagrApiClient('not-a-real-key', baseUrl);
  try {
    await badClient.getTemplates();
  } catch (err) {
    if (err instanceof AuthenticationError) {
      console.log(
        `Caught AuthenticationError (HTTP ${err.statusCode}, code ${err.code}): ${err.message}`,
      );
    }
  }

  const client = createClient();
  if (!client) {
    return;
  }

  // 404: unknown ids map to NotFoundError.
  try {
    await client.getTemplate('00000000-0000-0000-0000-000000000000');
  } catch (err) {
    if (err instanceof NotFoundError) {
      console.log(`Caught NotFoundError: ${err.message}`);
    }
  }

  // Catch the base type when any API failure should be handled the same
  // way. Order matters: catch subclasses (via instanceof checks) before the
  // generic PagrError fallback.
  try {
    await client.getDocument('00000000-0000-0000-0000-000000000000');
  } catch (err) {
    if (err instanceof NotFoundError) {
      console.log('Specific handling: the document does not exist.');
    } else if (err instanceof PagrError) {
      console.log(`Generic handling for anything else: HTTP ${err.statusCode}`);
    } else {
      throw err;
    }
  }

  // Business outcome, not an exception: a failed render reports issues as data.
  const picked = await pickPublishedTemplate(client);
  if (picked) {
    const result = await client.render(picked.template.id, '{}');
    console.log(`\nRender of an empty document: ok=${result.ok} (no exception thrown)`);
    for (const issue of result.issues) {
      console.log(`  [${issue.severity}] ${issue.type}: ${issue.description}`);
    }
    if (result.insufficientCredit) {
      console.log('  Insufficient credit — also data, not an exception.');
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
