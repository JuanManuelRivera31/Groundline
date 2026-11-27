import type { ConversationRecord, DailyApiUsage, DailyConversationStats, GapRow } from '@groundline/db';

export interface GapQuestion {
  readonly text: string;
  readonly count: number;
  readonly last_seen: string;
  readonly max_similarity: number | null;
}

export interface GapGroup {
  /** Nearest retrieved document (URL without anchor); null when nothing was retrieved. */
  readonly document_url: string | null;
  readonly document_title: string | null;
  readonly count: number;
  readonly questions: readonly GapQuestion[];
}

/** Lower case, NFKC, collapsed whitespace, no trailing punctuation: "How do I…?" and "how do i… " group together. */
export function normalizeQuestion(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s?!.¿¡]+$/u, '')
    .replace(/^[\s¿¡]+/u, '')
    .trim();
}

/**
 * Gap report: "I don't know" questions grouped by the nearest document the
 * retriever found (the topic the docs are missing), then deduplicated by
 * normalized text. Largest groups first.
 */
interface GapQuestionAcc {
  text: string;
  count: number;
  last: Date;
  sim: number | null;
}

interface GapGroupAcc {
  readonly url: string | null;
  readonly title: string | null;
  count: number;
  readonly questions: Map<string, GapQuestionAcc>;
}

export function groupGaps(rows: readonly GapRow[]): GapGroup[] {
  const groups = new Map<string, GapGroupAcc>();
  for (const row of rows) {
    const url = row.nearestUrl ? row.nearestUrl.replace(/#.*$/, '') : null;
    const key = url ?? '';
    const group: GapGroupAcc = groups.get(key) ?? { url, title: row.nearestTitle, count: 0, questions: new Map<string, GapQuestionAcc>() };
    group.count++;
    const norm = normalizeQuestion(row.questionRedacted);
    const q = group.questions.get(norm);
    if (q) {
      q.count++;
      if (row.createdAt > q.last) {
        q.last = row.createdAt;
        q.text = row.questionRedacted;
      }
      if (row.maxSimilarity !== null) q.sim = Math.max(q.sim ?? row.maxSimilarity, row.maxSimilarity);
    } else {
      group.questions.set(norm, { text: row.questionRedacted, count: 1, last: row.createdAt, sim: row.maxSimilarity });
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((g) => ({
      document_url: g.url,
      document_title: g.title,
      count: g.count,
      questions: [...g.questions.values()]
        .sort((a, b) => b.count - a.count || b.last.getTime() - a.last.getTime())
        .map((q) => ({ text: q.text, count: q.count, last_seen: q.last.toISOString(), max_similarity: q.sim })),
    }))
    .sort((a, b) => b.count - a.count || (a.document_url ?? '').localeCompare(b.document_url ?? ''));
}

export function conversationView(c: ConversationRecord): Record<string, unknown> {
  return {
    id: c.id,
    created_at: c.createdAt.toISOString(),
    question: c.questionRedacted,
    lang: c.lang,
    status: c.status,
    answer: c.answer,
    sources: c.sources,
    articles: c.articles,
    handoff_offered: c.handoffOffered,
    answered_by: c.answeredBy,
    floor_hit: c.floorHit,
    hedged: c.hedged,
    nearest_url: c.nearestUrl,
    max_similarity: c.maxSimilarity,
    latency_ms: c.latencyMs,
    generation_requests: c.generationRequests,
    tokens: { prompt: c.promptTokens, output: c.outputTokens, thoughts: c.thoughtsTokens },
    cost_usd: c.costUsd,
    country: c.country,
    error: c.error,
  };
}

export function dailyView(stats: { readonly conversations: readonly DailyConversationStats[]; readonly apiUsage: readonly DailyApiUsage[] }): Record<string, unknown> {
  return {
    days: stats.conversations.map((d) => ({
      day: d.day,
      conversations: d.total,
      by_status: d.byStatus,
      model_eligible: d.modelEligible,
      unavailable: d.unavailable,
      // Share of conversations that needed the model and got a model answer (not "unavailable").
      availability: d.modelEligible > 0 ? 1 - d.unavailable / d.modelEligible : null,
      latency_ms: { p50: d.latencyP50Ms, p95: d.latencyP95Ms },
      tokens: { prompt: d.promptTokens, output: d.outputTokens, thoughts: d.thoughtsTokens },
      equivalent_cost_usd: d.costUsd,
    })),
    api_usage: stats.apiUsage,
    note: 'Equivalent cost is tokens at paid list price; the free tier costs $0. Days are UTC; the Gemini daily quota resets at midnight Pacific time.',
  };
}
