/**
 * Single source of truth for pipeline stages.
 * The Postgres enum, the seed, the Kanban board and (later) the HighLevel
 * stage mapping all read from this list, so they can never drift apart.
 */
export const PIPELINE_STAGES = [
  "new_lead",
  "attempting_contact",
  "contacted",
  "qualified",
  "appointment_booked",
  "proposal_sent",
  "negotiation",
  "won",
  "lost",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const STAGE_META: Record<
  PipelineStage,
  { label: string; probability: number; terminal: boolean }
> = {
  new_lead: { label: "New lead", probability: 5, terminal: false },
  attempting_contact: { label: "Attempting contact", probability: 10, terminal: false },
  contacted: { label: "Contacted", probability: 20, terminal: false },
  qualified: { label: "Qualified", probability: 35, terminal: false },
  appointment_booked: { label: "Appointment booked", probability: 50, terminal: false },
  proposal_sent: { label: "Proposal sent", probability: 65, terminal: false },
  negotiation: { label: "Negotiation", probability: 80, terminal: false },
  won: { label: "Won", probability: 100, terminal: true },
  lost: { label: "Lost", probability: 0, terminal: true },
};

export const OPEN_STAGES = PIPELINE_STAGES.filter((s) => !STAGE_META[s].terminal);

export function isPipelineStage(value: string): value is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(value);
}

export const LEAD_SOURCES = [
  "website_form",
  "google_ads",
  "meta_ads",
  "referral",
  "linkedin",
  "webinar",
  "cold_outreach",
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const SOURCE_LABEL: Record<LeadSource, string> = {
  website_form: "Website form",
  google_ads: "Google Ads",
  meta_ads: "Meta Ads",
  referral: "Referral",
  linkedin: "LinkedIn",
  webinar: "Webinar",
  cold_outreach: "Cold outreach",
};

export const SERVICES = [
  "web_design",
  "seo",
  "paid_ads",
  "crm_automation",
  "social_media",
  "branding",
] as const;
export type Service = (typeof SERVICES)[number];

export const SERVICE_LABEL: Record<Service, string> = {
  web_design: "Web design",
  seo: "SEO",
  paid_ads: "Paid ads",
  crm_automation: "CRM automation",
  social_media: "Social media",
  branding: "Branding",
};

/**
 * The ordered list of stages an opportunity passed through to reach `stage`.
 * Used by the seed to build a realistic stage history.
 * For a lost deal, pass the last open stage it reached as `lostAfter`.
 */
export function stagePath(stage: PipelineStage, lostAfter?: PipelineStage): PipelineStage[] {
  const linear: PipelineStage[] = PIPELINE_STAGES.filter((s) => s !== "lost");
  if (stage === "lost") {
    const last = lostAfter ?? "new_lead";
    if (STAGE_META[last].terminal) throw new Error("lostAfter must be an open stage");
    return [...linear.slice(0, linear.indexOf(last) + 1), "lost"];
  }
  return linear.slice(0, linear.indexOf(stage) + 1);
}
