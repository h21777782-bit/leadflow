"use client";

import { useState, useTransition } from "react";
import { cancelAppointmentAction, confirmAppointmentAction, markCompletedAction, markNoShowAction, rescheduleAppointmentAction } from "@/app/actions/appointments";

type Props = { appointmentId: string; contactId: string; status: string; startsAt: string; endsAt: string };

export function AppointmentRowActions({ appointmentId, contactId, status, startsAt, endsAt }: Props) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [rescheduling, setRescheduling] = useState(false);
  const [newStart, setNewStart] = useState(startsAt.slice(0, 16));

  if (status === "cancelled" || status === "completed" || status === "no_show") {
    return message ? <p className={`text-xs ${message.ok ? "text-ok" : "text-bad"}`}>{message.text}</p> : null;
  }

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => setMessage(await fn().then((r) => ({ ok: r.ok, text: r.message }))));

  if (rescheduling) {
    const durationMs = new Date(endsAt).getTime() - new Date(startsAt).getTime();
    return (
      <div className="space-y-1">
        <input type="datetime-local" value={newStart} onChange={(e) => setNewStart(e.target.value)} className="rounded-md border border-line-strong px-1.5 py-1 text-xs" />
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              const s = new Date(newStart);
              const e = new Date(s.getTime() + durationMs);
              run(() => rescheduleAppointmentAction(appointmentId, s.toISOString(), e.toISOString(), contactId));
              setRescheduling(false);
            }}
            className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white disabled:opacity-60"
          >
            Confirm
          </button>
          <button type="button" onClick={() => setRescheduling(false)} className="rounded-md border border-line-strong px-2 py-1 text-xs">Cancel</button>
        </div>
        {message && <p className={`text-xs ${message.ok ? "text-ok" : "text-bad"}`}>{message.text}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap gap-1.5">
        {status === "scheduled" && (
          <button type="button" disabled={pending} onClick={() => run(() => confirmAppointmentAction(appointmentId, contactId))} className="rounded-md border border-line-strong px-2 py-1 text-xs hover:bg-canvas disabled:opacity-60">
            Confirm
          </button>
        )}
        <button type="button" disabled={pending} onClick={() => setRescheduling(true)} className="rounded-md border border-line-strong px-2 py-1 text-xs hover:bg-canvas disabled:opacity-60">
          Reschedule
        </button>
        <button type="button" disabled={pending} onClick={() => run(() => markCompletedAction(appointmentId, contactId))} className="rounded-md border border-line-strong px-2 py-1 text-xs hover:bg-canvas disabled:opacity-60">
          Completed
        </button>
        <button type="button" disabled={pending} onClick={() => run(() => markNoShowAction(appointmentId, contactId))} className="rounded-md border border-line-strong px-2 py-1 text-xs hover:bg-canvas disabled:opacity-60">
          No-show
        </button>
        <button type="button" disabled={pending} onClick={() => run(() => cancelAppointmentAction(appointmentId, "Cancelled from Appointments page", contactId))} className="rounded-md border border-bad/40 px-2 py-1 text-xs text-bad hover:bg-bad-soft disabled:opacity-60">
          Cancel
        </button>
      </div>
      {message && <p className={`text-xs ${message.ok ? "text-ok" : "text-bad"}`}>{message.text}</p>}
    </div>
  );
}
