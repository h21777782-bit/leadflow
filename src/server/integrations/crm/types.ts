/**
 * CRM provider contract (HighLevel today, could be another CRM later).
 * Field names match what marketplace.gohighlevel.com/docs documents for
 * /contacts/upsert, /opportunities/, /opportunities/:id/status,
 * /opportunities/pipelines, /calendars/:id/free-slots and
 * /calendars/events/appointments — see IMPLEMENTATION_LOG.md, Phases 5 and 7.
 */
export type CrmContactInput = {
  locationId: string;
  firstName: string;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  companyName?: string | null;
  tags?: string[];
};

export type CrmContactResult = { ghlContactId: string; created: boolean };

export type OpportunityStatus = "open" | "won" | "lost" | "abandoned";

export type CrmOpportunityInput = {
  locationId: string;
  pipelineId: string;
  pipelineStageId?: string | null;
  contactId: string; // the HighLevel contact id (our stored ghl_contact_id)
  name: string;
  status: OpportunityStatus;
  monetaryValue?: number;
};

export type CrmOpportunityResult = { ghlOpportunityId: string };

export type CrmPipelineStage = { id: string; name: string };
export type CrmPipeline = { id: string; name: string; stages: CrmPipelineStage[] };

export type CrmAppointmentInput = {
  locationId: string;
  calendarId: string;
  contactId: string; // the HighLevel contact id
  title: string;
  startTime: string; // ISO 8601
  endTime: string; // ISO 8601
};
export type CrmAppointmentResult = { ghlAppointmentId: string };

export interface CrmProvider {
  readonly name: string;
  upsertContact(input: CrmContactInput): Promise<CrmContactResult>;
  /** Creates the opportunity if `existingGhlOpportunityId` is absent, otherwise updates it in place. */
  upsertOpportunity(input: CrmOpportunityInput & { existingGhlOpportunityId?: string | null }): Promise<CrmOpportunityResult>;
  updateOpportunityStatus(input: { ghlOpportunityId: string; status: OpportunityStatus; lostReasonId?: string | null }): Promise<{ ok: true }>;
  getPipelines(locationId: string): Promise<CrmPipeline[]>;
  /** Phase 7 — not used for slot generation (that's our own, DST-safe `src/lib/scheduling.ts`); only for creating the synced event. */
  createAppointment(input: CrmAppointmentInput): Promise<CrmAppointmentResult>;
}
