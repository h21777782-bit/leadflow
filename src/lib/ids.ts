const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate route ids before querying, so a bad URL is a 404 instead of a Postgres cast error. */
export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}
