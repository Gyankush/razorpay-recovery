import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as dotenv from "dotenv";
import * as schema from "./schema";

// Load environment variables from .env.local, then .env
dotenv.config({ path: ".env.local" });
dotenv.config();

// Ensure DATABASE_URL is present
const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/payrescue";

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
