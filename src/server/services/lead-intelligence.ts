/**
 * Lead intelligence = scoring + routing, wired to the database.
 *
 *   processLeadChange(contactId, trigger)
 *     1. recalculateScore()  — pure scoreLead() on fresh DB facts, persist if changed
 *     2. routeLead()         — policy check → locked assignment → decision + audit
 *
 * Runs synchronously after the triggering change has committed (there is no
 * background worker yet — that is Phase 4). A failure here never undoes the
 * contact/opportunity change that triggered it; it is recorded in the audit log.
 */
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  appointments,
  contacts,
  leadScores,
  messages,
  opportunities,
  routingDecisions,
  routingRules,
  users,
} from "@/db/schema";
import { fullName } from "@/lib/normalize";
import { stableStringify } from "@/lib/stable-json";
import {
  decideAssignment,
  decideRoutingNeed,
  EARLY_STAGES,
  type AssignmentDecision,
  type RepState,
  type RoutingRule,
} from "@/lib/routing";
import { DEFAULT_SCORING_CONFIG, scoreLead, type AppointmentSignal, type ScoreResult, type ScoringInput } from "@/lib/scoring";
import { writeAudit } from "./audit";
import type { Actor, DbOrTx } from "./types";

const APPOINTMENT_STAGES = ["appointment_booked", "proposal_sent", "negotiation", "won"];

// ── Scoring ──────────────────────────────────────────────────────────────────
export async function loadScoringInput(db: DbOrTx, contactId: string, now = new Date()): Promise<ScoringInput | null> {
  const [c] = await db.select().from(contacts).where(eq(contacts.id, contactId));
  if (!c) return null;
  const [counts] = await db
    .select({
      inbound: sql<number>`count(*) filter (where ${messages.direction} = 'inbound')::int`,
      outbound: sql<number>`count(*) filter (where ${messages.direction} = 'outbound' and ${messages.status} = 'sent')::int`,
    })
    .from(messages)
    .where(eq(messages.contactId, contactId));
  const appts = await db
    .select({ status: appointments.status, startsAt: appointments.startsAt })
    .from(appointments)
    .where(eq(appointments.contactId, contactId))
    .orderBy(desc(appointments.startsAt));
  const opps = await db.select({ stage: opportunities.stage }).from(opportunities).where(eq(opportunities.contactId, contactId));

  // Best signal wins: completed > upcoming > no-show > cancelled > none.
  let appointment: AppointmentSignal = "none";
  if (appts.some((a) => a.status === "completed")) appointment = "completed";
  else if (appts.some((a) => (a.status === "scheduled" || a.status === "confirmed") && a.startsAt >= now)) appointment = "upcoming";
  else if (opps.some((o) => APPOINTMENT_STAGES.includes(o.stage))) appointment = "upcoming"; // stage moved by hand, no calendar row
  else if (appts.some((a) => a.status === "no_show")) appointment = "no_show";
  else if (appts.some((a) => a.status === "cancelled")) appointment = "cancelled";

  return {
    budgetAmount: c.budgetAmount,
    serviceInterest: c.serviceInterest,
    hasCompany: Boolean(c.company),
    hasEmail: Boolean(c.emailNormalized),
    hasPhone: Boolean(c.phoneE164),
    hasLocation: Boolean(c.country || c.timezone),
    hasContext: Boolean(c.notes) || Object.keys(c.customFields ?? {}).length > 0,
    inboundReplies: counts?.inbound ?? 0,
    outboundAttempts: counts?.outbound ?? 0,
    appointment,
  };
}

export type ScoreOutcome = {
  result: ScoreResult;
  previous: { score: number | null; band: string | null };
  changed: boolean;
};

