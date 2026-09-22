/**
 * Read-side data access for the UI.
 * Pages never build SQL themselves — they call these functions. That keeps
 * the UI swappable and the queries testable in one place.
 */
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { getEnv } from "@/lib/env";
import { OPEN_STAGES, PIPELINE_STAGES, type PipelineStage } from "@/lib/pipeline";
import { loadWorkload } from "@/server/services/lead-intelligence";

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
  const [bandRows, unassigned, workload, decisions] = await Promise.all([
    // Temperature counts only for leads still being worked (open opportunity).
    db
      .select({ band: s.contacts.leadBand, n: sql<number>`count(*)::int` })
      .from(s.contacts)
      .where(sql`exists (select 1 from opportunities o where o.contact_id = ${s.contacts.id} and o.status = 'open')`)
      .groupBy(s.contacts.leadBand),
    listUnassignedLeads(),
    listRepWorkload(),
    listRoutingDecisions({ limit: 8 }),
  ]);
  const bands = { hot: 0, warm: 0, cold: 0, unscored: 0 };
  for (const r of bandRows) bands[r.band ?? "unscored"] += r.n;

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
      completed: (jobs.completed ?? 0) + (jobs.skipped ?? 0),
      pending: (jobs.pending ?? 0) + (jobs.processing ?? 0),
      retrying: jobs.retry_scheduled ?? 0,
      failed: jobs.failed ?? 0,
    },
    recent,
    bands,
    unassigned,
    workload,
    decisions,
  };
}

// ── Scoring & routing views ──────────────────────────────────────────────────
const contactName = sql<string>`trim(${s.contacts.firstName} || ' ' || coalesce(${s.contacts.lastName}, ''))`;

export async function listUnassignedLeads() {
  return getDb()
    .select({
      id: s.contacts.id,
      name: contactName,
      company: s.contacts.company,
      country: s.contacts.country,
      serviceInterest: s.contacts.serviceInterest,
      leadScore: s.contacts.leadScore,
      leadBand: s.contacts.leadBand,
      reason: s.contacts.unassignedReason,
      assignmentSource: s.contacts.assignmentSource,
    })
    .from(s.contacts)
    .where(and(sql`${s.contacts.ownerId} is null`, sql`exists (select 1 from opportunities o where o.contact_id = ${s.contacts.id} and o.status = 'open')`))
    .orderBy(desc(s.contacts.leadScore));
}

export async function listRepWorkload() {
  const db = getDb();
  const [reps, wl] = await Promise.all([
    db.select().from(s.users).where(eq(s.users.role, "sales_rep")).orderBy(asc(s.users.name)),
    loadWorkload(db),
  ]);
  return reps.map((u) => ({ ...u, activeLeads: wl.get(u.id) ?? 0 }));
}

