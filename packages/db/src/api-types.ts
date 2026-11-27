/**
 * Data contract of the demo API (ADR-0012): conversations, hand-off cases,
 * per-IP rate limiting (hashed, never the IP) and the read-only admin views.
 * Implemented by the Postgres adapters next to `Db`.
 */

export interface ConversationSource {
  /** Marker number as shown in the answer ([1], [2]…). */
  readonly n: number;
  readonly title: string;
  readonly url: string;
  readonly quotes: readonly string[];
}

export interface ArticleRef {
  readonly title: string;
  readonly url: string;
}

export interface ConversationRecord {
  readonly id: string;
  readonly createdAt: Date;
  /** PII-redacted question; null when the request was region-blocked. */
  readonly questionRedacted: string | null;
  readonly lang: 'en' | 'es';
  readonly status: string;
  readonly answer: string;
  readonly sources: readonly ConversationSource[];
  readonly articles: readonly ArticleRef[];
  readonly handoffOffered: boolean;
  readonly answeredBy: string | null;
  readonly floorHit: boolean;
  readonly hedged: boolean;
  readonly nearestUrl: string | null;
  readonly nearestTitle: string | null;
  readonly maxSimilarity: number | null;
  readonly latencyMs: number;
  readonly generationRequests: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly thoughtsTokens: number;
  readonly costUsd: number | null;
  /** ISO 3166-1 alpha-2 code only. */
  readonly country: string | null;
  readonly error: string | null;
}

export interface HandoffInput {
  readonly id: string;
  readonly conversationId: string;
  readonly createdAt: Date;
  readonly noteRedacted: string | null;
  readonly deliveryStatus: string;
}

export interface HandoffRecord extends HandoffInput {
  readonly deliveredAt: Date | null;
}

export interface HandoffWithConversation extends HandoffRecord {
  readonly questionRedacted: string | null;
  readonly status: string;
  readonly answer: string;
}

export interface RateLimitRequest {
  readonly ipHash: string;
  readonly now: Date;
  readonly perMinute: number;
  readonly perDay: number;
  /** Start of the counting day (UTC midnight). */
  readonly dayStart: Date;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Counts before this request. */
  readonly minuteCount: number;
  readonly dayCount: number;
  /** Oldest event inside the last minute (for Retry-After), if any. */
  readonly oldestInMinute: Date | null;
}

export interface GapRow {
  readonly questionRedacted: string;
  readonly nearestUrl: string | null;
  readonly nearestTitle: string | null;
  readonly maxSimilarity: number | null;
  readonly createdAt: Date;
}

export interface DailyConversationStats {
  /** UTC day, YYYY-MM-DD. */
  readonly day: string;
  readonly total: number;
  readonly byStatus: Readonly<Record<string, number>>;
  /** Conversations that needed the model: not floor hits, region blocks or articles-only. */
  readonly modelEligible: number;
  readonly unavailable: number;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly thoughtsTokens: number;
  readonly costUsd: number;
}

export interface DailyApiUsage {
  readonly day: string;
  readonly model: string;
  readonly calls: number;
  readonly requests: number;
  /** Calls whose HTTP status was not 200 (including aborted or cancelled calls, status 0). */
  readonly failed: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
}

export interface PurgeResult {
  readonly conversations: number;
  readonly handoffs: number;
  readonly rateLimitEvents: number;
}

export interface ConversationQuery {
  readonly status?: string | undefined;
  readonly before?: Date | undefined;
  readonly limit: number;
}

export interface ApiStore {
  /** Cheap connectivity check for /v1/health. */
  ping(): Promise<void>;
  /**
   * Counts the hash's events in the minute before `now` and since `dayStart`,
   * and records this request only if both counts are under their limits.
   */
  consumeRateLimit(request: RateLimitRequest): Promise<RateLimitDecision>;

  insertConversation(conversation: ConversationRecord): Promise<void>;
  getConversation(id: string): Promise<ConversationRecord | null>;
  listConversations(query: ConversationQuery): Promise<ConversationRecord[]>;

  /** One case per conversation: returns the existing case when there already is one. */
  insertHandoff(handoff: HandoffInput): Promise<{ readonly created: boolean; readonly handoff: HandoffRecord }>;
  updateHandoffDelivery(id: string, deliveryStatus: string, deliveredAt: Date | null): Promise<void>;
  listHandoffs(query: { readonly before?: Date | undefined; readonly limit: number }): Promise<HandoffWithConversation[]>;

  /** Insufficient-status questions since `since`, newest first. */
  gapRows(query: { readonly since: Date; readonly limit: number }): Promise<GapRow[]>;
  dailyStats(since: Date): Promise<{ readonly conversations: DailyConversationStats[]; readonly apiUsage: DailyApiUsage[] }>;

  /** Deletes conversations (and their hand-off cases) created before `conversationsBefore`, and rate-limit events before `rateLimitBefore`. */
  purgeExpired(cutoffs: { readonly conversationsBefore: Date; readonly rateLimitBefore: Date }): Promise<PurgeResult>;
}
