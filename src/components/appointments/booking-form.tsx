"use client";

import { useMemo, useState, useTransition } from "react";
import { bookAppointmentAction, getAvailableSlotsAction } from "@/app/actions/appointments";
import { formatDateTime } from "@/lib/format";

type Rep = { id: string; name: string; timezone: string; isAvailable: boolean };
type ContactOption = { id: string; name: string; timezone: string | null; ownerId: string | null };
type Slot = { startsAt: string; endsAt: string };

const DURATIONS = [15, 30, 45, 60];

export function BookingForm({ reps, contacts }: { reps: Rep[]; contacts: ContactOption[] }) {
  const [ownerId, setOwnerId] = useState(reps[0]?.id ?? "");
  const [contactId, setContactId] = useState("");
  const [duration, setDuration] = useState(30);
  const [days, setDays] = useState(7);
  const [title, setTitle] = useState("Discovery call");
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [chosen, setChosen] = useState<Slot | null>(null);
  const [searching, startSearch] = useTransition();
  const [booking, startBook] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const rep = reps.find((r) => r.id === ownerId);
  const contact = contacts.find((c) => c.id === contactId);
  const leadTz = contact?.timezone || "UTC";

  const groupedSlots = useMemo(() => {
    if (!slots) return [];
    const groups = new Map<string, Slot[]>();
    for (const s of slots) {
      const day = new Date(s.startsAt).toISOString().slice(0, 10);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day)!.push(s);
    }
    return [...groups.entries()];
  }, [slots]);

  const findSlots = () => {
    if (!ownerId) return;
    setChosen(null);
    setMessage(null);
    startSearch(async () => {
      const rangeStart = new Date();
      const rangeEnd = new Date(Date.now() + days * 86_400_000);
      const r = await getAvailableSlotsAction({ ownerId, rangeStart: rangeStart.toISOString(), rangeEnd: rangeEnd.toISOString(), durationMinutes: duration });
      if (!r.ok) {
        setMessage({ ok: false, text: r.message });
        setSlots([]);
      } else {
        setSlots(r.slots);
      }
    });
  };

  const book = () => {
    if (!chosen || !contactId || !ownerId) return;
    startBook(async () => {
      const r = await bookAppointmentAction({ contactId, ownerId, title, startsAt: chosen.startsAt, endsAt: chosen.endsAt, timezone: leadTz });
      setMessage({ ok: r.ok, text: r.message });
      if (r.ok) {
        setSlots(null);
        setChosen(null);
      }
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-[13px]">
          <span className="mb-1 block font-medium">Contact</span>
          <select value={contactId} onChange={(e) => setContactId(e.target.value)} className="w-full rounded-md border border-line-strong bg-surface px-2 py-1.5">
            <option value="">Choose…</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="text-[13px]">
          <span className="mb-1 block font-medium">Rep</span>
          <select value={ownerId} onChange={(e) => { setOwnerId(e.target.value); setSlots(null); }} className="w-full rounded-md border border-line-strong bg-surface px-2 py-1.5">
            {reps.map((r) => <option key={r.id} value={r.id}>{r.name}{r.isAvailable ? "" : " (unavailable)"}</option>)}
          </select>
        </label>
        <label className="text-[13px]">
          <span className="mb-1 block font-medium">Duration</span>
          <select value={duration} onChange={(e) => { setDuration(Number(e.target.value)); setSlots(null); }} className="w-full rounded-md border border-line-strong bg-surface px-2 py-1.5">
            {DURATIONS.map((d) => <option key={d} value={d}>{d} min</option>)}
          </select>
        </label>
        <label className="text-[13px]">
          <span className="mb-1 block font-medium">Search window</span>
          <select value={days} onChange={(e) => { setDays(Number(e.target.value)); setSlots(null); }} className="w-full rounded-md border border-line-strong bg-surface px-2 py-1.5">
            <option value={3}>Next 3 days</option>
            <option value={7}>Next 7 days</option>
            <option value={14}>Next 14 days</option>
            <option value={31}>Next 31 days (max)</option>
          </select>
        </label>
      </div>

      <button type="button" onClick={findSlots} disabled={searching || !ownerId} className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-60">
        {searching ? "Finding slots…" : "Find available slots"}
      </button>

      {slots && slots.length === 0 && <p className="text-[13px] text-muted">No available slots in this window — try a wider search window or a different rep.</p>}

      {groupedSlots.length > 0 && (
        <div className="space-y-3">
          {rep && <p className="text-[13px] text-muted">Times shown: <strong>rep&apos;s time ({rep.timezone})</strong> — lead&apos;s time ({leadTz}) shown once a contact is picked.</p>}
          {groupedSlots.map(([day, daySlots]) => (
            <div key={day}>
              <p className="mb-1 text-[13px] font-medium">{day}</p>
              <div className="flex flex-wrap gap-1.5">
                {daySlots.map((s) => (
                  <button
                    key={s.startsAt}
                    type="button"
                    onClick={() => setChosen(s)}
                    className={`rounded-md border px-2 py-1 text-xs ${chosen?.startsAt === s.startsAt ? "border-accent bg-accent-soft text-accent" : "border-line-strong bg-surface hover:bg-canvas"}`}
                  >
                    {rep ? formatDateTime(s.startsAt, rep.timezone, { hour: "2-digit", minute: "2-digit" }) : s.startsAt}
                    {contact && <span className="ml-1 text-faint">({formatDateTime(s.startsAt, leadTz, { hour: "2-digit", minute: "2-digit" })} lead)</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {chosen && (
        <div className="rounded-md border border-line-strong bg-canvas p-3">
          <p className="mb-2 text-[13px] font-medium">
            Booking {rep?.name} with {contact?.name || "(choose a contact)"} — {formatDateTime(chosen.startsAt, rep?.timezone ?? "UTC")} ({rep?.timezone})
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1.5 text-[13px]" />
            <button type="button" onClick={book} disabled={booking || !contactId} className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-60">
              {booking ? "Booking…" : "Book appointment"}
            </button>
          </div>
        </div>
      )}

      {message && <p role="status" className={`text-[13px] ${message.ok ? "text-ok" : "text-bad"}`}>{message.text}</p>}
    </div>
  );
}
