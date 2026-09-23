import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from "@/lib/admin-session";
import { getEnv } from "@/lib/env";

/**
 * Gates every page and internal API behind the single shared admin password (Phase 8).
 * `/api/webhooks/*` is deliberately excluded — those stay protected by their own
 * HMAC/Ed25519 signature checks (see webhook-signature.ts), not a login, since
 * HighLevel/n8n can't hold a browser session. `/api/health` stays open for uptime
 * monitors. `/get-started` is the public "company website" lead-capture form — it
 * would defeat the point of a public intake form to hide it behind the admin login.
 * When ADMIN_PASSWORD isn't set, the app is intentionally open (local dev).
 */
let warnedOpen = false;

export function proxy(request: NextRequest) {
  const password = getEnv().ADMIN_PASSWORD;
  if (!password) {
    if (!warnedOpen) {
      console.warn("[leadflow] ADMIN_PASSWORD is not set — running with no admin login gate.");
      warnedOpen = true;
    }
    return NextResponse.next();
  }

  const cookie = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (verifyAdminSession(password, cookie)) return NextResponse.next();

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!api/webhooks|api/health|login|get-started|_next/static|_next/image|favicon.ico).*)"],
};
