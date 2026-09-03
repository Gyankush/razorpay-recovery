import { defineConfig } from "drizzle-kit";
import * as dotenv from "dotenv";

// Load environment variables from .env.local, then .env
dotenv.config({ path: ".env.local" });
dotenv.config();

if (!process.env.DATABASE_URL && process.env.NODE_ENV === "production") {
  throw new Error(
    "DATABASE_URL is missing. Refusing to use the local fallback in production."
  );
}

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ||
      "postgresql://postgres:postgres@localhost:5432/payrescue",
  },
  verbose: true,
  strict: false,
});
