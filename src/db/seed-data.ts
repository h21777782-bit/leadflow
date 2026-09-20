/**
 * DEMO DATA — fictional people and companies.
 * Email domains use the reserved `.example` TLD (RFC 2606) so nothing here can
 * ever reach a real inbox, even if a real email provider were wired in.
 *
 * This file is pure data (no DB access) so it can be unit-tested.
 */
import type { LeadSource, PipelineStage, Service } from "@/lib/pipeline";

export type SeedUser = {
  key: string;
  name: string;
  email: string;
  role: "admin" | "sales_rep";
  timezone: string;
  services: Service[];
  regions: string[];
  isActive: boolean;
  isAvailable: boolean;
  maxOpenLeads: number;
};

export const SEED_USERS: SeedUser[] = [
  { key: "admin", name: "Ops Admin", email: "admin@leadflow.example", role: "admin", timezone: "Asia/Kolkata", services: [], regions: [], isActive: true, isAvailable: false, maxOpenLeads: 0 },
  { key: "aarav", name: "Aarav Mehta", email: "aarav@leadflow.example", role: "sales_rep", timezone: "Asia/Kolkata", services: ["web_design", "branding"], regions: ["IN", "AE"], isActive: true, isAvailable: true, maxOpenLeads: 25 },
  { key: "neha", name: "Neha Kulkarni", email: "neha@leadflow.example", role: "sales_rep", timezone: "Asia/Kolkata", services: ["crm_automation", "social_media"], regions: ["IN", "SG"], isActive: true, isAvailable: true, maxOpenLeads: 25 },
  { key: "sophie", name: "Sophie Turner", email: "sophie@leadflow.example", role: "sales_rep", timezone: "Europe/London", services: ["seo", "paid_ads"], regions: ["GB", "DE", "NL", "IE"], isActive: true, isAvailable: true, maxOpenLeads: 20 },
  { key: "daniel", name: "Daniel Brooks", email: "daniel@leadflow.example", role: "sales_rep", timezone: "America/New_York", services: ["crm_automation", "paid_ads"], regions: ["US", "CA"], isActive: true, isAvailable: true, maxOpenLeads: 20 },
  // Unavailable on purpose: lets the routing demo show "skip unavailable rep".
  { key: "liam", name: "Liam Carter", email: "liam@leadflow.example", role: "sales_rep", timezone: "Australia/Sydney", services: ["web_design", "seo"], regions: ["AU", "NZ"], isActive: true, isAvailable: false, maxOpenLeads: 20 },
];

export type SeedRoutingRule = {
  name: string;
  priority: number;
  conditions: { services?: Service[]; countries?: string[]; sources?: LeadSource[]; minBudget?: number; requireServiceExpertise?: boolean };
  strategy: "assign_user" | "round_robin" | "least_loaded";
  targets: string[]; // SeedUser keys
};

export const SEED_ROUTING_RULES: SeedRoutingRule[] = [
  { name: "CRM automation — North America", priority: 10, conditions: { services: ["crm_automation"], countries: ["US", "CA"] }, strategy: "assign_user", targets: ["daniel"] },
  { name: "India, Gulf & Singapore", priority: 20, conditions: { countries: ["IN", "AE", "SG"] }, strategy: "round_robin", targets: ["aarav", "neha"] },
  { name: "UK & Europe", priority: 30, conditions: { countries: ["GB", "DE", "NL", "IE"] }, strategy: "assign_user", targets: ["sophie"] },
  { name: "Australia & New Zealand", priority: 40, conditions: { countries: ["AU", "NZ"] }, strategy: "round_robin", targets: ["liam", "aarav"] },
  // Fallback only hands a lead to someone who actually sells that service.
  { name: "Fallback — any rep who handles the service", priority: 100, conditions: { requireServiceExpertise: true }, strategy: "least_loaded", targets: ["aarav", "neha", "sophie", "daniel", "liam"] },
];

