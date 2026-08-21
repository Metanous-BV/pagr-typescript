// Validating document data against a template without rendering (consumes no credit).
import { createClient } from './env.js';
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

  const validSample = await client.validate(template.id, version.sampleData, {
    version: version.versionNumber,
  });
  console.log(`Sample data valid: ${validSample.isValid}`);

  // An empty document will typically surface missing-binding issues.
  const empty = await client.validate(template.id, {}, { version: version.versionNumber });
  console.log(`Empty document valid: ${empty.isValid}`);
  for (const issue of empty.issues) {
    console.log(`  [${issue.severity}] ${issue.type}: ${issue.description}`);
  }

  // An explicit array validates a batch — one set of issues per document,
  // correlated by documentIndex.
  const batch = await client.validate(template.id, [version.sampleData, {}]);
  console.log(
    `Batch: doc 0 issues=${batch.issuesFor(0).length}, doc 1 issues=${batch.issuesFor(1).length}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
