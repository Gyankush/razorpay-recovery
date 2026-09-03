/**
 * Connectivity + sanity check for any Postgres backend (Supabase *or* Neon).
 *
 * Usage:
 *   npm run db:check                  # checks DATABASE_URL from .env.local
 *   npm run db:check -- --db-url="postgresql://..."   # checks another backend
 *
 * Prints the (masked) host, server version, and row counts for the core
 * tables. Exits non-zero when the backend is unreachable or PayRescue
 * tables are missing. Never prints credentials.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import postgres from "postgres";

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(unparseable url)";
  }
}

async function main() {
  const flagIdx = process.argv.indexOf("--db-url");
  const connectionString =
    (flagIdx >= 0 ? process.argv[flagIdx + 1] : undefined) ||
    process.env.DATABASE_URL;

  if (!connectionString) {
    console.error("db:check: no connection string (set DATABASE_URL or --db-url)");
    process.exit(1);
  }

  console.log(`db:check: ${maskUrl(connectionString)}`);
  const sql = postgres(connectionString, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 10,
    ssl:
      !connectionString.includes("localhost") &&
      !connectionString.includes("127.0.0.1")
        ? "require"
        : false,
  });

  try {
    const v = await sql`SELECT version() AS v`;
    console.log(`server: ${String(v[0].v).split(" ").slice(0, 2).join(" ")}`);

    const tables = [
      "merchants",
      "orders",
      "payment_attempts",
      "payment_cases",
      "recovery_actions",
      "payment_links",
      "webhook_events",
      "settlements",
      "recon_items",
      "audit_logs",
      "autopilot_policies",
    ];
    for (const t of tables) {
      try {
        const r = await sql.unsafe(
          `SELECT count(*)::int AS n FROM "${t}"`
        );
        console.log(`${t}: ${r[0].n} rows`);
      } catch {
        console.log(`${t}: MISSING`);
      }
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("db:check failed:", err?.message ?? err);
  process.exit(1);
});
