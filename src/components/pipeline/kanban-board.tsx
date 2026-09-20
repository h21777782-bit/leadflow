"use client";

import Link from "next/link";
import { startTransition, useOptimistic, useState, type DragEvent } from "react";
import { moveStageAction } from "@/app/actions/opportunities";
import { BandBadge } from "@/components/ui/badges";
import { formatMoney } from "@/lib/format";
import { PIPELINE_STAGES, SOURCE_LABEL, STAGE_META, type LeadSource, type PipelineStage } from "@/lib/pipeline";

export type BoardCard = {
  id: string;
  contactId: string;
  contactName: string;
  company: string | null;
  stage: PipelineStage;
  valueAmount: number;
  currency: string;
  ownerName: string | null;
  leadSource: string;
  nextAction: string | null;
  lostReason: string | null;
  activityLabel: string;
  leadScore: number | null;
  leadBand: "hot" | "warm" | "cold" | null;
};

type Move = { cardId: string; to: PipelineStage };
type PendingReason = { card: BoardCard; to: PipelineStage };

/**
 * Drag a card to another column → optimistic move → server action changeStage()
 * (row lock + history + audit). If the server refuses (e.g. missing reason,
 * someone else moved it first), the optimistic state is dropped automatically
 * and the error is shown. Each card also has a "Move to" menu, because HTML
 * drag-and-drop does not work on touch screens or with a keyboard.
 */
