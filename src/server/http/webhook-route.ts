/**
 * Shared logic behind every /api/webhooks/* route. One function, six thin
 * route.ts files (see src/app/api/webhooks/*) each just calling it with their
 * own resource type.
 *
 *   1. Read the raw body (size-limited) — signatures are computed over raw
 *      bytes, so parsing JSON first would make verification impossible.
 *   2. Verify a signature BEFORE touching the database at all: X-GHL-Signature
 *      (Ed25519, HighLevel) if present, else X-LeadFlow-Signature/-Timestamp
 *      (HMAC-SHA256, our own website/n8n scheme). Reject with 401 otherwise —
 *      nothing unauthenticated is ever persisted, not even a "received" row.
 *   3. Parse and lightly validate JSON (400 on malformed/missing structure).
 *   4. Extract an idempotency key (eventId / webhookId / X-Idempotency-Key).
 *   5. "leads" calls ingestLeadEvent directly (it owns its own idempotent
 *      webhook_events handling); every other resource type goes through the
 *      generic receiveWebhook() + `webhook.process` job (acknowledge fast,
 *      202, and do the work in the background).
 */
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { getEnv } from "@/lib/env";
import { HIGHLEVEL_ED25519_PUBLIC_KEY_PEM, verifyGhlSignature, verifyHmacSignature } from "@/lib/webhook-signature";
import { ingestLeadEvent } from "@/server/services/intake";
import type { Actor } from "@/server/services/types";
import { receiveWebhook, type WebhookResourceType } from "@/server/services/webhooks";

export type WebhookRouteResourceType = WebhookResourceType | "leads";

const MAX_BODY_BYTES = 100_000; // 100 KB — generous for these payload shapes, small enough to bound abuse
const WEBHOOK_ACTOR: Actor = { type: "webhook", label: "inbound-webhook" };

async function readRawBody(req: NextRequest): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return { ok: false, status: 413, error: `Body too large (${declared} bytes, max ${MAX_BODY_BYTES})` };
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return { ok: false, status: 413, error: `Body too large (max ${MAX_BODY_BYTES} bytes)` };
  return { ok: true, text };
}

type SignatureOutcome = { ok: true; source: string } | { ok: false; status: number; error: string };

function verifySignature(req: NextRequest, rawBody: string): SignatureOutcome {
  const env = getEnv();
  const ghlSig = req.headers.get("x-ghl-signature");
  if (ghlSig !== null) {
    const publicKey = env.HIGHLEVEL_WEBHOOK_PUBLIC_KEY || HIGHLEVEL_ED25519_PUBLIC_KEY_PEM;
    const r = verifyGhlSignature(publicKey, rawBody, ghlSig);
    return r.valid ? { ok: true, source: "highlevel" } : { ok: false, status: 401, error: r.reason };
  }
  const hmacSig = req.headers.get("x-leadflow-signature");
  const timestamp = req.headers.get("x-leadflow-timestamp");
  if (hmacSig !== null || timestamp !== null) {
    const r = verifyHmacSignature(env.WEBHOOK_SIGNING_SECRET ?? "", rawBody, timestamp, hmacSig);
    return r.valid ? { ok: true, source: "webhook" } : { ok: false, status: 401, error: r.reason };
  }
  return { ok: false, status: 401, error: "Missing signature — send X-GHL-Signature, or X-LeadFlow-Signature + X-LeadFlow-Timestamp" };
}

export async function handleWebhookRequest(req: NextRequest, resourceType: WebhookRouteResourceType): Promise<NextResponse> {
  const body = await readRawBody(req);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status });

  const sig = verifySignature(req, body.text);
  if (!sig.ok) return NextResponse.json({ error: sig.error }, { status: sig.status });

  let json: unknown;
  try {
    json = body.text ? JSON.parse(body.text) : {};
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON" }, { status: 400 });
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 });
  }
  const payload = json as Record<string, unknown>;

  // Our own scheme lets the sender say which system it is (website vs n8n); HighLevel's signature already proves the source.
  const source = sig.source === "highlevel" ? "highlevel" : typeof payload.source === "string" && payload.source ? payload.source : "webhook";
  const eventId =
    (typeof payload.eventId === "string" && payload.eventId) ||
    (typeof payload.webhookId === "string" && payload.webhookId) ||
    req.headers.get("x-idempotency-key") ||
    null;
  if (!eventId) {
    return NextResponse.json({ error: "Missing an idempotency key: include \"eventId\" (or HighLevel's \"webhookId\") in the body, or an X-Idempotency-Key header" }, { status: 422 });
  }

  const db = getDb();

  if (resourceType === "leads") {
    const r = await ingestLeadEvent(db, WEBHOOK_ACTOR, { source, eventId, lead: payload });
    if (r.status === "rejected") return NextResponse.json({ error: r.detail, errors: r.errors }, { status: r.errors ? 400 : 422 });
    if (r.status === "duplicate_event") return NextResponse.json({ status: "duplicate", eventId: r.eventId, detail: r.detail, result: r.previous }, { status: 202 });
    return NextResponse.json({ status: "accepted", eventId: r.eventId, contactId: r.contactId, opportunityId: r.opportunityId, created: r.created, detail: r.detail }, { status: 202 });
  }

  const result = await receiveWebhook(db, { source, resourceType, externalEventId: eventId, payload, signatureValid: true });
  if (result.status === "duplicate") {
    return NextResponse.json({ status: "duplicate", eventId: result.eventId, webhookStatus: result.webhookStatus, result: result.result }, { status: 202 });
  }
  return NextResponse.json({ status: "accepted", eventId: result.eventId }, { status: 202 });
}
