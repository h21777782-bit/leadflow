/**
 * Loads the DEMO dataset. Wipes all app tables first, then inserts everything
 * inside ONE transaction — either the full dataset lands or nothing does.
 */
import { sql } from "drizzle-orm";
import type { Database } from "./client";
import * as s from "./schema";
import { SEED_FAILURES, SEED_LEADS, SEED_ROUTING_RULES, SEED_USERS } from "./seed-data";
import { PIPELINE_STAGES, SERVICE_LABEL, STAGE_META, stagePath } from "@/lib/pipeline";
import { fullName, normalizeEmail, normalizePhone } from "@/lib/normalize";
import { zonedDateParts, zonedTimeToUtc } from "@/lib/timezone";
import { processLeadChange } from "@/server/services/lead-intelligence";
import { SYSTEM_ACTOR } from "@/server/services/types";
import { ensureDefaultSteps } from "@/server/workflows/nurture";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SEED_META = { seed: true } as const;

const TABLES = [
  "audit_logs", "routing_decisions", "job_attempts", "worker_heartbeats", "app_settings", "workflow_steps", "integration_calls", "messages", "jobs", "workflow_runs", "lead_scores",
  "onboarding_tasks", "payments", "appointments", "stage_history", "opportunities",
  "contacts", "routing_rules", "pipeline_stages", "users", "webhook_events",
];

export type SeedSummary = Record<string, number>;

export async function seedDatabase(db: Database, now = new Date()): Promise<SeedSummary> {
  const summary = await insertDemoData(db, now);
  await ensureDefaultSteps(db); // follow-up sequence config (Phase 4)

  // Phase 3: score every lead and route the unowned ones with the REAL engine
  // (same code path as the app). Runs after the data transaction has committed.
  const ids = (await db.select({ id: s.contacts.id }).from(s.contacts)).map((r) => r.id);
  let routed = 0;
  for (const id of ids) {
    const r = await processLeadChange(db, SYSTEM_ACTOR, id, "seed");
    if (r.errors.length) throw new Error(`Seed scoring/routing failed: ${r.errors.join("; ")}`);
    if (r.routing && (r.routing.status === "assigned" || r.routing.status === "unassigned")) routed++;
  }
  return { ...summary, scored: ids.length, routed_by_engine: routed };
}