export type SeedLead = {
  firstName: string;
  lastName: string;
  company: string;
  email: string;
  phone: string; // as a human would type it
  country: string;
  timezone: string;
  source: LeadSource;
  service: Service;
  budget: number; // USD, whole units
  stage: PipelineStage;
  lostAfter?: PipelineStage; // for lost deals: the last open stage reached
  lostReason?: string;
  value: number;
  /** SeedUser key. Omitted for brand-new leads: the real routing engine assigns them during seeding. */
  owner?: string;
  createdDaysAgo: number;
  tags: string[];
  notes?: string;
  customFields?: Record<string, string | number | boolean>;
};

export const SEED_LEADS: SeedLead[] = [
  // ── New lead (4)
  { firstName: "Priya", lastName: "Sharma", company: "Sharma Dental Care", email: "priya@sharmadental.example", phone: "+91 98220 11234", country: "IN", timezone: "Asia/Kolkata", source: "website_form", service: "web_design", budget: 4000, stage: "new_lead", value: 4000, createdDaysAgo: 0, tags: ["healthcare"], customFields: { clinics: 2 } },
  { firstName: "Ethan", lastName: "Walker", company: "Walker HVAC", email: "ethan@walkerhvac.example", phone: "(415) 555-2671", country: "US", timezone: "America/Los_Angeles", source: "google_ads", service: "crm_automation", budget: 9000, stage: "new_lead", value: 9000, createdDaysAgo: 0, tags: ["home-services"], customFields: { crm: "none" } },
  { firstName: "Omar", lastName: "Haddad", company: "Haddad Realty", email: "omar@haddadrealty.example", phone: "+971 50 123 4567", country: "AE", timezone: "Asia/Dubai", source: "meta_ads", service: "paid_ads", budget: 2500, stage: "new_lead", value: 2500, createdDaysAgo: 1, tags: ["real-estate"] },
  { firstName: "Grace", lastName: "Lee", company: "Brightside Tutoring", email: "grace@brightside.example", phone: "0412 345 678", country: "AU", timezone: "Australia/Sydney", source: "website_form", service: "seo", budget: 800, stage: "new_lead", value: 800, createdDaysAgo: 1, tags: ["education"] },

  // ── Attempting contact (3)
  { firstName: "Rohan", lastName: "Deshpande", company: "Deshpande Logistics", email: "rohan@deshpandelogistics.example", phone: "+91 90110 22345", country: "IN", timezone: "Asia/Kolkata", source: "linkedin", service: "crm_automation", budget: 6000, stage: "attempting_contact", value: 6000, owner: "neha", createdDaysAgo: 3, tags: ["logistics"] },
  { firstName: "Hannah", lastName: "Fischer", company: "Fischer Bikes", email: "hannah@fischerbikes.example", phone: "+49 1512 3456789", country: "DE", timezone: "Europe/Berlin", source: "google_ads", service: "seo", budget: 3000, stage: "attempting_contact", value: 3000, owner: "sophie", createdDaysAgo: 2, tags: ["ecommerce"] },
  { firstName: "Marcus", lastName: "Reid", company: "Reid Fitness Studios", email: "marcus@reidfitness.example", phone: "+1 646 555 0142", country: "US", timezone: "America/New_York", source: "meta_ads", service: "social_media", budget: 1500, stage: "attempting_contact", value: 1500, owner: "daniel", createdDaysAgo: 4, tags: ["fitness"] },

  // ── Contacted (3)
  { firstName: "Ananya", lastName: "Iyer", company: "Iyer & Co Chartered Accountants", email: "ananya@iyerco.example", phone: "+91 98450 33456", country: "IN", timezone: "Asia/Kolkata", source: "referral", service: "web_design", budget: 5000, stage: "contacted", value: 5000, owner: "aarav", createdDaysAgo: 6, tags: ["professional-services"], notes: "Prefers WhatsApp after 6pm IST." },
  { firstName: "Oliver", lastName: "Bennett", company: "Bennett Legal", email: "oliver@bennettlegal.example", phone: "07911 123456", country: "GB", timezone: "Europe/London", source: "website_form", service: "seo", budget: 4500, stage: "contacted", value: 4500, owner: "sophie", createdDaysAgo: 5, tags: ["legal"] },
  { firstName: "Chloe", lastName: "Martin", company: "Maple Leaf Dental", email: "chloe@mapleleafdental.example", phone: "+1 416 555 0199", country: "CA", timezone: "America/Toronto", source: "google_ads", service: "crm_automation", budget: 7000, stage: "contacted", value: 7000, owner: "daniel", createdDaysAgo: 7, tags: ["healthcare"] },

  // ── Qualified (3)
  { firstName: "Vikram", lastName: "Nair", company: "Nair Hospitality Group", email: "vikram@nairhospitality.example", phone: "+91 99870 44567", country: "IN", timezone: "Asia/Kolkata", source: "referral", service: "branding", budget: 12000, stage: "qualified", value: 12000, owner: "aarav", createdDaysAgo: 9, tags: ["hospitality", "multi-location"] },
  { firstName: "Sofia", lastName: "de Vries", company: "Tulip Interiors", email: "sofia@tulipinteriors.example", phone: "+31 6 12345678", country: "NL", timezone: "Europe/Amsterdam", source: "linkedin", service: "paid_ads", budget: 5500, stage: "qualified", value: 5500, owner: "sophie", createdDaysAgo: 10, tags: ["interiors"] },
  { firstName: "Jason", lastName: "Kim", company: "Summit Roofing", email: "jason@summitroofing.example", phone: "+1 303 555 0123", country: "US", timezone: "America/Denver", source: "webinar", service: "crm_automation", budget: 15000, stage: "qualified", value: 15000, owner: "daniel", createdDaysAgo: 8, tags: ["home-services"] },

  // ── Appointment booked (3)
  { firstName: "Meera", lastName: "Joshi", company: "Joshi Skin Clinic", email: "meera@joshiskin.example", phone: "+91 97300 55678", country: "IN", timezone: "Asia/Kolkata", source: "meta_ads", service: "social_media", budget: 3500, stage: "appointment_booked", value: 3500, owner: "neha", createdDaysAgo: 5, tags: ["healthcare"] },
  { firstName: "Tom", lastName: "Hughes", company: "Hughes Plumbing", email: "tom@hughesplumbing.example", phone: "+44 7911 234567", country: "GB", timezone: "Europe/London", source: "google_ads", service: "paid_ads", budget: 4000, stage: "appointment_booked", value: 4000, owner: "sophie", createdDaysAgo: 6, tags: ["home-services"] },
  { firstName: "Aisha", lastName: "Khan", company: "Crescent Events", email: "aisha@crescentevents.example", phone: "+65 8123 4567", country: "SG", timezone: "Asia/Singapore", source: "website_form", service: "crm_automation", budget: 8000, stage: "appointment_booked", value: 8000, owner: "neha", createdDaysAgo: 4, tags: ["events"] },

  // ── Proposal sent (2)
  { firstName: "Ryan", lastName: "O'Connor", company: "Harbour Coffee Roasters", email: "ryan@harbourcoffee.example", phone: "+353 85 123 4567", country: "IE", timezone: "Europe/Dublin", source: "referral", service: "branding", budget: 6500, stage: "proposal_sent", value: 6500, owner: "sophie", createdDaysAgo: 14, tags: ["food-and-beverage"] },
  { firstName: "Kavya", lastName: "Reddy", company: "Reddy Builders", email: "kavya@reddybuilders.example", phone: "+91 98480 66789", country: "IN", timezone: "Asia/Kolkata", source: "linkedin", service: "web_design", budget: 10000, stage: "proposal_sent", value: 10000, owner: "aarav", createdDaysAgo: 16, tags: ["construction"] },

  // ── Negotiation (2)
  { firstName: "Emily", lastName: "Carter", company: "Carter Wealth Advisors", email: "emily@carterwealth.example", phone: "+1 212 555 0187", country: "US", timezone: "America/New_York", source: "webinar", service: "crm_automation", budget: 18000, stage: "negotiation", value: 18000, owner: "daniel", createdDaysAgo: 20, tags: ["finance"], notes: "Asked for a 3-month payment plan." },
  { firstName: "Arjun", lastName: "Malhotra", company: "Malhotra Motors", email: "arjun@malhotramotors.example", phone: "+91 98110 77890", country: "IN", timezone: "Asia/Kolkata", source: "google_ads", service: "paid_ads", budget: 7500, stage: "negotiation", value: 7500, owner: "neha", createdDaysAgo: 18, tags: ["automotive"] },

  // ── Won (2)
  { firstName: "Laura", lastName: "Schmidt", company: "Alpen Physio", email: "laura@alpenphysio.example", phone: "+49 1522 3456789", country: "DE", timezone: "Europe/Berlin", source: "website_form", service: "seo", budget: 5000, stage: "won", value: 5200, owner: "sophie", createdDaysAgo: 30, tags: ["healthcare"] },
  { firstName: "Siddharth", lastName: "Rao", company: "Rao Organics", email: "sid@raoorganics.example", phone: "+91 99000 88901", country: "IN", timezone: "Asia/Kolkata", source: "referral", service: "web_design", budget: 9000, stage: "won", value: 9500, owner: "aarav", createdDaysAgo: 35, tags: ["ecommerce"] },

  // ── Lost (2)
  { firstName: "Nathan", lastName: "Price", company: "Price Auto Detailing", email: "nathan@priceauto.example", phone: "+1 512 555 0164", country: "US", timezone: "America/Chicago", source: "meta_ads", service: "paid_ads", budget: 600, stage: "lost", lostAfter: "contacted", lostReason: "Budget too low for minimum retainer", value: 600, owner: "daniel", createdDaysAgo: 25, tags: ["automotive"] },
  { firstName: "Isabella", lastName: "Rossi", company: "Rossi Boutique", email: "isabella@rossiboutique.example", phone: "+44 7400 123456", country: "GB", timezone: "Europe/London", source: "linkedin", service: "branding", budget: 6000, stage: "lost", lostAfter: "proposal_sent", lostReason: "Chose a competitor with an in-house photographer", value: 6000, owner: "sophie", createdDaysAgo: 28, tags: ["retail"] },
];

