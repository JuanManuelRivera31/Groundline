import type {
  ApiUsageInput,
  CachedEmbeddingRow,
  CandidateLists,
  CandidateQuery,
  ConversationQuery,
  ConversationRecord,
  DailyApiUsage,
  DailyConversationStats,
  GapRow,
  HandoffInput,
  HandoffRecord,
  HandoffWithConversation,
  PurgeResult,
  RateLimitDecision,
  RateLimitRequest,
  SearchHit,
} from '@groundline/db';
import type { Store } from '../src/ask.ts';

export interface MemoryChunk {
  readonly chunkId: number;
  readonly ord: number;
  readonly url: string;
  readonly headingPath: string;
  readonly documentTitle: string;
  readonly content: string;
  readonly embedding: readonly number[];
  readonly embeddingModel: string;
}

const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
const day = (d: Date): string => d.toISOString().slice(0, 10);

/** In-memory stand-in for Postgres (engine reads plus the API tables), for offline API tests. */
export class MemoryStore implements Store {
  readonly chunks: MemoryChunk[] = [];
  readonly cache = new Map<string, CachedEmbeddingRow>();
  readonly usage: (ApiUsageInput & { ts: Date })[] = [];
  readonly conversations = new Map<string, ConversationRecord>();
  readonly handoffs = new Map<string, HandoffRecord>();
  readonly demoRequests: { ipHash: string; ts: Date }[] = [];
  pingFails = false;

  ping(): Promise<void> {
    return this.pingFails ? Promise.reject(new Error('db down')) : Promise.resolve();
  }

