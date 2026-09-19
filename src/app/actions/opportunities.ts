"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { getActingUser } from "@/server/services/actor";
import { changeStage, createOpportunity } from "@/server/services/opportunities";
import type { FieldErrors } from "@/lib/validation/contact";

export type StageActionResult = { ok: true } | { ok: false; error: string };

function revalidateCrm(contactId?: string) {
  for (const p of ["/pipeline", "/contacts", "/dashboard", "/activity"]) revalidatePath(p);
  if (contactId) revalidatePath(`/contacts/${contactId}`);
}

/** Used by the Kanban board and the lead page. */
export async function moveStageAction(input: {
  opportunityId: string;
  toStage: string;
  expectedFromStage: string;
  reason?: string;
  contactId?: string;
}): Promise<StageActionResult> {
  const db = getDb();
  const r = await changeStage(db, await getActingUser(db), input);
  if (r.status === "changed") {
    revalidateCrm(input.contactId);
    return { ok: true };
  }
  if (r.status === "conflict") revalidateCrm(input.contactId); // show the fresh state
  return { ok: false, error: r.status === "not_found" ? "This deal no longer exists." : r.error };
}

export type OpportunityFormState = { errors?: FieldErrors; message?: string; ok?: boolean };

export async function createOpportunityAction(contactId: string, _prev: OpportunityFormState, fd: FormData): Promise<OpportunityFormState> {
  const db = getDb();
  const r = await createOpportunity(db, await getActingUser(db), contactId, {
    title: String(fd.get("title") ?? ""),
    valueAmount: String(fd.get("valueAmount") ?? ""),
  });
  if (r.status === "invalid") return { errors: r.errors };
  if (r.status === "not_found") return { message: "This contact no longer exists." };
  revalidateCrm(contactId);
  return { ok: true, message: "Opportunity created in New lead." };
}
