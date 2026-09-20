"use client";

import { useActionState, useState, useTransition } from "react";
import { logReplyAction, routeNowAction, type SimpleState } from "@/app/actions/lead-intelligence";

export function RouteNowButton({ contactId, label = "Route now" }: { contactId: string; label?: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<SimpleState | null>(null);
  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => setResult(await routeNowAction(contactId)))}
        className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-60"
      >
        {pending ? "Routing…" : label}
      </button>
      {result && <p role="status" className={`mt-2 text-[13px] ${result.error ? "text-bad" : result.ok ? "text-ok" : "text-muted"}`}>{result.error ?? result.message}</p>}
    </div>
  );
}

/**
 * Manually record that the lead replied. This is a real DB write (inbound message)
 * that feeds the engagement and response factors. In Phase 6 the same thing will
 * be recorded automatically by the email/SMS webhook.
 */
export function LogReplyForm({ contactId }: { contactId: string }) {
  const [state, action, pending] = useActionState<SimpleState, FormData>(logReplyAction.bind(null, contactId), {});
  return (
    <form action={action} className="space-y-2">
      <label htmlFor="reply-body" className="block text-[13px] font-medium">Log a reply from this lead</label>
      <div className="flex gap-2">
        <select name="channel" aria-label="Channel" className="rounded-md border border-line-strong bg-surface px-2 py-1.5 text-[13px]">
          <option value="email">Email</option>
          <option value="sms">SMS</option>
        </select>
        <input id="reply-body" name="body" placeholder="What did they say?" className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1.5" />
        <button type="submit" disabled={pending} className="rounded-md border border-line-strong bg-surface px-3 py-1.5 text-[13px] font-medium hover:bg-canvas disabled:opacity-60">
          {pending ? "Saving…" : "Log reply"}
        </button>
      </div>
      {(state.error || state.message) && <p role="status" className={`text-[13px] ${state.error ? "text-bad" : "text-ok"}`}>{state.error ?? state.message}</p>}
    </form>
  );
}
