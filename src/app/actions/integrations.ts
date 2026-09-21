"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { pipelineStages } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { isPipelineStage } from "@/lib/pipeline";
import { CRM_FAILURE_SWITCH_KEY, getCrmProvider, type CrmFailureMode } from "@/server/integrations/crm";
import { getActingUser } from "@/server/services/actor";
import { setSetting } from "@/server/services/app-settings";
import { writeAudit } from "@/server/services/audit";

function revalidateIntegrations() {
  revalidatePath("/integrations");
}

export type ActionResult = { ok: boolean; message: string };

/** Calls the real (or mock) provider's cheapest read endpoint to prove credentials + connectivity work. */
export async function testConnectionAction(): Promise<ActionResult & { pipelineCount?: number; stageCount?: number }> {
  const env = getEnv();
  if (!env.MOCK_MODE && !env.HIGHLEVEL_LOCATION_ID) return { ok: false, message: "HIGHLEVEL_LOCATION_ID is not configured" };
  const db = getDb();
  try {
    const provider = getCrmProvider(db, (operation) => ({ operation }));
    const pipelines = await provider.getPipelines(env.HIGHLEVEL_LOCATION_ID ?? "mock-location");
    const stageCount = pipelines.reduce((n, p) => n + p.stages.length, 0);
    revalidateIntegrations();
    return { ok: true, message: `Connected (${provider.name}): ${pipelines.length} pipeline(s), ${stageCount} stage(s)`, pipelineCount: pipelines.length, stageCount };
  } catch (err) {
    revalidateIntegrations();
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function setCrmFailureModeAction(mode: CrmFailureMode): Promise<ActionResult> {
  if (!getEnv().MOCK_MODE) return { ok: false, message: "The demo failure switch only works in MOCK_MODE" };
  await setSetting(getDb(), CRM_FAILURE_SWITCH_KEY, mode);
  revalidateIntegrations();
  return { ok: true, message: `Demo CRM failure switch set to “${mode}”` };
}

export async function updateStageMappingAction(stageKey: string, ghlStageId: string): Promise<ActionResult> {
  if (!isPipelineStage(stageKey)) return { ok: false, message: `Unknown stage “${stageKey}”` };
  const db = getDb();
  const value = ghlStageId.trim() || null;
  const [row] = await db.update(pipelineStages).set({ ghlStageId: value }).where(eq(pipelineStages.key, stageKey)).returning();
  if (!row) return { ok: false, message: "Stage not found" };
  await writeAudit(db, await getActingUser(db), {
    eventType: "crm.stage_mapping_updated",
    entityType: "pipeline_stage",
    message: value ? `Stage “${stageKey}” mapped to HighLevel stage ${value}` : `Stage “${stageKey}” HighLevel mapping cleared`,
    metadata: { stageKey, ghlStageId: value },
  });
  revalidateIntegrations();
  return { ok: true, message: "Saved" };
}
