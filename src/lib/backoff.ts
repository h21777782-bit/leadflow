/**
 * Exponential backoff with "equal jitter" (pure, testable).
 *
 *   raw   = base × 2^(attempt−1), capped at max
 *   delay = raw/2 + random(0 … raw/2)
 *
 * Why jitter: if 100 jobs fail together (provider outage), pure exponential
 * backoff retries all 100 at the same instant again. Jitter spreads them out.
 * Equal jitter keeps a guaranteed minimum wait of raw/2.
 */
export type BackoffConfig = { baseSeconds: number; maxSeconds: number };

export function backoffDelayMs(attempt: number, cfg: BackoffConfig, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = Math.min(cfg.maxSeconds, cfg.baseSeconds * 2 ** (n - 1)) * 1000;
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(raw / 2 + r * (raw / 2));
}

export function backoffWindowMs(attempt: number, cfg: BackoffConfig): { min: number; max: number } {
  return { min: backoffDelayMs(attempt, cfg, () => 0), max: backoffDelayMs(attempt, cfg, () => 1) };
}
