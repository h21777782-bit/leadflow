"use client";

import { useEffect } from "react";

/**
 * Shown when a page's data load throws — most commonly because Postgres is not
 * running or DATABASE_URL is wrong. In production Next.js hides the original
 * message (only a digest is sent), so the guidance here is generic on purpose.
 */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error("[ui] page failed to load", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-xl px-8 py-16">
      <h1 className="text-lg font-semibold">This page could not load its data</h1>
      <p className="mt-2 text-muted">
        The most common cause is that the database is not reachable. Check that Postgres is running and that{" "}
        <code className="rounded bg-pending-soft px-1">DATABASE_URL</code> in <code className="rounded bg-pending-soft px-1">.env.local</code> is correct.
        You can confirm with <code className="rounded bg-pending-soft px-1">GET /api/health</code>.
      </p>
      {error.digest && <p className="mt-2 text-[13px] text-faint">Error reference: {error.digest}</p>}
      <button
        type="button"
        onClick={() => retry()}
        className="mt-6 rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent/90"
      >
        Try again
      </button>
    </div>
  );
}
