import { redactPii, type AppConfig } from '@groundline/core';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { conversationView, dailyView, groupGaps } from './admin.ts';
import { askQuestion, blockedByRegion, checkRateLimit, regionBlocked, type EngineClients, type Store } from './ask.ts';
import type { ApiConfig } from './config.ts';
import { constantTimeEqual, utcDayStart } from './crypto.ts';
import { deliverHandoff, handoffPayload, type WebhookFetch } from './handoff.ts';
import { errorLabel, type Logger } from './logger.ts';
import { API_MESSAGES, resolveLang } from './messages.ts';
import { normalizeCountry } from './region.ts';

export interface StoreHandle {
  readonly store: Store;
  /** Called once per request, after every deferred task has settled. */
  close(): Promise<void>;
}

export interface ClientInfo {
  /** Client IP, used only to compute the daily-salted hash; never stored or logged. */
  readonly ip: string | null;
  /** Raw country code from the platform (request.cf.country on Workers). */
  readonly country: string | null;
}

export interface AppDeps {
  readonly config: ApiConfig;
  /** Engine configuration (models, floor, budget…), unchanged from the CLI. */
  readonly appConfig: AppConfig;
  openStore(): StoreHandle;
  clientInfo(c: Context<ApiEnv>): ClientInfo;
  readonly now: () => number;
  readonly uuid: () => string;
  readonly webhookFetch: WebhookFetch;
  readonly logger: Logger;
  /** Keeps work alive after the response is sent (Workers: ctx.waitUntil). */
  defer(c: Context<ApiEnv>, task: Promise<unknown>): void;
  /** Tests only: offline Gemini fakes. */
  readonly engineClients?: EngineClients | undefined;
}

/** Hono environment of the API: per-request store and deferred-task hook. */
export interface ApiEnv {
  Variables: {
    store: Store;
    later: (task: Promise<unknown>) => void;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BODY_LIMIT_BYTES = 8 * 1024;
const DAY_MS = 86_400_000;
const RATE_LIMIT_EVENT_RETENTION_MS = 2 * DAY_MS;
const ADMIN_STATUSES = new Set(['answered', 'insufficient', 'handoff', 'declined', 'unavailable', 'articles_only', 'region_blocked']);
const GAP_ROWS = 2_000;

function apiError(code: string, message: string, extra: Record<string, unknown> = {}): { error: Record<string, unknown> } {
  return { error: { code, message, ...extra } };
}

type JsonBody = { ok: true; value: Record<string, unknown> } | { ok: false; code: 'invalid_json' | 'invalid_encoding' };

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Parses a JSON object body. Invalid UTF-8 is refused rather than decoded with
 * replacement characters, so garbled text never reaches the model or the database.
 */
async function readJsonObject(c: Context): Promise<JsonBody> {
  let text: string;
  try {
    text = utf8.decode(await c.req.arrayBuffer());
  } catch {
    return { ok: false, code: 'invalid_encoding' };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, code: 'invalid_json' };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, code: 'invalid_json' };
  }
}

function bodyError(code: 'invalid_json' | 'invalid_encoding', example: string): { error: Record<string, unknown> } {
  return code === 'invalid_encoding' ? apiError(code, 'The request body must be UTF-8.') : apiError(code, `Send a JSON object: ${example}.`);
}

