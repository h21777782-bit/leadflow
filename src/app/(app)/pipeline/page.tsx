import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { PageHeader } from "@/components/ui/page-header";
import { formatMoney, formatRelative } from "@/lib/format";
import { SOURCE_LABEL, STAGE_META, type LeadSource } from "@/lib/pipeline";
import { getPipelineBoard } from "@/server/queries";

export const metadata: Metadata = { title: "Pipeline" };

export default async function PipelinePage() {
  await connection();
  const board = await getPipelineBoard();

  return (
    <>
      <PageHeader title="Pipeline" description="Every opportunity by stage, most recently active first." />
      <div className="overflow-x-auto px-8 py-6">
        <div className="flex gap-3" style={{ minWidth: `${board.length * 264}px` }}>
          {board.map((col) => (
            <section key={col.stage} className="flex w-64 shrink-0 flex-col rounded-lg border border-line bg-surface/60" aria-label={STAGE_META[col.stage].label}>
              <header className="border-b border-line px-3 py-2.5">
                <div className="flex items-baseline justify-between">
                  <h2 className="font-semibold">{STAGE_META[col.stage].label}</h2>
                  <span className="tabular text-[13px] text-muted">{col.items.length}</span>
                </div>
                <p className="tabular text-[13px] text-muted">{formatMoney(col.total)}</p>
              </header>
              <ul className="flex-1 space-y-2 p-2">
                {col.items.map((o) => (
                  <li key={o.id} className="rounded-md border border-line bg-surface p-3">
                    <Link href={`/contacts/${o.contactId}`} className="font-medium text-ink hover:text-accent hover:underline">
                      {o.contactName}
                    </Link>
                    <p className="text-[13px] text-muted">{o.company}</p>
                    <div className="mt-2 flex items-baseline justify-between text-[13px]">
                      <span className="tabular font-medium">{formatMoney(o.valueAmount, o.currency)}</span>
                      <span className="text-muted">{o.ownerName ?? "Unassigned"}</span>
                    </div>
                    <p className="mt-1 text-xs text-faint">
                      {SOURCE_LABEL[o.leadSource as LeadSource] ?? o.leadSource}, active {formatRelative(o.lastActivityAt)}
                    </p>
                    {col.stage === "lost" && o.lostReason && <p className="mt-1 text-xs text-bad">{o.lostReason}</p>}
                    {col.stage !== "lost" && col.stage !== "won" && o.nextAction && (
                      <p className="mt-1 text-xs text-muted">Next: {o.nextAction}</p>
                    )}
                  </li>
                ))}
                {col.items.length === 0 && <li className="px-1 py-4 text-center text-[13px] text-faint">No deals</li>}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
