import "./load-env";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, getDb } from "@/db/client";

async function main() {
  const started = Date.now();
  await migrate(getDb(), { migrationsFolder: "./drizzle" });
  console.log(`✔ Migrations applied in ${Date.now() - started}ms`);
}

main()
  .catch((err) => {
    console.error("✖ Migration failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
