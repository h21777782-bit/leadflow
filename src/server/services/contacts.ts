/**
 * Contact write-side service.
 *
 *   input → validate → normalize → duplicate check → create / merge / update
 *         → audit (same transaction)
 *
 * Duplicate safety has two layers:
 *   1. findDuplicates() — lets us give a helpful answer ("this is Priya, created 2 days ago").
 *   2. UNIQUE indexes on email_normalized / phone_e164 — catch the race where two
 *      requests pass step 1 at the same moment. We translate that DB error back
 *      into a normal "duplicate" result instead of a 500.
 */
import { and, eq, ne, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import { uniqueViolation } from "@/db/errors";
import { contacts, opportunities, stageHistory, users } from "@/db/schema";
import { fullName } from "@/lib/normalize";
import { SERVICE_LABEL, type Service } from "@/lib/pipeline";
import { validateContact, type FieldErrors, type ValidContact } from "@/lib/validation/contact";
import { writeAudit } from "./audit";
import type { Actor, DbOrTx } from "./types";

type ContactRow = typeof contacts.$inferSelect;

export type DuplicateMatch = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  matchedOn: ("email" | "phone")[];
};

export type CreateContactResult =
  | { status: "invalid"; errors: FieldErrors }
  | { status: "duplicate"; matches: DuplicateMatch[]; raceDetected?: boolean }
  | { status: "created"; contactId: string; opportunityId: string | null };

export type UpdateContactResult =
  | { status: "invalid"; errors: FieldErrors }
  | { status: "not_found" }
  | { status: "duplicate"; matches: DuplicateMatch[] }
  | { status: "unchanged"; contactId: string }
  | { status: "updated"; contactId: string; changedFields: string[] };

export type MergeContactResult =
  | { status: "invalid"; errors: FieldErrors }
  | { status: "not_found" }
  | { status: "duplicate"; matches: DuplicateMatch[] }
  | { status: "unchanged"; contactId: string }
  | { status: "merged"; contactId: string; changedFields: string[] };

// ── Duplicate detection ──────────────────────────────────────────────────────
export async function findDuplicates(
  db: DbOrTx,
  keys: { emailNormalized: string | null; phoneE164: string | null; excludeId?: string },
): Promise<DuplicateMatch[]> {
  const conds: SQL[] = [];
  if (keys.emailNormalized) conds.push(eq(contacts.emailNormalized, keys.emailNormalized));
  if (keys.phoneE164) conds.push(eq(contacts.phoneE164, keys.phoneE164));
  if (conds.length === 0) return [];

  const where = keys.excludeId ? and(or(...conds), ne(contacts.id, keys.excludeId)) : or(...conds);
  const rows = await db.select().from(contacts).where(where);
  return rows.map((r) => ({
    id: r.id,
    name: fullName(r.firstName, r.lastName),
    email: r.email,
    phone: r.phone,
    company: r.company,
    matchedOn: [
      ...(keys.emailNormalized && r.emailNormalized === keys.emailNormalized ? (["email"] as const) : []),
      ...(keys.phoneE164 && r.phoneE164 === keys.phoneE164 ? (["phone"] as const) : []),
    ],
  }));
}

async function assertOwnerExists(db: DbOrTx, ownerId: string | undefined): Promise<FieldErrors | null> {
  if (!ownerId) return null;
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, ownerId));
  return u ? null : { ownerId: "Selected owner no longer exists" };
}

function toColumns(c: ValidContact) {
  return {
    firstName: c.firstName,
    lastName: c.lastName ?? null,
    email: c.email ?? null,
    emailNormalized: c.emailNormalized,
    phone: c.phone ?? null,
    phoneE164: c.phoneE164,
    company: c.company ?? null,
    leadSource: c.leadSource,
    serviceInterest: c.serviceInterest ?? null,
    budgetAmount: c.budgetAmount ?? null,
    country: c.country ?? null,
    timezone: c.timezone ?? null,
    ownerId: c.ownerId ?? null,
    tags: c.tags,
    customFields: c.customFields as Record<string, unknown>,
    notes: c.notes ?? null,
  };
}

// ── Create ───────────────────────────────────────────────────────────────────
export type CreateOptions = {
  /** Create a New-lead opportunity together with the contact (default true). */
  createOpportunity?: boolean;
  opportunityValue?: number;
};

