/**
 * JSON.stringify with sorted object keys. Postgres `jsonb` does NOT preserve
 * key order, so comparing a value read back from jsonb with a fresh object via
 * plain JSON.stringify reports false differences.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}