/** Length in Unicode code points (what a person counts as characters, emoji aside). */
function codePoints(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

function intParam(raw: string | undefined, fallback: number, min: number, max: number): number | null {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function dateParam(raw: string | undefined): Date | undefined | null {
  if (raw === undefined || raw === '') return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Deletes conversations older than RETENTION_DAYS (cases cascade) and rate-limit events older than 2 days. */
export async function runRetention(store: Store, config: ApiConfig, now: number): Promise<{ conversations: number; handoffs: number; rateLimitEvents: number }> {
  return store.purgeExpired({
    conversationsBefore: new Date(now - config.retentionDays * DAY_MS),
    rateLimitBefore: new Date(now - RATE_LIMIT_EVENT_RETENTION_MS),
  });
}

export function createApp(deps: AppDeps): Hono<ApiEnv> {
  const { config, logger } = deps;
  const allowedOrigins = new Set(config.corsOrigins);
  const app = new Hono<ApiEnv>();

  app.use(
    '*',
    cors({
      origin: (origin) => (allowedOrigins.has(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );

  // CORS only stops browsers from reading responses; refuse foreign origins outright.
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin !== undefined && !allowedOrigins.has(origin)) return c.json(apiError('origin_not_allowed', 'This origin is not allowed.'), 403);
    await next();
    return undefined;
  });

  app.use('/v1/*', async (c: Context<ApiEnv>, next) => {
    const handle = deps.openStore();
    const tasks: Promise<unknown>[] = [];
    c.set('store', handle.store);
    c.set('later', (task) => {
      tasks.push(
        task.catch((error: unknown) => {
          logger.error({ event: 'deferred_task_failed', route: c.req.path, error: errorLabel(error) });
        }),
      );
    });
    try {
      await next();
    } finally {
      deps.defer(
        c,
        Promise.allSettled(tasks)
          .then(() => handle.close())
          .catch((error: unknown) => {
            logger.error({ event: 'store_close_failed', error: errorLabel(error) });
          }),
      );
    }
  });

  app.use(
    '/v1/*',
    bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: (c) => c.json(apiError('body_too_large', `The request body must be under ${BODY_LIMIT_BYTES} bytes.`), 413) }),
  );

  app.onError((error, c) => {
    // Never echo the request or the error message: either may contain customer text.
    logger.error({ event: 'unhandled_error', route: c.req.path, error: errorLabel(error) });
    return c.json(apiError('internal', 'Something went wrong. Please try again.'), 500);
  });

  app.notFound((c) => c.json(apiError('not_found', 'Not found.'), 404));

  app.get('/v1/health', async (c) => {
    try {
      await c.var.store.ping();
      return c.json({ status: 'ok', db: 'ok' });
    } catch (error) {
      logger.warn({ event: 'health_db_error', error: errorLabel(error) });
      return c.json({ status: 'degraded', db: 'error' }, 503);
    }
  });

  app.post('/v1/ask', async (c) => {
    const startedAt = deps.now();
    const body = await readJsonObject(c);
    if (!body.ok) return c.json(bodyError(body.code, '{"question": "...", "lang": "en"}'), 400);
    const { question: rawQuestion, lang: rawLang } = body.value;
    if (typeof rawQuestion !== 'string') return c.json(apiError('invalid_request', '"question" must be a string.'), 400);
    if (rawLang !== undefined && typeof rawLang !== 'string') return c.json(apiError('invalid_request', '"lang" must be a string.'), 400);
    const question = rawQuestion.trim();
    const lang = resolveLang(rawLang, question);
    if (question.length === 0) return c.json(apiError('empty_question', 'The question is empty.'), 400);
    if (codePoints(question) > config.maxQuestionChars) {
      return c.json(apiError('question_too_long', API_MESSAGES.questionTooLong[lang].replace('{max}', String(config.maxQuestionChars)), { max_chars: config.maxQuestionChars }), 400);
    }

    const store = c.var.store;
    const info = deps.clientInfo(c);
    const country = normalizeCountry(info.country);
    const limit = await checkRateLimit(store, config, info.ip, startedAt);
    if (!limit.allowed) {
      logger.info({ event: 'rate_limited', status: limit.reason ?? undefined, country });
      c.header('Retry-After', String(limit.retryAfterSec));
      const message = limit.reason === 'day' ? API_MESSAGES.rateLimitedDay[lang] : API_MESSAGES.rateLimitedMinute[lang];
      return c.json(apiError('rate_limited', message, { retry_after_sec: limit.retryAfterSec }), 429);
    }

    const input = { id: deps.uuid(), question, lang, country, startedAt };
    const outcome = blockedByRegion(config, country)
      ? regionBlocked(input, deps.now())
      : await askQuestion({ store, config, appConfig: deps.appConfig, clients: deps.engineClients, now: deps.now }, input);
    // The id is generated here, so the row can be written after the response (no added latency).
    c.var.later(store.insertConversation(outcome.record));
    logger.info({
      event: 'ask',
      conversation_id: input.id,
      status: outcome.record.status,
      latency_ms: outcome.record.latencyMs,
      country,
      answered_by: outcome.record.answeredBy,
      redacted_spans: outcome.redactedSpans,
    });
    return c.json(outcome.response);
  });

  app.post('/v1/handoff', async (c) => {
    const body = await readJsonObject(c);
    if (!body.ok) return c.json(bodyError(body.code, '{"conversation_id": "..."}'), 400);
    const { conversation_id: conversationId, note: rawNote } = body.value;
    if (typeof conversationId !== 'string' || !UUID.test(conversationId)) return c.json(apiError('invalid_request', '"conversation_id" must be a conversation id.'), 400);
    if (rawNote !== undefined && rawNote !== null && typeof rawNote !== 'string') return c.json(apiError('invalid_request', '"note" must be a string.'), 400);
    const noteText = typeof rawNote === 'string' ? rawNote.trim() : '';
    if (codePoints(noteText) > config.maxNoteChars) return c.json(apiError('note_too_long', `The note must be under ${config.maxNoteChars} characters.`, { max_chars: config.maxNoteChars }), 400);

    const store = c.var.store;
    const conversation = await store.getConversation(conversationId.toLowerCase());
    if (!conversation) return c.json(apiError('not_found', 'Conversation not found.'), 404);

    const webhook = config.handoffWebhook;
    const { created, handoff } = await store.insertHandoff({
      id: deps.uuid(),
      conversationId: conversation.id,
      createdAt: new Date(deps.now()),
      noteRedacted: noteText ? redactPii(noteText).text : null,
      deliveryStatus: webhook ? 'pending' : 'not_configured',
    });
    let deliveryStatus = handoff.deliveryStatus;
    if (created && webhook) {
      const result = await deliverHandoff(deps.webhookFetch, webhook, handoffPayload(handoff, conversation), deps.now);
      await store.updateHandoffDelivery(handoff.id, result.status, result.deliveredAt);
      deliveryStatus = result.status;
    }
    const notified = deliveryStatus === 'delivered';
    logger.info({ event: 'handoff', conversation_id: conversation.id, handoff_id: handoff.id, status: deliveryStatus });
    const message = !webhook ? API_MESSAGES.handoffDemo[conversation.lang] : notified ? API_MESSAGES.handoffSent[conversation.lang] : API_MESSAGES.handoffRecorded[conversation.lang];
    return c.json({ handoff_id: handoff.id, conversation_id: conversation.id, notified, message }, created ? 201 : 200);
  });

  // ---- Read-only admin API ----
  app.use('/v1/admin/*', async (c, next) => {
    if (config.adminToken === null) return c.json(apiError('not_found', 'Not found.'), 404);
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!constantTimeEqual(token, config.adminToken)) {
      logger.warn({ event: 'admin_unauthorized', route: c.req.path });
      return c.json(apiError('unauthorized', 'A valid admin token is required.'), 401);
    }
    await next();
    return undefined;
  });

  app.get('/v1/admin/conversations', async (c) => {
    const limit = intParam(c.req.query('limit'), 50, 1, 100);
    const before = dateParam(c.req.query('before'));
    const status = c.req.query('status');
    if (limit === null || before === null || (status !== undefined && !ADMIN_STATUSES.has(status))) {
      return c.json(apiError('invalid_request', 'Use limit=1..100, before=<ISO date>, status=<known status>.'), 400);
    }
    const rows = await c.var.store.listConversations({ status, before, limit });
    const last = rows.at(-1);
    return c.json({ items: rows.map(conversationView), next_before: rows.length === limit && last ? last.createdAt.toISOString() : null });
  });

  app.get('/v1/admin/conversations/:id', async (c) => {
    const id = c.req.param('id');
    if (!UUID.test(id)) return c.json(apiError('invalid_request', 'Not a conversation id.'), 400);
    const row = await c.var.store.getConversation(id.toLowerCase());
    return row ? c.json(conversationView(row)) : c.json(apiError('not_found', 'Conversation not found.'), 404);
  });

  app.get('/v1/admin/handoffs', async (c) => {
    const limit = intParam(c.req.query('limit'), 50, 1, 100);
    const before = dateParam(c.req.query('before'));
    if (limit === null || before === null) return c.json(apiError('invalid_request', 'Use limit=1..100 and before=<ISO date>.'), 400);
    const rows = await c.var.store.listHandoffs({ before, limit });
    const last = rows.at(-1);
    return c.json({
      items: rows.map((h) => ({
        id: h.id,
        conversation_id: h.conversationId,
        created_at: h.createdAt.toISOString(),
        note: h.noteRedacted,
        delivery_status: h.deliveryStatus,
        delivered_at: h.deliveredAt?.toISOString() ?? null,
        question: h.questionRedacted,
        bot_status: h.status,
        answer: h.answer,
      })),
      next_before: rows.length === limit && last ? last.createdAt.toISOString() : null,
    });
  });

  app.get('/v1/admin/gaps', async (c) => {
    const days = intParam(c.req.query('days'), Math.min(30, config.retentionDays), 1, config.retentionDays);
    if (days === null) return c.json(apiError('invalid_request', `Use days=1..${config.retentionDays}.`), 400);
    const since = new Date(deps.now() - days * DAY_MS);
    const rows = await c.var.store.gapRows({ since, limit: GAP_ROWS });
    return c.json({ since: since.toISOString(), questions: rows.length, truncated: rows.length === GAP_ROWS, groups: groupGaps(rows) });
  });

  app.get('/v1/admin/daily', async (c) => {
    const days = intParam(c.req.query('days'), 30, 1, 90);
    if (days === null) return c.json(apiError('invalid_request', 'Use days=1..90.'), 400);
    const since = new Date(utcDayStart(deps.now()) - (days - 1) * DAY_MS);
    return c.json({ since: since.toISOString(), ...dailyView(await c.var.store.dailyStats(since)) });
  });

  return app;
}
