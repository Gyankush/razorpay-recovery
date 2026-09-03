import { NextRequest, NextResponse } from "next/server";

/**
 * Central auth gate for money-moving and admin APIs.
 * Webhook ingestion stays HMAC-protected (not by this gate).
 * Read-only GETs stay open; every POST/PUT/PATCH/DELETE under
 * /api/payment-cases/* plus the admin prefixes below require
 * the `x-admin-secret` header when ADMIN_SECRET is configured.
 */
const ADMIN_PREFIXES = [
  "/api/recovery-runs",
  "/api/demo/",
  "/api/eval/",
  "/api/reconciliation/run",
  "/api/connectors/",
  "/api/agent/",
  "/api/autopilot/",
  "/api/merchants/",
  "/api/webhooks/razorpay/sweep",
];

function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isCaseMutation =
    pathname.startsWith("/api/payment-cases/") && req.method !== "GET";
  const isAdminPath = ADMIN_PREFIXES.some((p) => pathname.startsWith(p));

  if (!isCaseMutation && !isAdminPath) return NextResponse.next();

  const secret = process.env.ADMIN_SECRET;
  const cronSecret = process.env.CRON_SECRET;

  // Vercel Cron authenticates as `Authorization: Bearer <CRON_SECRET>`.
  const authz = req.headers.get("authorization") ?? "";
  if (cronSecret && authz === `Bearer ${cronSecret}`) {
    return NextResponse.next();
  }

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json(
        { error: "Server misconfigured: ADMIN_SECRET is not set" },
        { status: 503 }
      );
    }
    console.warn(
      `[middleware] ADMIN_SECRET unset — allowing ${req.method} ${pathname} (development only)`
    );
    return NextResponse.next();
  }

  const provided = req.headers.get("x-admin-secret") ?? "";
  if (provided && timingSafeCompare(provided, secret)) {
    return NextResponse.next();
  }
  return NextResponse.json(
    { error: "Unauthorized: valid x-admin-secret header required" },
    { status: 401 }
  );
}

export const config = {
  matcher: ["/api/:path*"],
};
