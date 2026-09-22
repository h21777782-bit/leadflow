"use client";

import { useState, useTransition } from "react";
import { reprocessWebhookEventAction, type ActionResult } from "@/app/actions/webhooks";

export function ReprocessButton({ webhookEventId }: { webhookEventId: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => setResult(await reprocessWebhookEventAction(webhookEventId)))}
        className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white disabled:opacity-60"
      >
        {pending ? "Queuing…" : "Reprocess"}
      </button>
      {result && <p role="status" className={`mt-1.5 text-[13px] ${result.ok ? "text-ok" : "text-bad"}`}>{result.message}</p>}
    </div>
  );
}
