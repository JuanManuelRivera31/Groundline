import { describe, expect, it } from 'vitest';
import type { AnswerSource } from '@groundline/core';
import type { AnswerRecord } from '../src/answers.ts';
import { MARKER_OFFSET, reconstructModelAnswer, revalidateRecord, shiftMarkers } from '../src/revalidate.ts';

const words = (n: number, prefix = 'w'): string => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');

const SOURCES: AnswerSource[] = [
  { id: 'S1', title: 'Trial', headingPath: 'Trial', url: 'https://x.test/docs/trial', text: `${words(40)} The trial lasts 30 days.`, similarity: 0.7, chunkIds: [1] },
  { id: 'S2', title: 'Plans', headingPath: 'Plans', url: 'https://x.test/docs/plans', text: words(120, 'p'), similarity: 0.6, chunkIds: [2] },
];

function record(over: Partial<AnswerRecord>): AnswerRecord {
  return {
    id: 'dev-001',
    category: 'billing_account',
    expected_behavior: 'answer',
    question: 'how long is the trial',
    expected_urls: ['https://x.test/docs/trial'],
    reference_answer: 'r',
    key_facts: [],
    status: 'answered',
    model_status: 'answered',
    declined_injection: false,
    answer: '',
    citations: [],
    cited_sources: [],
    sources: SOURCES.map((s) => ({ source_id: s.id, url: s.url, similarity: s.similarity })),
    invalid_citations: [],
    removed_sentences: [],
    model_citations: 0,
    max_similarity: 0.7,
    floor_hit: false,
    handoff_offered: false,
    handoff_reason: '',
    error: null,
    finish_reason: 'STOP',
    usage: { generationRequests: 1, promptTokens: 1, outputTokens: 1, thoughtsTokens: 0, embeddingTokens: 1 },
    latency: { retrievalMs: 1, generationMs: 1, totalMs: 2, queueWaitMs: 0 },
    cost_usd: 0,
    ...over,
  };
}

describe('revalidation', () => {
  it('shifts markers, including grouped ones', () => {
    expect(shiftMarkers('a [1]. b [2, 3]', MARKER_OFFSET)).toBe('a [101]. b [102, 103]');
  });

  it('restores a downgraded answer whose only fault was a quote over 25 words', () => {
    const longQuote = `${words(40)} The trial lasts 30 days.`; // 45 words, verbatim
    const downgraded = record({
      status: 'insufficient',
      error: 'no_valid_citations',
      answer: 'I could not find this…',
      handoff_offered: true,
      removed_sentences: [
        { text: 'No, you are fine.', reason: 'unmarked_claim' },
        { text: 'The trial lasts 30 days [1].', reason: 'failed_citation' },
      ],
      invalid_citations: [{ marker: 1, source_id: 'S1', quote: longQuote, reason: 'quote_too_long' }],
      model_citations: 1,
    });
    expect(reconstructModelAnswer(downgraded)).toMatchObject({ answer: 'No, you are fine. The trial lasts 30 days [1].', citations: [{ marker: 1, source_id: 'S1' }] });
    const r = revalidateRecord(downgraded, SOURCES);
    expect(r).toMatchObject({ changedStatus: true, reconstructed: true, restoredSentences: 1 });
    expect(r.record).toMatchObject({ status: 'answered', error: null, answer: 'The trial lasts 30 days [1].', handoff_offered: false });
    expect(r.record.cited_sources.map((s) => s.url)).toEqual(['https://x.test/docs/trial']);
    expect(r.record.removed_sentences).toEqual([{ text: 'No, you are fine.', reason: 'unmarked_claim' }]);
  });

  it('keeps rejecting quotes over 80 words', () => {
    const r = revalidateRecord(
      record({
        status: 'insufficient',
        error: 'no_valid_citations',
        removed_sentences: [{ text: 'Plans are described [1].', reason: 'failed_citation' }],
        invalid_citations: [{ marker: 1, source_id: 'S2', quote: words(90, 'p'), reason: 'quote_too_long' }],
      }),
      SOURCES,
    );
    expect(r.changedStatus).toBe(false);
    expect(r.record.status).toBe('insufficient');
    expect(r.record.invalid_citations[0]?.reason).toBe('quote_too_long');
  });

  it('re-appends failed sentences of an answered record with offset markers and renumbers', () => {
    const answered = record({
      answer: 'Plans are listed [1].',
      citations: [{ marker: 1, source_id: 'S2', url: 'https://x.test/docs/plans', quote: words(5, 'p') }],
      removed_sentences: [{ text: 'The trial lasts 30 days [1].', reason: 'failed_citation' }],
      invalid_citations: [{ marker: 1, source_id: 'S1', quote: `${words(40)} The trial lasts 30 days.`, reason: 'quote_too_long' }],
    });
    const model = reconstructModelAnswer(answered);
    expect(model?.answer).toBe('Plans are listed [1]. The trial lasts 30 days [101].');
    expect(model?.citations.map((c) => c.marker)).toEqual([1, 101]);
    const r = revalidateRecord(answered, SOURCES);
    expect(r).toMatchObject({ changedStatus: false, restoredSentences: 1 });
    expect(r.record.answer).toBe('Plans are listed [1]. The trial lasts 30 days [2].');
    expect(r.record.citations.map((c) => [c.marker, c.source_id])).toEqual([
      [1, 'S2'],
      [2, 'S1'],
    ]);
  });

  it('leaves floor hits and invalid outputs untouched', () => {
    const floor = record({ status: 'insufficient', model_status: null, floor_hit: true });
    expect(revalidateRecord(floor, SOURCES)).toMatchObject({ changedStatus: false, reconstructed: false, record: floor });
    const invalid = record({ status: 'insufficient', error: 'invalid_output: response is not valid JSON' });
    expect(revalidateRecord(invalid, SOURCES).reconstructed).toBe(false);
  });
});
