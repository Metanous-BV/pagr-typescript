// Browsing previously rendered documents and downloading their bytes.
import { createClient, outputDir } from './env.js';

async function main(): Promise<void> {
  const client = createClient();
  if (!client) {
    return;
  }

  const page = await client.getDocuments({ take: 10, sortBy: 'renderedAt', sortDirection: 'desc' });
  console.log(
    `${page.total} rendered document(s) total; showing the ${page.items.length} most recent.`,
  );

  const fonts = await client.getFonts();
  console.log(
    `${fonts.length} font(s) available: ${fonts.slice(0, 5).join(', ')}${fonts.length > 5 ? ', ...' : ''}`,
  );

  const first = page.items[0];
  if (!first) {
    console.log('No rendered documents yet.');
    return;
  }
  console.log(`Most recent: ${first.toString()} (${first.pageCount} page(s))`);

  const bytes = await client.downloadDocument(first.id);
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await writeFile(join(outputDir, `${first.documentName}.pdf`), bytes);
  console.log(`Downloaded ${bytes.length} bytes to ${outputDir}.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
