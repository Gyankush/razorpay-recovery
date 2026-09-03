import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as dotenv from "dotenv";
import * as schema from "./schema";

// Load environment variables from .env.local, then .env
dotenv.config({ path: ".env.local" });
dotenv.config();

// Fail fast in production: never silently fall back to a local database,
// which would read/write the wrong data without anyone noticing.
if (!process.env.DATABASE_URL && process.env.NODE_ENV === "production") {
  throw new Error(
    "DATABASE_URL is missing. Refusing to start with a local fallback in production."
  );
}

// Ensure DATABASE_URL is present (local fallback is dev-only)
const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/payrescue";

if (!process.env.DATABASE_URL) {
  console.warn(
    "[db] DATABASE_URL not set — using local dev fallback postgresql://postgres:***@localhost:5432/payrescue"
  );
} else if (
  !process.env.DATABASE_URL.includes("localhost") &&
  !process.env.DATABASE_URL.includes("127.0.0.1")
) {
  try {
    console.log(
      `[db] connecting to ${new URL(process.env.DATABASE_URL).host} (password hidden)`
    );
  } catch {
    // ignore URL parse errors here; the driver will surface them
  }
}

/**
 * Cache connection for Next.js hot-reloading in development to avoid leaking connections.
 */
declare global {
  // eslint-disable-next-line no-var
  var _postgresClient: postgres.Sql | undefined;
}

const client =
  globalThis._postgresClient ??
  postgres(connectionString, {
    max: process.env.NODE_ENV === "production" ? 10 : 1,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl:
      process.env.DATABASE_URL &&
      !process.env.DATABASE_URL.includes("localhost") &&
      !process.env.DATABASE_URL.includes("127.0.0.1")
        ? "require"
        : false,
  });

if (process.env.NODE_ENV !== "production") {
  globalThis._postgresClient = client;
}

export const db = drizzle(client, { schema });
export { client };
export * from "./schema";
