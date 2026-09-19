import "./load-env";
import { closeDb, getDb } from "@/db/client";
import { seedDatabase } from "@/db/seed";

async function main() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "true") {
    throw new Error("Refusing to wipe and seed a production database. Set ALLOW_DEMO_SEED=true to override.");
  }
  const started = Date.now();
  const summary = await seedDatabase(getDb());
  console.log("✔ Demo data loaded in", `${Date.now() - started}ms`);
  console.table(summary);
}

main()
  .catch((err) => {
    console.error("✖ Seed failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
