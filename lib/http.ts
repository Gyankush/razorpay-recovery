import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Returns true when the request carries the admin secret or cron secret. */
export function isAdminRequest(req: NextRequest): boolean {
  // Vercel Cron: when CRON_SECRET is configured, Vercel sends it as
  // `Authorization: Bearer <CRON_SECRET>` on every scheduled hit.
  const cronSecret = process.env.CRON_SECRET;
  const authz = req.headers.get("authorization") ?? "";
  if (cronSecret && authz === `Bearer ${cronSecret}`) return true;

  const secret = process.env.ADMIN_SECRET;
  // Dev convenience: open when no secret is configured. Production callers
  // must treat "no secret configured" as misconfigured and refuse (see below).
  if (!secret) return !isProduction();

  const provided = req.headers.get("x-admin-secret");
  if (!provided) return false;
  try {
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(secret, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Enforces the admin gate for a mutating/admin route.
 * Returns a 401/503 NextResponse when blocked, or null when allowed.
 */
export function requireAdmin(req: NextRequest): NextResponse | null {
  if (
    !process.env.ADMIN_SECRET &&
    !process.env.CRON_SECRET &&
    isProduction()
  ) {
    return NextResponse.json(
      { error: "Server misconfigured: ADMIN_SECRET is not set" },
      { status: 503 }
    );
  }
  if (!isAdminRequest(req)) {
    return NextResponse.json(
      { error: "Unauthorized: valid x-admin-secret header required" },
      { status: 401 }
    );
  }
  return null;
}

/** Propagates a client request id, or mints one when absent. */
export function getRequestId(req: NextRequest, prefix = "req"): string {
  return (
    req.headers.get("x-request-id") ||
    `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
  );
}

const ALLOWED_CURRENCIES = new Set([
  "INR",
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "SGD",
  "AED",
]);

export function normalizeCurrency(input: unknown, fallback = "USD"): string {
  const c = String(input ?? fallback)
    .toUpperCase()
    .trim();
  return ALLOWED_CURRENCIES.has(c) ? c : fallback;
}

export function isValidCurrency(input: unknown): boolean {
  return ALLOWED_CURRENCIES.has(String(input ?? "").toUpperCase().trim());
}

/** Returns a floored positive integer, or null when invalid. */
export function toPositiveInt(input: unknown): number | null {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export function isUuid(input: unknown): boolean {
  return (
    typeof input === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)
  );
}

/** Never-throwing JSON.parse for untrusted DB text columns. */
export function safeJsonParse<T = unknown>(
  text: string | null | undefined
): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
