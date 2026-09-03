/**
 * Tiny in-memory rate limiter for public demo endpoints.
 * Per-instance (fine for demo protection; not a security boundary —
 * authenticated admin routes don't depend on it).
 */
const buckets = new Map<string, number[]>();

export function demoRateLimit(
  key: string,
  maxHits: number,
  windowMs: number
): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= maxHits) {
    const oldest = hits[0];
    return {
      allowed: false,
      retryAfterSec: Math.ceil((oldest + windowMs - now) / 1000),
    };
  }
  hits.push(now);
  buckets.set(key, hits);
  // Prevent unbounded growth in long-lived instances.
  if (buckets.size > 5000) buckets.clear();
  return { allowed: true };
}
