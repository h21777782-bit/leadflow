import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: [".env.local", ".env"], quiet: true });

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // Only needed for `drizzle-kit studio` / `push`; `generate` works offline.
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/leadflow",
  },
  strict: true,
  verbose: true,
});
