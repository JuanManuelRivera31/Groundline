import type { RetryPolicy } from '../embeddings/retry.ts';
import type { UsageRecorder } from '../embeddings/embed.ts';
import { GeminiApiError } from '../gemini/http.ts';
import type { GenerateResult, GenerationClient } from '../generation/types.ts';
import { equivalentCostUsd, LIST_PRICES, type ModelPrice } from '../pricing/list-prices.ts';
import { callWithRetry } from '../ratelimit/call-with-retry.ts';
import { QuotaExceededError, RateLimitWaitError, type Clock, type RateLimiterLike, type Sleep } from '../ratelimit/limiter.ts';
import { estimateTokens } from '../tokens.ts';
import { applyPolicy, fallbackOutcome, unavailableOutcome, type PolicyOutcome } from './policy.ts';
import { DEFAULT_PROMPT_VERSION, getPrompt } from './prompts/index.ts';
import { parseModelAnswer } from './schema.ts';
import { groupSources, maxSimilarity } from './sources.ts';
import type {
  AnswerMode,
  AnswerResult,
  AnswerSource,
  ArticleLink,
  GenerationAttempt,
  ModelCitation,
  ModelStatus,
  RetrievalFallback,
  RetrievedChunk,
} from './types.ts';
import type { QuoteBounds } from './validate.ts';

export interface AnswerEngineConfig {
  /** Retrieval candidates before grouping by URL. */
  readonly candidates: number;
  /** Sources (URL groups) sent to the model. */
  readonly sources: number;
  readonly floor: number;
  readonly embeddingModel: string;
  readonly maxOutputTokens: number;
  readonly promptVersion?: string | undefined;
  /** Live mode: time budget per answer, retrieval included (default 7 500 ms). */
  readonly liveBudgetMs?: number | undefined;
  /**
   * Live mode: when the model in flight has not answered after this many ms, start
   * the next chain model in parallel and keep the first valid answer (0 = no hedge).
   * Default 3 000 ms (ADR-0009, amendment S5d).
   */
  readonly hedgeAfterMs?: number | undefined;
  readonly quoteBounds?: QuoteBounds | undefined;
}

/** One model of the chain with its own client-side limiter. */
export interface GenerationTarget {
  readonly client: GenerationClient;
  readonly limiter: RateLimiterLike;
}

export interface EmbedQueryOptions {
  readonly mode: AnswerMode;
  /** Live mode: time left for the embedding call. */
  readonly timeoutMs?: number | undefined;
}

export interface AnswerEngineDeps {
  readonly config: AnswerEngineConfig;
  /** eval: primary model only, patient retries. live: model chain within the time budget. Default eval. */
  readonly mode?: AnswerMode | undefined;
  /** Query embedding (cache-first). In live mode it must give up within `timeoutMs`. */
  embedQuery(question: string, options: EmbedQueryOptions): Promise<readonly number[]>;
  /** Ranked chunks for the query (vector by default, hybrid if configured). */
  retrieve(question: string, vector: readonly number[], candidates: number): Promise<readonly RetrievedChunk[]>;
  /** Full-text search without API calls, for the live fallback when the query embedding fails. */
  searchFullText?(question: string, limit: number): Promise<readonly RetrievedChunk[]>;
  /** Model chain, primary first. Eval mode uses only the first. */
  readonly chain: readonly GenerationTarget[];
  readonly retry: RetryPolicy;
  readonly sleep: Sleep;
  readonly random: () => number;
  readonly clock: Clock;
  readonly usage: UsageRecorder;
  /** Creates an abort signal for live calls (default AbortSignal.timeout). */
  readonly timeoutSignal?: ((ms: number) => AbortSignal) | undefined;
  /** Resolves after `ms`, or as soon as `signal` aborts (live hedge timer). Default setTimeout. */
  readonly wait?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
  readonly prices?: Readonly<Record<string, ModelPrice>> | undefined;
  /** Usage kind for api_usage rows (default "generate"). */
  readonly usageKind?: string | undefined;
}

export const DEFAULT_LIVE_BUDGET_MS = 7_500;
export const DEFAULT_HEDGE_AFTER_MS = 3_000;
/** Below this remaining time a new live attempt is not started. */
export const MIN_ATTEMPT_MS = 300;
const ARTICLES = 3;

