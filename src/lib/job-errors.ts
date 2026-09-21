/**
 * Error classification for jobs.
 *  Transient → worth retrying (timeouts, 5xx, 429, network).
 *  Permanent → retrying cannot help (invalid recipient, missing data, no handler).
 * Unknown errors are treated as transient but still stop at maxAttempts.
 */
export class TransientJobError extends Error {
  readonly kind = "transient" as const;
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "TransientJobError";
  }
}

export class PermanentJobError extends Error {
  readonly kind = "permanent" as const;
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export type ErrorKind = "transient" | "permanent";

export function classifyError(err: unknown): { kind: ErrorKind; message: string; retryAfterMs?: number } {
  if (err instanceof PermanentJobError) return { kind: "permanent", message: err.message };
  if (err instanceof TransientJobError) return { kind: "transient", message: err.message, retryAfterMs: err.retryAfterMs };
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "transient", message: `Unexpected error: ${message}` };
}

/** Map an HTTP status to a kind — used by provider adapters (mock now, real ones later). */
export function kindForHttpStatus(status: number): ErrorKind {
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "transient";
  return "permanent";
}