  getCachedEmbeddings(keys: readonly string[]): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    for (const k of keys) {
      const row = this.cache.get(k);
      if (row) out.set(k, [...row.vector]);
    }
    return Promise.resolve(out);
  }

  putCachedEmbeddings(entries: readonly CachedEmbeddingRow[]): Promise<void> {
    for (const e of entries) if (!this.cache.has(e.key)) this.cache.set(e.key, e);
    return Promise.resolve();
  }

  recordApiUsage(usage: ApiUsageInput): Promise<void> {
    this.usage.push({ ...usage, ts: new Date() });
    return Promise.resolve();
  }

  sumApiRequestsSince(since: Date, model: string): Promise<number> {
    return Promise.resolve(this.usage.filter((u) => u.model === model && u.ts >= since).reduce((s, u) => s + u.requests, 0));
  }

  searchVector(vector: readonly number[], embeddingModel: string, limit: number): Promise<SearchHit[]> {
    const hits = this.chunks
      .filter((c) => c.embeddingModel === embeddingModel)
      .map((c) => ({ ...this.#hit(c), score: cosine(vector, c.embedding) }))
      .sort((a, b) => b.score - a.score || a.chunkId - b.chunkId)
      .slice(0, limit);
    return Promise.resolve(hits);
  }

  searchFullText(query: string, limit: number): Promise<SearchHit[]> {
    const q = words(query);
    const hits = this.chunks
      .map((c) => {
        const w = words(`${c.headingPath} ${c.content}`);
        let score = 0;
        for (const t of q) if (w.has(t)) score++;
        return { ...this.#hit(c), score };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.chunkId - b.chunkId)
      .slice(0, limit);
    return Promise.resolve(hits);
  }

  async searchCandidates(q: CandidateQuery): Promise<CandidateLists> {
    const vector = (await this.searchVector(q.vector, q.embeddingModel, q.vectorK)).map((h) => ({ ...h, cosine: h.score }));
    const fullText = (await this.searchFullText(q.query, q.ftsK)).map((h) => ({ ...h, cosine: null }));
    return { vector, fullText };
  }

  #hit(c: MemoryChunk): Omit<SearchHit, 'score'> {
    return { chunkId: c.chunkId, ord: c.ord, headingPath: c.headingPath, url: c.url, content: c.content, documentTitle: c.documentTitle };
  }

  consumeRateLimit(r: RateLimitRequest): Promise<RateLimitDecision> {
    const minuteStart = r.now.getTime() - 60_000;
    const mine = this.demoRequests.filter((e) => e.ipHash === r.ipHash);
    const inMinute = mine.filter((e) => e.ts.getTime() > minuteStart);
    const minuteCount = inMinute.length;
    const dayCount = mine.filter((e) => e.ts >= r.dayStart).length;
    const allowed = minuteCount < r.perMinute && dayCount < r.perDay;
    if (allowed) this.demoRequests.push({ ipHash: r.ipHash, ts: r.now });
    const oldest = inMinute.reduce<Date | null>((m, e) => (m === null || e.ts < m ? e.ts : m), null);
    return Promise.resolve({ allowed, minuteCount, dayCount, oldestInMinute: oldest });
  }

  insertConversation(c: ConversationRecord): Promise<void> {
    if (this.conversations.has(c.id)) return Promise.reject(new Error('duplicate conversation id'));
    this.conversations.set(c.id, c);
    return Promise.resolve();
  }

  getConversation(id: string): Promise<ConversationRecord | null> {
    return Promise.resolve(this.conversations.get(id) ?? null);
  }

  listConversations(q: ConversationQuery): Promise<ConversationRecord[]> {
    return Promise.resolve(
      [...this.conversations.values()]
        .filter((c) => (q.status === undefined || c.status === q.status) && (q.before === undefined || c.createdAt < q.before))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, q.limit),
    );
  }

  insertHandoff(h: HandoffInput): Promise<{ readonly created: boolean; readonly handoff: HandoffRecord }> {
    const existing = [...this.handoffs.values()].find((x) => x.conversationId === h.conversationId);
    if (existing) return Promise.resolve({ created: false, handoff: existing });
    const record: HandoffRecord = { ...h, deliveredAt: null };
    this.handoffs.set(h.id, record);
    return Promise.resolve({ created: true, handoff: record });
  }

  updateHandoffDelivery(id: string, deliveryStatus: string, deliveredAt: Date | null): Promise<void> {
    const h = this.handoffs.get(id);
    if (h) this.handoffs.set(id, { ...h, deliveryStatus, deliveredAt });
    return Promise.resolve();
  }

  listHandoffs(q: { readonly before?: Date | undefined; readonly limit: number }): Promise<HandoffWithConversation[]> {
    const rows = [...this.handoffs.values()]
      .filter((h) => q.before === undefined || h.createdAt < q.before)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, q.limit)
      .map((h) => {
        const c = this.conversations.get(h.conversationId);
        return { ...h, questionRedacted: c?.questionRedacted ?? null, status: c?.status ?? '', answer: c?.answer ?? '' };
      });
    return Promise.resolve(rows);
  }

  gapRows(q: { readonly since: Date; readonly limit: number }): Promise<GapRow[]> {
    return Promise.resolve(
      [...this.conversations.values()]
        .filter((c) => c.status === 'insufficient' && c.questionRedacted !== null && c.createdAt >= q.since)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, q.limit)
        .map((c) => ({ questionRedacted: c.questionRedacted ?? '', nearestUrl: c.nearestUrl, nearestTitle: c.nearestTitle, maxSimilarity: c.maxSimilarity, createdAt: c.createdAt })),
    );
  }

  dailyStats(since: Date): Promise<{ readonly conversations: DailyConversationStats[]; readonly apiUsage: DailyApiUsage[] }> {
    const byDay = new Map<string, ConversationRecord[]>();
    for (const c of this.conversations.values()) {
      if (c.createdAt < since) continue;
      const list = byDay.get(day(c.createdAt)) ?? [];
      list.push(c);
      byDay.set(day(c.createdAt), list);
    }
    const pct = (xs: number[], p: number): number | null => {
      if (xs.length === 0) return null;
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] ?? null;
    };
    const conversations = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([d, list]) => {
        const byStatus: Record<string, number> = {};
        for (const c of list) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
        const timed = list.filter((c) => c.status !== 'region_blocked').map((c) => c.latencyMs);
        return {
          day: d,
          total: list.length,
          byStatus,
          modelEligible: list.filter((c) => !c.floorHit && c.status !== 'region_blocked' && c.status !== 'articles_only').length,
          unavailable: list.filter((c) => c.status === 'unavailable').length,
          latencyP50Ms: pct(timed, 0.5),
          latencyP95Ms: pct(timed, 0.95),
          promptTokens: list.reduce((s, c) => s + c.promptTokens, 0),
          outputTokens: list.reduce((s, c) => s + c.outputTokens, 0),
          thoughtsTokens: list.reduce((s, c) => s + c.thoughtsTokens, 0),
          costUsd: list.reduce((s, c) => s + (c.costUsd ?? 0), 0),
        };
      });
    const usage = new Map<string, DailyApiUsage>();
    for (const u of this.usage) {
      if (u.ts < since) continue;
      const key = `${day(u.ts)}|${u.model}`;
      const prev = usage.get(key) ?? { day: day(u.ts), model: u.model, calls: 0, requests: 0, failed: 0, promptTokens: 0, outputTokens: 0 };
      usage.set(key, {
        ...prev,
        calls: prev.calls + 1,
        requests: prev.requests + u.requests,
        failed: prev.failed + (u.httpStatus === 200 ? 0 : 1),
        promptTokens: prev.promptTokens + (u.promptTokens ?? 0),
        outputTokens: prev.outputTokens + (u.outputTokens ?? 0),
      });
    }
    return Promise.resolve({ conversations, apiUsage: [...usage.values()] });
  }

  purgeExpired(cutoffs: { readonly conversationsBefore: Date; readonly rateLimitBefore: Date }): Promise<PurgeResult> {
    let conversations = 0;
    let handoffs = 0;
    for (const [id, c] of this.conversations) {
      if (c.createdAt >= cutoffs.conversationsBefore) continue;
      this.conversations.delete(id);
      conversations++;
      for (const [hid, h] of this.handoffs) {
        if (h.conversationId === id) {
          this.handoffs.delete(hid);
          handoffs++;
        }
      }
    }
    const before = this.demoRequests.length;
    const kept = this.demoRequests.filter((e) => e.ts >= cutoffs.rateLimitBefore);
    this.demoRequests.splice(0, this.demoRequests.length, ...kept);
    return Promise.resolve({ conversations, handoffs, rateLimitEvents: before - kept.length });
  }
}
