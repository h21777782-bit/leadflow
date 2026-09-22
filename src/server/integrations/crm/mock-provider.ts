/**
 * MOCK CRM provider — SIMULATION ONLY. Nothing is sent to HighLevel or anywhere else.
 *
 * Supports a DEMO-ONLY fault injection switch, stored in app_settings so the
 * separate worker process sees it (same pattern as the messaging mock provider):
 *   off        → every call succeeds
 *   429        → simulated rate limit, with a Retry-After-style delay attached
 *   503        → simulated outage (transient)
 *   timeout    → simulated request timeout (transient)
 *   401        → simulated bad/expired token (permanent — retrying can't fix credentials)
 * Refused unless MOCK_MODE=true (enforced by getCrmProvider()).
 *
 * Every simulated call is still logged to `integration_calls` via the same
 * logIntegrationCall() the real provider uses, so the Integrations page shows
 * activity in the default (mock) demo state, not only when MOCK_MODE=false.
 */
import { createHash } from "node:crypto";
import type { Database } from "@/db/client";
import { PermanentJobError, TransientJobError } from "@/lib/job-errors";
import { getSetting } from "@/server/services/app-settings";
import { logIntegrationCall, type CallContext } from "./http-client";
import type { CrmAppointmentInput, CrmAppointmentResult, CrmContactInput, CrmContactResult, CrmOpportunityInput, CrmOpportunityResult, CrmPipeline, CrmProvider } from "./types";

export const CRM_FAILURE_SWITCH_KEY = "demo.mock_crm_failure_mode";
export type CrmFailureMode = "off" | "429" | "503" | "timeout" | "401";

function hashId(prefix: string, key: string): string {
  return `${prefix}_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

const FAILURE_STATUS: Record<Exclude<CrmFailureMode, "off" | "timeout">, number> = { "429": 429, "503": 503, "401": 401 };

export class MockCrmProvider implements CrmProvider {
  readonly name = "mock";
  constructor(
    private readonly db: Database,
    private readonly ctx: (operation: string) => CallContext = (operation) => ({ operation }),
  ) {}

  private async run<T>(operation: string, produce: () => T): Promise<T> {
    const ctx = this.ctx(operation);
    const startedAt = Date.now();
    const mode = await getSetting<CrmFailureMode>(this.db, CRM_FAILURE_SWITCH_KEY, "off");
    const durationMs = () => Date.now() - startedAt;

    if (mode === "off") {
      const result = produce();
      await logIntegrationCall(this.db, ctx, { statusCode: 200, success: true, durationMs: durationMs() });
      return result;
    }
    if (mode === "timeout") {
      const message = `[SIMULATED] HighLevel ${operation}: request timed out`;
      await logIntegrationCall(this.db, ctx, { success: false, durationMs: durationMs(), error: message });
      throw new TransientJobError(message);
    }
    const status = FAILURE_STATUS[mode];
    const message = `[SIMULATED] HighLevel ${operation}: ${status} ${status === 429 ? "Too Many Requests" : status === 503 ? "Service Unavailable" : "Unauthorized"}`;
    await logIntegrationCall(this.db, ctx, { statusCode: status, success: false, durationMs: durationMs(), error: message });
    if (status === 401) throw new PermanentJobError(message);
    if (status === 429) throw new TransientJobError(message, 5_000);
    throw new TransientJobError(message);
  }

  async upsertContact(input: CrmContactInput): Promise<CrmContactResult> {
    const key = input.email ?? input.phone ?? `${input.locationId}:${input.firstName}:${input.lastName ?? ""}`;
    return this.run("contacts.upsert", () => ({ ghlContactId: hashId("mock_contact", key), created: true }));
  }

  async upsertOpportunity(input: CrmOpportunityInput & { existingGhlOpportunityId?: string | null }): Promise<CrmOpportunityResult> {
    return this.run(input.existingGhlOpportunityId ? "opportunities.update" : "opportunities.create", () => ({
      ghlOpportunityId: input.existingGhlOpportunityId ?? hashId("mock_opp", `${input.contactId}:${input.name}`),
    }));
  }

  async updateOpportunityStatus(): Promise<{ ok: true }> {
    return this.run("opportunities.update_status", () => ({ ok: true as const }));
  }

  async getPipelines(locationId: string): Promise<CrmPipeline[]> {
    return this.run("opportunities.get_pipelines", () => [
      {
        id: hashId("mock_pipeline", locationId),
        name: "Mock Sales Pipeline",
        stages: [
          { id: "mock_stage_new", name: "New" },
          { id: "mock_stage_contacted", name: "Contacted" },
          { id: "mock_stage_qualified", name: "Qualified" },
          { id: "mock_stage_won", name: "Won" },
          { id: "mock_stage_lost", name: "Lost" },
        ],
      },
    ]);
  }

  async createAppointment(input: CrmAppointmentInput): Promise<CrmAppointmentResult> {
    return this.run("calendars.create_appointment", () => ({ ghlAppointmentId: hashId("mock_appt", `${input.contactId}:${input.startTime}`) }));
  }
}
