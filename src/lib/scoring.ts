/**
 * LEAD SCORING ENGINE — pure functions, no database.
 *
 * 100 points in five factors:
 *   budget fit 30 · service fit 20 · engagement 20 · response 15 · appointment 15
 * Bands: Hot 70–100 · Warm 40–69 · Cold 0–39
 *
 * Principle: MISSING information is not bad news. Unknown budget/service get a
 * neutral partial credit, and a brand-new lead nobody has contacted yet is not
 * penalised for "not replying". Only explicit evidence (tiny budget, several
 * unanswered follow-ups, a no-show) lowers a factor.
 */

export type LeadBand = "hot" | "warm" | "cold";

export type ScoringConfig = {
  version: string;
  max: { budget: number; service: number; engagement: number; response: number; appointment: number };
  bands: { hotMin: number; warmMin: number };
  /** Budget tiers in USD, checked top-down. First tier whose `min` is ≤ budget wins. */
  budgetTiers: { min: number; points: number; label: string }[];
  budgetUnknownPoints: number;
  servicePoints: Record<string, number>;
  serviceUnknownPoints: number;
  engagement: {
    completeness: { company: number; bothContactMethods: number; location: number; context: number };
    /** Points for inbound replies: index = number of replies (capped at last entry). */
    repliesPoints: number[];
  };
  response: { replied: number; pending: number; unansweredAfterAttempts: number; attemptsBeforePenalty: number };
  appointment: { completed: number; upcoming: number; notBooked: number; cancelled: number; noShow: number };
};

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  version: "2026-09-v1",
  max: { budget: 30, service: 20, engagement: 20, response: 15, appointment: 15 },
  bands: { hotMin: 70, warmMin: 40 },
  budgetTiers: [
    { min: 10_000, points: 30, label: "$10k or more" },
    { min: 5_000, points: 24, label: "$5k–$9.9k" },
    { min: 2_500, points: 16, label: "$2.5k–$4.9k" },
    { min: 1_000, points: 8, label: "$1k–$2.4k" },
    { min: 0, points: 2, label: "under $1k (below our minimum retainer)" },
  ],
  budgetUnknownPoints: 12,
  servicePoints: { crm_automation: 20, web_design: 18, paid_ads: 16, seo: 14, branding: 12, social_media: 10 },
  serviceUnknownPoints: 8,
  engagement: {
    completeness: { company: 2, bothContactMethods: 2, location: 2, context: 2 },
    repliesPoints: [0, 6, 9, 12],
  },
  response: { replied: 15, pending: 7, unansweredAfterAttempts: 3, attemptsBeforePenalty: 2 },
  appointment: { completed: 15, upcoming: 13, notBooked: 5, cancelled: 3, noShow: 2 },
};

export type AppointmentSignal = "completed" | "upcoming" | "none" | "cancelled" | "no_show";

export type ScoringInput = {
  budgetAmount: number | null | undefined;
  serviceInterest: string | null | undefined;
  hasCompany: boolean;
  hasEmail: boolean;
  hasPhone: boolean;
  hasLocation: boolean; // country or timezone known
  hasContext: boolean; // notes or custom fields given
  inboundReplies: number;
  outboundAttempts: number;
  appointment: AppointmentSignal;
};

export type ScoreFactor = { factor: string; points: number; max: number; reason: string };
export type ScoreResult = { score: number; band: LeadBand; factors: ScoreFactor[]; configVersion: string };

const clampInt = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

