import { NextResponse } from "next/server";
import { EnvValidationError, getEnv } from "@/lib/env";
import { checkDatabase } from "@/server/queries";

/**
 * Liveness + dependency check. Returns 503 when the database is unreachable so
 * uptime monitors (and the interview demo) can see the failure explicitly.
 */
export async function GET() {
  let mode: "mock" | "live";
  try {
    mode = getEnv().MOCK_MODE ? "mock" : "live";
  } catch (err) {
    const issues = err instanceof EnvValidationError ? err.issues : ["unknown configuration error"];
    return NextResponse.json({ status: "misconfigured", issues }, { status: 500 });
  }

  const db = await checkDatabase();
  // Raw driver errors can reveal hostnames/ports — only show them outside production.
  const database = db.ok || process.env.NODE_ENV !== "production" ? db : { ok: false, error: "database unreachable" };
  const body = { status: db.ok ? "ok" : "degraded", mode, database, checkedAt: new Date().toISOString() };
  return NextResponse.json(body, { status: db.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
