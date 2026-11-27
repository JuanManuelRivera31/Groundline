import { parseConfig, type EnvRecord } from '@groundline/core';
import { ClientDb } from '@groundline/db/workers';
import type { Hono } from 'hono';
import { createApp, runRetention } from './app.ts';
import { parseApiConfig } from './config.ts';
import { errorLabel, jsonLogger } from './logger.ts';

/**
 * Cloudflare Workers entry point (ADR-0013). Same app as Node; the differences
 * are only here: one pg.Client per request (ClientDb) through Hyperdrive or
 * DATABASE_URL, the client IP from CF-Connecting-IP, the country from
 * request.cf.country, waitUntil for deferred work, and a daily cron for retention.
 */

interface HyperdriveBinding {
  readonly connectionString: string;
}

interface WorkerEnv {
  readonly HYPERDRIVE?: HyperdriveBinding;
  readonly [name: string]: unknown;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface Built {
  readonly app: Hono<never>;
  readonly connectionString: string;
  readonly retention: () => Promise<void>;
}

const logger = jsonLogger();
// Bindings are fixed per deployment, so the app is built once per isolate.
const built = new WeakMap<object, Built>();

function envRecord(env: WorkerEnv): EnvRecord {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
  return out;
}

function build(env: WorkerEnv): Built {
  const cached = built.get(env);
  if (cached) return cached;
  const vars = envRecord(env);
  const config = parseApiConfig(vars, 'workers');
  const appConfig = parseConfig(vars);
  const connectionString = env.HYPERDRIVE?.connectionString ?? vars.DATABASE_URL;
  if (!connectionString) throw new Error('No database: bind HYPERDRIVE or set DATABASE_URL.');
  const app = createApp({
    config,
    appConfig,
    openStore: () => {
      const db = new ClientDb(connectionString);
      return { store: db, close: () => db.close() };
    },
    clientInfo: (c) => {
      const cf = (c.req.raw as Request & { cf?: { country?: unknown } }).cf;
      return { ip: c.req.header('cf-connecting-ip') ?? null, country: typeof cf?.country === 'string' ? cf.country : null };
    },
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
    webhookFetch: (url, init) => fetch(url, init),
    logger,
    defer: (c, task) => {
      c.executionCtx.waitUntil(task);
    },
  });
  const retention = async (): Promise<void> => {
    const db = new ClientDb(connectionString);
    try {
      const r = await runRetention(db, config, Date.now());
      logger.info({ event: 'retention', count: r.conversations + r.rateLimitEvents });
    } finally {
      await db.close();
    }
  };
  const result: Built = { app: app as unknown as Hono<never>, connectionString, retention };
  built.set(env, result);
  return result;
}

function configError(error: unknown): Response {
  logger.error({ event: 'config_error', error: errorLabel(error) });
  return new Response(JSON.stringify({ error: { code: 'misconfigured', message: 'The service is not configured.' } }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
    let b: Built;
    try {
      b = build(env);
    } catch (error) {
      return configError(error);
    }
    return b.app.fetch(request, env, ctx as never);
  },

  scheduled(_controller: unknown, env: WorkerEnv, ctx: ExecutionContextLike): void {
    try {
      ctx.waitUntil(
        build(env)
          .retention()
          .catch((error: unknown) => {
            logger.error({ event: 'retention_failed', error: errorLabel(error) });
          }),
      );
    } catch (error) {
      logger.error({ event: 'config_error', error: errorLabel(error) });
    }
  },
};
