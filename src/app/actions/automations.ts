"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { getEnv } from "@/lib/env";
import { FAILURE_SWITCH_KEY, type FailureMode } from "@/server/integrations/messaging/mock-provider";
import { cancelJob, retryJobNow } from "@/server/queue/queue";
import { getActingUser } from "@/server/services/actor";
import { setSetting } from "@/server/services/app-settings";
import { cancelWorkflowRun, setOptOut, updateStepDelay } from "@/server/workflows/nurture";
import { SUPPORTED_JOB_TYPES } from "@/server/worker/runner";

function revalidateAutomations(contactId?: string) {
  for (const p of ["/automations", "/failed-automations", "/dashboard"]) revalidatePath(p);
  if (contactId) revalidatePath(`/contacts/${contactId}`);
}

export type ActionResult = { ok: boolean; message: string };

export async function retryJobAction(jobId: string, contactId?: string): Promise<ActionResult> {
  const db = getDb();
  const r = await retryJobNow(db, await getActingUser(db), jobId, SUPPORTED_JOB_TYPES);
  revalidateAutomations(contactId);
  if (r.status === "not_found") return { ok: false, message: "Job not found" };
  if (r.status === "not_allowed") return { ok: false, message: r.error };
  return { ok: true, message: r.message };
}

export async function cancelJobAction(jobId: string, reason: string, contactId?: string): Promise<ActionResult> {
  const db = getDb();
  const r = await cancelJob(db, await getActingUser(db), jobId, reason.trim() || "Cancelled manually");
  revalidateAutomations(contactId);
  if (r.status === "not_found") return { ok: false, message: "Job not found" };
  if (r.status === "not_allowed") return { ok: false, message: r.error };
  return { ok: true, message: r.message };
}

export async function cancelWorkflowAction(runId: string, reason: string, contactId: string): Promise<ActionResult> {
  const db = getDb();
  const r = await cancelWorkflowRun(db, await getActingUser(db), runId, reason.trim() || "Cancelled manually");
  revalidateAutomations(contactId);
  if (r.status === "not_found") return { ok: false, message: "Workflow run not found" };
  if (r.status === "not_allowed") return { ok: false, message: r.error };
  return { ok: true, message: `Workflow cancelled (${r.cancelledJobs} pending job(s) cancelled)` };
}

export async function setOptOutAction(contactId: string, optedOut: boolean): Promise<ActionResult> {
  const db = getDb();
  const r = await setOptOut(db, await getActingUser(db), contactId, optedOut);
  revalidateAutomations(contactId);
  if (r.status === "not_found") return { ok: false, message: "Contact not found" };
  return { ok: true, message: optedOut ? "Opted out — pending follow-ups will be skipped" : "Opted back in" };
}

/** DEMO ONLY: forces the mock messaging provider to fail sends. Refused outside MOCK_MODE. */
export async function setFailureModeAction(mode: FailureMode): Promise<ActionResult> {
  if (!getEnv().MOCK_MODE) return { ok: false, message: "The demo failure switch only works in MOCK_MODE" };
  const db = getDb();
  await setSetting(db, FAILURE_SWITCH_KEY, mode);
  revalidateAutomations();
  return { ok: true, message: `Demo failure switch set to “${mode}”` };
}

export async function updateStepDelayAction(stepId: string, delaySeconds: number): Promise<ActionResult> {
  const db = getDb();
  const r = await updateStepDelay(db, await getActingUser(db), stepId, delaySeconds);
  revalidateAutomations();
  if (r.status === "invalid") return { ok: false, message: r.error };
  if (r.status === "not_found") return { ok: false, message: "Step not found" };
  return { ok: true, message: "Delay updated — applies to steps scheduled from now on, not ones already waiting" };
}