export async function recalculateScore(db: Database, actor: Actor, contactId: string, trigger: string): Promise<ScoreOutcome | null> {
  return db.transaction(async (tx) => {
    // Lock the contact so two recalculations for the same lead cannot interleave.
    const [c] = await tx.select().from(contacts).where(eq(contacts.id, contactId)).for("update");
    if (!c) return null;
    const input = await loadScoringInput(tx, contactId);
    if (!input) return null;
    const result = scoreLead(input, DEFAULT_SCORING_CONFIG);
    const previous = { score: c.leadScore, band: c.leadBand };

    const [last] = await tx
      .select({ breakdown: leadScores.breakdown })
      .from(leadScores)
      .where(eq(leadScores.contactId, contactId))
      .orderBy(desc(leadScores.computedAt))
      .limit(1);
    const breakdownChanged = stableStringify(last?.breakdown ?? null) !== stableStringify(result.factors);
    const changed = previous.score !== result.score || previous.band !== result.band;

    await tx
      .update(contacts)
      .set({ leadScore: result.score, leadBand: result.band, scoredAt: sql`now()` })
      .where(eq(contacts.id, contactId));

    // History row only when something actually changed — recalculating is idempotent.
    if (changed || breakdownChanged) {
      await tx.insert(leadScores).values({
        contactId,
        score: result.score,
        band: result.band,
        breakdown: result.factors,
        trigger,
        configVersion: result.configVersion,
      });
    }
    if (changed) {
      const band = (b: string | null) => (b ? b.charAt(0).toUpperCase() + b.slice(1) : "unscored");
      await writeAudit(tx, actor, {
        eventType: "lead.scored",
        entityType: "contact",
        entityId: contactId,
        contactId,
        message:
          previous.score === null
            ? `Lead scored ${result.score}/100 (${band(result.band)})`
            : `Lead score ${previous.score} → ${result.score} (${band(previous.band)} → ${band(result.band)}) after ${trigger}`,
        metadata: { trigger, score: result.score, band: result.band, factors: result.factors },
      });
    }
    return { result, previous, changed };
  });
}

