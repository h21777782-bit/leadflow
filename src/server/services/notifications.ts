/**
 * Sales notifications — SIMULATED, in-app only. No real email/SMS/Slack/push
 * is ever sent; every row is clearly labelled and only ever read back by our
 * own UI. Phase 6: a rep is notified when their assigned lead replies.
 */
import type { Database } from "@/db/client";
import { notifications } from "@/db/schema";
import { fullName } from "@/lib/normalize";
import { writeAudit } from "./audit";
import type { Actor } from "./types";

export async function notifyRepOfReply(
  db: Database,
  actor: Actor,
  contact: { id: string; firstName: string; lastName: string | null; ownerId: string | null },
  replyBody: string,
): Promise<{ notified: boolean }> {
  if (!contact.ownerId) return { notified: false };
  const name = fullName(contact.firstName, contact.lastName);
  const snippet = replyBody.length > 140 ? `${replyBody.slice(0, 140)}…` : replyBody;
  await db.insert(notifications).values({
    recipientUserId: contact.ownerId,
    contactId: contact.id,
    channel: "internal",
    subject: `${name} replied`,
    body: `[SIMULATED] ${name} replied: "${snippet}"`,
    status: "sent",
  });
  await writeAudit(db, actor, {
    eventType: "notification.sent",
    entityType: "contact",
    entityId: contact.id,
    contactId: contact.id,
    message: `[SIMULATED] Notified owner that ${name} replied`,
  });
  return { notified: true };
}