export async function createContact(
  db: Database,
  actor: Actor,
  rawInput: unknown,
  opts: CreateOptions = {},
): Promise<CreateContactResult> {
  const v = validateContact(rawInput);
  if (!v.ok) return { status: "invalid", errors: v.errors };
  const c = v.data;

  const ownerErr = await assertOwnerExists(db, c.ownerId);
  if (ownerErr) return { status: "invalid", errors: ownerErr };

  const matches = await findDuplicates(db, c);
  if (matches.length) return { status: "duplicate", matches };

  try {
    return await db.transaction(async (tx) => {
      const name = fullName(c.firstName, c.lastName);
      const [contact] = await tx.insert(contacts).values(toColumns(c)).returning({ id: contacts.id });
      await writeAudit(tx, actor, {
        eventType: "contact.created",
        entityType: "contact",
        entityId: contact.id,
        contactId: contact.id,
        message: `Contact created for ${name} (source: ${c.leadSource})`,
        metadata: { duplicateCheck: "no match", emailNormalized: c.emailNormalized, phoneE164: c.phoneE164 },
      });

      let opportunityId: string | null = null;
      if (opts.createOpportunity !== false) {
        opportunityId = await insertOpportunity(tx, actor, {
          contactId: contact.id,
          title: `${c.company ?? name} — ${c.serviceInterest ? SERVICE_LABEL[c.serviceInterest as Service] : "New enquiry"}`,
          valueAmount: opts.opportunityValue ?? c.budgetAmount ?? 0,
          ownerId: c.ownerId ?? null,
          leadSource: c.leadSource,
        });
      }
      return { status: "created" as const, contactId: contact.id, opportunityId };
    });
  } catch (err) {
    const constraint = uniqueViolation(err);
    if (constraint === "contacts_email_normalized_uq" || constraint === "contacts_phone_e164_uq") {
      // Another request created the same person between our check and our insert.
      const raced = await findDuplicates(db, c);
      return { status: "duplicate", matches: raced, raceDetected: true };
    }
    throw err;
  }
}

// ── Opportunity insert (shared with opportunities service) ──────────────────
export async function insertOpportunity(
  tx: DbOrTx,
  actor: Actor,
  o: { contactId: string; title: string; valueAmount: number; ownerId: string | null; leadSource: string },
): Promise<string> {
  const [opp] = await tx
    .insert(opportunities)
    .values({ ...o, stage: "new_lead", status: "open" })
    .returning({ id: opportunities.id });
  await tx.insert(stageHistory).values({
    opportunityId: opp.id,
    fromStage: null,
    toStage: "new_lead",
    actorType: actor.type,
    actorUserId: actor.type === "user" ? actor.userId ?? null : null,
    reason: "Opportunity created",
  });
  await writeAudit(tx, actor, {
    eventType: "opportunity.created",
    entityType: "opportunity",
    entityId: opp.id,
    contactId: o.contactId,
    message: `Opportunity “${o.title}” created in New lead (${o.valueAmount} USD)`,
    metadata: { valueAmount: o.valueAmount },
  });
  return opp.id;
}

// ── Diff helpers ─────────────────────────────────────────────────────────────
type Patch = Partial<ReturnType<typeof toColumns>>;

const COMPARABLE: (keyof Patch)[] = [
  "firstName", "lastName", "email", "phone", "company", "leadSource", "serviceInterest",
  "budgetAmount", "country", "timezone", "ownerId", "tags", "customFields", "notes",
];

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function diffFields(existing: ContactRow, patch: Patch): string[] {
  return COMPARABLE.filter((k) => k in patch && !sameValue(existing[k as keyof ContactRow], patch[k]));
}

/**
 * Merge rules used when a duplicate is detected and the user (or, later, a
 * webhook) chooses "update the existing contact":
 *  - non-empty incoming values overwrite, empty incoming values never erase data
 *  - tags are unioned, custom fields merged (incoming wins per key)
 *  - notes are appended, not replaced
 *  - owner is only filled if the contact had none (routing decisions are not overwritten)
 */
export function buildMergePatch(existing: ContactRow, incoming: ValidContact): Patch {
  const inc = toColumns(incoming);
  const patch: Patch = {};
  const scalar = ["firstName", "lastName", "email", "phone", "company", "leadSource", "serviceInterest", "budgetAmount", "country", "timezone"] as const;
  for (const k of scalar) {
    const val = inc[k];
    if (val !== null && val !== undefined && val !== "") (patch as Record<string, unknown>)[k] = val;
  }
  if (patch.email) patch.emailNormalized = inc.emailNormalized;
  if (patch.phone) patch.phoneE164 = inc.phoneE164;
  if (!existing.ownerId && inc.ownerId) patch.ownerId = inc.ownerId;
  patch.tags = [...new Set([...existing.tags, ...inc.tags])];
  patch.customFields = { ...existing.customFields, ...inc.customFields };
  if (inc.notes && !(existing.notes ?? "").includes(inc.notes)) {
    patch.notes = existing.notes ? `${existing.notes}\n\n${inc.notes}` : inc.notes;
  }
  return patch;
}

