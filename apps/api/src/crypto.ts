// Web Crypto helpers (crypto.subtle exists on Node and Workers).

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)));
}

/** UTC calendar day, YYYY-MM-DD. */
export function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function utcDayStart(epochMs: number): number {
  const d = new Date(epochMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Daily-salted IP hash: salt = HMAC(secret, UTC day), hash = HMAC(salt, ip).
 * The IP itself is never stored, and hashes from different days cannot be linked
 * without the secret.
 */
export async function hashIp(secret: string, ip: string, epochMs: number): Promise<string> {
  const salt = await hmacSha256Hex(secret, `groundline-ip-salt:${utcDay(epochMs)}`);
  return hmacSha256Hex(salt, ip);
}

/** Compares two secrets without an early exit on the first differing character. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