export async function listRoutingDecisions({ limit = 50, contactId }: { limit?: number; contactId?: string } = {}) {
  const assigned = alias(s.users, "assigned");
  const previous = alias(s.users, "previous");
  return getDb()
    .select({
      id: s.routingDecisions.id,
      outcome: s.routingDecisions.outcome,
      ruleName: s.routingDecisions.ruleName,
      trigger: s.routingDecisions.trigger,
      reason: s.routingDecisions.reason,
      trace: s.routingDecisions.trace,
      createdAt: s.routingDecisions.createdAt,
      contactId: s.routingDecisions.contactId,
      contactName,
      assignedName: assigned.name,
      previousName: previous.name,
    })
    .from(s.routingDecisions)
    .innerJoin(s.contacts, eq(s.contacts.id, s.routingDecisions.contactId))
    .leftJoin(assigned, eq(assigned.id, s.routingDecisions.assignedUserId))
    .leftJoin(previous, eq(previous.id, s.routingDecisions.previousUserId))
    .where(contactId ? eq(s.routingDecisions.contactId, contactId) : undefined)
    .orderBy(desc(s.routingDecisions.createdAt))
    .limit(limit);
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
      leadScore: s.contacts.leadScore,
      leadBand: s.contacts.leadBand,
      unassignedReason: s.contacts.unassignedReason,
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
  const [scoreHistory, routing, contactJobs] = await Promise.all([
    db.select().from(s.leadScores).where(eq(s.leadScores.contactId, id)).orderBy(desc(s.leadScores.computedAt)).limit(10),
    listRoutingDecisions({ contactId: id, limit: 20 }),
    listJobs({ contactId: id, limit: 30 }),
  ]);
  const [history, appts, timeline, msgs, runs] = await Promise.all([
    oppIds.length
      ? db.select().from(s.stageHistory).where(inArray(s.stageHistory.opportunityId, oppIds)).orderBy(asc(s.stageHistory.createdAt))
      : Promise.resolve([]),
    db.select().from(s.appointments).where(eq(s.appointments.contactId, id)).orderBy(desc(s.appointments.startsAt)),
    db.select().from(s.auditLogs).where(eq(s.auditLogs.contactId, id)).orderBy(desc(s.auditLogs.createdAt)).limit(50),
    db.select().from(s.messages).where(eq(s.messages.contactId, id)).orderBy(desc(s.messages.createdAt)),
    db.select().from(s.workflowRuns).where(eq(s.workflowRuns.contactId, id)).orderBy(desc(s.workflowRuns.startedAt)),
  ]);

  return { ...contact, opportunities: opps, history, appointments: appts, timeline, messages: msgs, workflowRuns: runs, scoreHistory, routing, jobs: contactJobs };
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
      leadScore: s.contacts.leadScore,
      leadBand: s.contacts.leadBand,
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
      messagesSent: sql<number>`(select count(*)::int from messages m where m.workflow_run_id = ${s.workflowRuns.id} and m.status = 'sent' and m.direction = 'outbound')`,
      nextJobAt: sql<Date | null>`(select min(j.run_at) from jobs j where j.workflow_run_id = ${s.workflowRuns.id} and j.status in ('pending','retry_scheduled'))`,
    })
    .from(s.workflowRuns)
    .innerJoin(s.contacts, eq(s.contacts.id, s.workflowRuns.contactId))
    .orderBy(desc(s.workflowRuns.startedAt));
}

export type JobStatus = (typeof s.jobStatusEnum.enumValues)[number];

export async function listJobs({ statuses, limit = 100, contactId }: { statuses?: JobStatus[]; limit?: number; contactId?: string } = {}) {
  const rows = await getDb()
    .select({
      id: s.jobs.id,
      type: s.jobs.type,
      status: s.jobs.status,
      attempts: s.jobs.attempts,
      maxAttempts: s.jobs.maxAttempts,
      lastError: s.jobs.lastError,
      errorKind: s.jobs.errorKind,
      statusReason: s.jobs.statusReason,
      runAt: s.jobs.runAt,
      lockedBy: s.jobs.lockedBy,
      leaseExpiresAt: s.jobs.leaseExpiresAt,
      updatedAt: s.jobs.updatedAt,
      createdAt: s.jobs.createdAt,
      completedAt: s.jobs.completedAt,
      payload: s.jobs.payload,
      workflowRunId: s.jobs.workflowRunId,
      contactId: s.contacts.id,
      contactName: sql<string | null>`trim(${s.contacts.firstName} || ' ' || coalesce(${s.contacts.lastName}, ''))`,
    })
    .from(s.jobs)
    .leftJoin(s.contacts, eq(s.contacts.id, s.jobs.contactId))
    .where(and(statuses ? inArray(s.jobs.status, statuses) : undefined, contactId ? eq(s.jobs.contactId, contactId) : undefined))
    .orderBy(desc(s.jobs.updatedAt))
    .limit(limit);
  const attempts = rows.length
    ? await getDb().select().from(s.jobAttempts).where(inArray(s.jobAttempts.jobId, rows.map((r) => r.id))).orderBy(asc(s.jobAttempts.attempt))
    : [];
  return rows.map((r) => ({ ...r, attemptHistory: attempts.filter((a) => a.jobId === r.id) }));
}

export async function listFailedJobs() {
  return listJobs({ statuses: ["failed", "retry_scheduled"] });
}