/** First `n` distinct documents (URL without anchor), keeping retrieval order. */
export function topArticles(items: readonly { readonly title: string; readonly url: string }[], n = ARTICLES): ArticleLink[] {
  const seen = new Set<string>();
  const out: ArticleLink[] = [];
  for (const item of items) {
    const doc = item.url.replace(/#.*$/, '');
    if (seen.has(doc)) continue;
    seen.add(doc);
    out.push({ title: item.title, url: doc });
    if (out.length >= n) break;
  }
  return out;
}

interface GenerationRun {
  readonly result: GenerateResult | null;
  readonly model: string | null;
  readonly attempts: GenerationAttempt[];
  readonly queueWaitMs: number;
  readonly callMs: number;
  readonly hops: number;
  readonly hedged: boolean;
  readonly error: string | null;
}

function attemptOutcome(error: unknown): GenerationAttempt['outcome'] {
  if (error instanceof GeminiApiError) return error.timeout ? 'timeout' : error.status === 0 ? 'network' : 'http_error';
  return 'network';
}

/**
 * Answers one customer question: retrieve → floor check → one validated model
 * answer (no retry on bad output) → citation validation → final status.
 */
export async function answerQuestion(deps: AnswerEngineDeps, question: string): Promise<AnswerResult> {
  const { config, clock } = deps;
  const mode: AnswerMode = deps.mode ?? 'eval';
  const prompt = getPrompt(config.promptVersion ?? DEFAULT_PROMPT_VERSION);
  const start = clock.now();
  const budget = config.liveBudgetMs ?? DEFAULT_LIVE_BUDGET_MS;
  const deadline = start + budget;
  const remaining = (): number => deadline - clock.now();
  const embeddingTokens = estimateTokens(question);
  const primary = deps.chain[0];
  if (!primary) throw new Error('answerQuestion needs at least one generation model.');

  const base = {
    mode,
    promptVersion: prompt.version,
    declinedInjection: false,
    modelStatus: null,
    modelCitations: [] as ModelCitation[],
    finishReason: null,
  };

  // 1. Query embedding. In live mode a failure degrades to full-text articles.
  let vector: readonly number[];
  const embedStart = clock.now();
  try {
    vector = await deps.embedQuery(question, { mode, timeoutMs: mode === 'live' ? remaining() : undefined });
  } catch (error) {
    if (mode === 'eval') throw error;
    let fallback: RetrievalFallback = 'none';
    let articles: ArticleLink[] = [];
    if (deps.searchFullText) {
      const hits = await deps.searchFullText(question, ARTICLES * 4);
      articles = topArticles(hits.map((h) => ({ title: h.documentTitle, url: h.url })));
      if (articles.length > 0) fallback = 'fts';
    }
    const outcome = unavailableOutcome(question, articles, `embedding_unavailable: ${error instanceof Error ? error.message : String(error)}`);
    const totalMs = clock.now() - start;
    return finish(deps, outcome, {
      ...base,
      sources: [],
      maxSimilarity: 0,
      floorHit: false,
      answeredBy: null,
      hops: 0,
      hedged: false,
      attempts: [],
      retrievalFallback: fallback,
      articles,
      usage: { generationRequests: 0, promptTokens: 0, outputTokens: 0, thoughtsTokens: 0, embeddingTokens },
      latency: { retrievalMs: totalMs, embeddingMs: clock.now() - embedStart, generationMs: 0, totalMs, queueWaitMs: 0 },
      generationModel: primary.client.model,
    });
  }

  const embeddingMs = clock.now() - embedStart;

  // 2. Retrieval and floor.
  const ranked = await deps.retrieve(question, vector, config.candidates);
  const retrievalMs = clock.now() - start;
  const sources = groupSources(ranked, config.sources);
  const maxSim = maxSimilarity(ranked);
  const floorHit = maxSim < config.floor || sources.length === 0;
  const common = { ...base, sources, maxSimilarity: maxSim, floorHit, retrievalFallback: 'vector' as const };

  if (floorHit) {
    const totalMs = clock.now() - start;
    return finish(deps, fallbackOutcome(question, null), {
      ...common,
      answeredBy: null,
      hops: 0,
      hedged: false,
      attempts: [],
      articles: [],
      usage: { generationRequests: 0, promptTokens: 0, outputTokens: 0, thoughtsTokens: 0, embeddingTokens },
      latency: { retrievalMs, embeddingMs, generationMs: 0, totalMs, queueWaitMs: 0 },
      generationModel: primary.client.model,
    });
  }

  // 3. Generation.
  const user = prompt.buildUserContent(question, sources);
  const estTokens = estimateTokens(prompt.system) + estimateTokens(user);
  const request = { system: prompt.system, user, responseSchema: prompt.responseSchema(sources.map((s) => s.id)) };
  const cost = { requests: 1, tokens: Math.ceil(estTokens * 1.2) + config.maxOutputTokens };
  // A response the policy can use: complete JSON that matches the schema (the live hedge keeps the first one).
  const acceptable = (r: GenerateResult): boolean => r.finishReason === 'STOP' && parseModelAnswer(r.text, prompt.markerStyle).ok;
  const hedgeAfterMs = config.hedgeAfterMs ?? DEFAULT_HEDGE_AFTER_MS;
  const run =
    mode === 'eval'
      ? await generateEval(deps, primary, request, cost, estTokens)
      : await generateLive(deps, request, cost, estTokens, remaining, hedgeAfterMs, acceptable);

  const usage = {
    generationRequests: run.attempts.filter((a) => a.status !== null).length,
    promptTokens: run.result?.usage.promptTokens ?? 0,
    outputTokens: run.result?.usage.outputTokens ?? 0,
    thoughtsTokens: run.result?.usage.thoughtsTokens ?? 0,
    embeddingTokens,
  };

  // 4. Validation and final status.
  let outcome: PolicyOutcome;
  let modelStatus: ModelStatus | null = null;
  let modelCitations: readonly ModelCitation[] = [];
  let articles: ArticleLink[] = [];
  if (!run.result) {
    articles = topArticles(sources.map((s: AnswerSource) => ({ title: s.title, url: s.url })));
    outcome = unavailableOutcome(question, articles, run.error ?? 'generation_unavailable');
  } else {
    const parsed = run.result.finishReason === 'STOP' ? parseModelAnswer(run.result.text, prompt.markerStyle) : null;
    if (parsed?.ok) {
      modelStatus = parsed.value.status;
      modelCitations = parsed.value.citations;
      outcome = applyPolicy(question, parsed.value, sources, config.quoteBounds, prompt.codeBlocks);
    } else {
      outcome = fallbackOutcome(question, `invalid_output: ${parsed ? parsed.error : `finishReason ${run.result.finishReason}`}`);
    }
  }

  // Eval mode excludes limiter queue wait (it measures the pipeline); in live mode the customer waits it too.
  const totalMs = clock.now() - start - (mode === 'live' ? 0 : run.queueWaitMs);
  return finish(deps, outcome, {
    ...common,
    modelStatus,
    modelCitations,
    finishReason: run.result?.finishReason ?? null,
    answeredBy: run.result ? run.model : null,
    hops: run.hops,
    hedged: run.hedged,
    attempts: run.attempts,
    articles,
    usage,
    latency: { retrievalMs, embeddingMs, generationMs: run.callMs, totalMs, queueWaitMs: run.queueWaitMs },
    generationModel: run.model ?? primary.client.model,
  });
}

type FinishFields = Omit<
  AnswerResult,
  'status' | 'declinedInjection' | 'answer' | 'citations' | 'handoffOffered' | 'handoffReason' | 'invalidCitations' | 'removedSentences' | 'error' | 'costUsd'
> & { readonly generationModel: string; readonly declinedInjection?: boolean };

function finish(deps: AnswerEngineDeps, outcome: PolicyOutcome, f: FinishFields): AnswerResult {
  const { generationModel, ...fields } = f;
  return {
    ...fields,
    status: outcome.status,
    declinedInjection: outcome.declinedInjection,
    answer: outcome.answer,
    citations: outcome.citations,
    handoffOffered: outcome.handoffOffered,
    handoffReason: outcome.handoffReason,
    invalidCitations: outcome.invalidCitations,
    removedSentences: outcome.removedSentences,
    error: outcome.error,
    costUsd: equivalentCostUsd(
      {
        generationModel,
        promptTokens: f.usage.promptTokens,
        outputTokens: f.usage.outputTokens,
        thoughtsTokens: f.usage.thoughtsTokens,
        embeddingModel: deps.config.embeddingModel,
        embeddingTokens: f.usage.embeddingTokens,
      },
      deps.prices ?? LIST_PRICES,
    ),
  };
}

interface GenerateRequestBase {
  readonly system: string;
  readonly user: string;
  readonly responseSchema: unknown;
}

async function record(
  deps: AnswerEngineDeps,
  model: string,
  estTokens: number,
  status: number,
  durationMs: number,
  result?: GenerateResult,
): Promise<void> {
  await deps.usage.record({
    kind: deps.usageKind ?? 'generate',
    model,
    requests: 1,
    estTokens,
    httpStatus: status,
    promptTokens: result?.usage.promptTokens,
    outputTokens: result?.usage.outputTokens,
    thoughtsTokens: result?.usage.thoughtsTokens,
    latencyMs: durationMs,
  });
}

/** Eval mode: the primary model only, with patient retries (measures one model). Errors propagate. */
async function generateEval(
  deps: AnswerEngineDeps,
  primary: GenerationTarget,
  request: GenerateRequestBase,
  cost: { requests: number; tokens: number },
  estTokens: number,
): Promise<GenerationRun> {
  const attempts: GenerationAttempt[] = [];
  const model = primary.client.model;
  const call = await callWithRetry<GenerateResult>(
    { limiter: primary.limiter, retry: deps.retry, sleep: deps.sleep, random: deps.random, clock: deps.clock },
    cost,
    () => primary.client.generate(request),
    async (attempt) => {
      attempts.push({ model, status: attempt.status, outcome: attempt.status === 200 ? 'ok' : attempt.status === 0 ? 'network' : 'http_error', ms: attempt.durationMs });
      await record(deps, model, estTokens, attempt.status, attempt.durationMs, attempt.result);
    },
  );
  return { result: call.result, model, attempts, queueWaitMs: call.queueWaitMs, callMs: call.callMs, hops: 0, hedged: false, error: null };
}

/** Abortable timer on the global setTimeout (Node and Workers). */
function timerWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(id);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const id = setTimeout(done, Math.max(0, ms));
    signal.addEventListener('abort', done, { once: true });
  });
}

