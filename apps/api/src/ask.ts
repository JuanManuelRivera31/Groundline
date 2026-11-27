import {
  answerQuestion,
  planEmbeddings,
  redactPii,
  topArticles,
  type AnswerResult,
  type AnswerStatus,
  type AppConfig,
  type EmbeddingClient,
  type GenerationClient,
} from '@groundline/core';
import type { ApiStore, ArticleRef, ConversationRecord, ConversationSource } from '@groundline/db';
import { cacheStoreFor, createAnswerRuntime, type AnswerRuntimeDb } from '@groundline/evals/runtime';
import type { ApiConfig } from './config.ts';
import { hashIp, utcDayStart } from './crypto.ts';
import { API_MESSAGES, type Lang } from './messages.ts';
import { isRegionBlocked } from './region.ts';

/** What one request needs from the database: the engine's reads and writes plus the API tables. */
export type Store = ApiStore & AnswerRuntimeDb;

/** The engine's five statuses plus the two the API adds. */
export type ApiStatus = AnswerStatus | 'articles_only' | 'region_blocked';

export interface AskResponse {
  readonly conversation_id: string;
  readonly status: ApiStatus;
  /** Final text with [n] markers that match `sources[].n`. */
  readonly answer: string;
  readonly sources: readonly ConversationSource[];
  readonly articles: readonly ArticleRef[];
  readonly handoff_offered: boolean;
  readonly lang: Lang;
}

/** Offline fakes for the Gemini clients (tests only). */
export interface EngineClients {
  readonly generation?: ((model: string) => GenerationClient) | undefined;
  readonly embedding?: EmbeddingClient | undefined;
}

const DAY_MS = 86_400_000;
const ARTICLE_CANDIDATES = 12;

export interface RateLimitOutcome {
  readonly allowed: boolean;
  readonly reason: 'minute' | 'day' | null;
  readonly retryAfterSec: number;
}

/** Per-IP limit: `rateLimitPerMinute` in any 60 s and `rateLimitPerDay` per UTC day, counted on a daily-salted hash. */
export async function checkRateLimit(store: Store, config: ApiConfig, ip: string | null, now: number): Promise<RateLimitOutcome> {
  // A request without an IP (should not happen behind Cloudflare) shares one bucket: safe, not generous.
  const ipHash = await hashIp(config.ipHashSecret, ip ?? 'unknown', now);
  const dayStart = utcDayStart(now);
  const d = await store.consumeRateLimit({
    ipHash,
    now: new Date(now),
    perMinute: config.rateLimitPerMinute,
    perDay: config.rateLimitPerDay,
    dayStart: new Date(dayStart),
  });
  if (d.allowed) return { allowed: true, reason: null, retryAfterSec: 0 };
  if (d.dayCount >= config.rateLimitPerDay) return { allowed: false, reason: 'day', retryAfterSec: Math.max(1, Math.ceil((dayStart + DAY_MS - now) / 1000)) };
  const oldest = d.oldestInMinute?.getTime() ?? now;
  return { allowed: false, reason: 'minute', retryAfterSec: Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000)) };
}

/**
 * The engine config with the demo's daily generation cap applied as each chain
 * model's RPD (never above the configured RPD). The engine then skips a model
 * whose cap is spent with its existing local-quota check; nothing else changes.
 */
export function cappedConfig(config: AppConfig, cap: number): AppConfig {
  const g = config.generation;
  const limitsByModel = Object.fromEntries(
    g.models.map((m) => {
      const limits = g.limitsByModel[m] ?? g.limits;
      return [m, { ...limits, rpd: Math.min(limits.rpd, cap) }];
    }),
  );
  return { ...config, generation: { ...g, limitsByModel, limits: { ...g.limits, rpd: Math.min(g.limits.rpd, cap) } } };
}

/** Groups verified citations by their display marker: one numbered source per marker. */
export function citedSources(result: Pick<AnswerResult, 'citations'>): ConversationSource[] {
  const byMarker = new Map<number, { n: number; title: string; url: string; quotes: string[] }>();
  for (const c of result.citations) {
    const entry = byMarker.get(c.marker) ?? { n: c.marker, title: c.title, url: c.url, quotes: [] };
    if (!entry.quotes.includes(c.quote)) entry.quotes.push(c.quote);
    byMarker.set(c.marker, entry);
  }
  return [...byMarker.values()].sort((a, b) => a.n - b.n);
}

export interface AskContext {
  readonly store: Store;
  readonly config: ApiConfig;
  readonly appConfig: AppConfig;
  readonly clients?: EngineClients | undefined;
  readonly now: () => number;
}

export interface AskInput {
  readonly id: string;
  readonly question: string;
  readonly lang: Lang;
  readonly country: string | null;
  readonly startedAt: number;
}

export interface AskOutcome {
  readonly response: AskResponse;
  readonly record: ConversationRecord;
  readonly redactedSpans: number;
}