export async function getAutomationOverview(now = new Date()) {
  const db = getDb();
  const [jobCounts, runCounts, workerRows, failureMode, steps, messagesOut] = await Promise.all([
    db.select({ status: s.jobs.status, n: sql<number>`count(*)::int` }).from(s.jobs).groupBy(s.jobs.status),
    db.select({ status: s.workflowRuns.status, n: sql<number>`count(*)::int` }).from(s.workflowRuns).groupBy(s.workflowRuns.status),
    db.select().from(s.workerHeartbeats).orderBy(desc(s.workerHeartbeats.lastSeenAt)).limit(5),
    db.select().from(s.appSettings).where(eq(s.appSettings.key, "demo.mock_messaging_failure_mode")),
    db.select().from(s.workflowSteps).orderBy(asc(s.workflowSteps.workflowKey), asc(s.workflowSteps.position)),
    db
      .select({
        id: s.messages.id,
        contactId: s.messages.contactId,
        contactName: sql<string>`trim(${s.contacts.firstName} || ' ' || coalesce(${s.contacts.lastName}, ''))`,
        subject: s.messages.subject,
        body: s.messages.body,
        toAddress: s.messages.toAddress,
        status: s.messages.status,
        provider: s.messages.provider,
        providerMessageId: s.messages.providerMessageId,
        error: s.messages.error,
        idempotencyKey: s.messages.idempotencyKey,
        createdAt: s.messages.createdAt,
        attemptedAt: s.messages.attemptedAt,
      })
      .from(s.messages)
      .innerJoin(s.contacts, eq(s.contacts.id, s.messages.contactId))
      .where(and(eq(s.messages.direction, "outbound"), sql`${s.messages.templateKey} like 'nurture.followup%'`, sql`${s.messages.idempotencyKey} not like 'seed:%'`))
      .orderBy(desc(sql`coalesce(${s.messages.attemptedAt}, ${s.messages.createdAt})`))
      .limit(20),
  ]);
  const onlineThresholdMs = Math.max(10_000, getEnv().WORKER_POLL_MS * 3);
  const workers = workerRows.map((w) => ({ ...w, online: w.status === "running" && now.getTime() - w.lastSeenAt.getTime() < onlineThresholdMs }));

  return {
    jobs: Object.fromEntries(jobCounts.map((r) => [r.status, r.n])) as Partial<Record<JobStatus, number>>,
    runs: Object.fromEntries(runCounts.map((r) => [r.status, r.n])) as Record<string, number>,
    workers,
    failureMode: (failureMode[0]?.value as string | undefined) ?? "off",
    steps,
    messages: messagesOut,
  };
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

// ── Webhook events (Phase 6) ─────────────────────────────────────────────────
export async function listWebhookEvents(limit = 100) {
  const db = getDb();
  const rows = await db.select().from(s.webhookEvents).orderBy(desc(s.webhookEvents.receivedAt)).limit(limit);
  const jobIds = rows.map((r) => r.jobId).filter((id): id is string => Boolean(id));
  const jobs = jobIds.length ? await db.select().from(s.jobs).where(inArray(s.jobs.id, jobIds)) : [];
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  return rows.map((r) => ({ ...r, job: r.jobId ? (jobById.get(r.jobId) ?? null) : null }));
}

export async function getCrmOverview() {
  const db = getDb();
  const [stages, failureMode, contactCounts, opportunityCounts, jobCounts, calls] = await Promise.all([
    db.select().from(s.pipelineStages).orderBy(asc(s.pipelineStages.position)),
    db.select().from(s.appSettings).where(eq(s.appSettings.key, "demo.mock_crm_failure_mode")),
    db.select({ synced: sql<number>`count(*) filter (where ${s.contacts.ghlContactId} is not null)::int`, total: sql<number>`count(*)::int` }).from(s.contacts),
    db.select({ synced: sql<number>`count(*) filter (where ${s.opportunities.ghlOpportunityId} is not null)::int`, total: sql<number>`count(*)::int` }).from(s.opportunities),
    db
      .select({ status: s.jobs.status, n: sql<number>`count(*)::int` })
      .from(s.jobs)
      .where(sql`${s.jobs.type} like 'crm.%'`)
      .groupBy(s.jobs.status),
    listIntegrationCalls(25),
  ]);
  return {
    stages,
    failureMode: (failureMode[0]?.value as string | undefined) ?? "off",
    contacts: contactCounts[0],
    opportunities: opportunityCounts[0],
    jobs: Object.fromEntries(jobCounts.map((r) => [r.status, r.n])) as Partial<Record<JobStatus, number>>,
    calls,
  };
}

export async function listTeamAndRules() {
  const db = getDb();
  const [team, rules, wl] = await Promise.all([
    db.select().from(s.users).orderBy(asc(s.users.name)),
    db.select().from(s.routingRules).orderBy(asc(s.routingRules.priority)),
    loadWorkload(db),
  ]);
  return { team: team.map((u) => ({ ...u, openLeads: wl.get(u.id) ?? 0 })), rules };
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
