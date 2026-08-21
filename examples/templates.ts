// Browsing templates and versions: listing, paging, and reading a specific version.
import { createClient } from './env.js';

async function main(): Promise<void> {
  const client = createClient();
  if (!client) {
    return;
  }

  // Manual paging: getTemplates returns one page at a time; keep requesting
  // until PagedResult.hasMore is false.
  let skip = 0;
  const take = 20;
  const allTemplates = [];
  for (;;) {
    const page = await client.getTemplates({
      skip,
      take,
      sortBy: 'updatedAt',
      sortDirection: 'desc',
    });
    allTemplates.push(...page.items);
    if (!page.hasMore) {
      break;
    }
    skip += page.items.length;
  }
  console.log(`Found ${allTemplates.length} template(s).`);

  const first = allTemplates[0];
  if (!first) {
    console.log('No templates in this organisation yet.');
    return;
  }
  console.log(`First template: ${first.toString()}`);

  // Field filters use the indexed filters[i].field/op/value wire form.
  const filtered = await client.getTemplates({
    take: 5,
    filters: [{ field: 'name', op: 'contains', value: first.name.slice(0, 3) }],
  });
  console.log(`Templates matching a name filter: ${filtered.total}`);

  const versions = await client.getTemplateVersions(first.id, { take: 10 });
  console.log(`${first.name} has ${versions.total} version(s).`);

  if (first.latestVersionNumber !== null) {
    const latest = await client.getTemplateVersion(first.id, first.latestVersionNumber);
    console.log(`Latest published version: v${latest.versionNumber}`);

    const previewUrl = await client.getPreviewImageUrl(first.id, latest.versionNumber);
    console.log(`Preview image: ${previewUrl ?? '(none)'}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
