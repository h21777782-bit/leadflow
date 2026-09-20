/**
 * Database schema (Drizzle ORM → PostgreSQL / Supabase).
 *
 * The complete schema for all phases is defined up front so migrations stay
 * linear and later phases only add behaviour, not tables.
 *
 * Conventions
 * - All timestamps are `timestamptz` and stored in UTC. Display timezone is a
 *   presentation concern (see src/lib/format.ts).
 * - Money is stored as integer whole units + ISO currency code.
 * - `ghl_*_id` columns hold the matching HighLevel record id once synced.
 * - Every uniqueness guarantee that protects us from duplicates (contacts,
 *   webhooks, jobs, messages) is enforced by a UNIQUE index in the database,
 *   not only in application code. App checks can race; the index cannot.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { PIPELINE_STAGES } from "@/lib/pipeline";

// ── Enums ─────────────────────────────────────────────────────────────────────
export const pipelineStageEnum = pgEnum("pipeline_stage", PIPELINE_STAGES);
export const opportunityStatusEnum = pgEnum("opportunity_status", ["open", "won", "lost"]);
export const userRoleEnum = pgEnum("user_role", ["admin", "sales_rep"]);
export const actorTypeEnum = pgEnum("actor_type", ["system", "user", "webhook", "integration", "worker"]);
export const leadBandEnum = pgEnum("lead_band", ["hot", "warm", "cold"]);
export const routingStrategyEnum = pgEnum("routing_strategy", ["assign_user", "round_robin", "least_loaded"]);
export const messageDirectionEnum = pgEnum("message_direction", ["outbound", "inbound"]);
export const routingOutcomeEnum = pgEnum("routing_outcome", ["assigned", "reassigned", "unassigned"]);
export const workflowRunStatusEnum = pgEnum("workflow_run_status", ["running", "completed", "stopped", "failed"]);
export const jobStatusEnum = pgEnum("job_status", ["pending", "running", "succeeded", "retrying", "dead", "cancelled"]);
export const messageChannelEnum = pgEnum("message_channel", ["email", "sms"]);
export const messageStatusEnum = pgEnum("message_status", ["queued", "sent", "failed", "skipped"]);
export const appointmentStatusEnum = pgEnum("appointment_status", ["scheduled", "confirmed", "cancelled", "completed", "no_show"]);
export const webhookStatusEnum = pgEnum("webhook_status", ["received", "processed", "failed", "duplicate", "rejected"]);
export const taskStatusEnum = pgEnum("task_status", ["todo", "in_progress", "done"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ── Users (sales reps / admins) ──────────────────────────────────────────────
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  role: userRoleEnum("role").notNull().default("sales_rep"),
  timezone: text("timezone").notNull(),
  services: text("services").array().notNull().default(sql`'{}'::text[]`),
  regions: text("regions").array().notNull().default(sql`'{}'::text[]`),
  isActive: boolean("is_active").notNull().default(true), // employment status
  isAvailable: boolean("is_available").notNull().default(true), // e.g. on leave
  maxOpenLeads: integer("max_open_leads").notNull().default(25),
  lastAssignedAt: timestamp("last_assigned_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// ── Pipeline stage config (labels, order, HighLevel mapping) ─────────────────
export const pipelineStages = pgTable("pipeline_stages", {
  key: pipelineStageEnum("key").primaryKey(),
  label: text("label").notNull(),
  position: integer("position").notNull(),
  probability: integer("probability").notNull(),
  isTerminal: boolean("is_terminal").notNull().default(false),
  ghlStageId: text("ghl_stage_id"),
});

// ── Contacts ──────────────────────────────────────────────────────────────────
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name"),
    email: text("email"),
    emailNormalized: text("email_normalized"),
    phone: text("phone"),
    phoneE164: text("phone_e164"),
    company: text("company"),
    leadSource: text("lead_source").notNull(),
    serviceInterest: text("service_interest"),
    budgetAmount: integer("budget_amount"),
    budgetCurrency: text("budget_currency").notNull().default("USD"),
    country: text("country"), // ISO-3166 alpha-2
    timezone: text("timezone"), // IANA, e.g. Asia/Kolkata
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
    notes: text("notes"),
    lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
    nextFollowUpAt: timestamp("next_follow_up_at", { withTimezone: true }),
    ghlContactId: text("ghl_contact_id"),
    // Current score (denormalized for fast lists/dashboards; history in lead_scores)
    leadScore: integer("lead_score"),
    leadBand: leadBandEnum("lead_band"),
    scoredAt: timestamp("scored_at", { withTimezone: true }),
    // Ownership provenance: routing | manual | seed (null = never assigned)
    assignmentSource: text("assignment_source"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    unassignedReason: text("unassigned_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("contacts_band_idx").on(t.leadBand),
    uniqueIndex("contacts_email_normalized_uq").on(t.emailNormalized),
    uniqueIndex("contacts_phone_e164_uq").on(t.phoneE164),
    uniqueIndex("contacts_ghl_contact_id_uq").on(t.ghlContactId),
    index("contacts_owner_idx").on(t.ownerId),
    index("contacts_created_at_idx").on(t.createdAt),
  ],
);

// ── Opportunities ─────────────────────────────────────────────────────────────
export const opportunities = pgTable(
  "opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    stage: pipelineStageEnum("stage").notNull().default("new_lead"),
    status: opportunityStatusEnum("status").notNull().default("open"),
    valueAmount: integer("value_amount").notNull().default(0),
    currency: text("currency").notNull().default("USD"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    leadSource: text("lead_source").notNull(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    nextAction: text("next_action"),
    nextActionAt: timestamp("next_action_at", { withTimezone: true }),
    lostReason: text("lost_reason"),
    wonAt: timestamp("won_at", { withTimezone: true }),
    lostAt: timestamp("lost_at", { withTimezone: true }),
    ghlOpportunityId: text("ghl_opportunity_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("opportunities_stage_idx").on(t.stage),
    index("opportunities_contact_idx").on(t.contactId),
    index("opportunities_owner_idx").on(t.ownerId),
    uniqueIndex("opportunities_ghl_id_uq").on(t.ghlOpportunityId),
  ],
);

// Every stage change is appended here — never updated, never deleted.
export const stageHistory = pgTable(
  "stage_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    opportunityId: uuid("opportunity_id").notNull().references(() => opportunities.id, { onDelete: "cascade" }),
    fromStage: pipelineStageEnum("from_stage"),
    toStage: pipelineStageEnum("to_stage").notNull(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [index("stage_history_opp_idx").on(t.opportunityId, t.createdAt)],
);

// ── Lead routing & scoring ────────────────────────────────────────────────────
export type RoutingConditions = import("@/lib/routing").RuleConditions;

export const routingRules = pgTable("routing_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  priority: integer("priority").notNull(), // lower number = evaluated first
  isActive: boolean("is_active").notNull().default(true),
  conditions: jsonb("conditions").$type<RoutingConditions>().notNull().default({}),
  strategy: routingStrategyEnum("strategy").notNull(),
  targetUserIds: uuid("target_user_ids").array().notNull(),
  createdAt: createdAt(),
});

export type ScoreFactor = { factor: string; points: number; max: number; reason: string };

export const leadScores = pgTable(
  "lead_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    score: integer("score").notNull(),
    band: leadBandEnum("band").notNull(),
    breakdown: jsonb("breakdown").$type<ScoreFactor[]>().notNull(),
    trigger: text("trigger"),
    configVersion: text("config_version"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("lead_scores_contact_idx").on(t.contactId, t.computedAt)],
);

// Every routing attempt that produced an outcome (assign / reassign / leave unassigned).
export const routingDecisions = pgTable(
  "routing_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    outcome: routingOutcomeEnum("outcome").notNull(),
    assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
    previousUserId: uuid("previous_user_id").references(() => users.id, { onDelete: "set null" }),
    ruleId: uuid("rule_id").references(() => routingRules.id, { onDelete: "set null" }),
    ruleName: text("rule_name"),
    trigger: text("trigger").notNull(),
    reason: text("reason").notNull(),
    trace: jsonb("trace").$type<unknown[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [
    index("routing_decisions_contact_idx").on(t.contactId, t.createdAt),
    index("routing_decisions_created_idx").on(t.createdAt),
  ],
);

// ── Workflows, jobs, messages ────────────────────────────────────────────────
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowKey: text("workflow_key").notNull(),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "cascade" }),
    status: workflowRunStatusEnum("status").notNull().default("running"),
    currentStep: text("current_step"),
    stopReason: text("stop_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    // A contact can be in a given workflow only once at a time.
    uniqueIndex("workflow_runs_one_active_uq")
      .on(t.workflowKey, t.contactId)
      .where(sql`status = 'running'`),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatusEnum("status").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastError: text("last_error"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    workflowRunId: uuid("workflow_run_id").references(() => workflowRuns.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("jobs_idempotency_key_uq").on(t.idempotencyKey),
    index("jobs_due_idx").on(t.status, t.runAt),
    index("jobs_contact_idx").on(t.contactId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    workflowRunId: uuid("workflow_run_id").references(() => workflowRuns.id, { onDelete: "set null" }),
    channel: messageChannelEnum("channel").notNull(),
    direction: messageDirectionEnum("direction").notNull().default("outbound"),
    templateKey: text("template_key").notNull(),
    toAddress: text("to_address").notNull(),
    body: text("body").notNull(),
    status: messageStatusEnum("status").notNull().default("queued"),
    idempotencyKey: text("idempotency_key").notNull(),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // The database refuses a second row for the same logical message.
    uniqueIndex("messages_idempotency_key_uq").on(t.idempotencyKey),
    index("messages_contact_idx").on(t.contactId),
  ],
);

// ── Appointments ─────────────────────────────────────────────────────────────
export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "set null" }),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(), // UTC instant
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    timezone: text("timezone").notNull(), // IANA zone the prospect booked in
    status: appointmentStatusEnum("status").notNull().default("scheduled"),
    ghlAppointmentId: text("ghl_appointment_id"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [
    index("appointments_starts_idx").on(t.startsAt),
    uniqueIndex("appointments_ghl_id_uq").on(t.ghlAppointmentId),
  ],
);

// ── Webhooks & integrations ──────────────────────────────────────────────────
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(), // website | n8n | highlevel | payments
    eventType: text("event_type").notNull(),
    externalEventId: text("external_event_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    signatureValid: boolean("signature_valid"),
    status: webhookStatusEnum("status").notNull().default("received"),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    // Idempotency: the same provider event can only be stored once.
    uniqueIndex("webhook_events_source_event_uq").on(t.source, t.externalEventId),
    index("webhook_events_received_idx").on(t.receivedAt),
  ],
);

export const integrationCalls = pgTable(
  "integration_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(), // highlevel | mock | email | sms
    operation: text("operation").notNull(), // e.g. contacts.upsert
    statusCode: integer("status_code"),
    success: boolean("success").notNull(),
    durationMs: integer("duration_ms"),
    attempt: integer("attempt").notNull().default(1),
    error: text("error"),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("integration_calls_created_idx").on(t.createdAt)],
);

// ── Audit log (append-only) ──────────────────────────────────────────────────
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(), // e.g. contact.created, stage.changed
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id"),
    message: text("message").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_created_idx").on(t.createdAt),
    index("audit_logs_contact_idx").on(t.contactId, t.createdAt),
  ],
);

// ── Payments & onboarding ────────────────────────────────────────────────────
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "set null" }),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull().default("USD"),
    externalPaymentId: text("external_payment_id").notNull(),
    status: text("status").notNull().default("succeeded"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("payments_external_id_uq").on(t.externalPaymentId)],
);

export const onboardingTasks = pgTable(
  "onboarding_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    position: integer("position").notNull(),
    status: taskStatusEnum("status").notNull().default("todo"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("onboarding_tasks_contact_idx").on(t.contactId)],
);
