/**
 * CRM provider contract (HighLevel today, could be another CRM later).
 * Field names match what marketplace.gohighlevel.com/docs documents for
 * /contacts/upsert, /opportunities/, /opportunities/:id/status and
 * /opportunities/pipelines — see IMPLEMENTATION_LOG.md, Phase 5.
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

export interface CrmProvider {
  readonly name: string;
  upsertContact(input: CrmContactInput): Promise<CrmContactResult>;
  /** Creates the opportunity if `existingGhlOpportunityId` is absent, otherwise updates it in place. */
  upsertOpportunity(input: CrmOpportunityInput & { existingGhlOpportunityId?: string | null }): Promise<CrmOpportunityResult>;
  updateOpportunityStatus(input: { ghlOpportunityId: string; status: OpportunityStatus; lostReasonId?: string | null }): Promise<{ ok: true }>;
  getPipelines(locationId: string): Promise<CrmPipeline[]>;
}
