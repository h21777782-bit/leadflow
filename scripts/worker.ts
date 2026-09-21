/**
 * Background worker process.
 *
 *   npm run worker          # long-running (local, or Railway/Render/Fly as a separate service)
 *   npm run worker:once     # process currently due jobs once and exit (demos, cron-style runs)
 *
 * This must NOT run inside a Vercel serverless function: those are short-lived and
 * cannot keep a polling loop alive. The web app only writes jobs to Postgres; this
 * process executes them.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { closeDb, getDb } from "@/db/client";
import { runOnce, runWorker } from "@/server/worker/runner";

const once = process.argv.includes("--once");
const workerId = process.env.WORKER_ID ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 6)}`;
const stamp = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

async function main() {
  const db = getDb();
  if (once) {
    const r = await runOnce(db, workerId, stamp);
    stamp(`run-once finished: recovered ${r.recovered}, claimed ${r.claimed}, outcomes [${r.outcomes.join(", ")}]`);
    return;
  }
  const controller = new AbortController();
  const stop = (sig: string) => {
    if (controller.signal.aborted) return;
    stamp(`${sig} received — finishing current batch, then exiting`);
    controller.abort();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM")); // what Railway/Docker send on deploy/stop
  await runWorker(db, { workerId, signal: controller.signal, log: stamp });
}

main()
  .catch((err) => {
    console.error("✖ worker crashed:", err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
