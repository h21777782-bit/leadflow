/**
 * Read-side data access for the UI.
 * Pages never build SQL themselves — they call these functions. That keeps
 * the UI swappable and the queries testable in one place.
 */
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { OPEN_STAGES, PIPELINE_STAGES, type PipelineStage } from "@/lib/pipeline";

const owner = alias(s.users, "owner");

// ── Dashboard ────────────────────────────────────────────────────────────────
export async function getDashboardSummary(now = new Date()) {
  const db = getDb();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3_600_000);

  const [stageRows, [totals], sourceRows, jobRows, [appt], recent] = await Promise.all([
    db
      .select({ stage: s.opportunities.stage, count: sql<number>`count(*)::int`, value: sql<number>`coalesce(sum(${s.opportunities.valueAmount}),0)::int` })
      .from(s.opportunities)
      .groupBy(s.opportunities.stage),
    db
      .select({
        newLeads: sql<number>`count(*) filter (where ${s.contacts.createdAt} >= ${weekAgo.toISOString()}::timestamptz)::int`,
        totalLeads: sql<number>`count(*)::int`,
      })
      .from(s.contacts),
    db
      .select({
        source: s.opportunities.leadSource,
        leads: sql<number>`count(*)::int`,
        won: sql<number>`count(*) filter (where ${s.opportunities.status} = 'won')::int`,
        wonValue: sql<number>`coalesce(sum(${s.opportunities.valueAmount}) filter (where ${s.opportunities.status} = 'won'),0)::int`,
      })
      .from(s.opportunities)
      .groupBy(s.opportunities.leadSource)
      .orderBy(desc(sql`count(*)`)),
    db.select({ status: s.jobs.status, count: sql<number>`count(*)::int` }).from(s.jobs).groupBy(s.jobs.status),
    db
      .select({ upcoming: sql<number>`count(*)::int` })
      .from(s.appointments)
      .where(and(gte(s.appointments.startsAt, now), inArray(s.appointments.status, ["scheduled", "confirmed"]))),
    listActivity({ limit: 8 }),
  ]);

  const byStage = Object.fromEntries(PIPELINE_STAGES.map((st) => [st, { count: 0, value: 0 }])) as Record<PipelineStage, { count: number; value: number }>;
  for (const r of stageRows) byStage[r.stage] = { count: r.count, value: r.value };

  const won = byStage.won.count;
  const lost = byStage.lost.count;
  const qualifiedOrLater = OPEN_STAGES.slice(OPEN_STAGES.indexOf("qualified")).reduce((n, st) => n + byStage[st].count, 0);
  const openValue = OPEN_STAGES.reduce((n, st) => n + byStage[st].value, 0);
  const jobs = Object.fromEntries(jobRows.map((r) => [r.status, r.count])) as Partial<Record<(typeof s.jobStatusEnum.enumValues)[number], number>>;

  return {
    newLeads: totals.newLeads,
    totalLeads: totals.totalLeads,
    qualifiedOrLater,
    upcomingAppointments: appt.upcoming,
    won,
    lost,
    wonValue: byStage.won.value,
    openValue,
    conversionRate: won + lost === 0 ? null : won / (won + lost),
    byStage,
    sources: sourceRows,
    automation: {
      succeeded: jobs.succeeded ?? 0,
      pending: (jobs.pending ?? 0) + (jobs.running ?? 0),
      retrying: jobs.retrying ?? 0,
      dead: jobs.dead ?? 0,
    },
    recent,
  };
}

// ── Contacts ─────────────────────────────────────────────────────────────────
export async function listContacts() {
  const db = getDb();
  return db
    .select({
      id: s.contacts.id,
      firstName: s.contacts.firstName,
      lastName: s.contacts.lastName,
      email: s.contacts.email,
      company: s.contacts.company,
      country: s.contacts.country,
      leadSource: s.contacts.leadSource,
      serviceInterest: s.contacts.serviceInterest,
      budgetAmount: s.contacts.budgetAmount,
      budgetCurrency: s.contacts.budgetCurrency,
      ownerName: owner.name,
      tags: s.contacts.tags,
      // A contact can have several deals; show the most recent one's stage.
      stage: sql<PipelineStage | null>`(select o.stage from opportunities o where o.contact_id = ${s.contacts.id} order by o.created_at desc limit 1)`,
      opportunityCount: sql<number>`(select count(*)::int from opportunities o where o.contact_id = ${s.contacts.id})`,
      nextFollowUpAt: s.contacts.nextFollowUpAt,
      createdAt: s.contacts.createdAt,
    })
    .from(s.contacts)
    .leftJoin(owner, eq(owner.id, s.contacts.ownerId))
    .orderBy(desc(s.contacts.createdAt));
}