/** A number we can trust: finite and ≥ 0. Anything else counts as "unknown". */
function validBudget(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

export function bandFor(score: number, cfg: ScoringConfig = DEFAULT_SCORING_CONFIG): LeadBand {
  if (score >= cfg.bands.hotMin) return "hot";
  if (score >= cfg.bands.warmMin) return "warm";
  return "cold";
}

export function scoreBudget(budget: number | null | undefined, cfg = DEFAULT_SCORING_CONFIG): ScoreFactor {
  const b = validBudget(budget);
  if (b === null) {
    return { factor: "budget", points: cfg.budgetUnknownPoints, max: cfg.max.budget, reason: "Budget not provided — neutral credit, not a penalty" };
  }
  const tier = cfg.budgetTiers.find((t) => b >= t.min) ?? cfg.budgetTiers[cfg.budgetTiers.length - 1];
  return { factor: "budget", points: tier.points, max: cfg.max.budget, reason: `Budget $${b.toLocaleString("en-US")} — ${tier.label}` };
}

export function scoreService(service: string | null | undefined, cfg = DEFAULT_SCORING_CONFIG): ScoreFactor {
  if (!service) {
    return { factor: "service", points: cfg.serviceUnknownPoints, max: cfg.max.service, reason: "Service not specified — neutral credit" };
  }
  const pts = cfg.servicePoints[service];
  if (pts === undefined) {
    return { factor: "service", points: cfg.serviceUnknownPoints, max: cfg.max.service, reason: `Unrecognised service “${service}” — neutral credit` };
  }
  return { factor: "service", points: pts, max: cfg.max.service, reason: `Service fit for ${service.replace(/_/g, " ")}` };
}

export function scoreEngagement(i: ScoringInput, cfg = DEFAULT_SCORING_CONFIG): ScoreFactor {
  const c = cfg.engagement.completeness;
  const parts: string[] = [];
  let pts = 0;
  if (i.hasCompany) { pts += c.company; parts.push("company"); }
  if (i.hasEmail && i.hasPhone) { pts += c.bothContactMethods; parts.push("email + phone"); }
  if (i.hasLocation) { pts += c.location; parts.push("location"); }
  if (i.hasContext) { pts += c.context; parts.push("notes/details"); }
  const replies = Math.max(0, Math.floor(i.inboundReplies || 0));
  const table = cfg.engagement.repliesPoints;
  const replyPts = table[Math.min(replies, table.length - 1)];
  pts += replyPts;
  const replyText = replies === 0 ? "no replies yet" : `${replies} ${replies === 1 ? "reply" : "replies"} (+${replyPts})`;
  return {
    factor: "engagement",
    points: clampInt(pts, 0, cfg.max.engagement),
    max: cfg.max.engagement,
    reason: `Profile: ${parts.length ? parts.join(", ") : "minimal"}; ${replyText}`,
  };
}

export function scoreResponse(i: ScoringInput, cfg = DEFAULT_SCORING_CONFIG): ScoreFactor {
  const r = cfg.response;
  const replies = Math.max(0, Math.floor(i.inboundReplies || 0));
  const attempts = Math.max(0, Math.floor(i.outboundAttempts || 0));
  if (replies > 0) return { factor: "response", points: r.replied, max: cfg.max.response, reason: "Lead has replied" };
  if (attempts >= r.attemptsBeforePenalty) {
    return { factor: "response", points: r.unansweredAfterAttempts, max: cfg.max.response, reason: `No reply after ${attempts} contact attempts` };
  }
  return {
    factor: "response",
    points: r.pending,
    max: cfg.max.response,
    reason: attempts === 0 ? "Not contacted yet — neutral, not a penalty" : "Awaiting first reply — neutral",
  };
}

export function scoreAppointment(signal: AppointmentSignal, cfg = DEFAULT_SCORING_CONFIG): ScoreFactor {
  const a = cfg.appointment;
  const map: Record<AppointmentSignal, [number, string]> = {
    completed: [a.completed, "Discovery call completed"],
    upcoming: [a.upcoming, "Appointment booked"],
    none: [a.notBooked, "No appointment booked yet — neutral"],
    cancelled: [a.cancelled, "Appointment cancelled"],
    no_show: [a.noShow, "Missed a booked appointment (no-show)"],
  };
  const [points, reason] = map[signal] ?? map.none;
  return { factor: "appointment", points, max: cfg.max.appointment, reason };
}

export function scoreLead(input: ScoringInput, cfg: ScoringConfig = DEFAULT_SCORING_CONFIG): ScoreResult {
  const factors = [
    scoreBudget(input.budgetAmount, cfg),
    scoreService(input.serviceInterest, cfg),
    scoreEngagement(input, cfg),
    scoreResponse(input, cfg),
    scoreAppointment(input.appointment, cfg),
  ].map((f) => ({ ...f, points: clampInt(f.points, 0, f.max) }));
  const score = clampInt(factors.reduce((n, f) => n + f.points, 0), 0, 100);
  return { score, band: bandFor(score, cfg), factors, configVersion: cfg.version };
}

/** Sanity check used by tests: each factor's best case must equal its max, and maxes must sum to 100. */
export function validateScoringConfig(cfg: ScoringConfig): string[] {
  const errs: string[] = [];
  const sum = Object.values(cfg.max).reduce((a, b) => a + b, 0);
  if (sum !== 100) errs.push(`Factor maximums sum to ${sum}, expected 100`);
  if (Math.max(...cfg.budgetTiers.map((t) => t.points)) !== cfg.max.budget) errs.push("Top budget tier must equal max.budget");
  if (Math.max(...Object.values(cfg.servicePoints)) !== cfg.max.service) errs.push("Best service must equal max.service");
  const c = cfg.engagement.completeness;
  const engBest = c.company + c.bothContactMethods + c.location + c.context + Math.max(...cfg.engagement.repliesPoints);
  if (engBest !== cfg.max.engagement) errs.push(`Best engagement is ${engBest}, expected ${cfg.max.engagement}`);
  if (cfg.response.replied !== cfg.max.response) errs.push("replied must equal max.response");
  if (cfg.appointment.completed !== cfg.max.appointment) errs.push("completed must equal max.appointment");
  if (!(cfg.bands.hotMin > cfg.bands.warmMin && cfg.bands.warmMin > 0)) errs.push("Band thresholds must be 0 < warm < hot");
  for (let k = 1; k < cfg.budgetTiers.length; k++) {
    if (cfg.budgetTiers[k].min >= cfg.budgetTiers[k - 1].min) errs.push("Budget tiers must be in descending order of min");
  }
  return errs;
}
