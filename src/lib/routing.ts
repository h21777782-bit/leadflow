/**
 * ROUTING ENGINE — pure functions, no database.
 *
 * decideAssignment():  which rep should own this lead, and WHY (full trace).
 * decideRoutingNeed(): should we route at all? (explicit reassignment policy)
 *
 * The service layer loads data under row locks, calls these, and persists the
 * result. Keeping the decision pure makes every rule unit-testable.
 */

export type RoutingStrategy = "assign_user" | "round_robin" | "least_loaded";

export type RuleConditions = {
  services?: string[];
  countries?: string[];
  sources?: string[];
  minBudget?: number;
  /** Only reps who list the lead's service may receive it (when the service is known). */
  requireServiceExpertise?: boolean;
};

export type RoutingRule = {
  id: string;
  name: string;
  priority: number;
  isActive: boolean;
  conditions: RuleConditions;
  strategy: RoutingStrategy;
  targetUserIds: string[];
};

export type RepState = {
  id: string;
  name: string;
  role: "admin" | "sales_rep";
  isActive: boolean;
  isAvailable: boolean;
  services: string[];
  regions: string[];
  maxOpenLeads: number;
  activeLeads: number; // current workload
  lastAssignedAt: Date | null;
};

export type LeadFacts = {
  serviceInterest: string | null;
  country: string | null;
  leadSource: string;
  budgetAmount: number | null;
};

export type CandidateNote = { userId: string; name: string; eligible: boolean; note: string };
export type RuleTrace = { ruleId: string; ruleName: string; matched: boolean; why: string; candidates?: CandidateNote[] };

export type AssignmentDecision =
  | {
      status: "assigned";
      userId: string;
      userName: string;
      ruleId: string;
      ruleName: string;
      strategy: RoutingStrategy;
      reason: string;
      trace: RuleTrace[];
    }
  | { status: "unassigned"; reason: string; trace: RuleTrace[] };

// ── Rule matching ────────────────────────────────────────────────────────────
export function ruleMatches(rule: RoutingRule, lead: LeadFacts): { matched: boolean; why: string } {
  const c = rule.conditions;
  if (!rule.isActive) return { matched: false, why: "rule is paused" };
  if (c.services?.length) {
    if (!lead.serviceInterest) return { matched: false, why: "lead service unknown" };
    if (!c.services.includes(lead.serviceInterest)) return { matched: false, why: `service ${lead.serviceInterest} not in ${c.services.join("/")}` };
  }
  if (c.countries?.length) {
    if (!lead.country) return { matched: false, why: "lead country unknown" };
    if (!c.countries.includes(lead.country)) return { matched: false, why: `country ${lead.country} not in ${c.countries.join("/")}` };
  }
  if (c.sources?.length && !c.sources.includes(lead.leadSource)) {
    return { matched: false, why: `source ${lead.leadSource} not in ${c.sources.join("/")}` };
  }
  if (c.minBudget !== undefined && c.minBudget > 0) {
    if (lead.budgetAmount === null) return { matched: false, why: "budget unknown" };
    if (lead.budgetAmount < c.minBudget) return { matched: false, why: `budget below ${c.minBudget}` };
  }
  return { matched: true, why: "all conditions met" };
}

// ── Eligibility ──────────────────────────────────────────────────────────────
export function repEligibility(rep: RepState | undefined, lead: LeadFacts, rule: RoutingRule): { eligible: boolean; note: string } {
  if (!rep) return { eligible: false, note: "user no longer exists" };
  if (rep.role !== "sales_rep") return { eligible: false, note: "not a sales rep" };
  if (!rep.isActive) return { eligible: false, note: "inactive" };
  if (!rep.isAvailable) return { eligible: false, note: "unavailable" };
  if (rep.activeLeads >= rep.maxOpenLeads) return { eligible: false, note: `at capacity (${rep.activeLeads}/${rep.maxOpenLeads})` };
  if (rule.conditions.requireServiceExpertise && lead.serviceInterest && !rep.services.includes(lead.serviceInterest)) {
    return { eligible: false, note: `does not handle ${lead.serviceInterest}` };
  }
  return { eligible: true, note: `eligible (${rep.activeLeads}/${rep.maxOpenLeads} leads)` };
}

const time = (d: Date | null) => (d ? d.getTime() : -Infinity); // never assigned = first in line

/**
 * Fair ordering between equally suitable reps.
 *  round_robin  → least recently assigned first, then lower workload
 *  least_loaded → lowest workload ratio first, then least recently assigned
 * Final tie-break on id keeps the result deterministic.
 */
export function orderCandidates(reps: RepState[], strategy: RoutingStrategy): RepState[] {
  const ratio = (r: RepState) => r.activeLeads / Math.max(1, r.maxOpenLeads);
  return [...reps].sort((a, b) => {
    const byTime = time(a.lastAssignedAt) - time(b.lastAssignedAt);
    const byLoad = ratio(a) - ratio(b);
    const primary = strategy === "least_loaded" ? byLoad || byTime : byTime || byLoad;
    return primary || a.id.localeCompare(b.id);
  });
}

