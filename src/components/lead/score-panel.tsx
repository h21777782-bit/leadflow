import { BandBadge } from "@/components/ui/badges";
import { formatDateTime } from "@/lib/format";
import type { ScoreFactor } from "@/lib/scoring";

const LABEL: Record<string, string> = {
  budget: "Budget fit",
  service: "Service fit",
  engagement: "Engagement",
  response: "Response",
  appointment: "Appointment",
};

/** Explains exactly why the lead has its score: one bar + reason per factor. */
export function ScorePanel({
  score,
  band,
  scoredAt,
  factors,
  history,
  tz,
}: {
  score: number | null;
  band: "hot" | "warm" | "cold" | null;
  scoredAt: Date | null;
  factors: ScoreFactor[] | null;
  history: { id: string; score: number; band: string; trigger: string | null; computedAt: Date }[];
  tz: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="tabular text-3xl font-semibold">
          {score ?? "—"}
          <span className="text-base font-normal text-muted">/100</span>
        </p>
        <BandBadge band={band} />
      </div>
      <p className="text-xs text-faint">Calculated {formatDateTime(scoredAt, tz)}. Hot 70+, Warm 40–69, Cold under 40.</p>
      {factors && (
        <ul className="mt-4 space-y-3">
          {factors.map((f) => (
            <li key={f.factor}>
              <div className="flex justify-between text-[13px]">
                <span className="font-medium">{LABEL[f.factor] ?? f.factor}</span>
                <span className="tabular">{f.points} / {f.max}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-pending-soft">
                <div className="h-1.5 rounded-full bg-accent" style={{ width: `${(f.points / f.max) * 100}%` }} />
              </div>
              <p className="mt-0.5 text-xs text-muted">{f.reason}</p>
            </li>
          ))}
        </ul>
      )}
      {history.length > 1 && (
        <>
          <h3 className="mt-5 text-[13px] font-medium text-muted">Score history</h3>
          <ol className="mt-1 space-y-1 text-[13px]">
            {history.map((h) => (
              <li key={h.id} className="flex justify-between gap-2">
                <span className="tabular">{h.score} ({h.band})</span>
                <span className="text-muted">{h.trigger ?? "—"}, {formatDateTime(h.computedAt, tz, { dateStyle: "short", timeStyle: "short" })}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
