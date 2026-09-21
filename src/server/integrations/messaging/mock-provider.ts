/**
 * MOCK messaging provider — SIMULATION ONLY. Nothing is sent anywhere.
 *
 * It records the "sent" message in our own messages table (done by the caller)
 * and returns a fake provider id. It also supports a DEMO-ONLY failure switch,
 * stored in app_settings so the separate worker process sees it:
 *   off        → every send succeeds
 *   transient  → throws a retryable error ("503 Service Unavailable — simulated")
 *   permanent  → throws a non-retryable error ("400 Invalid recipient — simulated")
 * The switch is refused unless MOCK_MODE=true.
 */
import { createHash } from "node:crypto";
import type { Database } from "@/db/client";
import { PermanentJobError, TransientJobError } from "@/lib/job-errors";
import { getSetting } from "@/server/services/app-settings";
import type { MessagingProvider, OutgoingMessage, SendResult } from "./types";

export const FAILURE_SWITCH_KEY = "demo.mock_messaging_failure_mode";
export type FailureMode = "off" | "transient" | "permanent";

export class MockMessagingProvider implements MessagingProvider {
  readonly name = "mock";
  constructor(private readonly db: Database) {}

  async send(msg: OutgoingMessage): Promise<SendResult> {
    const mode = await getSetting<FailureMode>(this.db, FAILURE_SWITCH_KEY, "off");
    if (mode === "transient") throw new TransientJobError("[SIMULATED] Mock provider: 503 Service Unavailable");
    if (mode === "permanent") throw new PermanentJobError("[SIMULATED] Mock provider: 400 Invalid recipient");
    // Deterministic id from the idempotency key: the same logical message always maps to the same id,
    // exactly how a real provider's idempotency key behaves.
    const id = createHash("sha256").update(msg.idempotencyKey).digest("hex").slice(0, 16);
    return { providerMessageId: `mock_${id}`, provider: this.name, simulated: true };
  }
}
