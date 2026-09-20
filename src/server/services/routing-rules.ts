/**
 * Routing rule configuration (persisted in routing_rules). Validated with Zod
 * so a bad rule can never be saved; every change is audited, and unassigned
 * leads are re-routed because a new/edited rule may now cover them.
 */
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db/client";
import { routingRules, users } from "@/db/schema";
import { LEAD_SOURCES, SERVICES } from "@/lib/pipeline";
import type { FieldErrors } from "@/lib/validation/contact";
import { writeAudit } from "./audit";
import { rerouteUnassigned } from "./lead-intelligence";
import type { Actor } from "./types";

const csvToList = (v: unknown) =>
  (Array.isArray(v) ? v : String(v ?? "").split(","))
    .map((x) => String(x).trim())
    .filter(Boolean);

export const ruleInputSchema = z.object({
  name: z.string().trim().min(3, "Name the rule").max(80),
  priority: z.coerce.number().int("Whole number").min(1, "1 or more").max(1000),
  strategy: z.enum(["assign_user", "round_robin", "least_loaded"]),
  isActive: z.boolean(),
  services: z.preprocess(csvToList, z.array(z.enum(SERVICES))),
  countries: z.preprocess(
    (v) => csvToList(v).map((c) => c.toUpperCase()),
    z.array(z.string().regex(/^[A-Z]{2}$/, "Use 2-letter country codes, comma-separated")),
  ),
  sources: z.preprocess(csvToList, z.array(z.enum(LEAD_SOURCES))),
  minBudget: z.preprocess((v) => (v === "" || v == null ? undefined : v), z.coerce.number().int().min(0).optional()),
  requireServiceExpertise: z.boolean(),
  targetUserIds: z.preprocess(csvToList, z.array(z.uuid()).min(1, "Pick at least one rep")),
});

export type RuleInput = z.input<typeof ruleInputSchema>;

export async function saveRoutingRule(
  db: Database,
  actor: Actor,
  ruleId: string | null,
  raw: unknown,
): Promise<{ status: "invalid"; errors: FieldErrors } | { status: "not_found" } | { status: "saved"; ruleId: string; rerouted: number }> {
  const p = ruleInputSchema.safeParse(raw);
  if (!p.success) {
    const errors: FieldErrors = {};
    for (const i of p.error.issues) errors[String(i.path[0] ?? "form")] ??= i.message;
    return { status: "invalid", errors };
  }
  const r = p.data;
  const reps = await db.select({ id: users.id }).from(users).where(inArray(users.id, r.targetUserIds));
  if (reps.length !== new Set(r.targetUserIds).size) return { status: "invalid", errors: { targetUserIds: "Unknown rep selected" } };

  const values = {
    name: r.name,
    priority: r.priority,
    strategy: r.strategy,
    isActive: r.isActive,
    targetUserIds: [...new Set(r.targetUserIds)],
    conditions: {
      ...(r.services.length ? { services: r.services } : {}),
      ...(r.countries.length ? { countries: r.countries } : {}),
      ...(r.sources.length ? { sources: r.sources } : {}),
      ...(r.minBudget ? { minBudget: r.minBudget } : {}),
      ...(r.requireServiceExpertise ? { requireServiceExpertise: true } : {}),
    },
  };

  const saved = await db.transaction(async (tx) => {
    let id = ruleId;
    if (id) {
      const [before] = await tx.select().from(routingRules).where(eq(routingRules.id, id)).for("update");
      if (!before) return null;
      await tx.update(routingRules).set(values).where(eq(routingRules.id, id));
      await writeAudit(tx, actor, {
        eventType: "routing_rule.updated",
        entityType: "routing_rule",
        entityId: id,
        message: `Routing rule “${r.name}” updated`,
        metadata: { before: { ...before, createdAt: undefined }, after: values },
      });
    } else {
      [{ id }] = await tx.insert(routingRules).values(values).returning({ id: routingRules.id });
      await writeAudit(tx, actor, {
        eventType: "routing_rule.created",
        entityType: "routing_rule",
        entityId: id,
        message: `Routing rule “${r.name}” created (priority ${r.priority})`,
        metadata: { after: values },
      });
    }
    return id!;
  });
  if (!saved) return { status: "not_found" };
  const rerouted = await rerouteUnassigned(db, actor, "routing_rule.changed");
  return { status: "saved", ruleId: saved, rerouted: rerouted.filter((x) => x.outcome && "userId" in x.outcome).length };
}
