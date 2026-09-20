"use client";

import { useActionState, useState } from "react";
import { saveRuleAction, type SimpleState } from "@/app/actions/lead-intelligence";
import { LEAD_SOURCES, SERVICES, SERVICE_LABEL, SOURCE_LABEL } from "@/lib/pipeline";

export type RuleView = {
  id: string | null;
  name: string;
  priority: number;
  strategy: "assign_user" | "round_robin" | "least_loaded";
  isActive: boolean;
  services: string[];
  countries: string[];
  sources: string[];
  minBudget: number | null;
  requireServiceExpertise: boolean;
  targetUserIds: string[];
};

const STRATEGY_LABEL = { assign_user: "First available in list", round_robin: "Round robin", least_loaded: "Lowest workload" };

export function RuleEditor({ rule, reps, summary }: { rule: RuleView; reps: { id: string; name: string }[]; summary: string }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<SimpleState, FormData>(saveRuleAction.bind(null, rule.id), {});
  const e = state.errors ?? {};

  if (!open) {
    return (
      <div className="flex items-start justify-between gap-4">
        <div className="text-[13px]">{summary}</div>
        <div className="shrink-0 text-right">
          <button type="button" onClick={() => setOpen(true)} className="text-[13px] font-medium text-accent hover:underline">
            {rule.id ? "Edit" : "Add a routing rule"}
          </button>
          {state.message && <p className="mt-1 text-xs text-ok">{state.message}</p>}
        </div>
      </div>
    );
  }

  const box = "rounded-md border border-line-strong bg-surface px-2 py-1.5";
  return (
    <form action={action} className="grid gap-3 rounded-md bg-canvas p-4 sm:grid-cols-2" noValidate>
      <label className="text-[13px]">Name<input name="name" defaultValue={rule.name} className={`mt-1 w-full ${box}`} />{e.name && <span className="text-bad">{e.name}</span>}</label>
      <label className="text-[13px]">Priority (lower runs first)<input name="priority" type="number" defaultValue={rule.priority} className={`mt-1 w-full ${box}`} />{e.priority && <span className="text-bad">{e.priority}</span>}</label>
      <label className="text-[13px]">Strategy
        <select name="strategy" defaultValue={rule.strategy} className={`mt-1 w-full ${box}`}>
          {Object.entries(STRATEGY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label className="text-[13px]">Countries (2-letter, comma-separated; empty = any)
        <input name="countries" defaultValue={rule.countries.join(", ")} className={`mt-1 w-full ${box}`} />
        {e.countries && <span className="text-bad">{e.countries}</span>}
      </label>
      <fieldset className="text-[13px]"><legend>Services (none = any)</legend>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {SERVICES.map((s) => <label key={s} className="flex items-center gap-1"><input type="checkbox" name="services" value={s} defaultChecked={rule.services.includes(s)} className="accent-accent" />{SERVICE_LABEL[s]}</label>)}
        </div>
      </fieldset>
      <fieldset className="text-[13px]"><legend>Lead sources (none = any)</legend>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {LEAD_SOURCES.map((s) => <label key={s} className="flex items-center gap-1"><input type="checkbox" name="sources" value={s} defaultChecked={rule.sources.includes(s)} className="accent-accent" />{SOURCE_LABEL[s]}</label>)}
        </div>
      </fieldset>
      <label className="text-[13px]">Minimum budget (USD, optional)<input name="minBudget" inputMode="numeric" defaultValue={rule.minBudget ?? ""} className={`mt-1 w-full ${box}`} /></label>
      <fieldset className="text-[13px]"><legend>Assign to</legend>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {reps.map((r) => <label key={r.id} className="flex items-center gap-1"><input type="checkbox" name="targetUserIds" value={r.id} defaultChecked={rule.targetUserIds.includes(r.id)} className="accent-accent" />{r.name}</label>)}
        </div>
        {e.targetUserIds && <span className="text-bad">{e.targetUserIds}</span>}
      </fieldset>
      <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="requireServiceExpertise" defaultChecked={rule.requireServiceExpertise} className="size-4 accent-accent" />Only reps who sell the lead’s service</label>
      <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="isActive" defaultChecked={rule.isActive} className="size-4 accent-accent" />Rule is active</label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className="rounded-md bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-60">{pending ? "Saving…" : "Save rule"}</button>
        <button type="button" onClick={() => setOpen(false)} className="text-muted hover:text-ink">Close</button>
        {(state.error || state.message) && <span role="status" className={`text-[13px] ${state.error ? "text-bad" : "text-ok"}`}>{state.error ?? state.message}</span>}
      </div>
    </form>
  );
}
