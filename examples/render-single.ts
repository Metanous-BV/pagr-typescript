// Single-document rendering: with/without inline bytes, and persist:false.
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

  // Metadata only (no inline bytes) — cheaper when you only need the document id/view URL.
  const metadataOnly = await client.render(template.id, version.sampleData, {
    version: version.versionNumber,
  });
  console.log(`Rendered (metadata only): ${metadataOnly.toString()}`);

  // With includeDocument:true, the PDF bytes are Base64-inline on the result.
  const withBytes = await client.render(template.id, version.sampleData, {
    version: version.versionNumber,
    includeDocument: true,
  });
  if (withBytes.ok) {
    console.log(`Saved to ${await withBytes.document!.save(outputDir)}`);
  }

  // persist:false skips server-side storage entirely; the server streams the
  // PDF directly and this SDK detects it via content-type — no different
  // from the JSON path above from the caller's perspective.
  const notPersisted = await client.render(template.id, version.sampleData, {
    version: version.versionNumber,
    includeDocument: true,
    persist: false,
  });
  console.log(
    `Not persisted, ${notPersisted.document?.fileSizeBytes ?? 0} bytes, not stored server-side.`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
