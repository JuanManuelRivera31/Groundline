import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { generationLimitDefaults } from '@groundline/core';
import { PgDb } from '@groundline/db/node';
import { loadConfig } from '@groundline/evals';
import { createApp, runRetention } from '../app.ts';
import { parseApiConfig } from '../config.ts';
import { errorLabel, jsonLogger } from '../logger.ts';

/** Local entry point (`pnpm dev:api`): Hono on Node over the Docker Postgres pool. */
async function main(): Promise<void> {
  const appConfig = loadConfig(); // also loads .env into process.env
  const config = parseApiConfig(process.env, 'node');
  const logger = jsonLogger();
  const db = new PgDb(appConfig.databaseUrl);
  const pending = new Set<Promise<unknown>>();

  const app = createApp({
    config,
    appConfig,
    openStore: () => ({ store: db, close: () => Promise.resolve() }),
    clientInfo: (c) => {
      const header = config.devCountryHeader ? c.req.header('x-groundline-dev-country') : undefined;
      return { ip: getConnInfo(c).remote.address ?? null, country: header ?? config.devCountry };
    },
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
    webhookFetch: (url, init) => fetch(url, init),
    logger,
    defer: (_c, task) => {
      pending.add(task);
      void task.finally(() => pending.delete(task));
    },
  });

  await db.ping();
  const purge = async (): Promise<void> => {
    try {
      const r = await runRetention(db, config, Date.now());
      logger.info({ event: 'retention', count: r.conversations + r.rateLimitEvents });
    } catch (error) {
      logger.error({ event: 'retention_failed', error: errorLabel(error) });
    }
  };
  await purge();
  const timer = setInterval(() => void purge(), 24 * 60 * 60 * 1000);
  timer.unref();

  const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' });
  const notes = [
    `Groundline API on http://127.0.0.1:${config.port} (model chain ${appConfig.generation.models.join(' → ')}, budget ${appConfig.generation.liveBudgetMs} ms, hedge ${appConfig.generation.hedgeAfterMs} ms)`,
    `Limits: ${config.rateLimitPerMinute}/min and ${config.rateLimitPerDay}/day per IP, ${config.maxQuestionChars} chars, daily AI cap ${config.demoDailyGenCap} per model, retention ${config.retentionDays} days`,
    `CORS origins: ${config.corsOrigins.length > 0 ? config.corsOrigins.join(', ') : '(none)'}`,
    `Admin API: ${config.adminToken ? 'enabled' : 'disabled (ADMIN_TOKEN not set)'} | hand-off webhook: ${config.handoffWebhook ? config.handoffWebhook.format : 'not configured (demo)'}`,
    `Country: ${config.devCountry ?? 'none (allowed locally)'}${config.devCountryHeader ? ', x-groundline-dev-country header honoured' : ''}`,
  ];
  if (config.ipHashSecretGenerated) notes.push('Warning: IP_HASH_SECRET not set; using a random key for this process.');
  const missing = generationLimitDefaults(appConfig);
  if (missing.length > 0) notes.push(`Warning: ${missing.join(', ')} not set; using default generation limits.`);
  for (const line of notes) console.log(line);

  const shutdown = (): void => {
    clearInterval(timer);
    server.close();
    void Promise.allSettled([...pending]).then(() => db.close());
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
