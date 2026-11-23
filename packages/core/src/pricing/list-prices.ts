/**
 * Paid-tier list prices, used only to report an *equivalent* cost: the kit
 * runs on the free tier, where these calls cost $0. Update `verifiedOn` when
 * re-checking the source page.
 */
export interface ModelPrice {
  /** USD per 1M input (prompt) tokens, text. */
  readonly inputPerMillion: number;
  /** USD per 1M output tokens, thinking tokens included; 0 for embedding models. */
  readonly outputPerMillion: number;
  readonly sourceUrl: string;
  readonly verifiedOn: string;
}

export const PRICING_SOURCE_URL = 'https://ai.google.dev/gemini-api/docs/pricing';

export const LIST_PRICES: Readonly<Record<string, ModelPrice>> = {
  'gemini-3.5-flash-lite': {
    inputPerMillion: 0.3,
    outputPerMillion: 2.5,
    sourceUrl: PRICING_SOURCE_URL,
    verifiedOn: '2026-11-23',
  },
  'gemini-embedding-001': {
    inputPerMillion: 0.15,
    outputPerMillion: 0,
    sourceUrl: PRICING_SOURCE_URL,
    verifiedOn: '2026-11-23',
  },
};

export interface CostInput {
  readonly generationModel: string;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly thoughtsTokens: number;
  readonly embeddingModel: string;
  /** Estimated: the embeddings API reports no token usage. */
  readonly embeddingTokens: number;
}

/** Equivalent USD cost at list price, or null if a model has no price entry. */
export function equivalentCostUsd(input: CostInput, prices: Readonly<Record<string, ModelPrice>> = LIST_PRICES): number | null {
  const gen = prices[input.generationModel];
  const emb = prices[input.embeddingModel];
  if (!gen || !emb) return null;
  return (
    (input.promptTokens * gen.inputPerMillion +
      (input.outputTokens + input.thoughtsTokens) * gen.outputPerMillion +
      input.embeddingTokens * emb.inputPerMillion) /
    1_000_000
  );
}