export function KanbanBoard({ cards }: { cards: BoardCard[] }) {
  const [optimistic, applyMove] = useOptimistic(cards, (state: BoardCard[], m: Move) =>
    state.map((c) => (c.id === m.cardId ? { ...c, stage: m.to } : c)),
  );
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<PipelineStage | null>(null);
  const [pendingReason, setPendingReason] = useState<PendingReason | null>(null);
  const [reason, setReason] = useState("");

  function requestMove(card: BoardCard, to: PipelineStage) {
    if (card.stage === to) return;
    setError(null);
    // Lost, or moving a closed deal, needs a reason before we even call the server.
    if (to === "lost" || STAGE_META[card.stage].terminal) {
      setReason("");
      setPendingReason({ card, to });
      return;
    }
    commit(card, to);
  }

  function commit(card: BoardCard, to: PipelineStage, why?: string) {
    startTransition(async () => {
      applyMove({ cardId: card.id, to });
      const r = await moveStageAction({
        opportunityId: card.id,
        contactId: card.contactId,
        toStage: to,
        expectedFromStage: card.stage,
        reason: why,
      });
      if (!r.ok) setError(`${card.contactName}: ${r.error}`);
    });
  }

  function onDrop(e: DragEvent, to: PipelineStage) {
    e.preventDefault();
    setDragOver(null);
    const card = optimistic.find((c) => c.id === e.dataTransfer.getData("text/plain"));
    if (card) requestMove(card, to);
  }

  return (
    <>
      {error && (
        <div role="alert" className="mx-8 mt-4 flex items-start justify-between gap-4 rounded-md bg-bad-soft px-3 py-2 text-bad">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="font-medium">Dismiss</button>
        </div>
      )}
      <div className="overflow-x-auto px-8 py-6">
        <div className="flex gap-3" style={{ minWidth: `${PIPELINE_STAGES.length * 264}px` }}>
          {PIPELINE_STAGES.map((stage) => {
            const items = optimistic.filter((c) => c.stage === stage);
            const total = items.reduce((n, c) => n + c.valueAmount, 0);
            return (
              <section
                key={stage}
                aria-label={STAGE_META[stage].label}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (dragOver !== stage) setDragOver(stage);
                }}
                onDragLeave={() => setDragOver((s) => (s === stage ? null : s))}
                onDrop={(e) => onDrop(e, stage)}
                className={`flex w-64 shrink-0 flex-col rounded-lg border bg-surface/60 transition-colors ${
                  dragOver === stage ? "border-accent bg-accent-soft/60" : "border-line"
                }`}
              >
                <header className="border-b border-line px-3 py-2.5">
                  <div className="flex items-baseline justify-between">
                    <h2 className="font-semibold">{STAGE_META[stage].label}</h2>
                    <span className="tabular text-[13px] text-muted">{items.length}</span>
                  </div>
                  <p className="tabular text-[13px] text-muted">{formatMoney(total)}</p>
                </header>
                <ul className="min-h-24 flex-1 space-y-2 p-2">
                  {items.map((c) => (
                    <li
                      key={c.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", c.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      className="cursor-grab rounded-md border border-line bg-surface p-3 active:cursor-grabbing"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <Link href={`/contacts/${c.contactId}`} className="font-medium text-ink hover:text-accent hover:underline">
                          {c.contactName}
                        </Link>
                        <BandBadge band={c.leadBand} score={c.leadScore} />
                      </div>
                      <p className="text-[13px] text-muted">{c.company}</p>
                      <div className="mt-2 flex items-baseline justify-between text-[13px]">
                        <span className="tabular font-medium">{formatMoney(c.valueAmount, c.currency)}</span>
                        <span className={c.ownerName ? "text-muted" : "font-medium text-warm"}>{c.ownerName ?? "Unassigned"}</span>
                      </div>
                      <p className="mt-1 text-xs text-faint">
                        {SOURCE_LABEL[c.leadSource as LeadSource] ?? c.leadSource}, active {c.activityLabel}
                      </p>
                      {stage === "lost" && c.lostReason && <p className="mt-1 text-xs text-bad">{c.lostReason}</p>}
                      {!STAGE_META[stage].terminal && c.nextAction && <p className="mt-1 text-xs text-muted">Next: {c.nextAction}</p>}
                      <label className="mt-2 block">
                        <span className="sr-only">Move {c.contactName} to stage</span>
                        <select
                          value=""
                          onChange={(e) => requestMove(c, e.target.value as PipelineStage)}
                          className="w-full rounded border border-line bg-canvas px-1.5 py-1 text-xs text-muted"
                        >
                          <option value="" disabled>Move to…</option>
                          {PIPELINE_STAGES.filter((s) => s !== stage).map((s) => (
                            <option key={s} value={s}>{STAGE_META[s].label}</option>
                          ))}
                        </select>
                      </label>
                    </li>
                  ))}
                  {items.length === 0 && <li className="px-1 py-4 text-center text-[13px] text-faint">Drop a deal here</li>}
                </ul>
              </section>
            );
          })}
        </div>
      </div>

      {pendingReason && (
        <div className="fixed inset-0 z-20 grid place-items-center bg-ink/30 p-4" role="dialog" aria-modal="true" aria-labelledby="reason-title">
          <form
            className="w-full max-w-md rounded-lg bg-surface p-5 shadow-lg"
            onSubmit={(e) => {
              e.preventDefault();
              const p = pendingReason;
              setPendingReason(null);
              commit(p.card, p.to, reason);
            }}
          >
            <h2 id="reason-title" className="font-semibold">
              {pendingReason.to === "lost"
                ? `Mark ${pendingReason.card.contactName} as lost`
                : `Reopen ${pendingReason.card.contactName}'s ${STAGE_META[pendingReason.card.stage].label.toLowerCase()} deal`}
            </h2>
            <label htmlFor="move-reason" className="mt-3 block text-[13px] font-medium">
              {pendingReason.to === "lost" ? "Why was it lost?" : "Why is this deal being reopened?"}
            </label>
            <textarea
              id="move-reason"
              autoFocus
              required
              minLength={3}
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-md border border-line-strong px-2.5 py-1.5"
            />
            <p className="mt-1 text-xs text-faint">Saved on the deal and in the activity log.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setPendingReason(null)} className="px-3 py-1.5 text-muted hover:text-ink">Cancel</button>
              <button type="submit" disabled={reason.trim().length < 3} className="rounded-md bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-50">
                {pendingReason.to === "lost" ? "Mark as lost" : "Reopen deal"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
