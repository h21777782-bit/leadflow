/**
 * Shared HTTP client for the real HighLevel API. Handles auth headers, a
 * request timeout, 429/Retry-After, transient-vs-permanent classification,
 * and logs every call to `integration_calls` — headers (which hold the
 * bearer token) are never included in what's logged, only status/timing/error text.
 */
import type { Database } from "@/db/client";
import { integrationCalls } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { kindForHttpStatus, PermanentJobError, TransientJobError } from "@/lib/job-errors";

export type CallContext = { operation: string; jobId?: string | null; attempt?: number };

/** Exported so the mock provider can log its simulated calls the same way — no headers/tokens ever pass through here. */
export async function logIntegrationCall(
  db: Database,
  ctx: CallContext,
  result: { statusCode?: number; success: boolean; durationMs: number; error?: string },
) {
  await db.insert(integrationCalls).values({
    provider: "highlevel",
    operation: ctx.operation,
    statusCode: result.statusCode ?? null,
    success: result.success,
    durationMs: result.durationMs,
    attempt: ctx.attempt ?? 1,
    error: result.error ?? null,
    jobId: ctx.jobId ?? null,
  });
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text || null;
  }
}

function errorMessage(operation: string, status: number, body: unknown): string {
  if (body && typeof body === "object" && "message" in body) {
    const m = (body as Record<string, unknown>).message;
    if (typeof m === "string") return `HighLevel ${operation}: ${m}`;
  }
  return `HighLevel ${operation}: HTTP ${status}`;
}

export async function highLevelRequest<T>(
  db: Database,
  ctx: CallContext,
  init: { method: "GET" | "POST" | "PUT"; path: string; query?: Record<string, string | undefined>; body?: unknown },
): Promise<T> {
  const env = getEnv();
  if (!env.HIGHLEVEL_PRIVATE_TOKEN || !env.HIGHLEVEL_LOCATION_ID) {
    throw new PermanentJobError("HighLevel is not configured (HIGHLEVEL_PRIVATE_TOKEN / HIGHLEVEL_LOCATION_ID missing) — nothing was sent");
  }

  const url = new URL(init.path, env.HIGHLEVEL_API_BASE_URL);
  for (const [k, v] of Object.entries(init.query ?? {})) if (v != null) url.searchParams.set(k, v);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.HIGHLEVEL_HTTP_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${env.HIGHLEVEL_PRIVATE_TOKEN}`,
        Version: env.HIGHLEVEL_API_VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;
    const text = await res.text();
    const json = text ? safeJsonParse(text) : null;

    if (!res.ok) {
      const message = errorMessage(ctx.operation, res.status, json);
      await logIntegrationCall(db, ctx, { statusCode: res.status, success: false, durationMs, error: message });
      const retryAfterMs = parseRetryAfterMs(res.headers.get("Retry-After"));
      if (kindForHttpStatus(res.status) === "transient") throw new TransientJobError(message, retryAfterMs);
      throw new PermanentJobError(message);
    }
    await logIntegrationCall(db, ctx, { statusCode: res.status, success: true, durationMs });
    return json as T;
  } catch (err) {
    if (err instanceof TransientJobError || err instanceof PermanentJobError) throw err; // already logged above
    const durationMs = Date.now() - startedAt;
    const aborted = err instanceof Error && err.name === "AbortError";
    const message = aborted
      ? `HighLevel ${ctx.operation}: request timed out after ${env.HIGHLEVEL_HTTP_TIMEOUT_MS}ms`
      : `HighLevel ${ctx.operation}: ${err instanceof Error ? err.message : String(err)}`;
    await logIntegrationCall(db, ctx, { success: false, durationMs, error: message });
    throw new TransientJobError(message); // network errors and timeouts are always worth retrying
  } finally {
    clearTimeout(timer);
  }
}