function baseRecord(input: AskInput, now: number): Omit<ConversationRecord, 'questionRedacted' | 'status' | 'answer'> {
  return {
    id: input.id,
    createdAt: new Date(input.startedAt),
    lang: input.lang,
    sources: [],
    articles: [],
    handoffOffered: false,
    answeredBy: null,
    floorHit: false,
    hedged: false,
    nearestUrl: null,
    nearestTitle: null,
    maxSimilarity: null,
    latencyMs: now - input.startedAt,
    generationRequests: 0,
    promptTokens: 0,
    outputTokens: 0,
    thoughtsTokens: 0,
    costUsd: null,
    country: input.country,
    error: null,
  };
}

function respond(record: ConversationRecord, redactedSpans: number): AskOutcome {
  return {
    record,
    redactedSpans,
    response: {
      conversation_id: record.id,
      status: record.status as ApiStatus,
      answer: record.answer,
      sources: record.sources,
      articles: record.articles,
      handoff_offered: record.handoffOffered,
      lang: record.lang,
    },
  };
}

/** Region-blocked: fixed message, no Gemini call; the question is not kept. */
export function regionBlocked(input: AskInput, now: number): AskOutcome {
  const record: ConversationRecord = {
    ...baseRecord(input, now),
    questionRedacted: null,
    status: 'region_blocked',
    answer: API_MESSAGES.regionBlocked[input.lang],
  };
  return respond(record, 0);
}

export function blockedByRegion(config: ApiConfig, country: string | null): boolean {
  return isRegionBlocked(country, config.blockedCountries, config.blockUnknownCountry);
}

/** Daily AI budget spent: up to 3 articles without any Gemini call (cached query embedding → vector search; else full-text). */
async function articlesOnly(ctx: AskContext, input: AskInput, question: string, redactedSpans: number): Promise<AskOutcome> {
  const emb = ctx.appConfig.embedding;
  const plan = await planEmbeddings(cacheStoreFor(ctx.store), emb, [question], 'RETRIEVAL_QUERY');
  const cached = plan.cached.get(plan.keys[0] ?? '');
  const hits = cached
    ? await ctx.store.searchVector(cached, emb.model, ARTICLE_CANDIDATES)
    : await ctx.store.searchFullText(question, ARTICLE_CANDIDATES);
  const articles = topArticles(hits.map((h) => ({ title: h.documentTitle, url: h.url })));
  const lead = articles.length > 0 ? API_MESSAGES.articlesOnly[input.lang] : API_MESSAGES.articlesOnlyNone[input.lang];
  const answer = [lead, ...articles.map((a) => `- ${a.title}: ${a.url}`)].join('\n');
  const record: ConversationRecord = {
    ...baseRecord(input, ctx.now()),
    questionRedacted: question,
    status: 'articles_only',
    answer,
    articles,
    handoffOffered: true,
    nearestUrl: hits[0]?.url ?? null,
    nearestTitle: hits[0]?.documentTitle ?? null,
    maxSimilarity: cached ? (hits[0]?.score ?? null) : null,
    error: cached ? 'demo_daily_cap' : 'demo_daily_cap: fts',
  };
  return respond(record, redactedSpans);
}

/**
 * Redacts the question, applies the daily generation cap and runs the frozen
 * engine in live mode. Only the redacted text reaches the model or the database.
 */
export async function askQuestion(ctx: AskContext, input: AskInput): Promise<AskOutcome> {
  const redacted = redactPii(input.question);
  const question = redacted.text;
  const appConfig = cappedConfig(ctx.appConfig, ctx.config.demoDailyGenCap);
  const runtime = await createAnswerRuntime(appConfig, ctx.store, { embedKind: 'api_embed_query', mode: 'live', clients: ctx.clients });
  if (runtime.generationQuotas.every((q) => q.remaining < 1)) return articlesOnly(ctx, input, question, redacted.total);

  const result = await answerQuestion(runtime.deps, question);
  const nearest = result.sources[0];
  const record: ConversationRecord = {
    ...baseRecord(input, ctx.now()),
    questionRedacted: question,
    status: result.status,
    answer: result.answer,
    sources: citedSources(result),
    articles: result.articles,
    handoffOffered: result.handoffOffered,
    answeredBy: result.answeredBy,
    floorHit: result.floorHit,
    hedged: result.hedged,
    nearestUrl: nearest?.url ?? null,
    nearestTitle: nearest?.title ?? null,
    maxSimilarity: result.sources.length > 0 ? result.maxSimilarity : null,
    generationRequests: result.usage.generationRequests,
    promptTokens: result.usage.promptTokens,
    outputTokens: result.usage.outputTokens,
    thoughtsTokens: result.usage.thoughtsTokens,
    costUsd: result.costUsd,
    error: result.error,
  };
  return respond(record, redacted.total);
}