export async function getContactDetail(id: string) {
  const db = getDb();
  const [contact] = await db
    .select({ contact: s.contacts, ownerName: owner.name, ownerTimezone: owner.timezone })
    .from(s.contacts)
    .leftJoin(owner, eq(owner.id, s.contacts.ownerId))
    .where(eq(s.contacts.id, id));
  if (!contact) return null;

  const opps = await db.select().from(s.opportunities).where(eq(s.opportunities.contactId, id)).orderBy(desc(s.opportunities.createdAt));
  const oppIds = opps.map((o) => o.id);
  const [history, appts, timeline, msgs, runs] = await Promise.all([
    oppIds.length
      ? db.select().from(s.stageHistory).where(inArray(s.stageHistory.opportunityId, oppIds)).orderBy(asc(s.stageHistory.createdAt))
      : Promise.resolve([]),
    db.select().from(s.appointments).where(eq(s.appointments.contactId, id)).orderBy(desc(s.appointments.startsAt)),
    db.select().from(s.auditLogs).where(eq(s.auditLogs.contactId, id)).orderBy(desc(s.auditLogs.createdAt)).limit(50),
    db.select().from(s.messages).where(eq(s.messages.contactId, id)).orderBy(desc(s.messages.createdAt)),
    db.select().from(s.workflowRuns).where(eq(s.workflowRuns.contactId, id)).orderBy(desc(s.workflowRuns.startedAt)),
  ]);

  return { ...contact, opportunities: opps, history, appointments: appts, timeline, messages: msgs, workflowRuns: runs };
}

// ── Pipeline board ───────────────────────────────────────────────────────────
export async function getPipelineBoard() {
  const db = getDb();
  const rows = await db
    .select({
      id: s.opportunities.id,
      title: s.opportunities.title,
      stage: s.opportunities.stage,
      valueAmount: s.opportunities.valueAmount,
      currency: s.opportunities.currency,
      leadSource: s.opportunities.leadSource,
      lastActivityAt: s.opportunities.lastActivityAt,
      nextAction: s.opportunities.nextAction,
      lostReason: s.opportunities.lostReason,
      contactId: s.contacts.id,
      contactName: sql<string>`trim(${s.contacts.firstName} || ' ' || coalesce(${s.contacts.lastName}, ''))`,
      company: s.contacts.company,
      ownerName: owner.name,
    })
    .from(s.opportunities)
    .innerJoin(s.contacts, eq(s.contacts.id, s.opportunities.contactId))
    .leftJoin(owner, eq(owner.id, s.opportunities.ownerId))
    .orderBy(desc(s.opportunities.lastActivityAt));

  return PIPELINE_STAGES.map((stage) => {
    const items = rows.filter((r) => r.stage === stage);
    return { stage, items, total: items.reduce((n, r) => n + r.valueAmount, 0) };
  });
}

// ── Appointments ─────────────────────────────────────────────────────────────
/** Split into upcoming/past here (data layer), not in the component: render must stay pure. */
export async function listAppointments(now = new Date()) {
  const db = getDb();
  const rows = await db
    .select({
      id: s.appointments.id,
      title: s.appointments.title,
      startsAt: s.appointments.startsAt,
      endsAt: s.appointments.endsAt,
      timezone: s.appointments.timezone,
      status: s.appointments.status,
      contactId: s.contacts.id,
      contactName: sql<string>`trim(${s.contacts.firstName} || ' ' || coalesce(${s.contacts.lastName}, ''))`,
      ownerName: owner.name,
      ownerTimezone: owner.timezone,
    })
    .from(s.appointments)
    .innerJoin(s.contacts, eq(s.contacts.id, s.appointments.contactId))
    .leftJoin(owner, eq(owner.id, s.appointments.ownerId))
    .orderBy(desc(s.appointments.startsAt));
  return {
    upcoming: rows.filter((r) => r.startsAt >= now).reverse(), // soonest first
    past: rows.filter((r) => r.startsAt < now), // most recent first
  };
}