// ── Main decision ────────────────────────────────────────────────────────────
export function decideAssignment(lead: LeadFacts, rules: RoutingRule[], reps: RepState[]): AssignmentDecision {
  const byId = new Map(reps.map((r) => [r.id, r]));
  const trace: RuleTrace[] = [];

  for (const rule of [...rules].sort((a, b) => a.priority - b.priority)) {
    const m = ruleMatches(rule, lead);
    if (!m.matched) {
      trace.push({ ruleId: rule.id, ruleName: rule.name, matched: false, why: m.why });
      continue;
    }
    const notes: CandidateNote[] = rule.targetUserIds.map((id) => {
      const rep = byId.get(id);
      const e = repEligibility(rep, lead, rule);
      return { userId: id, name: rep?.name ?? "unknown", eligible: e.eligible, note: e.note };
    });
    const eligible = notes.filter((n) => n.eligible).map((n) => byId.get(n.userId)!);
    if (eligible.length === 0) {
      trace.push({ ruleId: rule.id, ruleName: rule.name, matched: true, why: "matched, but no eligible rep — trying next rule", candidates: notes });
      continue;
    }

    // Prefer reps who actually handle this service; fall back to the rule's other eligible reps.
    const experts = lead.serviceInterest ? eligible.filter((r) => r.services.includes(lead.serviceInterest!)) : [];
    const pool = experts.length ? experts : eligible;

    let chosen: RepState;
    if (rule.strategy === "assign_user") {
      // Ordered preference: first eligible rep in the rule's list.
      chosen = rule.targetUserIds.map((id) => pool.find((r) => r.id === id)).find(Boolean)!;
    } else {
      chosen = orderCandidates(pool, rule.strategy)[0];
    }

    const how =
      rule.strategy === "assign_user"
        ? "first eligible rep in the rule's list"
        : rule.strategy === "round_robin"
          ? `round robin across ${pool.length} eligible rep(s)`
          : `lowest workload across ${pool.length} eligible rep(s)`;
    const expertise = experts.length ? `handles ${lead.serviceInterest}` : lead.serviceInterest ? `no ${lead.serviceInterest} specialist available in this rule` : "service unknown";
    trace.push({ ruleId: rule.id, ruleName: rule.name, matched: true, why: `assigned to ${chosen.name}`, candidates: notes });
    return {
      status: "assigned",
      userId: chosen.id,
      userName: chosen.name,
      ruleId: rule.id,
      ruleName: rule.name,
      strategy: rule.strategy,
      reason: `Rule “${rule.name}”: ${how}; ${chosen.name} ${expertise}, workload ${chosen.activeLeads}/${chosen.maxOpenLeads}`,
      trace,
    };
  }

  const matchedButFull = trace.filter((t) => t.matched);
  const reason = matchedButFull.length
    ? `No eligible rep: ${matchedButFull
        .flatMap((t) => (t.candidates ?? []).map((c) => `${c.name} ${c.note}`))
        .filter((v, i, a) => a.indexOf(v) === i)
        .join("; ")}`
    : "No routing rule matches this lead";
  return { status: "unassigned", reason, trace };
}

// ── Reassignment policy ──────────────────────────────────────────────────────
export const EARLY_STAGES = ["new_lead", "attempting_contact"] as const;

export type RoutingContext = {
  hasOpenOpportunity: boolean;
  latestOpenStage: string | null;
  ownerId: string | null;
  owner: Pick<RepState, "name" | "isActive" | "isAvailable"> | null;
  assignmentSource: "routing" | "manual" | "seed" | null;
  force: boolean; // explicit "Route now" by a user
};

export type RoutingNeed = { route: true; reason: string } | { route: false; reason: string };

/**
 * When is automatic (re)assignment allowed?
 *  1. No open opportunity → never (nothing to work).
 *  2. Manually assigned/unassigned by a person → never automatically; only "Route now".
 *  3. No owner → route.
 *  4. Owner inactive/unavailable AND no conversation yet (new / attempting contact) → reassign.
 *  5. Owner inactive/unavailable but already in conversation → keep; needs a human decision.
 *  6. Otherwise → keep the current owner (sticky ownership, even if lead details change).
 */
export function decideRoutingNeed(ctx: RoutingContext): RoutingNeed {
  if (!ctx.hasOpenOpportunity) return { route: false, reason: "No open opportunity" };
  if (ctx.assignmentSource === "manual" && !ctx.force) {
    return { route: false, reason: "Owner was set manually — automatic routing is off for this lead" };
  }
  if (!ctx.ownerId) return { route: true, reason: ctx.force ? "Routing requested manually" : "Lead has no owner" };
  const unavailable = !ctx.owner || !ctx.owner.isActive || !ctx.owner.isAvailable;
  if (unavailable) {
    const who = ctx.owner?.name ?? "Previous owner";
    const state = !ctx.owner ? "no longer exists" : !ctx.owner.isActive ? "is inactive" : "is unavailable";
    if (ctx.latestOpenStage && (EARLY_STAGES as readonly string[]).includes(ctx.latestOpenStage)) {
      return { route: true, reason: `${who} ${state} and the lead has not been contacted yet` };
    }
    return { route: false, reason: `${who} ${state}, but the lead is already in conversation — needs a manual decision` };
  }
  return { route: false, reason: `Already owned by ${ctx.owner?.name} (ownership is sticky)` };
}
