import type { ReactNode } from "react";
import { STAGE_META, type PipelineStage } from "@/lib/pipeline";

type Tone = "neutral" | "accent" | "ok" | "bad" | "hot" | "warm" | "cold";

const TONE: Record<Tone, string> = {
  neutral: "bg-pending-soft text-pending",
  accent: "bg-accent-soft text-accent",
  ok: "bg-ok-soft text-ok",
  bad: "bg-bad-soft text-bad",
  hot: "bg-hot-soft text-hot",
  warm: "bg-warm-soft text-warm",
  cold: "bg-cold-soft text-cold",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${TONE[tone]}`}>
      {children}
    </span>
  );
}

export function StageBadge({ stage }: { stage: PipelineStage | null }) {
  if (!stage) return <Badge>No opportunity</Badge>;
  const tone: Tone = stage === "won" ? "ok" : stage === "lost" ? "bad" : stage === "new_lead" ? "accent" : "neutral";
  return <Badge tone={tone}>{STAGE_META[stage].label}</Badge>;
}

const STATUS_TONE: Record<string, Tone> = {
  running: "accent",
  pending: "neutral",
  scheduled: "neutral",
  confirmed: "accent",
  completed: "ok",
  succeeded: "ok",
  sent: "ok",
  processed: "ok",
  stopped: "neutral",
  cancelled: "neutral",
  retrying: "warm",
  failed: "bad",
  dead: "bad",
  no_show: "bad",
  rejected: "bad",
};

const STATUS_LABEL: Record<string, string> = {
  dead: "Failed — needs action",
  retrying: "Retrying",
  no_show: "No-show",
};

export function StatusBadge({ status }: { status: string }) {
  const label = STATUS_LABEL[status] ?? status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ");
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{label}</Badge>;
}

export function BandBadge({ band, score }: { band: "hot" | "warm" | "cold" | null; score?: number | null }) {
  if (!band) return <Badge>Not scored</Badge>;
  const label = band === "hot" ? "Hot" : band === "warm" ? "Warm" : "Cold";
  return (
    <Badge tone={band}>
      {label}
      {score != null && <span className="tabular ml-1 font-semibold">{score}</span>}
    </Badge>
  );
}
