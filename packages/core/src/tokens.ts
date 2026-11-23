/**
 * Rough token estimate (~4 characters per token for English prose).
 * Exact counts would require the countTokens API, which spends quota, so the
 * estimate is used for chunk sizing and for client-side TPM budgeting (with a
 * safety factor applied by the caller).
 */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN);
}
