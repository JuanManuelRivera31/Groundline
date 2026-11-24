import { applyPolicy, type AnswerSource, type ModelAnswer, type ModelCitation, type QuoteBounds } from '@groundline/core';
import type { AnswerRecord } from './answers.ts';

/** Marker offset for re-appended failed sentences, so they never collide with renumbered surviving markers. */
export const MARKER_OFFSET = 100;

const MARKER_GROUP = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

export function shiftMarkers(text: string, offset: number): string {
  return text.replace(MARKER_GROUP, (_m, group: string) => `[${group.split(',').map((n) => String(Number(n.trim()) + offset)).join(', ')}]`);
}

/**
 * Rebuilds the model's answer from a stored record (no API).
 * - Downgraded answers (`no_valid_citations`): the removed sentences in their
 *   original order with the original (invalid) citations. Exact except for
 *   courtesy-only sentences and line breaks, which were not stored.
 * - Other model answers: the final text with its surviving (renumbered)
 *   citations, plus the removed sentences re-appended with markers shifted
 *   by MARKER_OFFSET, together with their invalid citations.
 * Returns null when the model was not called or its output was invalid.
 */
export function reconstructModelAnswer(record: AnswerRecord): ModelAnswer | null {
  if (record.model_status === null || record.error?.startsWith('invalid_output')) return null;
  const base = { status: record.model_status, declined_injection: record.declined_injection, handoff_reason: record.handoff_reason };
  if (record.error === 'no_valid_citations') {
    return {
      ...base,
      answer: record.removed_sentences.map((s) => s.text).join(' '),
      citations: record.invalid_citations.map(({ marker, source_id, quote }) => ({ marker, source_id, quote })),
    };
  }
  const surviving: ModelCitation[] = record.citations.map((c) => ({ marker: c.marker, source_id: c.source_id, quote: c.quote }));
  const reappended = record.removed_sentences.map((s) => shiftMarkers(s.text, MARKER_OFFSET));
  return {
    ...base,
    answer: [record.answer, ...reappended].join(' ').trim(),
    citations: [
      ...surviving,
      ...record.invalid_citations.map(({ marker, source_id, quote }) => ({ marker: marker + MARKER_OFFSET, source_id, quote })),
    ],
  };
}

export interface RevalidatedRecord {
  readonly record: AnswerRecord;
  readonly changedStatus: boolean;
  /** Removed sentences before minus after. */
  readonly restoredSentences: number;
  readonly reconstructed: boolean;
}

/** Applies the current validator and policy to a stored answer, with the sources rebuilt from retrieval. */
export function revalidateRecord(record: AnswerRecord, sources: readonly AnswerSource[], bounds?: QuoteBounds): RevalidatedRecord {
  const model = reconstructModelAnswer(record);
  if (!model) return { record, changedStatus: false, restoredSentences: 0, reconstructed: false };
  const outcome = applyPolicy(record.question, model, sources, bounds);
  const byId = new Map(sources.map((s) => [s.id, s]));
  const cited = new Set(outcome.citations.map((c) => c.sourceId));
  const next: AnswerRecord = {
    ...record,
    status: outcome.status,
    answer: outcome.answer,
    citations: outcome.citations.map((c) => ({ marker: c.marker, source_id: c.sourceId, url: c.url, quote: c.quote })),
    cited_sources: [...cited].flatMap((id) => {
      const s = byId.get(id);
      return s ? [{ source_id: s.id, url: s.url, title: s.title, heading_path: s.headingPath, text: s.text }] : [];
    }),
    invalid_citations: outcome.invalidCitations,
    removed_sentences: outcome.removedSentences,
    handoff_offered: outcome.handoffOffered,
    handoff_reason: outcome.handoffReason,
    error: outcome.error,
  };
  return {
    record: next,
    changedStatus: next.status !== record.status,
    restoredSentences: record.removed_sentences.length - outcome.removedSentences.length,
    reconstructed: true,
  };
}
