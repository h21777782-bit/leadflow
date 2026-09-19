"use client";

import { useActionState, useState } from "react";
import { createOpportunityAction, type OpportunityFormState } from "@/app/actions/opportunities";

export function NewOpportunityForm({ contactId, defaultTitle }: { contactId: string; defaultTitle: string }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<OpportunityFormState, FormData>(createOpportunityAction.bind(null, contactId), {});

  if (!open) {
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)} className="text-[13px] font-medium text-accent hover:underline">
          Add another opportunity
        </button>
        {state.ok && <p className="mt-1 text-[13px] text-ok">{state.message}</p>}
      </div>
    );
  }
  return (
    <form action={action} className="space-y-2 rounded-md bg-canvas p-3" noValidate>
      <label className="block text-[13px] font-medium" htmlFor="opp-title">Title</label>
      <input id="opp-title" name="title" defaultValue={defaultTitle} className="w-full rounded-md border border-line-strong bg-surface px-2 py-1.5" />
      {state.errors?.title && <p className="text-[13px] text-bad">{state.errors.title}</p>}
      <label className="block text-[13px] font-medium" htmlFor="opp-value">Value (USD)</label>
      <input id="opp-value" name="valueAmount" inputMode="numeric" defaultValue="0" className="w-full rounded-md border border-line-strong bg-surface px-2 py-1.5" />
      {state.errors?.valueAmount && <p className="text-[13px] text-bad">{state.errors.valueAmount}</p>}
      {state.message && !state.ok && <p className="text-[13px] text-bad">{state.message}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="rounded-md bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-60">
          {pending ? "Creating…" : "Create opportunity"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="px-2 text-muted hover:text-ink">Close</button>
      </div>
      {state.ok && <p className="text-[13px] text-ok">{state.message}</p>}
    </form>
  );
}
