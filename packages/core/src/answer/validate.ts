import type {
  AnswerSource,
  InvalidCitation,
  InvalidCitationReason,
  ModelAnswer,
  ModelCitation,
  RemovedSentence,
  VerifiedCitation,
} from './types.ts';

export const MAX_QUOTE_WORDS = 25;

/**
 * Normalization for quote matching: Unicode NFKC, typographic quotes and
 * dashes to ASCII, markdown links/emphasis/code marks removed, whitespace
 * collapsed, lower case. Applied identically to the quote and the source.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[‘’‚‛′´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const EDGE_PUNCTUATION = /^[\s"'.,;:!?()[\]-]+|[\s"'.,;:!?()[\]-]+$/g;

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/** Returns why a citation is invalid, or null when its quote is found verbatim in its source. */
export function checkCitation(
  citation: ModelCitation,
  sources: ReadonlyMap<string, AnswerSource>,
  normalizedSources = new Map<string, string>(),
): InvalidCitationReason | null {
  const source = sources.get(citation.source_id);
  if (!source) return 'unknown_source';
  const quote = normalizeForMatch(citation.quote).replace(EDGE_PUNCTUATION, '');
  if (quote.length === 0) return 'empty_quote';
  if (wordCount(citation.quote) > MAX_QUOTE_WORDS) return 'quote_too_long';
  let haystack = normalizedSources.get(source.id);
  if (haystack === undefined) {
    haystack = normalizeForMatch(source.text);
    normalizedSources.set(source.id, haystack);
  }
  return haystack.includes(quote) ? null : 'quote_not_found';
}

const MARKER_GROUP = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
const MARKERS_AFTER_PUNCT = /([.!?])((?:\s*\[\d+(?:\s*,\s*\d+)*\])+)/g;
const BULLET = /^(\s*(?:[-*•]|\d+[.)])\s+)/;
const ABBREVIATION = /(?:\b(?:e\.g|i\.e|etc|vs|approx|incl|no|p\.ej|aprox)\.|\b[A-Z]\.)$/i;

const COURTESY = [
  /\b(happy|glad) to help\b/i,
  /\blet me know\b/i,
  /\bhope (this|that) helps\b/i,
  /\bfeel free\b/i,
  /\banything else\b/i,
  /\bsupport team\b/i,
  /\b(a|real) (person|human)\b/i,
  /\bsomeone (from|on) (our|the) team\b/i,
  /\bconnect you\b/i,
  /\bcon gusto\b/i,
  /\bav[ií]same\b/i,
  /\bespero que (esto|te)\b/i,
  /\bno dudes\b/i,
  /\balgo m[aá]s\b/i,
  /\bequipo de soporte\b/i,
  /\buna persona\b/i,
  /\bponerte en contacto\b/i,
];

function markersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(MARKER_GROUP)) {
    for (const n of (m[1] ?? '').split(',')) out.push(Number(n.trim()));
  }
  return out;
}

function stripMarkers(text: string): string {
  return text.replace(MARKER_GROUP, '').replace(/\s+([.,;:!?])/g, '$1').trim();
}

/**
 * A sentence without markers is a factual claim unless it is clearly
 * non-informative: a question, an intro ending in ":", two words or fewer,
 * or a courtesy / hand-off phrase (English and Spanish list above).
 */
export function isClaim(sentence: string): boolean {
  const text = stripMarkers(sentence);
  if (text.length === 0) return false;
  if (/[?:]$/.test(text)) return false;
  if (wordCount(text) <= 2) return false;
  return !COURTESY.some((re) => re.test(text));
}

