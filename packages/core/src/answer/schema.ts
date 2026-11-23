import { ANSWER_STATUSES, type AnswerStatus, type ModelAnswer, type ModelCitation } from './types.ts';

/** JSON Schema for the model's structured output; source ids are restricted to the ones sent. */
export function answerResponseSchema(sourceIds: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: [...ANSWER_STATUSES] },
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

export type ParseResult = { readonly ok: true; readonly value: ModelAnswer } | { readonly ok: false; readonly error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Parses and type-checks the model's JSON. Content (source ids, quotes) is
 * validated separately; this only rejects output that does not fit the shape.
 */
export function parseModelAnswer(text: string): ParseResult {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let raw: unknown;
  try {
    raw = JSON.parse(stripped);
  } catch {
    return { ok: false, error: 'response is not valid JSON' };
  }
  if (!isRecord(raw)) return { ok: false, error: 'response is not a JSON object' };

  const status = raw.status;
  if (typeof status !== 'string' || !(ANSWER_STATUSES as readonly string[]).includes(status)) {
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
    if (typeof marker !== 'number' || !Number.isInteger(marker) || marker < 1) {
      return { ok: false, error: `citation ${i} has an invalid marker` };
    }
    if (typeof sourceId !== 'string' || typeof quote !== 'string') {
      return { ok: false, error: `citation ${i} needs string source_id and quote` };
    }
    citations.push({ marker, source_id: sourceId, quote });
  }

  return {
    ok: true,
    value: {
      status: status as AnswerStatus,
      declined_injection: raw.declined_injection,
      answer: raw.answer,
      citations,
      handoff_reason: handoff,
    },
  };
}
