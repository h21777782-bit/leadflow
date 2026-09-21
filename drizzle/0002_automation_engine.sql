-- Hand-edited: rename job_status values IN PLACE instead of drizzle's drop/recreate,
-- so existing rows keep their (renamed) status and nothing is lost.
ALTER TYPE "public"."job_status" RENAME VALUE 'running' TO 'processing';--> statement-breakpoint
ALTER TYPE "public"."job_status" RENAME VALUE 'succeeded' TO 'completed';--> statement-breakpoint
ALTER TYPE "public"."job_status" RENAME VALUE 'retrying' TO 'retry_scheduled';--> statement-breakpoint
ALTER TYPE "public"."job_status" RENAME VALUE 'dead' TO 'failed';--> statement-breakpoint
ALTER TYPE "public"."job_status" ADD VALUE 'skipped';--> statement-breakpoint
CREATE TYPE "public"."attempt_outcome" AS ENUM('completed', 'skipped', 'transient_error', 'permanent_error', 'abandoned');--> statement-breakpoint
ALTER TYPE "public"."workflow_run_status" ADD VALUE 'cancelled';--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"worker_id" text,
	"outcome" "attempt_outcome" NOT NULL,
	"error" text,
	"duration_ms" integer,
	"next_run_at" timestamp with time zone,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"hostname" text,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"jobs_completed" integer DEFAULT 0 NOT NULL,
	"jobs_failed" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_key" text NOT NULL,
	"step_key" text NOT NULL,
	"position" integer NOT NULL,
	"delay_seconds" integer NOT NULL,
	"channel" "message_channel" DEFAULT 'email' NOT NULL,
	"subject" text NOT NULL,
	"body_template" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "opted_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "error_kind" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "opportunity_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "provider" text DEFAULT 'mock' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_attempts_job_idx" ON "job_attempts" USING btree ("job_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_steps_key_uq" ON "workflow_steps" USING btree ("workflow_key","step_key");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_lease_idx" ON "jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "jobs_run_idx" ON "jobs" USING btree ("workflow_run_id");