/** Splits a line into sentences, keeping markers that follow punctuation with their sentence. */
export function splitSentences(line: string): string[] {
  const moved = line.replace(MARKERS_AFTER_PUNCT, (_m, punct: string, marks: string) => ` ${marks.replace(/\s+/g, '')}${punct}`);
  const parts = moved.split(/(?<=[.!?])\s+(?=\S)/);
  const merged: string[] = [];
  for (const part of parts) {
    const prev = merged.at(-1);
    if (prev !== undefined && ABBREVIATION.test(prev)) merged[merged.length - 1] = `${prev} ${part}`;
    else merged.push(part);
  }
  return merged.map((s) => s.replace(/\s+\[/g, ' [').trim()).filter((s) => s.length > 0);
}

export interface ValidationOutcome {
  readonly answer: string;
  readonly citations: VerifiedCitation[];
  readonly invalidCitations: InvalidCitation[];
  readonly removedSentences: RemovedSentence[];
  /** At least one sentence kept a marker backed by a verified quote. */
  readonly hasSupportedSentence: boolean;
}

/**
 * Checks every citation against its source and rewrites the answer:
 * sentences whose markers all failed are removed, failed markers are dropped,
 * unmarked claims are removed when `requireMarkers` is set (status answered),
 * and surviving markers are renumbered 1..k in order of appearance.
 */
export function validateAnswer(
  model: Pick<ModelAnswer, 'answer' | 'citations'>,
  sources: readonly AnswerSource[],
  options: { readonly requireMarkers: boolean },
): ValidationOutcome {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const normalized = new Map<string, string>();
  const invalidCitations: InvalidCitation[] = [];
  const validByMarker = new Map<number, ModelCitation[]>();
  for (const citation of model.citations) {
    const reason = checkCitation(citation, byId, normalized);
    if (reason) {
      invalidCitations.push({ ...citation, reason });
    } else {
      const list = validByMarker.get(citation.marker) ?? [];
      list.push(citation);
      validByMarker.set(citation.marker, list);
    }
  }

  const removedSentences: RemovedSentence[] = [];
  let hasSupportedSentence = false;
  const lines: string[] = [];
  for (const rawLine of model.answer.replace(/\r\n?/g, '\n').split('\n')) {
    if (rawLine.trim() === '') {
      lines.push('');
      continue;
    }
    const prefix = BULLET.exec(rawLine)?.[1] ?? '';
    const kept: string[] = [];
    for (const sentence of splitSentences(rawLine.slice(prefix.length))) {
      const markers = markersIn(sentence);
      if (markers.length === 0) {
        if (options.requireMarkers && isClaim(sentence)) removedSentences.push({ text: sentence, reason: 'unmarked_claim' });
        else kept.push(sentence);
        continue;
      }
      const valid = markers.filter((m) => validByMarker.has(m));
      if (valid.length === 0) {
        removedSentences.push({ text: sentence, reason: 'failed_citation' });
        continue;
      }
      hasSupportedSentence = true;
      kept.push(
        sentence
          .replace(MARKER_GROUP, (_m, group: string) => {
            const keep = group
              .split(',')
              .map((n) => Number(n.trim()))
              .filter((n) => validByMarker.has(n));
            return keep.map((n) => `[${n}]`).join('');
          })
          .replace(/\s+([.,;:!?])/g, '$1')
          .replace(/\s{2,}/g, ' ')
          .trim(),
      );
    }
    if (kept.length > 0) lines.push(prefix + kept.join(' '));
  }

  // Renumber markers by first appearance.
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const renumber = new Map<number, number>();
  for (const m of markersIn(text)) if (!renumber.has(m)) renumber.set(m, renumber.size + 1);
  const answer = text.replace(MARKER_GROUP, (_m, group: string) =>
    group
      .split(',')
      .map((n) => `[${renumber.get(Number(n.trim())) ?? n.trim()}]`)
      .join(''),
  );

  const citations: VerifiedCitation[] = [];
  const seen = new Set<string>();
  for (const [oldMarker, newMarker] of [...renumber.entries()].sort((a, b) => a[1] - b[1])) {
    for (const c of validByMarker.get(oldMarker) ?? []) {
      const key = `${newMarker}|${c.source_id}|${normalizeForMatch(c.quote)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const source = byId.get(c.source_id);
      if (!source) continue;
      citations.push({
        marker: newMarker,
        sourceId: source.id,
        url: source.url,
        title: source.title,
        headingPath: source.headingPath,
        quote: c.quote,
      });
    }
  }

  return { answer, citations, invalidCitations, removedSentences, hasSupportedSentence };
}
