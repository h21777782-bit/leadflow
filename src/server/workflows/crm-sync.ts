/**
 * CRM SYNC — outbox jobs that keep HighLevel in sync with our local data.
 *
 * Every contact/opportunity write enqueues a job (idempotency key collapses
 * bursts within the same second, e.g. create + score + route in one request).
 * Each handler reloads the CURRENT database state right before acting — same
 * principle as the nurture workflow — so a retried job always sends the
 * latest truth, never a stale snapshot from when it was first enqueued.
 *
 * `ghl_contact_id` / `ghl_opportunity_id` are stored once and reused on every
 * later sync, so HighLevel's `POST /contacts/upsert` and `PUT /opportunities/:id`
 * are called instead of `POST /opportunities/` again — never a second record
 * for the same lead or deal, however many times a job is retried or replayed.
 */
import { desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { contacts, opportunities, pipelineStages } from "@/db/schema";
import { getEnv, type Env } from "@/lib/env";
import { PermanentJobError, TransientJobError } from "@/lib/job-errors";
import { getCrmProvider } from "@/server/integrations/crm";
import type { OpportunityStatus } from "@/server/integrations/crm/types";
import { enqueueJob, type Job } from "@/server/queue/queue";
import { writeAudit } from "@/server/services/audit";
import type { Actor, DbOrTx } from "@/server/services/types";
import type { HandlerResult } from "@/server/workflows/nurture";

export const CRM_SYNC_CONTACT = "crm.sync_contact";
export const CRM_SYNC_OPPORTUNITY = "crm.sync_opportunity";
/** Job type name matches the pre-existing seed data (SEED_FAILURES in db/seed-data.ts) exactly. */
export const CRM_UPDATE_OPPORTUNITY = "crm.update_opportunity";

function stamp(): string {
  return new Date().toISOString().slice(0, 19); // second-resolution — collapses same-request bursts
}

/** The mock provider ignores locationId/pipelineId entirely — only require real values outside MOCK_MODE. */
function requireLocationId(env: Env): string {
  if (env.HIGHLEVEL_LOCATION_ID) return env.HIGHLEVEL_LOCATION_ID;
  if (env.MOCK_MODE) return "mock-location";
  throw new PermanentJobError("HIGHLEVEL_LOCATION_ID is not configured");
}

function requirePipelineId(env: Env): string {
  if (env.HIGHLEVEL_PIPELINE_ID) return env.HIGHLEVEL_PIPELINE_ID;
  if (env.MOCK_MODE) return "mock-pipeline";
  throw new PermanentJobError("HIGHLEVEL_PIPELINE_ID is not configured");
}

// ── Enqueue helpers (call after the triggering transaction commits) ─────────
export async function enqueueContactSync(tx: DbOrTx, contactId: string): Promise<void> {
  await enqueueJob(tx, {
    type: CRM_SYNC_CONTACT,
    idempotencyKey: `crm:sync_contact:${contactId}:${stamp()}`,
    runAt: new Date(),
    payload: { contactId },
    contactId,
  });
}

export async function enqueueOpportunitySync(tx: DbOrTx, opportunityId: string, contactId: string): Promise<void> {
  await enqueueJob(tx, {
    type: CRM_SYNC_OPPORTUNITY,
    idempotencyKey: `crm:sync_opportunity:${opportunityId}:${stamp()}`,
    runAt: new Date(),
    payload: { opportunityId },
    contactId,
    opportunityId,
  });
}

export async function enqueueOpportunityStageSync(tx: DbOrTx, opportunityId: string, contactId: string): Promise<void> {
  await enqueueJob(tx, {
    type: CRM_UPDATE_OPPORTUNITY,
    idempotencyKey: `crm:update_opportunity:${opportunityId}:${stamp()}`,
    runAt: new Date(),
    payload: { opportunityId },
    contactId,
    opportunityId,
  });
}

// ── Handlers ─────────────────────────────────────────────────────────────────
async function resolveOpportunityId(db: Database, payload: Record<string, unknown>): Promise<string> {
  if (typeof payload.opportunityId === "string") return payload.opportunityId;
  if (typeof payload.contactId === "string") {
    // Legacy/seeded payload shape: only a contactId. Resolve to that contact's latest opportunity.
    const [opp] = await db.select({ id: opportunities.id }).from(opportunities).where(eq(opportunities.contactId, payload.contactId)).orderBy(desc(opportunities.createdAt)).limit(1);
    if (!opp) throw new PermanentJobError(`Contact ${payload.contactId} has no opportunity to sync to HighLevel`);
    return opp.id;
  }
  throw new PermanentJobError("Job payload is missing opportunityId or contactId");
}

export async function handleSyncContact(db: Database, job: Job, workerId: string): Promise<HandlerResult> {
  const env = getEnv();
  const locationId = requireLocationId(env);
  const { contactId } = job.payload as { contactId?: string };
  if (!contactId) throw new PermanentJobError("Job payload is missing contactId");

  const [c] = await db.select().from(contacts).where(eq(contacts.id, contactId));
  if (!c) throw new PermanentJobError(`Contact ${contactId} no longer exists`);
  if (!c.email && !c.phone) return { outcome: "skipped", reason: "Contact has no email or phone to sync" };

  const provider = getCrmProvider(db, (operation) => ({ operation, jobId: job.id, attempt: job.attempts }));
  const res = await provider.upsertContact({
    locationId,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    phone: c.phoneE164 ?? c.phone,
    companyName: c.company,
    tags: c.tags,
  });
  await db.update(contacts).set({ ghlContactId: res.ghlContactId }).where(eq(contacts.id, contactId));
  const actor: Actor = { type: "worker", label: workerId };
  await writeAudit(db, actor, {
    eventType: "crm.contact_synced",
    entityType: "contact",
    entityId: contactId,
    contactId,
    message: `Synced to HighLevel (${res.created ? "created" : "updated"} contact ${res.ghlContactId})`,
    metadata: { ghlContactId: res.ghlContactId, created: res.created },
  });
  return { outcome: "completed", note: `HighLevel contact ${res.ghlContactId}` };
}

/** Shared by both `crm.sync_opportunity` (new deals) and `crm.update_opportunity` (stage/status changes) — both just mean "make HighLevel match the database now". */
async function syncOpportunity(db: Database, job: Job, workerId: string, opportunityId: string): Promise<HandlerResult> {
  const env = getEnv();
  const locationId = requireLocationId(env);
  const pipelineId = requirePipelineId(env);

  const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, opportunityId));
  if (!opp) throw new PermanentJobError(`Opportunity ${opportunityId} no longer exists`);
  const [c] = await db.select().from(contacts).where(eq(contacts.id, opp.contactId));
  if (!c) throw new PermanentJobError(`Contact for opportunity ${opportunityId} no longer exists`);
  if (!c.ghlContactId) {
    // The contact sync job hasn't completed yet — retry until it has (simple ordering by backoff,
    // not a job dependency graph; see IMPLEMENTATION_LOG.md, Phase 5, for why this is good enough here).
    throw new TransientJobError(`Contact ${c.id} has not been synced to HighLevel yet — retrying until it is`);
  }

  const [stageRow] = await db.select().from(pipelineStages).where(eq(pipelineStages.key, opp.stage));
  const status: OpportunityStatus = opp.status;

  const provider = getCrmProvider(db, (operation) => ({ operation, jobId: job.id, attempt: job.attempts }));
  const res = await provider.upsertOpportunity({
    locationId,
    pipelineId,
    pipelineStageId: stageRow?.ghlStageId ?? null,
    contactId: c.ghlContactId,
    name: opp.title,
    status,
    monetaryValue: opp.valueAmount,
    existingGhlOpportunityId: opp.ghlOpportunityId,
  });
  if (!opp.ghlOpportunityId) await db.update(opportunities).set({ ghlOpportunityId: res.ghlOpportunityId }).where(eq(opportunities.id, opportunityId));

  const actor: Actor = { type: "worker", label: workerId };
  await writeAudit(db, actor, {
    eventType: "crm.opportunity_synced",
    entityType: "opportunity",
    entityId: opportunityId,
    contactId: opp.contactId,
    message: `Synced to HighLevel (opportunity ${res.ghlOpportunityId}, stage “${opp.stage}”${stageRow?.ghlStageId ? "" : " — no HighLevel stage mapped yet"}, status ${status})`,
    metadata: { ghlOpportunityId: res.ghlOpportunityId, stage: opp.stage, ghlStageId: stageRow?.ghlStageId ?? null, status },
  });
  return { outcome: "completed", note: `HighLevel opportunity ${res.ghlOpportunityId}` };
}

export async function handleSyncOpportunity(db: Database, job: Job, workerId: string): Promise<HandlerResult> {
  return syncOpportunity(db, job, workerId, await resolveOpportunityId(db, job.payload as Record<string, unknown>));
}

export async function handleUpdateOpportunity(db: Database, job: Job, workerId: string): Promise<HandlerResult> {
  return syncOpportunity(db, job, workerId, await resolveOpportunityId(db, job.payload as Record<string, unknown>));
}
