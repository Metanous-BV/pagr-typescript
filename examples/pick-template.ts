import type { PagrApiClient, Template, TemplateVersion } from '../src/index.js';

/** Finds a template with a published version, and that latest published version. */
export async function pickPublishedTemplate(
  client: PagrApiClient,
): Promise<{ template: Template; version: TemplateVersion } | null> {
  const templates = await client.getTemplates({ take: 50 });
  for (const template of templates) {
    if (template.latestVersionNumber === null) {
      continue;
    }
    const version = await client.getTemplateVersion(template.id, template.latestVersionNumber);
    return { template, version };
  }
  console.log('No published template found in this organisation.');
  return null;
}
