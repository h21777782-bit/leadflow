import type { DbOrTx } from "./types";
import { auditLogs } from "@/db/schema";
import type { Actor } from "./types";

export type AuditEntry = {
  eventType: string;
  entityType: string;
  entityId?: string | null;
  contactId?: string | null;
  message: string;
  metadata?: Record<string, unknown>;
};

/**
 * Append one audit record. Always called with the SAME transaction as the
 * change it describes, so the log can never claim something that was rolled back.
 */
export async function writeAudit(db: DbOrTx, actor: Actor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    eventType: entry.eventType,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    contactId: entry.contactId ?? null,
    actorType: actor.type,
    actorId: actor.userId ?? actor.label,
    message: entry.message,
    metadata: { ...entry.metadata, actorLabel: actor.label },
  });
}
