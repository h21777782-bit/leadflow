import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { loginAction } from "@/app/actions/admin-auth";
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from "@/lib/admin-session";
import { getEnv } from "@/lib/env";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  await connection();
  const sp = await searchParams;
  const next = typeof sp.next === "string" && sp.next.startsWith("/") ? sp.next : "/";
  const error = sp.error === "1";
  const password = getEnv().ADMIN_PASSWORD;

  if (!password) redirect(next); // login disabled — nothing to sign in to
  const existing = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  if (verifyAdminSession(password, existing)) redirect(next);

  return (
    <div className="grid min-h-screen place-items-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2">
          <span aria-hidden className="grid size-7 place-items-center rounded-md bg-accent text-[13px] font-semibold text-white">LF</span>
          <span className="text-[15px] font-semibold">LeadFlow</span>
        </div>
        <h1 className="text-lg font-semibold tracking-tight">Admin sign in</h1>
        <p className="mt-1 text-[13px] text-muted">This demo is gated behind a single shared password (see .env.example).</p>

        {error && <p className="mt-4 rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-[13px] text-bad">Incorrect password.</p>}

        <form action={loginAction} className="mt-4 space-y-3">
          <input type="hidden" name="next" value={next} />
          <label className="block text-[13px]">
            <span className="mb-1 block font-medium">Password</span>
            <input
              type="password"
              name="password"
              autoFocus
              required
              className="w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-[14px]"
            />
          </label>
          <button type="submit" className="w-full rounded-md bg-accent px-3 py-2 font-medium text-white hover:bg-accent/90">
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