// ── Workload ─────────────────────────────────────────────────────────────────
/** Active leads per rep = contacts they own that still have at least one open opportunity. */
export async function loadWorkload(db: DbOrTx): Promise<Map<string, number>> {
  const rows = await db
    .select({ ownerId: contacts.ownerId, n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(
      and(
        sql`${contacts.ownerId} is not null`,
        sql`exists (select 1 from opportunities o where o.contact_id = ${contacts.id} and o.status = 'open')`,
      ),
    )
    .groupBy(contacts.ownerId);
  return new Map(rows.map((r) => [r.ownerId as string, r.n]));
}

// ── Routing ──────────────────────────────────────────────────────────────────
export type RoutingOutcome =
  | { status: "skipped"; reason: string }
  | { status: "unchanged"; reason: string }
  | { status: "assigned" | "reassigned"; userId: string; userName: string; reason: string; decisionId: string }
  | { status: "unassigned"; reason: string; decisionId: string };

export async function routeLead(
  db: Database,
  actor: Actor,
  contactId: string,
  opts: { trigger: string; force?: boolean },
): Promise<RoutingOutcome> {
  return db.transaction(async (tx) => {
    // Lock order is always: contact row, then rep rows by id → no deadlocks between routers.
    const [c] = await tx.select().from(contacts).where(eq(contacts.id, contactId)).for("update");
    if (!c) return { status: "skipped" as const, reason: "Contact not found" };

    const openOpps = await tx
      .select({ id: opportunities.id, stage: opportunities.stage })
      .from(opportunities)
      .where(and(eq(opportunities.contactId, contactId), eq(opportunities.status, "open")))
      .orderBy(desc(opportunities.createdAt));

    // Lock ALL rep rows (small table) so capacity checks and last_assigned_at updates are serialized.
    const repRows = await tx.select().from(users).where(eq(users.role, "sales_rep")).orderBy(asc(users.id)).for("update");
    const owner = c.ownerId ? repRows.find((r) => r.id === c.ownerId) ?? null : null;

    const need = decideRoutingNeed({
      hasOpenOpportunity: openOpps.length > 0,
      latestOpenStage: openOpps[0]?.stage ?? null,
      ownerId: c.ownerId,
      owner: owner ? { name: owner.name, isActive: owner.isActive, isAvailable: owner.isAvailable } : null,
      assignmentSource: (c.assignmentSource as "routing" | "manual" | "seed" | null) ?? null,
      force: Boolean(opts.force),
    });
    if (!need.route) return { status: "skipped" as const, reason: need.reason };

    const workload = await loadWorkload(tx);
    const reps: RepState[] = repRows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      isActive: r.isActive,
      isAvailable: r.isAvailable,
      services: r.services,
      regions: r.regions,
      maxOpenLeads: r.maxOpenLeads,
      // Don't count this lead against its current (being-replaced) owner.
      activeLeads: (workload.get(r.id) ?? 0) - (r.id === c.ownerId ? 1 : 0),
      lastAssignedAt: r.lastAssignedAt,
    }));
    const rules: RoutingRule[] = (await tx.select().from(routingRules).orderBy(asc(routingRules.priority))).map((r) => ({
      id: r.id,
      name: r.name,
      priority: r.priority,
      isActive: r.isActive,
      conditions: r.conditions,
      strategy: r.strategy,
      targetUserIds: r.targetUserIds,
    }));

    const decision: AssignmentDecision = decideAssignment(
      { serviceInterest: c.serviceInterest, country: c.country, leadSource: c.leadSource, budgetAmount: c.budgetAmount },
      rules,
      reps,
    );
    const name = fullName(c.firstName, c.lastName);

    if (decision.status === "unassigned") {
      // Idempotent: repeating the same failed routing does not spam history.
      if (!c.ownerId && c.unassignedReason === decision.reason) {
        return { status: "unchanged" as const, reason: decision.reason };
      }
      await tx
        .update(contacts)
        .set({ ownerId: null, assignmentSource: "routing", assignedAt: null, unassignedReason: decision.reason })
        .where(eq(contacts.id, contactId));
      await tx.update(opportunities).set({ ownerId: null }).where(and(eq(opportunities.contactId, contactId), eq(opportunities.status, "open")));
      const [d] = await tx
        .insert(routingDecisions)
        .values({ contactId, outcome: "unassigned", previousUserId: c.ownerId, trigger: opts.trigger, reason: `${need.reason}. ${decision.reason}`, trace: decision.trace })
        .returning({ id: routingDecisions.id });
      await writeAudit(tx, actor, {
        eventType: "lead.unassigned",
        entityType: "contact",
        entityId: contactId,
        contactId,
        message: `${name} left unassigned: ${decision.reason}`,
        metadata: { trigger: opts.trigger, previousOwnerId: c.ownerId, decisionId: d.id },
      });
      return { status: "unassigned" as const, reason: decision.reason, decisionId: d.id };
    }

    const outcome = c.ownerId ? "reassigned" : "assigned";
    await tx
      .update(contacts)
      .set({ ownerId: decision.userId, assignmentSource: "routing", assignedAt: sql`now()`, unassignedReason: null })
      .where(eq(contacts.id, contactId));
    await tx
      .update(opportunities)
      .set({ ownerId: decision.userId })
      .where(and(eq(opportunities.contactId, contactId), eq(opportunities.status, "open")));
    await tx.update(users).set({ lastAssignedAt: sql`now()` }).where(eq(users.id, decision.userId));
    const [d] = await tx
      .insert(routingDecisions)
      .values({
        contactId,
        outcome,
        assignedUserId: decision.userId,
        previousUserId: c.ownerId,
        ruleId: decision.ruleId,
        ruleName: decision.ruleName,
        trigger: opts.trigger,
        reason: `${need.reason}. ${decision.reason}`,
        trace: decision.trace,
      })
      .returning({ id: routingDecisions.id });
    await writeAudit(tx, actor, {
      eventType: outcome === "assigned" ? "owner.assigned" : "owner.reassigned",
      entityType: "contact",
      entityId: contactId,
      contactId,
      message:
        outcome === "assigned"
          ? `${name} assigned to ${decision.userName}. ${decision.reason}`
          : `${name} reassigned from ${owner?.name ?? "previous owner"} to ${decision.userName} (${need.reason}). ${decision.reason}`,
      metadata: { trigger: opts.trigger, ruleId: decision.ruleId, decisionId: d.id, previousOwnerId: c.ownerId },
    });
    return { status: outcome, userId: decision.userId, userName: decision.userName, reason: decision.reason, decisionId: d.id };
  });
}

