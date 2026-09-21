"use client";

import { useState, useTransition } from "react";
import {
  cancelJobAction,
  cancelWorkflowAction,
  retryJobAction,
  setFailureModeAction,
  setOptOutAction,
  updateStepDelayAction,
  type ActionResult,
} from "@/app/actions/automations";
import type { FailureMode } from "@/server/integrations/messaging/mock-provider";

function Result({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  return <p role="status" className={`mt-1.5 text-[13px] ${result.ok ? "text-ok" : "text-bad"}`}>{result.message}</p>;
}

export function RetryJobButton({ jobId, contactId }: { jobId: string; contactId?: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => setResult(await retryJobAction(jobId, contactId)))}
        className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white disabled:opacity-60"
      >
        {pending ? "Retrying…" : "Retry now"}
      </button>
      <Result result={result} />
    </div>
  );
}

export function CancelJobButton({ jobId, contactId }: { jobId: string; contactId?: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => setResult(await cancelJobAction(jobId, "Cancelled from Automations page", contactId)))}
        className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium hover:bg-canvas disabled:opacity-60"
      >
        {pending ? "Cancelling…" : "Cancel"}
      </button>
      <Result result={result} />
    </div>
  );
}

export function CancelWorkflowButton({ runId, contactId, label = "Cancel workflow" }: { runId: string; contactId: string; label?: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => setResult(await cancelWorkflowAction(runId, "Cancelled manually", contactId)))}
        className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium hover:bg-canvas disabled:opacity-60"
      >
        {pending ? "Cancelling…" : label}
      </button>
      <Result result={result} />
    </div>
  );
}

export function OptOutToggle({ contactId, optedOut }: { contactId: string; optedOut: boolean }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [state, setState] = useState(optedOut);
  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await setOptOutAction(contactId, !state);
            if (r.ok) setState(!state);
            setResult(r);
          })
        }
        className={`rounded-md border px-3 py-1.5 text-[13px] font-medium disabled:opacity-60 ${
          state ? "border-line-strong bg-surface hover:bg-canvas" : "border-bad/40 bg-bad-soft text-bad hover:bg-bad-soft/70"
        }`}
      >
        {pending ? "Saving…" : state ? "Opted out — click to opt back in" : "Opt out of follow-ups"}
      </button>
      <Result result={result} />
    </div>
  );
}

const FAILURE_MODES: { value: FailureMode; label: string }[] = [
  { value: "off", label: "Off — every send succeeds" },
  { value: "transient", label: "Transient — 503, retried automatically" },
  { value: "permanent", label: "Permanent — 400, not retried" },
];

export function FailureModeSwitch({ current }: { current: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {FAILURE_MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            disabled={pending}
            onClick={() => start(async () => setResult(await setFailureModeAction(m.value)))}
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

export function StepDelayForm({ stepId, stepKey, delaySeconds }: { stepId: string; stepKey: string; delaySeconds: number }) {
  const [value, setValue] = useState(String(delaySeconds));
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(value);
        start(async () => setResult(await updateStepDelayAction(stepId, n)));
      }}
    >
      <label htmlFor={`delay-${stepId}`} className="w-28 shrink-0 text-[13px] font-medium">{stepKey.replace(/_/g, " ")}</label>
      <input
        id={`delay-${stepId}`}
        type="number"
        min={0}
        max={30 * 86_400}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-28 rounded-md border border-line-strong bg-surface px-2 py-1 text-[13px]"
      />
      <span className="text-[13px] text-muted">seconds</span>
      <button type="submit" disabled={pending} className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium hover:bg-canvas disabled:opacity-60">
        {pending ? "Saving…" : "Save"}
      </button>
      <Result result={result} />
    </form>
  );
}
