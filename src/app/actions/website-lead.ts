"use server";

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getEnv } from "@/lib/env";
import { signHmac } from "@/lib/webhook-signature";

/**
 * The public "company website" contact form has no admin session, so it can't
 * call a server/service function directly the way the internal /contacts/new
 * form does — that would skip the exact signature-verified path a real
 * external website actually goes through. Instead this signs the payload with
 * the same HMAC scheme scripts/webhook-send.ts uses and POSTs it to the real
 * /api/webhooks/leads route over HTTP, so the demo genuinely exercises
 * signature verification, idempotency, and duplicate detection — not a
 * shortcut that only looks like it does.
 *
 * Always redirects, even on failure — see the no-JS hang fix in
 * lead-intelligence.ts (Phase 8): a useActionState-style return-state-on-error
 * pattern isn't used here on purpose.
 */
export async function submitWebsiteLeadAction(fd: FormData): Promise<void> {
  const secret = getEnv().WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    redirect("/get-started?error=" + encodeURIComponent("WEBHOOK_SIGNING_SECRET is not configured — set it in .env.local to enable this form"));
  }

  const payload = {
    source: "website",
    eventId: randomUUID(),
    firstName: String(fd.get("firstName") ?? ""),
    lastName: String(fd.get("lastName") ?? ""),
    email: String(fd.get("email") ?? ""),
    phone: String(fd.get("phone") ?? ""),
    country: String(fd.get("country") ?? "") || undefined,
    company: String(fd.get("company") ?? ""),
    leadSource: "website_form",
    serviceInterest: String(fd.get("serviceInterest") ?? "") || undefined,
    budgetAmount: String(fd.get("budgetAmount") ?? "") || undefined,
    notes: String(fd.get("notes") ?? "") || undefined,
    tags: "website-live",
  };
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const signature = signHmac(secret, body, ts);

  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;

  const res = await fetch(`${origin}/api/webhooks/leads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-LeadFlow-Timestamp": String(ts),
      "X-LeadFlow-Signature": signature,
    },
    body,
  });
  const result = await res.json().catch(() => ({}));

  if (!res.ok) {
    const base = typeof result.error === "string" ? result.error : `Request failed (${res.status})`;
    const fieldErrors = result.errors && typeof result.errors === "object" ? Object.entries(result.errors as Record<string, string>) : [];
    const detail = fieldErrors.length ? `${base}: ${fieldErrors.map(([field, msg]) => `${field} — ${msg}`).join("; ")}` : base;
    redirect(`/get-started?error=${encodeURIComponent(detail)}`);
  }
  if (result.status === "duplicate") {
    // A literal replay of the same webhook event (identical eventId) — returns the original result.
    redirect(`/get-started?duplicate=1&contactId=${result.result?.contactId ?? ""}`);
  }
  if (result.created === false) {
    // The realistic case: same person, a *new* eventId — ingestLeadEvent recognized the email/phone
    // match and merged into the existing contact instead of creating a second one.
    redirect(`/get-started?duplicate=1&contactId=${result.contactId}`);
  }
  redirect(`/get-started?submitted=1&contactId=${result.contactId}&eventId=${payload.eventId}`);
}
