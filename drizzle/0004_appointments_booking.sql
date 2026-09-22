ALTER TABLE "jobs" ADD COLUMN "appointment_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "working_hours_start" text DEFAULT '09:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "working_hours_end" text DEFAULT '17:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "working_days" integer[] DEFAULT '{1,2,3,4,5}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_appointment_idx" ON "jobs" USING btree ("appointment_id");--> statement-breakpoint
-- Hand-added (drizzle-kit's schema DSL can't express EXCLUDE constraints): the database itself
-- refuses two non-cancelled appointments for the same rep with overlapping time ranges, so
-- double-booking is impossible even under concurrent inserts — not just checked in application code.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_overlap_per_owner" EXCLUDE USING gist (
  "owner_id" WITH =,
  tstzrange("starts_at", "ends_at") WITH &&
) WHERE ("status" <> 'cancelled');