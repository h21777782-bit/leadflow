"use client";

import { useState, useTransition } from "react";
import { setCrmFailureModeAction, testConnectionAction, updateStageMappingAction, type ActionResult } from "@/app/actions/integrations";
import type { CrmFailureMode } from "@/server/integrations/crm";

function Result({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  return <p role="status" className={`mt-1.5 text-[13px] ${result.ok ? "text-ok" : "text-bad"}`}>{result.message}</p>;
}

export function TestConnectionButton() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => setResult(await testConnectionAction()))}
        className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-60"
      >
        {pending ? "Testing…" : "Test connection"}
      </button>
      <Result result={result} />
    </div>
  );
}

const CRM_FAILURE_MODES: { value: CrmFailureMode; label: string }[] = [
  { value: "off", label: "Off — every call succeeds" },
  { value: "429", label: "429 — rate limited (retried)" },
  { value: "503", label: "503 — outage (retried)" },
  { value: "timeout", label: "Timeout (retried)" },
  { value: "401", label: "401 — bad token (not retried)" },
];

export function CrmFailureModeSwitch({ current }: { current: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {CRM_FAILURE_MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            disabled={pending}
            onClick={() => start(async () => setResult(await setCrmFailureModeAction(m.value)))}
            className={`rounded-md border px-2.5 py-1.5 text-[13px] font-medium disabled:opacity-60 ${
              current === m.value ? "border-accent bg-accent-soft text-accent" : "border-line-strong bg-surface hover:bg-canvas"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <Result result={result} />
    </div>
  );
}

export function StageMappingForm({ stageKey, label, ghlStageId }: { stageKey: string; label: string; ghlStageId: string | null }) {
  const [value, setValue] = useState(ghlStageId ?? "");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => setResult(await updateStageMappingAction(stageKey, value)));
      }}
    >
      <label htmlFor={`stage-map-${stageKey}`} className="w-40 shrink-0 text-[13px] font-medium">{label}</label>
      <input
        id={`stage-map-${stageKey}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="HighLevel stage id"
        className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-[13px]"
      />
      <button type="submit" disabled={pending} className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium hover:bg-canvas disabled:opacity-60">
        {pending ? "Saving…" : "Save"}
      </button>
      {result && <span className={`text-[13px] ${result.ok ? "text-ok" : "text-bad"}`}>{result.ok ? "✓" : result.message}</span>}
    </form>
  );
}
