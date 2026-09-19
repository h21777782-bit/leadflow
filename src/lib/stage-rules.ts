/**
 * Pipeline stage-change rules (pure — no DB), so they are unit-testable and
 * shared by the Kanban board, the lead page and (later) automations/webhooks.
 */
import { STAGE_META, type PipelineStage } from "@/lib/pipeline";

export type StageChangeRequest = {
  from: PipelineStage;
  to: PipelineStage;
  reason?: string | null;
};

export type StageChangeDecision =
  | { ok: true; status: "open" | "won" | "lost"; isReopen: boolean }
  | { ok: false; error: string };

export const MIN_REASON_LENGTH = 3;

export function decideStageChange({ from, to, reason }: StageChangeRequest): StageChangeDecision {
  const why = reason?.trim() ?? "";

  if (from === to) return { ok: false, error: `Already in ${STAGE_META[to].label}` };

  // A lost deal must say why — this is what makes lost-reason reporting possible.
  if (to === "lost" && why.length < MIN_REASON_LENGTH) {
    return { ok: false, error: "Give a reason when marking a deal as lost" };
  }

  // Moving a closed deal (won/lost) anywhere else is a manual override: require a reason.
  const isReopen = STAGE_META[from].terminal;
  if (isReopen && why.length < MIN_REASON_LENGTH) {
    return { ok: false, error: `Give a reason for moving a ${STAGE_META[from].label.toLowerCase()} deal` };
  }

  const status = to === "won" ? "won" : to === "lost" ? "lost" : "open";
  return { ok: true, status, isReopen };
}
