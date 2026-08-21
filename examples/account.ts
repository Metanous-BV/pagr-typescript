// Organisation usage and credit statistics.
import { createClient } from './env.js';

async function main(): Promise<void> {
  const client = createClient();
  if (!client) {
    return;
  }

  const stats = await client.getOrgStats();
  console.log(stats.toString());

  // Every count is `number | null` — `null` means the server omitted the field,
  // which is not the same as a genuine 0. And -1 means "unlimited for this tier".
  const pagesRemaining = stats.pagesAvailable;
  if (pagesRemaining === null) {
    console.log('The API reported no page allowance for this organisation.');
  } else if (pagesRemaining !== -1 && pagesRemaining < 10) {
    console.log('Warning: fewer than 10 pages remaining this billing period.');
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
