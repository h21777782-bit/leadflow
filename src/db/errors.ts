/**
 * Translate low-level Postgres errors into something the domain can act on.
 * Drizzle wraps driver errors (DrizzleQueryError → cause = PostgresError),
 * so we walk the `cause` chain.
 */
type PgLike = { code?: string; constraint_name?: string; constraint?: string; cause?: unknown };

function* errorChain(err: unknown): Generator<PgLike> {
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === "object" && depth < 5; depth++) {
    yield cur as PgLike;
    cur = (cur as PgLike).cause;
  }
}

/** Returns the violated constraint name for a unique violation (SQLSTATE 23505), else null. */
export function uniqueViolation(err: unknown): string | null {
  for (const e of errorChain(err)) {
    if (e.code === "23505") return e.constraint_name ?? e.constraint ?? "unknown_constraint";
  }
  return null;
}
