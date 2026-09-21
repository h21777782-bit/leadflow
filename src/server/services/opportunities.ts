/**
 * Opportunity write-side service.
 *
 * changeStage() is the ONLY code path that moves a deal between stages
 * (Kanban drag, lead page, and later automations/webhooks all call it), so
 * stage history and audit logging cannot be skipped by any caller.
 */
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db/client";
import { contacts, opportunities, stageHistory } from "@/db/schema";
import { PIPELINE_STAGES, STAGE_META, type PipelineStage } from "@/lib/pipeline";
import { decideStageChange } from "@/lib/stage-rules";
import type { FieldErrors } from "@/lib/validation/contact";
import { writeAudit } from "./audit";
import { processLeadChange } from "./lead-intelligence";
import { insertOpportunity } from "./contacts";
import { enqueueOpportunityStageSync, enqueueOpportunitySync } from "@/server/workflows/crm-sync";
import type { Actor } from "./types";

/** Never blocks or undoes the write it's called after if enqueueing fails. */
async function safeEnqueueOpportunitySync(db: Database, actor: Actor, opportunityId: string, contactId: string): Promise<void> {
  try {
    await enqueueOpportunitySync(db, opportunityId, contactId);
  } catch (err) {
    await writeAudit(db, actor, { eventType: "crm.sync_enqueue_failed", entityType: "opportunity", entityId: opportunityId, contactId, message: `Could not enqueue HighLevel sync: ${err instanceof Error ? err.message : String(err)}` });
  }
}

async function safeEnqueueStageSync(db: Database, actor: Actor, opportunityId: string, contactId: string): Promise<void> {
  try {
    await enqueueOpportunityStageSync(db, opportunityId, contactId);
  } catch (err) {
    await writeAudit(db, actor, { eventType: "crm.sync_enqueue_failed", entityType: "opportunity", entityId: opportunityId, contactId, message: `Could not enqueue HighLevel sync: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ── Create ───────────────────────────────────────────────────────────────────
const createOppSchema = z.object({
  title: z.string().trim().min(2, "Give the opportunity a title").max(160),
  valueAmount: z.coerce.number().int("Value must be a whole number").min(0, "Value cannot be negative").max(100_000_000),
});

export type CreateOpportunityResult =
  | { status: "invalid"; errors: FieldErrors }
  | { status: "not_found" }
  | { status: "created"; opportunityId: string };

export async function createOpportunity(
  db: Database,
  actor: Actor,
  contactId: string,
  raw: unknown,
): Promise<CreateOpportunityResult> {
  const parsed = createOppSchema.safeParse(raw);
  if (!parsed.success) {
    const errors: FieldErrors = {};
    for (const i of parsed.error.issues) errors[String(i.path[0] ?? "form")] ??= i.message;
    return { status: "invalid", errors };
  }
  const r = await db.transaction(async (tx) => {
    const [c] = await tx.select().from(contacts).where(eq(contacts.id, contactId));
    if (!c) return { status: "not_found" as const };
    const id = await insertOpportunity(tx, actor, {
      contactId,
      title: parsed.data.title,
      valueAmount: parsed.data.valueAmount,
      ownerId: c.ownerId,
      leadSource: c.leadSource,
    });
    return { status: "created" as const, opportunityId: id };
  });
  if (r.status === "created") {
    await processLeadChange(db, actor, contactId, "opportunity.created");
    await safeEnqueueOpportunitySync(db, actor, r.opportunityId, contactId);
  }
  return r;
}

// ── Stage change ─────────────────────────────────────────────────────────────
export type ChangeStageInput = {
  opportunityId: string;
  toStage: string;
  /** The stage the caller *saw*. If the deal has moved since, we refuse instead of overwriting. */
  expectedFromStage?: string;
  reason?: string | null;
};

export type ChangeStageResult =
  | { status: "changed"; from: PipelineStage; to: PipelineStage }
  | { status: "invalid"; error: string }
  | { status: "not_found" }
  | { status: "conflict"; currentStage: PipelineStage; error: string };

const isStage = (v: string): v is PipelineStage => (PIPELINE_STAGES as readonly string[]).includes(v);

export async function changeStage(db: Database, actor: Actor, input: ChangeStageInput): Promise<ChangeStageResult> {
  const r = await changeStageTx(db, actor, input);
  if (r.status === "changed") {
    // Stage affects the appointment factor and whether the lead still needs an owner.
    const [o] = await db.select({ contactId: opportunities.contactId }).from(opportunities).where(eq(opportunities.id, input.opportunityId));
    if (o) {
      await processLeadChange(db, actor, o.contactId, "stage.changed");
      await safeEnqueueStageSync(db, actor, input.opportunityId, o.contactId);
    }
  }
  return r;
}

async function changeStageTx(db: Database, actor: Actor, input: ChangeStageInput): Promise<ChangeStageResult> {
  if (!isStage(input.toStage)) return { status: "invalid", error: `Unknown stage “${input.toStage}”` };
  const to = input.toStage;
  const reason = input.reason?.trim() || null;

  return db.transaction(async (tx) => {
    // Row lock: two people dragging the same card at once are serialized here.
    const [opp] = await tx.select().from(opportunities).where(eq(opportunities.id, input.opportunityId)).for("update");
    if (!opp) return { status: "not_found" as const };

    if (input.expectedFromStage && input.expectedFromStage !== opp.stage) {
      return {
        status: "conflict" as const,
        currentStage: opp.stage,
        error: `This deal was already moved to ${STAGE_META[opp.stage].label} by someone else. Refresh and try again.`,
      };
    }

    const decision = decideStageChange({ from: opp.stage, to, reason });
    if (!decision.ok) return { status: "invalid" as const, error: decision.error };

    await tx
      .update(opportunities)
      .set({
        stage: to,
        status: decision.status,
        lastActivityAt: sql`now()`,
        updatedAt: sql`now()`,
        wonAt: to === "won" ? sql`now()` : null,
        lostAt: to === "lost" ? sql`now()` : null,
        lostReason: to === "lost" ? reason : null,
        nextAction: STAGE_META[to].terminal ? null : opp.nextAction,
      })
      .where(eq(opportunities.id, opp.id));

    await tx.insert(stageHistory).values({
      opportunityId: opp.id,
      fromStage: opp.stage,
      toStage: to,
      actorType: actor.type,
      actorUserId: actor.type === "user" ? actor.userId ?? null : null,
      reason,
    });

    const label = `${STAGE_META[opp.stage].label} → ${STAGE_META[to].label}`;
    await writeAudit(tx, actor, {
      eventType: "stage.changed",
      entityType: "opportunity",
      entityId: opp.id,
      contactId: opp.contactId,
      message: `Stage changed: ${label}${reason ? ` (${reason})` : ""}`,
      metadata: { from: opp.stage, to, reason },
    });
    if (to === "won" || to === "lost") {
      await writeAudit(tx, actor, {
        eventType: `opportunity.${to}`,
        entityType: "opportunity",
        entityId: opp.id,
        contactId: opp.contactId,
        message: to === "won" ? `Deal won: ${opp.title} (${opp.valueAmount} ${opp.currency})` : `Deal lost: ${opp.title} — ${reason}`,
        metadata: { valueAmount: opp.valueAmount },
      });
    }
    if (decision.isReopen) {
      await writeAudit(tx, actor, {
        eventType: "manual.override",
        entityType: "opportunity",
        entityId: opp.id,
        contactId: opp.contactId,
        message: `Closed deal reopened: ${label} — ${reason}`,
        metadata: { from: opp.stage, to },
      });
    }
    return { status: "changed" as const, from: opp.stage, to };
  });
}