async function insertDemoData(db: Database, now: Date): Promise<SeedSummary> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`));

    // 1. Pipeline stage config
    await tx.insert(s.pipelineStages).values(
      PIPELINE_STAGES.map((key, position) => ({
        key,
        label: STAGE_META[key].label,
        position,
        probability: STAGE_META[key].probability,
        isTerminal: STAGE_META[key].terminal,
      })),
    );

    // 2. Users
    const userRows = await tx
      .insert(s.users)
      .values(SEED_USERS.map((u) => ({ name: u.name, email: u.email, role: u.role, timezone: u.timezone, services: u.services, regions: u.regions, isActive: u.isActive, isAvailable: u.isAvailable, maxOpenLeads: u.maxOpenLeads })))
      .returning({ id: s.users.id, email: s.users.email });
    const userId = (key: string) => {
      const email = SEED_USERS.find((u) => u.key === key)?.email;
      const row = userRows.find((r) => r.email === email);
      if (!row) throw new Error(`Seed user not found: ${key}`);
      return row.id;
    };

    // 3. Routing rules (configurable in Settings; engine arrives in Phase 3)
    await tx.insert(s.routingRules).values(
      SEED_ROUTING_RULES.map((r) => ({
        name: r.name,
        priority: r.priority,
        conditions: r.conditions,
        strategy: r.strategy,
        targetUserIds: r.targets.map(userId),
      })),
    );

    const audit: (typeof s.auditLogs.$inferInsert)[] = [];
    const counts: SeedSummary = {
      contacts: 0, opportunities: 0, stage_history: 0, appointments: 0,
      workflow_runs: 0, messages: 0, jobs: 0, integration_calls: 0, payments: 0, onboarding_tasks: 0,
    };

    for (const [i, lead] of SEED_LEADS.entries()) {
      const createdAt = new Date(now.getTime() - lead.createdDaysAgo * DAY - (i % 5) * HOUR - 30 * 60_000);
      // Brand-new leads have no owner yet — the routing engine assigns them after insert.
      const ownerId = lead.owner ? userId(lead.owner) : null;
      const name = fullName(lead.firstName, lead.lastName);

      // Contact
      const [contact] = await tx
        .insert(s.contacts)
        .values({
          firstName: lead.firstName,
          lastName: lead.lastName,
          email: lead.email,
          emailNormalized: normalizeEmail(lead.email),
          phone: lead.phone,
          phoneE164: normalizePhone(lead.phone, lead.country),
          company: lead.company,
          leadSource: lead.source,
          serviceInterest: lead.service,
          budgetAmount: lead.budget,
          country: lead.country,
          timezone: lead.timezone,
          ownerId,
          assignmentSource: ownerId ? "seed" : null,
          assignedAt: ownerId ? createdAt : null,
          tags: [...lead.tags, "demo-data"], // visible label: fictional seed record
          customFields: lead.customFields ?? {},
          notes: lead.notes,
          createdAt,
          updatedAt: createdAt,
        })
        .returning({ id: s.contacts.id });
      counts.contacts++;
      audit.push({ eventType: "contact.created", entityType: "contact", entityId: contact.id, contactId: contact.id, actorType: "webhook", actorId: lead.source, message: `Contact created for ${name} from ${lead.source}`, metadata: SEED_META, createdAt });
      if (lead.owner) {
        audit.push({ eventType: "owner.assigned", entityType: "contact", entityId: contact.id, contactId: contact.id, actorType: "system", message: `[demo seed] Pre-assigned to ${SEED_USERS.find((u) => u.key === lead.owner)?.name}`, metadata: SEED_META, createdAt: new Date(createdAt.getTime() + 1000) });
      }

      // Opportunity + stage history
      const path = stagePath(lead.stage, lead.lostAfter);
      const lastChange = new Date(Math.max(createdAt.getTime() + 60_000, now.getTime() - 2 * HOUR));
      const step = path.length > 1 ? (lastChange.getTime() - createdAt.getTime()) / (path.length - 1) : 0;
      const stageTimes = path.map((_, idx) => new Date(createdAt.getTime() + idx * step));
      const finalAt = stageTimes[stageTimes.length - 1];

      const [opp] = await tx
        .insert(s.opportunities)
        .values({
          contactId: contact.id,
          title: `${lead.company} — ${SERVICE_LABEL[lead.service]}`,
          stage: lead.stage,
          status: lead.stage === "won" ? "won" : lead.stage === "lost" ? "lost" : "open",
          valueAmount: lead.value,
          ownerId,
          leadSource: lead.source,
          lastActivityAt: finalAt,
          nextAction: nextActionFor(lead.stage),
          nextActionAt: STAGE_META[lead.stage].terminal ? null : new Date(now.getTime() + ((i % 3) + 1) * DAY),
          lostReason: lead.lostReason,
          wonAt: lead.stage === "won" ? finalAt : null,
          lostAt: lead.stage === "lost" ? finalAt : null,
          createdAt,
          updatedAt: finalAt,
        })
        .returning({ id: s.opportunities.id });
      counts.opportunities++;
      audit.push({ eventType: "opportunity.created", entityType: "opportunity", entityId: opp.id, contactId: contact.id, actorType: "system", message: `Opportunity created in New lead (${lead.value} USD)`, metadata: SEED_META, createdAt: new Date(createdAt.getTime() + 2000) });

      const history = path.map((stage, idx) => ({
        opportunityId: opp.id,
        fromStage: idx === 0 ? null : path[idx - 1],
        toStage: stage,
        actorType: idx === 0 ? ("system" as const) : ("user" as const),
        actorUserId: idx === 0 ? null : ownerId,
        reason: stage === "lost" ? lead.lostReason : null,
        createdAt: stageTimes[idx],
      }));
      await tx.insert(s.stageHistory).values(history);
      counts.stage_history += history.length;
      for (const h of history.slice(1)) {
        audit.push({ eventType: "stage.changed", entityType: "opportunity", entityId: opp.id, contactId: contact.id, actorType: "user", actorId: ownerId, message: `Stage changed: ${STAGE_META[h.fromStage!].label} → ${STAGE_META[h.toStage].label}`, metadata: { ...SEED_META, from: h.fromStage, to: h.toStage }, createdAt: h.createdAt });
      }

      // Contact timestamps
      const contacted = path.includes("contacted");
      await tx
        .update(s.contacts)
        .set({
          lastContactedAt: contacted ? finalAt : null,
          nextFollowUpAt: STAGE_META[lead.stage].terminal ? null : new Date(now.getTime() + ((i % 3) + 1) * DAY),
        })
        .where(sql`${s.contacts.id} = ${contact.id}`);

      // Appointments: upcoming for "appointment_booked", completed for later stages
      if (path.includes("appointment_booked")) {
        const upcoming = lead.stage === "appointment_booked";
        const base = upcoming ? new Date(now.getTime() + (i % 3 + 1) * DAY) : stageTimes[path.indexOf("appointment_booked")];
        const d = zonedDateParts(base, lead.timezone);
        const startsAt = zonedTimeToUtc({ ...d, hour: 11, minute: 0 }, lead.timezone);
        const [appt] = await tx
          .insert(s.appointments)
          .values({
            contactId: contact.id,
            opportunityId: opp.id,
            ownerId,
            title: `Discovery call — ${lead.company}`,
            startsAt,
            endsAt: new Date(startsAt.getTime() + 30 * 60_000),
            timezone: lead.timezone,
            status: upcoming ? "confirmed" : "completed",
            createdAt: stageTimes[path.indexOf("appointment_booked")],
          })
          .returning({ id: s.appointments.id });
        counts.appointments++;
        audit.push({ eventType: "appointment.booked", entityType: "appointment", entityId: appt.id, contactId: contact.id, actorType: "webhook", actorId: "calendar", message: `Discovery call booked for 11:00 ${lead.timezone}`, metadata: SEED_META, createdAt: stageTimes[path.indexOf("appointment_booked")] });
      }

      // Nurture workflow history
      const running = lead.stage === "new_lead" || lead.stage === "attempting_contact";
      const stopReason = path.includes("appointment_booked") ? "appointment_booked" : "lead_responded";
      const [run] = await tx
        .insert(s.workflowRuns)
        .values({
          workflowKey: "new_lead_nurture",
          contactId: contact.id,
          opportunityId: opp.id,
          status: running ? "running" : "stopped",
          currentStep: lead.stage === "new_lead" ? "acknowledgement_sent" : lead.stage === "attempting_contact" ? "followup_1_sent" : null,
          stopReason: running ? null : stopReason,
          startedAt: createdAt,
          finishedAt: running ? null : finalAt,
        })
        .returning({ id: s.workflowRuns.id });
      counts.workflow_runs++;
      audit.push({ eventType: "workflow.triggered", entityType: "workflow_run", entityId: run.id, contactId: contact.id, actorType: "system", message: "Workflow “New lead nurture” started", metadata: SEED_META, createdAt: new Date(createdAt.getTime() + 3000) });

      const sent: { key: string; at: Date; body: string }[] = [
        { key: "ack", at: new Date(createdAt.getTime() + 5000), body: `Hi ${lead.firstName}, thanks for reaching out about ${SERVICE_LABEL[lead.service]}. We'll be in touch shortly.` },
      ];
      if (lead.stage !== "new_lead") {
        sent.push({ key: "followup_1", at: new Date(createdAt.getTime() + Math.min(DAY, step || DAY)), body: `Hi ${lead.firstName}, following up on your enquiry — would a 20-minute call this week help?` });
      }
      for (const m of sent) {
        await tx.insert(s.messages).values({
          contactId: contact.id,
          workflowRunId: run.id,
          channel: "email",
          templateKey: `nurture.${m.key}`,
          toAddress: lead.email,
          body: m.body,
          status: "sent",
          idempotencyKey: `wf:${run.id}:${m.key}`,
          providerMessageId: `mock_msg_${run.id.slice(0, 8)}_${m.key}`,
          attemptedAt: m.at,
          createdAt: m.at,
        });
        counts.messages++;
        audit.push({ eventType: "message.sent", entityType: "message", contactId: contact.id, actorType: "worker", message: `Email “nurture.${m.key}” sent`, metadata: SEED_META, createdAt: m.at });
      }
      // Leads that reached "contacted" replied at least once; later stages replied more.
      const replies = !path.includes("contacted") ? 0 : path.includes("appointment_booked") ? 2 : 1;
      for (let r = 0; r < replies; r++) {
        const at = new Date(stageTimes[path.indexOf("contacted")].getTime() + r * 3 * HOUR);
        await tx.insert(s.messages).values({
          contactId: contact.id, workflowRunId: run.id, channel: "email", direction: "inbound",
          templateKey: "inbound.reply", toAddress: "sales-inbox",
          body: r === 0 ? `[demo seed] Hi, yes — interested. Can you share pricing?` : `[demo seed] Thanks, the call time works for us.`,
          status: "sent", idempotencyKey: `seed:reply:${contact.id}:${r}`, attemptedAt: at, createdAt: at,
        });
        counts.messages++;
        audit.push({ eventType: "message.received", entityType: "contact", contactId: contact.id, actorType: "webhook", actorId: "email", message: "[demo seed] Reply received from lead", metadata: SEED_META, createdAt: at });
      }
      if (!running) {
        audit.push({ eventType: "workflow.stopped", entityType: "workflow_run", entityId: run.id, contactId: contact.id, actorType: "system", message: `Workflow stopped: ${stopReason.replace("_", " ")}`, metadata: SEED_META, createdAt: finalAt });
      } else {
        const nextKey = lead.stage === "new_lead" ? "followup_1" : "followup_2";
        await tx.insert(s.jobs).values({
          type: "workflow.send_followup",
          payload: { workflowRunId: run.id, step: nextKey },
          status: "pending",
          idempotencyKey: `wf:${run.id}:${nextKey}`,
          runAt: new Date(now.getTime() + ((i % 4) + 1) * 6 * HOUR),
          workflowRunId: run.id,
          contactId: contact.id,
          opportunityId: opp.id,
          createdAt,
        });
        counts.jobs++;
      }

      // Won deals → payment + onboarding checklist
      if (lead.stage === "won") {
        await tx.insert(s.payments).values({ contactId: contact.id, opportunityId: opp.id, amount: lead.value, externalPaymentId: `demo_pay_${opp.id.slice(0, 8)}`, receivedAt: finalAt });
        counts.payments++;
        const tasks = ["Send welcome email & contract", "Collect brand assets and logins", "Kick-off call", "Set up project workspace"];
        await tx.insert(s.onboardingTasks).values(
          tasks.map((title, position) => ({
            contactId: contact.id, opportunityId: opp.id, title, position,
            status: position < 2 ? ("done" as const) : ("todo" as const),
            dueAt: new Date(finalAt.getTime() + (position + 1) * DAY),
            completedAt: position < 2 ? new Date(finalAt.getTime() + position * HOUR) : null,
          })),
        );
        counts.onboarding_tasks += tasks.length;
        audit.push({ eventType: "payment.received", entityType: "payment", contactId: contact.id, actorType: "webhook", actorId: "payments", message: `Payment received: ${lead.value} USD`, metadata: SEED_META, createdAt: finalAt });
      }
    }

    // Seeded DEMO failures (clearly labelled)
    for (const f of SEED_FAILURES) {
      const [c] = await tx.select({ id: s.contacts.id }).from(s.contacts).where(sql`${s.contacts.emailNormalized} = ${f.leadEmail}`);
      if (!c) throw new Error(`Seed failure references unknown lead ${f.leadEmail}`);
      const firstAttempt = new Date(now.getTime() - f.hoursAgo * HOUR);
      const [job] = await tx
        .insert(s.jobs)
        .values({
          type: f.jobType,
          payload: { contactId: c.id, ...SEED_META },
          status: f.status,
          idempotencyKey: `seed:${f.jobType}:${c.id}`,
          runAt: firstAttempt,
          attempts: f.attempts,
          lastError: f.error,
          errorKind: f.statusCode && (f.statusCode >= 500 || f.statusCode === 429) ? "transient" : "permanent",
          statusReason: "[demo seed] Historical failure record",
          completedAt: new Date(firstAttempt.getTime() + 2 ** f.attempts * 60_000),
          contactId: c.id,
          createdAt: firstAttempt,
          updatedAt: new Date(firstAttempt.getTime() + f.attempts * 60_000),
        })
        .returning({ id: s.jobs.id });
      counts.jobs++;
      // One integration_call row per attempt, spaced like exponential backoff (1,2,4,8… min)
      for (let a = 1; a <= f.attempts; a++) {
        const at = new Date(firstAttempt.getTime() + (2 ** (a - 1) - 1) * 60_000);
        await tx.insert(s.integrationCalls).values({ provider: f.provider, operation: f.operation, statusCode: f.statusCode, success: false, durationMs: 180 + a * 37, attempt: a, error: f.error, jobId: job.id, createdAt: at });
        counts.integration_calls++;
        await tx.insert(s.jobAttempts).values({ jobId: job.id, attempt: a, workerId: "demo-seed", outcome: f.statusCode === 400 ? "permanent_error" : "transient_error", error: f.error, durationMs: 180 + a * 37, startedAt: at, finishedAt: at });
      }
      if (f.jobType === "message.send_sms") {
        const lead = SEED_LEADS.find((l) => l.email === f.leadEmail)!;
        await tx.insert(s.messages).values({ contactId: c.id, channel: "sms", templateKey: "nurture.sms_nudge", toAddress: normalizePhone(lead.phone, lead.country) ?? lead.phone, body: `Hi ${lead.firstName}, quick nudge from the team — reply YES for a call.`, status: "failed", idempotencyKey: `seed:sms:${c.id}`, error: f.error, attemptedAt: firstAttempt, createdAt: firstAttempt });
        counts.messages++;
      }
      audit.push({ eventType: "integration.failed", entityType: "job", entityId: job.id, contactId: c.id, actorType: "integration", actorId: f.provider, message: f.error, metadata: { ...SEED_META, operation: f.operation, statusCode: f.statusCode }, createdAt: firstAttempt });
      if (f.status === "failed") {
        audit.push({ eventType: "job.dead_lettered", entityType: "job", entityId: job.id, contactId: c.id, actorType: "worker", message: `Moved to failed automations after ${f.attempts} attempts`, metadata: SEED_META, createdAt: new Date(firstAttempt.getTime() + (2 ** (f.attempts - 1)) * 60_000) });
      }
    }

    // Insert audit log in chronological order
    audit.sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
    for (let i = 0; i < audit.length; i += 200) {
      await tx.insert(s.auditLogs).values(audit.slice(i, i + 200));
    }

    return { users: userRows.length, routing_rules: SEED_ROUTING_RULES.length, ...counts, audit_logs: audit.length };
  });
}

function nextActionFor(stage: string): string | null {
  switch (stage) {
    case "new_lead": return "Automated acknowledgement sent — wait for reply";
    case "attempting_contact": return "Call lead (2nd attempt)";
    case "contacted": return "Qualify budget and timeline";
    case "qualified": return "Offer discovery call slots";
    case "appointment_booked": return "Prepare for discovery call";
    case "proposal_sent": return "Follow up on proposal";
    case "negotiation": return "Send revised terms";
    default: return null;
  }
}