async function lockContact(tx: DbOrTx, id: string): Promise<ContactRow | undefined> {
  const [row] = await tx.select().from(contacts).where(eq(contacts.id, id)).for("update");
  return row;
}

async function ownerName(tx: DbOrTx, id: string | null | undefined): Promise<string> {
  if (!id) return "Unassigned";
  const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, id));
  return u?.name ?? "Unknown user";
}

async function applyPatch(
  db: Database,
  actor: Actor,
  id: string,
  build: (existing: ContactRow) => Patch,
  eventType: "contact.updated" | "contact.merged",
): Promise<{ status: "not_found" } | { status: "unchanged" } | { status: "changed"; changedFields: string[] }> {
  return db.transaction(async (tx) => {
    const existing = await lockContact(tx, id); // row lock: concurrent edits queue up
    if (!existing) return { status: "not_found" as const };
    const patch = build(existing);
    const changed = diffFields(existing, patch);
    if (changed.length === 0) return { status: "unchanged" as const };

    await tx.update(contacts).set({ ...patch, updatedAt: sql`now()` }).where(eq(contacts.id, id));
    const name = fullName(patch.firstName ?? existing.firstName, patch.lastName ?? existing.lastName);
    await writeAudit(tx, actor, {
      eventType,
      entityType: "contact",
      entityId: id,
      contactId: id,
      message:
        eventType === "contact.merged"
          ? `Duplicate submission merged into ${name}: ${changed.join(", ")}`
          : `Contact ${name} updated: ${changed.join(", ")}`,
      metadata: { changedFields: changed },
    });
    if (changed.includes("ownerId")) {
      await writeAudit(tx, actor, {
        eventType: "owner.changed",
        entityType: "contact",
        entityId: id,
        contactId: id,
        message: `Owner manually changed from ${await ownerName(tx, existing.ownerId)} to ${await ownerName(tx, patch.ownerId)}`,
        metadata: { from: existing.ownerId, to: patch.ownerId, manualOverride: true },
      });
    }
    return { status: "changed" as const, changedFields: changed };
  });
}

// ── Update (edit form) ───────────────────────────────────────────────────────
export async function updateContact(db: Database, actor: Actor, id: string, rawInput: unknown): Promise<UpdateContactResult> {
  const v = validateContact(rawInput);
  if (!v.ok) return { status: "invalid", errors: v.errors };
  const ownerErr = await assertOwnerExists(db, v.data.ownerId);
  if (ownerErr) return { status: "invalid", errors: ownerErr };

  const matches = await findDuplicates(db, { ...v.data, excludeId: id });
  if (matches.length) return { status: "duplicate", matches };

  try {
    const r = await applyPatch(db, actor, id, () => toColumns(v.data), "contact.updated");
    if (r.status === "not_found") return r;
    if (r.status === "unchanged") return { status: "unchanged", contactId: id };
    return { status: "updated", contactId: id, changedFields: r.changedFields };
  } catch (err) {
    if (uniqueViolation(err)?.startsWith("contacts_")) {
      return { status: "duplicate", matches: await findDuplicates(db, { ...v.data, excludeId: id }) };
    }
    throw err;
  }
}

// ── Merge (duplicate → "update existing instead") ────────────────────────────
export async function mergeIntoContact(db: Database, actor: Actor, id: string, rawInput: unknown): Promise<MergeContactResult> {
  const v = validateContact(rawInput);
  if (!v.ok) return { status: "invalid", errors: v.errors };

  // The incoming email/phone may belong to a THIRD contact — never silently merge across people.
  const others = await findDuplicates(db, { ...v.data, excludeId: id });
  if (others.length) return { status: "duplicate", matches: others };

  try {
    const r = await applyPatch(db, actor, id, (existing) => buildMergePatch(existing, v.data), "contact.merged");
    if (r.status === "not_found") return r;
    if (r.status === "unchanged") return { status: "unchanged", contactId: id };
    return { status: "merged", contactId: id, changedFields: r.changedFields };
  } catch (err) {
    if (uniqueViolation(err)?.startsWith("contacts_")) {
      return { status: "duplicate", matches: await findDuplicates(db, { ...v.data, excludeId: id }) };
    }
    throw err;
  }
}
