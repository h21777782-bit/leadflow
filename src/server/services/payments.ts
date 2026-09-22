/**
 * Payment received (webhook) → mark the deal Won, create the onboarding
 * checklist, audit. Idempotent on `externalPaymentId` (UNIQUE in the schema):
 * the same payment delivered twice never double-marks a deal won or creates
 * a second onboarding checklist.
 */
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { onboardingTasks, opportunities, payments } from "@/db/schema";
import { changeStage } from "./opportunities";
import { writeAudit } from "./audit";
import type { Actor } from "./types";

const ONBOARDING_CHECKLIST = ["Send welcome email & contract", "Collect brand assets and logins", "Kick-off call", "Set up project workspace"];

export type ProcessPaymentInput = {
  opportunityId: string;
  amount: number;
  currency?: string;
  externalPaymentId: string;
};

export type ProcessPaymentResult =
  | { status: "invalid"; error: string }
  | { status: "not_found" }
  | { status: "duplicate"; paymentId: string }
  | { status: "processed"; paymentId: string; opportunityId: string };

export async function processPaymentReceived(db: Database, actor: Actor, input: ProcessPaymentInput): Promise<ProcessPaymentResult> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) return { status: "invalid", error: "amount must be a positive number" };
  if (!input.externalPaymentId.trim()) return { status: "invalid", error: "externalPaymentId is required" };

  const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, input.opportunityId));
  if (!opp) return { status: "not_found" };

  const [claimed] = await db
    .insert(payments)
    .values({ contactId: opp.contactId, opportunityId: opp.id, amount: input.amount, currency: input.currency ?? opp.currency, externalPaymentId: input.externalPaymentId })
    .onConflictDoNothing({ target: payments.externalPaymentId })
    .returning({ id: payments.id });
  if (!claimed) {
    const [existing] = await db.select({ id: payments.id }).from(payments).where(eq(payments.externalPaymentId, input.externalPaymentId));
    return { status: "duplicate", paymentId: existing.id };
  }

  await writeAudit(db, actor, {
    eventType: "payment.received",
    entityType: "payment",
    entityId: claimed.id,
    contactId: opp.contactId,
    message: `Payment received: ${input.amount} ${input.currency ?? opp.currency} for "${opp.title}"`,
    metadata: { amount: input.amount, externalPaymentId: input.externalPaymentId },
  });

  if (opp.status !== "won") {
    const r = await changeStage(db, actor, { opportunityId: opp.id, toStage: "won" });
    if (r.status !== "changed" && r.status !== "invalid") {
      // "invalid" here just means it's already won (from === to); anything else is unexpected — surface it.
      throw new Error(`Could not mark opportunity ${opp.id} won after payment: ${JSON.stringify(r)}`);
    }
  }

  const existingTasks = await db.select({ id: onboardingTasks.id }).from(onboardingTasks).where(eq(onboardingTasks.opportunityId, opp.id));
  if (existingTasks.length === 0) {
    await db.insert(onboardingTasks).values(
      ONBOARDING_CHECKLIST.map((title, position) => ({ contactId: opp.contactId, opportunityId: opp.id, title, position, status: "todo" as const })),
    );
  }

  return { status: "processed", paymentId: claimed.id, opportunityId: opp.id };
}
