/**
 * Should this follow-up be sent right now? (pure)
 * The worker loads the LATEST state from the database just before sending and
 * asks this function. Order matters: the first matching stop reason wins.
 */
export type FollowUpState = {
  workflowStatus: "running" | "completed" | "stopped" | "failed" | "cancelled";
  optedOut: boolean;
  hasOpenOpportunity: boolean;
  closedAs: "won" | "lost" | null; // latest closed deal, when none are open
  repliedSinceStart: boolean;
  appointmentBooked: boolean;
  hasAddress: boolean; // an email (or phone for SMS) to send to
};

export type FollowUpDecision =
  | { action: "send" }
  | { action: "stop"; reason: StopReason; message: string };

export type StopReason = "workflow_cancelled" | "workflow_not_running" | "opted_out" | "deal_won" | "deal_lost" | "no_open_deal" | "lead_replied" | "appointment_booked";

export function decideFollowUp(s: FollowUpState): FollowUpDecision {
  if (s.workflowStatus === "cancelled") return { action: "stop", reason: "workflow_cancelled", message: "Workflow was cancelled manually" };
  if (s.workflowStatus !== "running") return { action: "stop", reason: "workflow_not_running", message: `Workflow is ${s.workflowStatus}` };
  if (s.optedOut) return { action: "stop", reason: "opted_out", message: "Contact opted out of messages" };
  if (!s.hasOpenOpportunity) {
    if (s.closedAs === "won") return { action: "stop", reason: "deal_won", message: "Deal was won" };
    if (s.closedAs === "lost") return { action: "stop", reason: "deal_lost", message: "Deal was lost" };
    return { action: "stop", reason: "no_open_deal", message: "No open deal for this contact" };
  }
  if (s.repliedSinceStart) return { action: "stop", reason: "lead_replied", message: "Lead replied — a salesperson takes over" };
  if (s.appointmentBooked) return { action: "stop", reason: "appointment_booked", message: "Appointment booked" };
  return { action: "send" };
}

/** {{firstName}} style templating; unknown placeholders are left visible so mistakes are obvious. */
export function renderTemplate(tpl: string, vars: Record<string, string | null | undefined>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (vars[k] ? String(vars[k]) : m));
}