/**
 * Historical automation failures for the Failed Automations screen.
 * These are SEEDED DEMO RECORDS, not real incidents. Each error string is
 * prefixed with "[demo seed]" so they can never be mistaken for real history.
 */
export type SeedFailure = {
  leadEmail: string;
  jobType: string;
  status: "dead" | "retrying";
  attempts: number;
  error: string;
  statusCode: number | null;
  provider: string;
  operation: string;
  hoursAgo: number;
};

export const SEED_FAILURES: SeedFailure[] = [
  { leadEmail: "rohan@deshpandelogistics.example", jobType: "crm.sync_contact", status: "dead", attempts: 5, error: "[demo seed] HighLevel API responded 503 Service Unavailable after 5 attempts", statusCode: 503, provider: "highlevel", operation: "contacts.upsert", hoursAgo: 20 },
  { leadEmail: "marcus@reidfitness.example", jobType: "message.send_sms", status: "dead", attempts: 5, error: "[demo seed] SMS provider rejected the message: destination unreachable", statusCode: 400, provider: "sms", operation: "sms.send", hoursAgo: 30 },
  { leadEmail: "hannah@fischerbikes.example", jobType: "crm.update_opportunity", status: "retrying", attempts: 2, error: "[demo seed] HighLevel API responded 429 Too Many Requests", statusCode: 429, provider: "highlevel", operation: "opportunities.update", hoursAgo: 1 },
];
