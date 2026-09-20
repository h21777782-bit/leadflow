import type { Metadata } from "next";
import { connection } from "next/server";
import { KanbanBoard, type BoardCard } from "@/components/pipeline/kanban-board";
import { PageHeader } from "@/components/ui/page-header";
import { formatRelative } from "@/lib/format";
import { getPipelineBoard } from "@/server/queries";

export const metadata: Metadata = { title: "Pipeline" };

export default async function PipelinePage() {
  await connection();
  const board = await getPipelineBoard();
  const now = new Date(); // server-side: keeps client render pure
  const cards: BoardCard[] = board.flatMap((col) =>
    col.items.map((o) => ({
      id: o.id,
      contactId: o.contactId,
      contactName: o.contactName,
      company: o.company,
      stage: o.stage,
      valueAmount: o.valueAmount,
      currency: o.currency,
      ownerName: o.ownerName,
      leadSource: o.leadSource,
      nextAction: o.nextAction,
      lostReason: o.lostReason,
      activityLabel: formatRelative(o.lastActivityAt, now),
      leadScore: o.leadScore,
      leadBand: o.leadBand,
    })),
  );

  return (
    <>
      <PageHeader
        title="Pipeline"
        description="Drag a deal to another stage, or use its Move to menu. Every move is saved with who, when and why."
      />
      <KanbanBoard cards={cards} />
    </>
  );
}
