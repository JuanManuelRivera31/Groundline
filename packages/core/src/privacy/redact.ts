/**
 * Personal-data redaction for customer text (ADR-0012). It runs before the
 * question reaches the model and before anything is stored, because the Gemini
 * free tier may use submitted content to improve Google's products (rule 2).
 *
 * Deliberately conservative: a false positive costs a word of context, a false
 * negative leaks personal data. Detected spans become "[redacted]":
 * - email addresses;
 * - IPv4 and IPv6 addresses;
 * - card-shaped numbers: 13–19 digits, optionally grouped by single spaces or
 *   dashes (shape only, no Luhn check, so a 13-digit ms timestamp is redacted too);
 * - phone numbers: 9–15 digits with an optional leading "+", grouped by spaces,
 *   dashes, dots or parentheses (a bare 9-digit run such as "612345678" included).
 * Inside URLs only emails and IP addresses are redacted, so numeric path
 * segments and query values keep working. Dates, versions, ports and numbers
 * with thousands separators ("100,000") are left alone.
 */

export const REDACTED = '[redacted]';

export type PiiKind = 'email' | 'ip' | 'card' | 'phone';

export interface RedactionResult {
  readonly text: string;
  readonly counts: Readonly<Record<PiiKind, number>>;
  /** Total number of redacted spans. */
  readonly total: number;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`(?<![\\d.])${OCTET}(?:\\.${OCTET}){3}(?![\\d.]*\\d)`, 'g');
const H = '[0-9A-Fa-f]{1,4}';
// Full form, or a compressed form with "::". The look-arounds keep "std::vector" and "10:30:00" out.
const IPV6 = new RegExp(
  `(?<![\\w:])(?:(?:${H}:){7}${H}|(?:${H}:){1,7}:(?:${H}(?::${H}){0,6})?|::${H}(?::${H}){0,6})(?![\\w:])`,
  'g',
);
const CARD = /(?<![\w.,/-])\d(?:[ -]?\d){12,18}(?![\w/-]|[.,]\d)/g;
const PHONE_CANDIDATE = /(?<![\w.,/+-])(?:\+\s?)?\(?\d[\d ().\u00A0-]{6,}\d(?![\w]|[.,]\d)/g;
const MIN_PHONE_DIGITS = 9;
const MAX_PHONE_DIGITS = 15;

function digitCount(text: string): number {
  let n = 0;
  for (const ch of text) if (ch >= '0' && ch <= '9') n++;
  return n;
}

function redactSegment(segment: string, inUrl: boolean, counts: Record<PiiKind, number>): string {
  let out = segment.replace(EMAIL, () => {
    counts.email++;
    return REDACTED;
  });
  out = out.replace(IPV4, () => {
    counts.ip++;
    return REDACTED;
  });
  out = out.replace(IPV6, () => {
    counts.ip++;
    return REDACTED;
  });
  if (inUrl) return out;
  out = out.replace(CARD, () => {
    counts.card++;
    return REDACTED;
  });
  out = out.replace(PHONE_CANDIDATE, (match) => {
    const digits = digitCount(match);
    if (digits < MIN_PHONE_DIGITS || digits > MAX_PHONE_DIGITS) return match;
    counts.phone++;
    return REDACTED;
  });
  return out;
}

/** Replaces personal data in `text` with "[redacted]" and counts what was found. */
export function redactPii(text: string): RedactionResult {
  const counts: Record<PiiKind, number> = { email: 0, ip: 0, card: 0, phone: 0 };
  let out = '';
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    out += redactSegment(text.slice(last, start), false, counts);
    out += redactSegment(match[0], true, counts);
    last = start + match[0].length;
  }
  out += redactSegment(text.slice(last), false, counts);
  return { text: out, counts, total: counts.email + counts.ip + counts.card + counts.phone };
}