// ── Orchestration ────────────────────────────────────────────────────────────
export type LeadChangeOutcome = { score: ScoreOutcome | null; routing: RoutingOutcome | null; errors: string[] };

export async function processLeadChange(
  db: Database,
  actor: Actor,
  contactId: string,
  trigger: string,
  opts: { force?: boolean; skipRouting?: boolean } = {},
): Promise<LeadChangeOutcome> {
  const out: LeadChangeOutcome = { score: null, routing: null, errors: [] };
  try {
    out.score = await recalculateScore(db, actor, contactId, trigger);
  } catch (err) {
    out.errors.push(`scoring: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!opts.skipRouting) {
    try {
      out.routing = await routeLead(db, actor, contactId, { trigger, force: opts.force });
    } catch (err) {
      out.errors.push(`routing: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (out.errors.length) {
    // Best effort: record the failure without hiding the original change.
    try {
      await writeAudit(db, actor, {
        eventType: "lead_intelligence.failed",
        entityType: "contact",
        entityId: contactId,
        contactId,
        message: `Scoring/routing failed after ${trigger}: ${out.errors.join("; ")}`,
        metadata: { trigger },
      });
    } catch {
      /* database itself is failing — the caller still gets `errors` */
    }
  }
  return out;
}

// ── Inbound reply (manual log until webhooks arrive in Phase 6) ─────────────
export async function logInboundReply(
  db: Database,
  actor: Actor,
  contactId: string,
  raw: { channel?: string; body?: string },
): Promise<{ status: "logged"; outcome: LeadChangeOutcome } | { status: "invalid"; error: string } | { status: "not_found" }> {
  const channel = raw.channel === "sms" ? "sms" : "email";
  const body = (raw.body ?? "").trim();
  if (body.length < 2) return { status: "invalid", error: "Write what the lead said (at least 2 characters)" };
  if (body.length > 2000) return { status: "invalid", error: "Reply is too long (2000 characters max)" };

  const found = await db.transaction(async (tx) => {
    const [c] = await tx.select().from(contacts).where(eq(contacts.id, contactId)).for("update");
    if (!c) return false;
    await tx.insert(messages).values({
      contactId,
      channel,
      direction: "inbound",
      templateKey: "inbound.reply",
      toAddress: "sales-inbox",
      body,
      status: "sent",
      idempotencyKey: `reply:${contactId}:${crypto.randomUUID()}`,
      attemptedAt: sql`now()`,
    });
    await tx.update(contacts).set({ lastContactedAt: sql`now()` }).where(eq(contacts.id, contactId));
    await writeAudit(tx, actor, {
      eventType: "message.received",
      entityType: "contact",
      entityId: contactId,
      contactId,
      message: `Reply logged (${channel}): “${body.slice(0, 80)}${body.length > 80 ? "…" : ""}”`,
      metadata: { channel, loggedManually: true },
    });
    return true;
  });
  if (!found) return { status: "not_found" };
  return { status: "logged", outcome: await processLeadChange(db, actor, contactId, "reply.logged") };
}

// ── Rep availability / capacity changes ─────────────────────────────────────
export type RepUpdate = { isAvailable?: boolean; isActive?: boolean; maxOpenLeads?: number };

export async function updateRepStatus(
  db: Database,
  actor: Actor,
  userId: string,
  patch: RepUpdate,
): Promise<{ status: "not_found" } | { status: "invalid"; error: string } | { status: "updated"; rerouted: { contactId: string; outcome: RoutingOutcome | null }[] }> {
  if (patch.maxOpenLeads !== undefined && (!Number.isInteger(patch.maxOpenLeads) || patch.maxOpenLeads < 0 || patch.maxOpenLeads > 500)) {
    return { status: "invalid", error: "Capacity must be a whole number between 0 and 500" };
  }
  const before = await db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!u || u.role !== "sales_rep") return null;
    await tx.update(users).set(patch).where(eq(users.id, userId));
    const changes = Object.entries(patch)
      .filter(([k, v]) => u[k as keyof typeof u] !== v)
      .map(([k, v]) => `${k}: ${String(u[k as keyof typeof u])} → ${String(v)}`);
    if (changes.length) {
      await writeAudit(tx, actor, {
        eventType: "rep.updated",
        entityType: "user",
        entityId: userId,
        message: `${u.name} updated — ${changes.join(", ")}`,
        metadata: { before: { isAvailable: u.isAvailable, isActive: u.isActive, maxOpenLeads: u.maxOpenLeads }, after: patch },
      });
    }
    return u;
  });
  if (!before) return { status: "not_found" };

  const nowUnavailable = patch.isAvailable === false || patch.isActive === false;
  const gainedCapacity = patch.isAvailable === true || patch.isActive === true || (patch.maxOpenLeads ?? 0) > before.maxOpenLeads;

  // Who needs routing now? Both queries only pick leads the policy may touch.
  const affected = new Set<string>();
  if (nowUnavailable) {
    const rows = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.ownerId, userId),
          sql`coalesce(${contacts.assignmentSource}, '') <> 'manual'`,
          sql`exists (select 1 from opportunities o where o.contact_id = ${contacts.id} and o.status = 'open' and o.stage in (${sql.join(EARLY_STAGES.map((s) => sql`${s}`), sql`, `)}))`,
        ),
      );
    rows.forEach((r) => affected.add(r.id));
  }
  if (gainedCapacity) (await unassignedRoutableIds(db)).forEach((id) => affected.add(id));

  const rerouted: { contactId: string; outcome: RoutingOutcome | null }[] = [];
  for (const id of affected) {
    const r = await processLeadChange(db, actor, id, nowUnavailable ? "rep.unavailable" : "rep.capacity_available", { force: false });
    rerouted.push({ contactId: id, outcome: r.routing });
  }
  return { status: "updated", rerouted };
}

export async function unassignedRoutableIds(db: DbOrTx): Promise<string[]> {
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        isNull(contacts.ownerId),
        sql`coalesce(${contacts.assignmentSource}, '') <> 'manual'`,
        sql`exists (select 1 from opportunities o where o.contact_id = ${contacts.id} and o.status = 'open')`,
      ),
    )
    .orderBy(asc(contacts.createdAt));
  return rows.map((r) => r.id);
}

/** After routing rules change, try again for every unassigned lead. */
export async function rerouteUnassigned(db: Database, actor: Actor, trigger: string) {
  const ids = await unassignedRoutableIds(db);
  const results = [];
  for (const id of ids) results.push({ contactId: id, outcome: (await processLeadChange(db, actor, id, trigger)).routing });
  return results;
}

export async function rescoreAll(db: Database, actor: Actor, trigger: string, ids?: string[]) {
  const list = ids ?? (await db.select({ id: contacts.id }).from(contacts)).map((r) => r.id);
  let changed = 0;
  for (const id of list) if ((await recalculateScore(db, actor, id, trigger))?.changed) changed++;
  return { total: list.length, changed };
}