// ── Automations ──────────────────────────────────────────────────────────────
export async function listWorkflowRuns() {
  const db = getDb();
  return db
    .select({
      id: s.workflowRuns.id,
      workflowKey: s.workflowRuns.workflowKey,
      status: s.workflowRuns.status,
      currentStep: s.workflowRuns.currentStep,
      stopReason: s.workflowRuns.stopReason,
      startedAt: s.workflowRuns.startedAt,
      finishedAt: s.workflowRuns.finishedAt,
      contactId: s.contacts.id,
      contactName: sql<string>`trim(${s.contacts.firstName} || ' ' || coalesce(${s.contacts.lastName}, ''))`,
      messagesSent: sql<number>`(select count(*)::int from messages m where m.workflow_run_id = ${s.workflowRuns.id} and m.status = 'sent')`,
    })
    .from(s.workflowRuns)
    .innerJoin(s.contacts, eq(s.contacts.id, s.workflowRuns.contactId))
    .orderBy(desc(s.workflowRuns.startedAt));
}

export async function listFailedJobs() {
  const db = getDb();
  return db
    .select({
      id: s.jobs.id,
      type: s.jobs.type,
      status: s.jobs.status,
      attempts: s.jobs.attempts,
      maxAttempts: s.jobs.maxAttempts,
      lastError: s.jobs.lastError,
      runAt: s.jobs.runAt,
      updatedAt: s.jobs.updatedAt,
      createdAt: s.jobs.createdAt,
      contactId: s.contacts.id,
      contactName: sql<string>`trim(${s.contacts.firstName} || ' ' || coalesce(${s.contacts.lastName}, ''))`,
    })
    .from(s.jobs)
    .leftJoin(s.contacts, eq(s.contacts.id, s.jobs.contactId))
    .where(inArray(s.jobs.status, ["dead", "retrying"]))
    .orderBy(desc(s.jobs.updatedAt));
}

// ── Activity (audit log) ─────────────────────────────────────────────────────
export async function listActivity({ limit = 100 }: { limit?: number } = {}) {
  const db = getDb();
  return db
    .select({
      id: s.auditLogs.id,
      eventType: s.auditLogs.eventType,
      message: s.auditLogs.message,
      actorType: s.auditLogs.actorType,
      createdAt: s.auditLogs.createdAt,
      contactId: s.auditLogs.contactId,
      contactName: sql<string | null>`trim(${s.contacts.firstName} || ' ' || coalesce(${s.contacts.lastName}, ''))`,
    })
    .from(s.auditLogs)
    .leftJoin(s.contacts, eq(s.contacts.id, s.auditLogs.contactId))
    .orderBy(desc(s.auditLogs.createdAt))
    .limit(limit);
}

// ── Integrations & settings ──────────────────────────────────────────────────
export async function listIntegrationCalls(limit = 25) {
  const db = getDb();
  return db.select().from(s.integrationCalls).orderBy(desc(s.integrationCalls.createdAt)).limit(limit);
}

export async function listTeamAndRules() {
  const db = getDb();
  const [team, rules, openCounts] = await Promise.all([
    db.select().from(s.users).orderBy(asc(s.users.name)),
    db.select().from(s.routingRules).orderBy(asc(s.routingRules.priority)),
    db
      .select({ ownerId: s.opportunities.ownerId, open: sql<number>`count(*)::int` })
      .from(s.opportunities)
      .where(eq(s.opportunities.status, "open"))
      .groupBy(s.opportunities.ownerId),
  ]);
  const openByOwner = new Map(openCounts.map((r) => [r.ownerId, r.open]));
  return { team: team.map((u) => ({ ...u, openLeads: openByOwner.get(u.id) ?? 0 })), rules };
}

export async function checkDatabase(): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const started = Date.now();
  try {
    await getDb().execute(sql`select 1`);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "unknown database error" };
  }
}

export async function getContactForEdit(id: string) {
  const [c] = await getDb().select().from(s.contacts).where(eq(s.contacts.id, id));
  return c ?? null;
}

export async function listAssignableUsers() {
  return getDb()
    .select({ id: s.users.id, name: s.users.name, isAvailable: s.users.isAvailable })
    .from(s.users)
    .where(eq(s.users.role, "sales_rep"))
    .orderBy(asc(s.users.name));
}
