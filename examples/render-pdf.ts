// Raw-PDF rendering: the opt-in `Accept: application/pdf` path.
//
// Unlike render() (which returns the JSON envelope, with bytes Base64-inline
// when includeDocument:true), renderPdf() streams the PDF binary directly and
// reads document metadata from X-Pagr-* response headers. Single-document only.
// A blocked/failed render comes back as a failed PdfRenderResult (business
// outcome), never thrown.
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

  const result = await client.renderPdf(template.id, version.sampleData, {
    version: version.versionNumber,
    persist: true,
  });

  if (!result.ok) {
    console.log(`Render blocked/failed (${result.status}): ${result.message ?? ''}`);
    for (const issue of result.issues) {
      console.log(`  [${issue.severity}] ${issue.type}: ${issue.description}`);
    }
    return;
  }

  const doc = result.document!;
  console.log(
    `Rendered ${doc.documentName}: ${doc.pageCount} page(s), ` +
      `${doc.content.length} bytes, id=${doc.documentId ?? '(not persisted)'}`,
  );
  console.log(`Saved to ${await doc.save(outputDir)}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