/** One chain model started in live mode. */
interface Lane {
  readonly model: string;
  readonly launchedAt: number;
  readonly controller: AbortController;
  /** Set before the engine aborts a lane whose result is no longer needed. */
  cancelled: boolean;
}

/** How a lane ended: an HTTP 200 result, or the error that ended it (null when cancelled). */
interface LaneEnd {
  readonly lane: Lane;
  readonly result: GenerateResult | null;
  readonly error: string | null;
}

const HEDGE = Symbol('hedge');

/** Read through a function: the flag changes while a lane awaits, so it must not be narrowed. */
const isCancelled = (lane: Lane): boolean => lane.cancelled;

/**
 * Live mode: walk the model chain within the remaining budget (ADR-0009, amendment S5d).
 * - 503/5xx, timeouts and network errors switch to the next model at once; a 429
 *   waits for its retryDelay and retries the same model once only if that fits.
 * - Hedge: when the newest model in flight has not answered after `hedgeAfterMs`,
 *   the next model starts in parallel. The first acceptable answer wins; the other
 *   call is aborted and recorded as "cancelled". Every call ends by the deadline.
 */
async function generateLive(
  deps: AnswerEngineDeps,
  request: GenerateRequestBase,
  cost: { requests: number; tokens: number },
  estTokens: number,
  remaining: () => number,
  hedgeAfterMs: number,
  acceptable: (result: GenerateResult) => boolean,
): Promise<GenerationRun> {
  const { clock } = deps;
  const attempts: GenerationAttempt[] = [];
  const signalFor = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const wait = deps.wait ?? timerWait;
  const phaseStart = clock.now();
  let queueWaitMs = 0;
  let lastError: string | null = null;
  let next = 0;
  let launched = 0;
  let hedged = false;
  const inFlight = new Map<Lane, Promise<LaneEnd>>();
  let newest: Lane | null = null;

  const runLane = async (target: GenerationTarget, lane: Lane): Promise<LaneEnd> => {
    const model = lane.model;
    let retried429 = false;
    for (;;) {
      const queued = clock.now();
      try {
        await target.limiter.acquire(cost, { maxWaitMs: Math.max(0, remaining() - MIN_ATTEMPT_MS) });
      } catch (error) {
        if (!(error instanceof QuotaExceededError || error instanceof RateLimitWaitError)) throw error;
        attempts.push({ model, status: null, outcome: error instanceof QuotaExceededError ? 'quota_local' : 'rate_local', ms: 0 });
        return { lane, result: null, error: error.message };
      }
      queueWaitMs += clock.now() - queued;
      if (isCancelled(lane)) return { lane, result: null, error: null };
      const started = clock.now();
      // The budget deadline aborts this call; so does the engine when another lane wins.
      const budget = signalFor(Math.max(1, remaining()));
      const onBudget = (): void => {
        lane.controller.abort(budget.reason);
      };
      if (budget.aborted) onBudget();
      else budget.addEventListener('abort', onBudget, { once: true });
      try {
        const result = await target.client.generate({ ...request, signal: lane.controller.signal });
        const ms = clock.now() - started;
        attempts.push({ model, status: 200, outcome: 'ok', ms });
        await record(deps, model, estTokens, 200, ms, result);
        return { lane, result, error: null };
      } catch (error) {
        const ms = clock.now() - started;
        const status = error instanceof GeminiApiError ? error.status : 0;
        attempts.push({ model, status, outcome: isCancelled(lane) ? 'cancelled' : attemptOutcome(error), ms });
        await record(deps, model, estTokens, status, ms);
        if (isCancelled(lane)) return { lane, result: null, error: null };
        const retryAfter = error instanceof GeminiApiError ? error.retryAfterMs : undefined;
        if (status === 429 && !retried429 && retryAfter !== undefined && retryAfter + MIN_ATTEMPT_MS < remaining()) {
          retried429 = true;
          await deps.sleep(retryAfter);
          continue;
        }
        // 503/5xx/timeout/network/4xx: the engine moves to the next model.
        return { lane, result: null, error: error instanceof Error ? error.message : String(error) };
      } finally {
        budget.removeEventListener('abort', onBudget);
      }
    }
  };

  /** Starts the next chain model; false when none is left or the budget is used up. */
  const launch = (): boolean => {
    const target = deps.chain[next];
    if (!target) return false;
    next++;
    if (remaining() < MIN_ATTEMPT_MS) {
      attempts.push({ model: target.client.model, status: null, outcome: 'budget', ms: 0 });
      lastError = 'live_budget_exhausted';
      next = deps.chain.length;
      return false;
    }
    launched++;
    const lane: Lane = { model: target.client.model, launchedAt: clock.now(), controller: new AbortController(), cancelled: false };
    inFlight.set(lane, runLane(target, lane));
    newest = lane;
    return true;
  };

  let winner: LaneEnd | null = null;
  /** First complete but unusable response: kept only if no lane in flight does better (no retry on bad output). */
  let held: LaneEnd | null = null;
  launch();
  try {
    while (inFlight.size > 0) {
      const racers: Promise<LaneEnd | typeof HEDGE>[] = [...inFlight.values()];
      const timer = new AbortController();
      // `newest` is set inside launch(); the cast stops TypeScript from narrowing it to null.
      const hedgeFrom = newest as Lane | null;
      if (hedgeAfterMs > 0 && held === null && next < deps.chain.length && hedgeFrom) {
        const delay = Math.max(0, hedgeFrom.launchedAt + hedgeAfterMs - clock.now());
        if (remaining() - delay >= MIN_ATTEMPT_MS) racers.push(wait(delay, timer.signal).then(() => HEDGE));
      }
      const settled = await Promise.race(racers);
      timer.abort();
      if (settled === HEDGE) {
        if (launch()) hedged = true;
        continue;
      }
      inFlight.delete(settled.lane);
      if (settled.result) {
        if (acceptable(settled.result)) {
          winner = settled;
          break;
        }
        held ??= settled;
        continue;
      }
      if (settled.error !== null) lastError = settled.error;
      if (inFlight.size === 0 && held === null) launch();
    }
  } finally {
    const losers = [...inFlight.keys()];
    for (const lane of losers) {
      lane.cancelled = true;
      lane.controller.abort();
    }
    await Promise.allSettled([...inFlight.values()]);
  }

  const chosen = winner ?? held;
  const callMs = clock.now() - phaseStart - queueWaitMs;
  const hops = Math.max(0, launched - 1);
  if (chosen?.result) return { result: chosen.result, model: chosen.lane.model, attempts, queueWaitMs, callMs, hops, hedged, error: null };
  return { result: null, model: null, attempts, queueWaitMs, callMs, hops, hedged, error: lastError };
}
