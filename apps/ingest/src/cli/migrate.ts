import { PgDb } from '@groundline/db/node';
import { loadConfig, redactDatabaseUrl } from '../env.ts';
import { errorMessage } from '../runtime.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`Migrating ${redactDatabaseUrl(config.databaseUrl)}`);
  const db = new PgDb(config.databaseUrl);
  try {
    const result = await db.migrate();
    console.log(`  applied: ${result.applied.length > 0 ? result.applied.join(', ') : 'none'}`);
    console.log(`  already applied: ${result.alreadyApplied.length > 0 ? result.alreadyApplied.join(', ') : 'none'}`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
