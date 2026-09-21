import { eq, sql } from "drizzle-orm";
import { appSettings } from "@/db/schema";
import type { DbOrTx } from "./types";

/** Runtime switches shared by the web app and the separate worker process (both read the DB). */
export async function getSetting<T>(db: DbOrTx, key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return row ? (row.value as T) : fallback;
}

export async function setSetting(db: DbOrTx, key: string, value: unknown): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: sql`now()` } });
}
