import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { Database } from "@/db/client";
import type * as schema from "@/db/schema";

export type Tx = PgTransaction<PostgresJsQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
export type DbOrTx = Database | Tx;

/** Who performed an action. Written to audit_logs and stage_history. */
export type Actor = {
  type: "system" | "user" | "webhook" | "integration" | "worker";
  userId?: string | null;
  label: string;
};

export const SYSTEM_ACTOR: Actor = { type: "system", label: "system" };
