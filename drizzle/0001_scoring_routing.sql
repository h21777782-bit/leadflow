CREATE TYPE "public"."message_direction" AS ENUM('outbound', 'inbound');--> statement-breakpoint
CREATE TYPE "public"."routing_outcome" AS ENUM('assigned', 'reassigned', 'unassigned');--> statement-breakpoint
ALTER TYPE "public"."routing_strategy" ADD VALUE 'least_loaded';--> statement-breakpoint
CREATE TABLE "routing_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"outcome" "routing_outcome" NOT NULL,
	"assigned_user_id" uuid,
	"previous_user_id" uuid,
	"rule_id" uuid,
	"rule_name" text,
	"trigger" text NOT NULL,
	"reason" text NOT NULL,
	"trace" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "lead_score" integer;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "lead_band" "lead_band";--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "scored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "assignment_source" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "unassigned_reason" text;--> statement-breakpoint
ALTER TABLE "lead_scores" ADD COLUMN "trigger" text;--> statement-breakpoint
ALTER TABLE "lead_scores" ADD COLUMN "config_version" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "direction" "message_direction" DEFAULT 'outbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_previous_user_id_users_id_fk" FOREIGN KEY ("previous_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_rule_id_routing_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."routing_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routing_decisions_contact_idx" ON "routing_decisions" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE INDEX "routing_decisions_created_idx" ON "routing_decisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "contacts_band_idx" ON "contacts" USING btree ("lead_band");