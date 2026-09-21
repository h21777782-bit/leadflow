import { describe, expect, it } from "vitest";
import { backoffDelayMs, backoffWindowMs } from "@/lib/backoff";
import { decideFollowUp, renderTemplate, type FollowUpState } from "@/lib/followup-rules";
import { classifyError, kindForHttpStatus, PermanentJobError, TransientJobError } from "@/lib/job-errors";

const cfg = { baseSeconds: 15, maxSeconds: 3600 };

describe("exponential backoff with jitter", () => {
  it("doubles each attempt (upper bound of window)", () => {
    expect([1, 2, 3, 4, 5].map((a) => backoffWindowMs(a, cfg).max)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000]);
  });
  it("equal jitter: delay is always between raw/2 and raw", () => {
    for (let a = 1; a <= 8; a++) {
      const { min, max } = backoffWindowMs(a, cfg);
      expect(min).toBe(max / 2);
      for (const r of [0, 0.13, 0.5, 0.99, 1]) {
        const d = backoffDelayMs(a, cfg, () => r);
        expect(d).toBeGreaterThanOrEqual(min);
        expect(d).toBeLessThanOrEqual(max);
      }
    }
  });
  it("is capped at maxSeconds", () => {
    expect(backoffWindowMs(30, cfg).max).toBe(3_600_000);
  });
  it("treats nonsense attempt numbers as attempt 1 and clamps bad random values", () => {
    expect(backoffDelayMs(0, cfg, () => 1)).toBe(15_000);
    expect(backoffDelayMs(-5, cfg, () => 5)).toBe(15_000);
  });
  it("actually spreads retries out (not all identical)", () => {
    const values = new Set(Array.from({ length: 50 }, () => backoffDelayMs(3, cfg)));
    expect(values.size).toBeGreaterThan(10);
  });
});

describe("error classification", () => {
  it("separates transient from permanent", () => {
    expect(classifyError(new TransientJobError("503")).kind).toBe("transient");
    expect(classifyError(new PermanentJobError("bad email")).kind).toBe("permanent");
    expect(classifyError(new Error("socket hang up"))).toMatchObject({ kind: "transient", message: "Unexpected error: socket hang up" });
    expect(classifyError("weird").kind).toBe("transient");
  });
  it("maps HTTP statuses", () => {
    expect([429, 500, 503, 408].map(kindForHttpStatus)).toEqual(["transient", "transient", "transient", "transient"]);
    expect([400, 401, 403, 404, 422].map(kindForHttpStatus)).toEqual(["permanent", "permanent", "permanent", "permanent", "permanent"]);
  });
});

describe("follow-up stop rules", () => {
  const ok: FollowUpState = { workflowStatus: "running", optedOut: false, hasOpenOpportunity: true, closedAs: null, repliedSinceStart: false, appointmentBooked: false, hasAddress: true };
  it("sends when nothing has changed", () => expect(decideFollowUp(ok)).toEqual({ action: "send" }));
  it.each([
    [{ workflowStatus: "cancelled" as const }, "workflow_cancelled"],
    [{ workflowStatus: "stopped" as const }, "workflow_not_running"],
    [{ optedOut: true }, "opted_out"],
    [{ hasOpenOpportunity: false, closedAs: "won" as const }, "deal_won"],
    [{ hasOpenOpportunity: false, closedAs: "lost" as const }, "deal_lost"],
    [{ hasOpenOpportunity: false }, "no_open_deal"],
    [{ repliedSinceStart: true }, "lead_replied"],
    [{ appointmentBooked: true }, "appointment_booked"],
  ])("stops for %o → %s", (patch, reason) => {
    expect(decideFollowUp({ ...ok, ...patch })).toMatchObject({ action: "stop", reason });
  });
  it("opt-out wins over everything except cancellation", () => {
    expect(decideFollowUp({ ...ok, optedOut: true, repliedSinceStart: true })).toMatchObject({ reason: "opted_out" });
  });
  it("renders templates and leaves unknown placeholders visible", () => {
    expect(renderTemplate("Hi {{firstName}}, {{ unknown }}", { firstName: "Asha" })).toBe("Hi Asha, {{ unknown }}");
  });
});
