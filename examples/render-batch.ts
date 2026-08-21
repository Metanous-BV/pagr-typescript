// Batch rendering: many documents in one request, correlated back to their inputs.
import { createClient, outputDir } from './env.js';
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

  // Five copies of the same sample data, just to have a batch to render.
  const dataSets = Array.from({ length: 5 }, () => version.sampleData);

  const result = await client.renderBatch(template.id, dataSets, {
    version: version.versionNumber,
    includeDocument: true,
  });

  console.log(`Batch: ${result.succeeded.length} succeeded, ${result.failed.length} failed.`);
  if (result.insufficientCredit) {
    console.log('Stopped early — organisation is out of credit.');
  }

  // Each item correlates one submitted input (by position) to its outcome.
  for (const item of result) {
    console.log(item.toString());
  }

  const written = await result.saveAll(outputDir);
  console.log(`Saved ${written.length} document(s) to ${outputDir}.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
