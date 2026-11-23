import type { UsageRecorder } from '../embeddings/embed.ts';
import type { GenerationClient, GenerateResult } from '../generation/types.ts';
import { equivalentCostUsd, LIST_PRICES, type ModelPrice } from '../pricing/list-prices.ts';
import { callWithRetry, type RetryCallDeps } from '../ratelimit/call-with-retry.ts';
import type { Clock } from '../ratelimit/limiter.ts';
import { estimateTokens } from '../tokens.ts';
import { applyPolicy, fallbackOutcome, type PolicyOutcome } from './policy.ts';
import { buildUserContentV1, PROMPT_VERSION, SYSTEM_INSTRUCTION_V1 } from './prompts/v1.ts';
import { answerResponseSchema, parseModelAnswer } from './schema.ts';
import { groupSources, maxSimilarity } from './sources.ts';
import type { AnswerResult, AnswerStatus, ModelCitation, RetrievedChunk } from './types.ts';

export interface AnswerEngineConfig {
  /** Retrieval candidates before grouping by URL. */
  readonly candidates: number;
  /** Sources (URL groups) sent to the model. */
  readonly sources: number;
  readonly floor: number;
  readonly embeddingModel: string;
  readonly maxOutputTokens: number;
}

export interface AnswerEngineDeps {
  readonly config: AnswerEngineConfig;
  /** Query embedding (cache-first). */
  embedQuery(question: string): Promise<readonly number[]>;
  /** Ranked chunks for the query (vector by default, hybrid if configured). */
  retrieve(question: string, vector: readonly number[], candidates: number): Promise<readonly RetrievedChunk[]>;
  readonly generation: GenerationClient;
  /** Limiter, retry policy, sleep, random and clock for generation calls. */
  readonly call: RetryCallDeps;
  readonly usage: UsageRecorder;
  readonly clock: Clock;
  readonly prices?: Readonly<Record<string, ModelPrice>>;
  /** Usage kind for api_usage rows (default "generate"). */
  readonly usageKind?: string;
}

/**
 * Answers one customer question: retrieve → floor check → one model call
 * (no retry on bad output) → citation validation → final status.
 */
export async function answerQuestion(deps: AnswerEngineDeps, question: string): Promise<AnswerResult> {
  const { config, clock } = deps;
  const start = clock.now();
  const vector = await deps.embedQuery(question);
  const ranked = await deps.retrieve(question, vector, config.candidates);
  const retrievalMs = clock.now() - start;
  const sources = groupSources(ranked, config.sources);
  const maxSim = maxSimilarity(ranked);
  const embeddingTokens = estimateTokens(question);

  let outcome: PolicyOutcome;
  let modelStatus: AnswerStatus | null = null;
  let modelCitations: readonly ModelCitation[] = [];
  let finishReason: string | null = null;
  let generationMs = 0;
  let queueWaitMs = 0;
  let generationRequests = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  let thoughtsTokens = 0;
  const floorHit = maxSim < config.floor || sources.length === 0;

  if (floorHit) {
    outcome = fallbackOutcome(question, null);
  } else {
    const system = SYSTEM_INSTRUCTION_V1;
    const user = buildUserContentV1(question, sources);
    const estTokens = estimateTokens(system) + estimateTokens(user);
    const call = await callWithRetry<GenerateResult>(
      deps.call,
      { requests: 1, tokens: Math.ceil(estTokens * 1.2) + config.maxOutputTokens },
      () => deps.generation.generate({ system, user, responseSchema: answerResponseSchema(sources.map((s) => s.id)) }),
      async (attempt) => {
        generationRequests++;
        await deps.usage.record({
          kind: deps.usageKind ?? 'generate',
          model: deps.generation.model,
          requests: 1,
          estTokens,
          httpStatus: attempt.status,
          promptTokens: attempt.result?.usage.promptTokens,
          outputTokens: attempt.result?.usage.outputTokens,
          thoughtsTokens: attempt.result?.usage.thoughtsTokens,
          latencyMs: attempt.durationMs,
        });
      },
    );
    generationMs = call.callMs;
    queueWaitMs = call.queueWaitMs;
    const result = call.result;
    finishReason = result.finishReason;
    promptTokens = result.usage.promptTokens;
    outputTokens = result.usage.outputTokens;
    thoughtsTokens = result.usage.thoughtsTokens;

    const parsed = result.finishReason === 'STOP' ? parseModelAnswer(result.text) : null;
    if (parsed?.ok) {
      modelStatus = parsed.value.status;
      modelCitations = parsed.value.citations;
      outcome = applyPolicy(question, parsed.value, sources);
    } else {
      const reason = parsed ? parsed.error : `finishReason ${result.finishReason}`;
      outcome = fallbackOutcome(question, `invalid_output: ${reason}`);
    }
  }

  const totalMs = clock.now() - start - queueWaitMs;
  return {
    status: outcome.status,
    declinedInjection: outcome.declinedInjection,
    answer: outcome.answer,
    citations: outcome.citations,
    handoffOffered: outcome.handoffOffered,
    handoffReason: outcome.handoffReason,
    sources,
    maxSimilarity: maxSim,
    floorHit,
    modelStatus,
    modelCitations,
    invalidCitations: outcome.invalidCitations,
    removedSentences: outcome.removedSentences,
    error: outcome.error,
    finishReason,
    promptVersion: PROMPT_VERSION,
    usage: { generationRequests, promptTokens, outputTokens, thoughtsTokens, embeddingTokens },
    latency: { retrievalMs, generationMs, totalMs, queueWaitMs },
    costUsd: equivalentCostUsd(
      {
        generationModel: deps.generation.model,
        promptTokens,
        outputTokens,
        thoughtsTokens,
        embeddingModel: config.embeddingModel,
        embeddingTokens,
      },
      deps.prices ?? LIST_PRICES,
    ),
  };
}
