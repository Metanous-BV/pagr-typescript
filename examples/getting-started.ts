// Your first render: connect, pick a template, render a document, save the PDF.
import { createClient, outputDir } from './env.js';
import { pickPublishedTemplate } from './pick-template.js';

async function main(): Promise<void> {
  const client = createClient();
  if (!client) {
    return;
  }

  // Check the service is reachable before doing any work.
  await client.getStatus();
  console.log(`Connected to Pagr API ${await client.getVersion()}`);

  const picked = await pickPublishedTemplate(client);
  if (!picked) {
    return;
  }
  const { template, version } = picked;

  // Every version carries sample data matching its bindings — a good
  // starting point for your own document. It's a JSON string, ready to pass
  // straight to render().
  const result = await client.render(template.id, version.sampleData, {
    version: version.versionNumber,
    includeDocument: true,
  });

  if (!result.ok) {
    console.log(`Render failed: ${result.message ?? result.status}`);
    for (const issue of result.issues) {
      console.log(`  [${issue.severity}] ${issue.description}`);
    }
    return;
  }

  const document = result.document!;
  console.log(
    `Rendered ${document.documentName}: ${document.pageCount} page(s), ${document.fileSizeBytes} bytes`,
  );
  console.log(`Saved to ${await document.save(outputDir)}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
