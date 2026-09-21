/**
 * Real HighLevel API v2 provider. Endpoints and field names are exactly what
 * marketplace.gohighlevel.com/docs documents — see IMPLEMENTATION_LOG.md,
 * Phase 5, for each URL and the date checked. No endpoint here was guessed.
 */
import type { Database } from "@/db/client";
import { highLevelRequest, type CallContext } from "./http-client";
import type { CrmContactInput, CrmContactResult, CrmOpportunityInput, CrmOpportunityResult, CrmPipeline, CrmProvider, OpportunityStatus } from "./types";

type UpsertContactResponse = { new: boolean; contact: { id: string } };
type OpportunityResponse = { opportunity: { id: string } };
type PipelinesResponse = { pipelines: { id: string; name: string; stages?: { id: string; name: string }[] }[] };

export class HighLevelProvider implements CrmProvider {
  readonly name = "highlevel";
  constructor(
    private readonly db: Database,
    private readonly ctx: (operation: string) => CallContext = (operation) => ({ operation }),
  ) {}

  async upsertContact(input: CrmContactInput): Promise<CrmContactResult> {
    const res = await highLevelRequest<UpsertContactResponse>(this.db, this.ctx("contacts.upsert"), {
      method: "POST",
      path: "/contacts/upsert",
      body: {
        locationId: input.locationId,
        firstName: input.firstName,
        lastName: input.lastName ?? undefined,
        email: input.email ?? undefined,
        phone: input.phone ?? undefined,
        companyName: input.companyName ?? undefined,
        tags: input.tags,
      },
    });
    return { ghlContactId: res.contact.id, created: res.new };
  }

  async upsertOpportunity(input: CrmOpportunityInput & { existingGhlOpportunityId?: string | null }): Promise<CrmOpportunityResult> {
    const body = {
      pipelineId: input.pipelineId,
      name: input.name,
      status: input.status,
      pipelineStageId: input.pipelineStageId ?? undefined,
      monetaryValue: input.monetaryValue,
    };
    if (input.existingGhlOpportunityId) {
      const res = await highLevelRequest<OpportunityResponse>(this.db, this.ctx("opportunities.update"), {
        method: "PUT",
        path: `/opportunities/${input.existingGhlOpportunityId}`,
        body,
      });
      return { ghlOpportunityId: res.opportunity.id };
    }
    const res = await highLevelRequest<OpportunityResponse>(this.db, this.ctx("opportunities.create"), {
      method: "POST",
      path: "/opportunities/",
      body: { ...body, locationId: input.locationId, contactId: input.contactId },
    });
    return { ghlOpportunityId: res.opportunity.id };
  }

  async updateOpportunityStatus(input: { ghlOpportunityId: string; status: OpportunityStatus; lostReasonId?: string | null }): Promise<{ ok: true }> {
    await highLevelRequest(this.db, this.ctx("opportunities.update_status"), {
      method: "PUT",
      path: `/opportunities/${input.ghlOpportunityId}/status`,
      body: { status: input.status, lostReasonId: input.lostReasonId ?? undefined },
    });
    return { ok: true };
  }

  async getPipelines(locationId: string): Promise<CrmPipeline[]> {
    const res = await highLevelRequest<PipelinesResponse>(this.db, this.ctx("opportunities.get_pipelines"), {
      method: "GET",
      path: "/opportunities/pipelines",
      query: { locationId },
    });
    return res.pipelines.map((p) => ({ id: p.id, name: p.name, stages: p.stages ?? [] }));
  }
}
