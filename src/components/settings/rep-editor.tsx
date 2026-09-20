"use client";

import { useActionState } from "react";
import { updateRepAction, type SimpleState } from "@/app/actions/lead-intelligence";

/** Availability / active / capacity for one rep. Saving re-routes affected leads (real engine). */
export function RepEditor({ rep }: { rep: { id: string; name: string; isAvailable: boolean; isActive: boolean; maxOpenLeads: number; openLeads: number } }) {
  const [state, action, pending] = useActionState<SimpleState, FormData>(updateRepAction.bind(null, rep.id), {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <label className="flex items-center gap-1.5 text-[13px]">
        <input type="checkbox" name="isAvailable" defaultChecked={rep.isAvailable} className="size-4 accent-accent" /> Available
      </label>
      <label className="flex items-center gap-1.5 text-[13px]">
        <input type="checkbox" name="isActive" defaultChecked={rep.isActive} className="size-4 accent-accent" /> Active
      </label>
      <label className="flex items-center gap-1.5 text-[13px]">
        Capacity
        <input name="maxOpenLeads" type="number" min={0} max={500} defaultValue={rep.maxOpenLeads} aria-label={`${rep.name} capacity`} className="w-16 rounded-md border border-line-strong px-1.5 py-1" />
      </label>
      <button type="submit" disabled={pending} className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[13px] font-medium hover:bg-canvas disabled:opacity-60">
        {pending ? "Saving…" : "Save"}
      </button>
      {(state.error || state.message) && <p role="status" className={`w-full text-xs ${state.error ? "text-bad" : "text-ok"}`}>{state.error ?? state.message}</p>}
    </form>
  );
}
