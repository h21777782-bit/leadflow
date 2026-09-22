"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getEnv } from "@/lib/env";
import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_MAX_AGE_SECONDS, checkAdminPassword, signAdminSession } from "@/lib/admin-session";

/**
 * Always redirects, even on a wrong password — never returns inline state.
 * A useActionState-bound form that returns state instead of redirecting hangs
 * indefinitely for a no-JS submission in this Next.js build (see the fix in
 * lead-intelligence.ts and IMPLEMENTATION_LOG.md, Phase 8); a login form is
 * exactly the kind of form a no-JS or password-manager-driven submit hits, so
 * it gets the same redirect-only treatment as demo.ts rather than useActionState.
 */
export async function loginAction(fd: FormData): Promise<void> {
  const password = String(fd.get("password") ?? "");
  const next = String(fd.get("next") ?? "/");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const configured = getEnv().ADMIN_PASSWORD;

  if (!configured) redirect(safeNext); // login is disabled — nothing to check
  if (!password || !checkAdminPassword(configured, password)) {
    redirect(`/login?error=1&next=${encodeURIComponent(safeNext)}`);
  }

  const expiresAtMs = Date.now() + ADMIN_SESSION_MAX_AGE_SECONDS * 1000;
  (await cookies()).set(ADMIN_SESSION_COOKIE, signAdminSession(configured, expiresAtMs), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
  });
  redirect(safeNext);
}

export async function logoutAction(): Promise<void> {
  (await cookies()).delete(ADMIN_SESSION_COOKIE);
  redirect("/login");
}
