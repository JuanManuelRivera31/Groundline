/**
 * Regional block (ADR-0012). The Gemini API Additional Terms say: "You may use
 * only Paid Services when making API Clients available to users in the European
 * Economic Area, Switzerland, or the United Kingdom". The demo runs on the free
 * (unpaid) tier, so requests from those places never reach Gemini.
 * Source: https://ai.google.dev/gemini-api/terms (effective 2026-03-23, read 2026-11-26).
 */

/** The 27 EU member states (ISO 3166-1 alpha-2). */
const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
/** EEA members outside the EU. */
const EEA_EXTRA = ['IS', 'LI', 'NO'];
/** Switzerland and the United Kingdom. */
const CH_UK = ['CH', 'GB'];
/**
 * Conservative extras with their own ISO codes: EU territories that geolocation
 * may report separately (Åland, French outermost regions, Saint-Martin) and the
 * Crown Dependencies plus Gibraltar.
 */
const PRUDENT = ['AX', 'GF', 'GP', 'MQ', 'RE', 'YT', 'MF', 'GG', 'JE', 'IM', 'GI'];

export const DEFAULT_BLOCKED_COUNTRIES: readonly string[] = [...EU, ...EEA_EXTRA, ...CH_UK, ...PRUDENT];

/** "XX" is the conventional unknown-country code; anything not shaped like a two-letter code is unknown too (e.g. "T1"). */
export function normalizeCountry(raw: string | null | undefined): string | null {
  const code = raw?.trim().toUpperCase();
  if (!code || !/^[A-Z]{2}$/.test(code) || code === 'XX') return null;
  return code;
}

export function isRegionBlocked(country: string | null, blocked: ReadonlySet<string>, blockUnknown: boolean): boolean {
  if (country === null) return blockUnknown;
  return blocked.has(country);
}
