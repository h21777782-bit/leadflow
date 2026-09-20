"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { getActingUser } from "@/server/services/actor";
import { logInboundReply, processLeadChange, updateRepStatus } from "@/server/services/lead-intelligence";
import { saveRoutingRule } from "@/server/services/routing-rules";
import type { FieldErrors } from "@/lib/validation/contact";

function revalidateAll(contactId?: string) {
  for (const p of ["/dashboard", "/contacts", "/pipeline", "/activity", "/settings"]) revalidatePath(p);
  if (contactId) revalidatePath(`/contacts/${contactId}`);
}

export type SimpleState = { ok?: boolean; message?: string; error?: string; errors?: FieldErrors };

export async function logReplyAction(contactId: string, _prev: SimpleState, fd: FormData): Promise<SimpleState> {
  const db = getDb();
  const r = await logInboundReply(db, await getActingUser(db), contactId, { channel: String(fd.get("channel") ?? "email"), body: String(fd.get("body") ?? "") });
  if (r.status === "invalid") return { error: r.error };
  if (r.status === "not_found") return { error: "Contact not found" };
  revalidateAll(contactId);
  const sc = r.outcome.score;
  return { ok: true, message: sc?.changed ? `Reply logged. Score ${sc.previous.score} → ${sc.result.score}.` : "Reply logged. Score unchanged." };
}

/** Recalculate score and, if the lead is unassigned, route it now (a human asked — this also clears a manual unassign). */
export async function routeNowAction(contactId: string): Promise<SimpleState> {
  const db = getDb();
  const r = await processLeadChange(db, await getActingUser(db), contactId, "manual.route_now", { force: true });
  revalidateAll(contactId);
  if (r.errors.length) return { error: r.errors.join("; ") };
  const rt = r.routing;
  if (!rt) return { message: "Score recalculated." };
  if (rt.status === "assigned" || rt.status === "reassigned") return { ok: true, message: `Assigned to ${rt.userName}.` };
  return { ok: rt.status !== "unassigned", message: rt.reason };
}

export async function updateRepAction(userId: string, _prev: SimpleState, fd: FormData): Promise<SimpleState> {
  const db = getDb();
  // Never coerce a missing/blank field to 0 — Number(null) === 0 would silently
  // set capacity to zero and stop all routing to this rep.
  const rawCap = String(fd.get("maxOpenLeads") ?? "").trim();
  if (rawCap === "" || !/^\d+$/.test(rawCap)) return { error: "Capacity must be a whole number" };
  const cap = Number(rawCap);
  const r = await updateRepStatus(db, await getActingUser(db), userId, {
    isAvailable: fd.get("isAvailable") === "on",
    isActive: fd.get("isActive") === "on",
    maxOpenLeads: cap,
  });
  if (r.status === "invalid") return { error: r.error };
  if (r.status === "not_found") return { error: "Rep not found" };
  revalidateAll();
  const moved = r.rerouted.filter((x) => x.outcome && (x.outcome.status === "assigned" || x.outcome.status === "reassigned")).length;
  const left = r.rerouted.filter((x) => x.outcome?.status === "unassigned").length;
  return { ok: true, message: `Saved. ${r.rerouted.length} lead(s) re-evaluated: ${moved} assigned, ${left} left unassigned.` };
}

export async function saveRuleAction(ruleId: string | null, _prev: SimpleState, fd: FormData): Promise<SimpleState> {
  const db = getDb();
  const r = await saveRoutingRule(db, await getActingUser(db), ruleId, {
    name: fd.get("name"),
    priority: fd.get("priority"),
    strategy: fd.get("strategy"),
    isActive: fd.get("isActive") === "on",
    services: fd.getAll("services").map(String),
    countries: String(fd.get("countries") ?? ""),
    sources: fd.getAll("sources").map(String),
    minBudget: String(fd.get("minBudget") ?? ""),
    requireServiceExpertise: fd.get("requireServiceExpertise") === "on",
    targetUserIds: fd.getAll("targetUserIds").map(String),
  });
  if (r.status === "invalid") return { errors: r.errors };
  if (r.status === "not_found") return { error: "Rule not found" };
  revalidateAll();
  return { ok: true, message: `Rule saved. ${r.rerouted} waiting lead(s) were assigned.` };
}
