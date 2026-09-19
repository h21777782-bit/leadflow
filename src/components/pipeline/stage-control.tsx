"use client";

import { useState, useTransition } from "react";
import { moveStageAction } from "@/app/actions/opportunities";
import { PIPELINE_STAGES, STAGE_META, type PipelineStage } from "@/lib/pipeline";

/** Change an opportunity's stage from the lead page. Keyboard- and touch-friendly. */
export function StageControl({ opportunityId, contactId, stage }: { opportunityId: string; contactId: string; stage: PipelineStage }) {
  const [to, setTo] = useState<PipelineStage>(stage);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const needsReason = to === "lost" || (STAGE_META[stage].terminal && to !== stage);

  return (
    <form
      className="mt-3 space-y-2 rounded-md bg-canvas p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const r = await moveStageAction({ opportunityId, contactId, toStage: to, expectedFromStage: stage, reason });
          if (!r.ok) setError(r.error);
          else setReason("");
        });
      }}
    >
      <label htmlFor={`stage-${opportunityId}`} className="block text-[13px] font-medium">Move to stage</label>
      <div className="flex gap-2">
        <select
          id={`stage-${opportunityId}`}
          value={to}
          onChange={(e) => setTo(e.target.value as PipelineStage)}
          className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1.5"
        >
          {PIPELINE_STAGES.map((s) => <option key={s} value={s}>{STAGE_META[s].label}</option>)}
        </select>
        <button type="submit" disabled={pending || to === stage} className="rounded-md bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-50">
          {pending ? "Moving…" : "Move"}
        </button>
      </div>
      {needsReason && (
        <input
          aria-label={to === "lost" ? "Lost reason" : "Reason for reopening"}
          placeholder={to === "lost" ? "Why was it lost? (required)" : "Why reopen this closed deal? (required)"}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-md border border-line-strong bg-surface px-2 py-1.5"
        />
      )}
      {error && <p role="alert" className="text-[13px] text-bad">{error}</p>}
    </form>
  );
}
