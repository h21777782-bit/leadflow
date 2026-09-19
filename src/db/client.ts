import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv } from "@/lib/env";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

/**
 * One connection pool per process. In `next dev`, modules are re-evaluated on
 * hot reload, so the pool is cached on globalThis to avoid leaking connections.
 */
const globalForDb = globalThis as unknown as {
  __leadflowSql?: postgres.Sql;
  __leadflowDb?: Database;
};

export function getDb(): Database {
  if (!globalForDb.__leadflowDb) {
    const env = getEnv();
    const client = postgres(env.DATABASE_URL, {
      max: 10,
      connect_timeout: 5, // seconds — fail fast so the UI can show a DB error state
      idle_timeout: 20,
      onnotice: () => {},
    });
    globalForDb.__leadflowSql = client;
    globalForDb.__leadflowDb = drizzle(client, { schema });
  }
  return globalForDb.__leadflowDb;
}

export async function closeDb(): Promise<void> {
  await globalForDb.__leadflowSql?.end({ timeout: 5 });
  globalForDb.__leadflowSql = undefined;
  globalForDb.__leadflowDb = undefined;
}

export { schema };
