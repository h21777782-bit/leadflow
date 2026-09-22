"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { bulkRetryJobsAction, type ActionResult } from "@/app/actions/automations";
import { RetryJobButton } from "@/components/automations/controls";
import { StatusBadge } from "@/components/ui/badges";
import { Table, Td, Th } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";

export type FailedJobRow = {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string; // ISO — serialized for a client component
  contactId: string | null;
  contactName: string | null;
  attemptHistory: { id: string; attempt: number; outcome: string; error: string | null }[];
  retryable: boolean;
};

/** The whole interactive table lives in one client component so selection state (for bulk retry) is a single source of truth — no cross-component sync hacks. */
export function FailedJobsTable({ jobs, tz }: { jobs: FailedJobRow[]; tz: string }) {
  // listFailedJobs() only ever returns status "failed" or "retry_scheduled" — both are what retryJobNow accepts.
  const retryableIds = jobs.filter((j) => j.retryable).map((j) => j.id);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  const allSelected = retryableIds.length > 0 && retryableIds.every((id) => selected.has(id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(retryableIds));
  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = () => {
    setConfirming(false);
    start(async () => {
      const r = await bulkRetryJobsAction([...selected]);
      setResult(r);
      if (r.ok) setSelected(new Set());
    });
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-canvas/40 px-4 py-2.5 text-[13px]">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={retryableIds.length === 0} className="size-4 accent-accent" />
          Select all retryable ({retryableIds.length})
        </label>
        <span className="text-muted">{selected.size} selected</span>
        {!confirming ? (
          <button type="button" disabled={selected.size === 0 || pending} onClick={() => setConfirming(true)} className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white disabled:opacity-60">
            Retry selected
          </button>
        ) : (
          <span className="flex items-center gap-2">
            <span className="text-bad">Retry {selected.size} job(s) now?</span>
            <button type="button" disabled={pending} onClick={run} className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white disabled:opacity-60">
              {pending ? "Retrying…" : "Confirm"}
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="rounded-md border border-line-strong px-2.5 py-1 text-xs">Cancel</button>
          </span>
        )}
        {result && <span className={result.ok ? "text-ok" : "text-bad"}>{result.message}</span>}
      </div>

      <Table>
        <thead>
          <tr>
            <Th />
            <Th>Workflow step</Th>
            <Th>Lead</Th>
            <Th>First attempt</Th>
            <Th>Error</Th>
            <Th className="text-right">Retries</Th>
            <Th>Status</Th>
            <Th>Retry</Th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <Td>{j.retryable && <input type="checkbox" checked={selected.has(j.id)} onChange={() => toggle(j.id)} className="size-4 accent-accent" aria-label="Select this job" />}</Td>
              <Td className="whitespace-nowrap font-medium">{j.type}</Td>
              <Td>{j.contactId ? <Link href={`/contacts/${j.contactId}`} className="text-accent hover:underline">{j.contactName}</Link> : "—"}</Td>
              <Td className="tabular whitespace-nowrap text-[13px]">{formatDateTime(j.createdAt, tz)}</Td>
              <Td className="max-w-md text-[13px] text-bad">
                {j.lastError}
                {j.attemptHistory.length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-accent">Attempt history ({j.attemptHistory.length})</summary>
                    <ul className="mt-1 space-y-1 text-xs text-muted">
                      {j.attemptHistory.map((a) => (
                        <li key={a.id}>#{a.attempt} {a.outcome} — {a.error ?? "ok"}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </Td>
              <Td className="tabular text-right">{j.attempts} / {j.maxAttempts}</Td>
              <Td><StatusBadge status={j.status} /></Td>
              <Td>
                {j.retryable ? (
                  <RetryJobButton jobId={j.id} contactId={j.contactId ?? undefined} />
                ) : (
                  <p className="max-w-[14rem] text-[13px] text-muted">No worker handler exists for “{j.type}” jobs yet, so retrying cannot succeed.</p>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
