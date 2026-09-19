import { count, eq } from "drizzle-orm";
import { Sidebar } from "@/components/sidebar";
import { getDb } from "@/db/client";
import { jobs } from "@/db/schema";
import { getEnv } from "@/lib/env";

async function loadShellState(): Promise<{ mode: "mock" | "live"; failedCount: number }> {
  // The shell must render even when config or the DB is broken, so the error
  // boundary inside can explain what is wrong instead of a blank page.
  let mode: "mock" | "live" = "mock";
  try {
    mode = getEnv().MOCK_MODE ? "mock" : "live";
    const [row] = await getDb().select({ n: count() }).from(jobs).where(eq(jobs.status, "dead"));
    return { mode, failedCount: row?.n ?? 0 };
  } catch {
    return { mode, failedCount: 0 };
  }
}

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { mode, failedCount } = await loadShellState();
  return (
    <div className="flex min-h-screen">
      <Sidebar mode={mode} failedCount={failedCount} />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
