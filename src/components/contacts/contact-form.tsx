"use client";

import Link from "next/link";
import { useActionState, useState, useTransition, type ReactNode } from "react";
import { mergeContactAction, type ContactFormState } from "@/app/actions/contacts";
import { LEAD_SOURCES, SERVICES, SERVICE_LABEL, SOURCE_LABEL } from "@/lib/pipeline";

type Option = { id: string; name: string; isAvailable: boolean };

type Props = {
  mode: "create" | "edit";
  action: (prev: ContactFormState, fd: FormData) => Promise<ContactFormState>;
  initial?: Record<string, string>;
  owners: Option[];
  cancelHref: string;
};

const input =
  "w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 aria-[invalid=true]:border-bad";

function Field({ label, name, error, hint, children }: { label: string; name: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-[13px] font-medium">{label}</label>
      {children}
      {error ? (
        <p id={`${name}-error`} className="mt-1 text-[13px] text-bad">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-faint">{hint}</p>
      ) : null}
    </div>
  );
}

export function ContactForm({ mode, action, initial = {}, owners, cancelHref }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  const [merging, startMerge] = useTransition();
  const [mergeState, setMergeState] = useState<ContactFormState | null>(null);

  // After a failed submit the server echoes the typed values back; otherwise use the initial record.
  const v = state.values ?? initial;
  const errors = mergeState?.errors ?? state.errors ?? {};
  const duplicates = mergeState?.duplicates ?? state.duplicates;
  const message = mergeState?.message ?? state.message;

  const text = (name: string, label: string, extra: Record<string, unknown> = {}, hint?: string) => (
    <Field label={label} name={name} error={errors[name]} hint={hint}>
      <input
        id={name}
        name={name}
        defaultValue={v[name] ?? ""}
        aria-invalid={Boolean(errors[name])}
        aria-describedby={errors[name] ? `${name}-error` : undefined}
        className={input}
        {...extra}
      />
    </Field>
  );

  return (
    // key forces inputs to pick up echoed values after a failed submit
    <form action={formAction} key={JSON.stringify(state.values ?? null)} className="space-y-6" noValidate>
      {duplicates && duplicates.length > 0 && (
        <div role="alert" className="rounded-lg border border-warm/40 bg-warm-soft p-4">
          <p className="font-medium text-ink">{message}</p>
          <ul className="mt-2 space-y-2">
            {duplicates.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface px-3 py-2">
                <div>
                  <Link href={`/contacts/${d.id}`} className="font-medium text-accent hover:underline">{d.name}</Link>
                  <span className="text-[13px] text-muted"> {d.company ? `at ${d.company}, ` : ""}matched on {d.matchedOn.join(" and ")}</span>
                </div>
                {mode === "create" && duplicates.length === 1 && (
                  <button
                    type="button"
                    disabled={merging}
                    onClick={() =>
                      startMerge(async () => {
                        const values = state.values ?? {};
                        setMergeState(await mergeContactAction(d.id, values));
                      })
                    }
                    className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[13px] font-medium hover:bg-canvas disabled:opacity-60"
                  >
                    {merging ? "Updating…" : "Update this contact instead"}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {mode === "create" && duplicates.length === 1 && (
            <p className="mt-2 text-xs text-muted">
              Updating fills in the new details, adds new tags and appends notes. Existing values are never erased.
            </p>
          )}
        </div>
      )}
      {!duplicates?.length && message && <p role="alert" className="rounded-md bg-bad-soft px-3 py-2 text-bad">{message}</p>}

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 font-semibold">Person</legend>
        {text("firstName", "First name", { required: true, autoComplete: "off" })}
        {text("lastName", "Last name")}
        {text("email", "Email", { type: "email" }, "Email or phone is required. Used for duplicate detection.")}
        {text("phone", "Phone", { type: "tel" }, "Local format is fine if the country is set.")}
        {text("company", "Company")}
        {text("country", "Country code", { maxLength: 2, placeholder: "IN" })}
        {text("timezone", "Timezone", { placeholder: "Asia/Kolkata" }, "IANA name, e.g. Europe/London")}
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 font-semibold">Lead</legend>
        <Field label="Lead source" name="leadSource" error={errors.leadSource}>
          <select id="leadSource" name="leadSource" defaultValue={v.leadSource ?? ""} aria-invalid={Boolean(errors.leadSource)} className={input}>
            <option value="" disabled>Choose…</option>
            {LEAD_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
          </select>
        </Field>
        <Field label="Service interested in" name="serviceInterest" error={errors.serviceInterest}>
          <select id="serviceInterest" name="serviceInterest" defaultValue={v.serviceInterest ?? ""} className={input}>
            <option value="">Not specified</option>
            {SERVICES.map((s) => <option key={s} value={s}>{SERVICE_LABEL[s]}</option>)}
          </select>
        </Field>
        {text("budgetAmount", "Budget (USD)", { inputMode: "numeric" })}
        <Field label="Owner" name="ownerId" error={errors.ownerId} hint={mode === "create" ? "Leave empty for now — automatic routing arrives in Phase 3." : "Changing the owner is logged as a manual override."}>
          <select id="ownerId" name="ownerId" defaultValue={v.ownerId ?? ""} className={input}>
            <option value="">Unassigned</option>
            {owners.map((o) => <option key={o.id} value={o.id}>{o.name}{o.isAvailable ? "" : " (unavailable)"}</option>)}
          </select>
        </Field>
        {text("tags", "Tags", {}, "Comma-separated")}
        <Field label="Custom fields" name="customFields" error={errors.customFields} hint="One per line, e.g. clinics: 2">
          <textarea id="customFields" name="customFields" rows={3} defaultValue={v.customFields ?? ""} className={input} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Notes" name="notes" error={errors.notes}>
            <textarea id="notes" name="notes" rows={3} defaultValue={v.notes ?? ""} className={input} />
          </Field>
        </div>
        {mode === "create" && (
          <label className="flex items-center gap-2 sm:col-span-2">
            <input type="checkbox" name="createOpportunity" defaultChecked className="size-4 accent-accent" />
            <span>Also create an opportunity in New lead (value = budget)</span>
          </label>
        )}
      </fieldset>

      <div className="flex items-center gap-3 border-t border-line pt-4">
        <button type="submit" disabled={pending} className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent/90 disabled:opacity-60">
          {pending ? "Saving…" : mode === "create" ? "Create contact" : "Save changes"}
        </button>
        <Link href={cancelHref} className="text-muted hover:text-ink">Cancel</Link>
      </div>
    </form>
  );
}
