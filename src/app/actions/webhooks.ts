"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { reprocessWebhookEvent } from "@/server/services/webhooks";

export type ActionResult = { ok: boolean; message: string };

export async function reprocessWebhookEventAction(webhookEventId: string): Promise<ActionResult> {
  const r = await reprocessWebhookEvent(getDb(), webhookEventId);
  revalidatePath("/webhooks");
  if (r.status === "not_found") return { ok: false, message: "Webhook event not found" };
  return { ok: true, message: "Reprocessing queued — the worker will pick it up on its next poll" };
}
