"use client";

import { useState, useTransition } from "react";
import { updateWorkingHoursAction } from "@/app/actions/appointments";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function WorkingHoursEditor({ rep }: { rep: { id: string; workingHoursStart: string; workingHoursEnd: string; workingDays: number[] } }) {
  const [start, setStart] = useState(rep.workingHoursStart);
  const [end, setEnd] = useState(rep.workingHoursEnd);
  const [days, setDays] = useState<number[]>(rep.workingDays);
  const [pending, start_] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const toggleDay = (d: number) => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));

  return (
    <form
      className="flex flex-wrap items-center gap-2 text-[13px]"
      onSubmit={(e) => {
        e.preventDefault();
        start_(async () => setResult(await updateWorkingHoursAction(rep.id, start, end, days)));
      }}
    >
      <input type="time" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Working hours start" className="rounded-md border border-line-strong px-1.5 py-1" />
      <span className="text-muted">–</span>
      <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="Working hours end" className="rounded-md border border-line-strong px-1.5 py-1" />
      <div className="flex gap-1">
        {DAY_LABELS.map((label, i) => (
          <button
            key={i}
            type="button"
            onClick={() => toggleDay(i)}
            aria-pressed={days.includes(i)}
            className={`rounded px-1.5 py-0.5 text-xs font-medium ${days.includes(i) ? "bg-accent-soft text-accent" : "bg-canvas text-faint"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <button type="submit" disabled={pending} className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium hover:bg-canvas disabled:opacity-60">
        {pending ? "Saving…" : "Save hours"}
      </button>
      {result && <span className={result.ok ? "text-ok" : "text-bad"}>{result.ok ? "✓" : result.message}</span>}
    </form>
  );
}
