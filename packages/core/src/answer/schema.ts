import { MODEL_STATUSES, type ModelAnswer, type ModelCitation, type ModelStatus } from './types.ts';

/** JSON Schema for the model's structured output; source ids are restricted to the ones sent. */
export function answerResponseSchema(sourceIds: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: [...MODEL_STATUSES] },
      declined_injection: { type: 'boolean' },
      answer: { type: 'string' },
      citations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            marker: { type: 'integer', minimum: 1 },
            source_id: { type: 'string', enum: [...sourceIds] },
            quote: { type: 'string' },
          },
          required: ['marker', 'source_id', 'quote'],
        },
      },
      handoff_reason: { type: 'string' },
    },
    required: ['status', 'declined_injection', 'answer', 'citations', 'handoff_reason'],
  };
}

/**
 * JSON Schema for prompts with source-id markers ([S1]): citations carry only
 * source_id and quote, so a marker can never point at the wrong source.
 */
export function sourceMarkerResponseSchema(sourceIds: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: [...MODEL_STATUSES] },
      declined_injection: { type: 'boolean' },
      answer: { type: 'string' },
      citations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            source_id: { type: 'string', enum: [...sourceIds] },
            quote: { type: 'string' },
          },
          required: ['source_id', 'quote'],
        },
      },
      handoff_reason: { type: 'string' },
    },
    required: ['status', 'declined_injection', 'answer', 'citations', 'handoff_reason'],
  };
}

export type MarkerStyle = 'numeric' | 'source';

/** Internal marker base for bare numeric markers in source-style output: never backed by a citation, so the cascade drops them. */
export const ORPHAN_MARKER_BASE = 10_000;

const SOURCE_MARKER_GROUP = /\[\s*(S\d+(?:\s*,\s*S\d+)*)\s*\]/gi;
const NUMERIC_MARKER_GROUP = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/** "S3" -> 3; null for anything else. */
export function sourceNumber(sourceId: string): number | null {
  const m = /^S(\d+)$/i.exec(sourceId.trim());
  return m?.[1] ? Number(m[1]) : null;
}

/**
 * Rewrites source-style markers into the internal numeric form used by the
 * validator: [S3] -> [3], and any bare numeric marker [n] -> [10000+n] (never
 * valid). Each citation's internal marker is its source number, so a sentence
 * marked [S3] is supported exactly by verified quotes from S3.
 */
export function sourceMarkersToInternal(answer: string): string {
  return answer
    .replace(NUMERIC_MARKER_GROUP, (_m, group: string) =>
      `[${group
        .split(',')
        .map((n) => String(ORPHAN_MARKER_BASE + Number(n.trim())))
        .join(', ')}]`,
    )
    .replace(SOURCE_MARKER_GROUP, (_m, group: string) =>
      `[${group
        .split(',')
        .map((id) => String(sourceNumber(id) ?? ORPHAN_MARKER_BASE))
        .join(', ')}]`,
    );
}

export type ParseResult = { readonly ok: true; readonly value: ModelAnswer } | { readonly ok: false; readonly error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Parses and type-checks the model's JSON. Content (source ids, quotes) is
 * validated separately; this only rejects output that does not fit the shape.
 */
export function parseModelAnswer(text: string, style: MarkerStyle = 'numeric'): ParseResult {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let raw: unknown;
  try {
    raw = JSON.parse(stripped);
  } catch {
    return { ok: false, error: 'response is not valid JSON' };
  }
  if (!isRecord(raw)) return { ok: false, error: 'response is not a JSON object' };

  const status = raw.status;
  if (typeof status !== 'string' || !(MODEL_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: `invalid status ${JSON.stringify(status)}` };
  }
  if (typeof raw.answer !== 'string') return { ok: false, error: 'answer must be a string' };
  if (typeof raw.declined_injection !== 'boolean') return { ok: false, error: 'declined_injection must be a boolean' };
  const handoff = raw.handoff_reason ?? '';
  if (typeof handoff !== 'string') return { ok: false, error: 'handoff_reason must be a string' };
  if (!Array.isArray(raw.citations)) return { ok: false, error: 'citations must be an array' };

  const citations: ModelCitation[] = [];
  for (const [i, c] of (raw.citations as unknown[]).entries()) {
    if (!isRecord(c)) return { ok: false, error: `citation ${i} is not an object` };
    const { marker, source_id: sourceId, quote } = c;
    if (typeof sourceId !== 'string' || typeof quote !== 'string') {
      return { ok: false, error: `citation ${i} needs string source_id and quote` };
    }
    if (style === 'source') {
      // Internal marker = source number; an unknown id gets a marker no text marker can match.
      citations.push({ marker: sourceNumber(sourceId) ?? ORPHAN_MARKER_BASE - 1, source_id: sourceId, quote });
      continue;
    }
    if (typeof marker !== 'number' || !Number.isInteger(marker) || marker < 1) {
      return { ok: false, error: `citation ${i} has an invalid marker` };
    }
    citations.push({ marker, source_id: sourceId, quote });
  }

  return {
    ok: true,
    value: {
      status: status as ModelStatus,
      declined_injection: raw.declined_injection,
      answer: style === 'source' ? sourceMarkersToInternal(raw.answer) : raw.answer,
      citations,
      handoff_reason: handoff,
    },
  };
}
