/**
 * Integration test against a real Postgres.
 *
 * Uses TEST_DATABASE_URL — a SEPARATE database — because the suite wipes and
 * reseeds data. Skipped automatically when TEST_DATABASE_URL is not set, so
 * `npm test` still works on a machine without a database.
 * Proves the database itself (not just app code) enforces our guarantees.
 */
import { hasTestDb } from "./helpers/test-db"; // must be first: points getDb() at TEST_DATABASE_URL
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db/client";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { contacts, messages, stageHistory, webhookEvents, workflowRuns } from "@/db/schema";
import { seedDatabase } from "@/db/seed";
import { getContactDetail, getDashboardSummary, getPipelineBoard, listAppointments, listContacts } from "@/server/queries";


describe.skipIf(!hasTestDb)("database (integration)", () => {
  beforeAll(async () => {
    await migrate(getDb(), { migrationsFolder: "./drizzle" });
    await seedDatabase(getDb());
  });
  afterAll(async () => {
    await closeDb();
  });

  it("seeds 24 contacts, each with an opportunity and stage history", async () => {
    const db = getDb();
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(contacts);
    expect(n).toBe(24);
    const [{ h }] = await db.select({ h: sql<number>`count(distinct opportunity_id)::int` }).from(stageHistory);
    expect(h).toBe(24);
  });

  it("rejects a duplicate contact by normalized email at the DB level", async () => {
    const db = getDb();
    await expect(
      db.insert(contacts).values({ firstName: "Dup", leadSource: "website_form", emailNormalized: "priya@sharmadental.example" }),
    ).rejects.toThrow();
  });

  it("rejects the same webhook event twice (idempotency)", async () => {
    const db = getDb();
    const evt = { source: "website", eventType: "lead.created", externalEventId: "evt_demo_1", payload: {} };
    await db.insert(webhookEvents).values(evt);
    await expect(db.insert(webhookEvents).values(evt)).rejects.toThrow();
  });

  it("rejects a second message with the same idempotency key (no double-send)", async () => {
    const db = getDb();
    const [existing] = await db.select().from(messages).limit(1);
    await expect(
      db.insert(messages).values({ ...existing, id: undefined }),
    ).rejects.toThrow();
  });

  it("allows only one running workflow per contact per workflow", async () => {
    const db = getDb();
    const [running] = await db.select().from(workflowRuns).where(eq(workflowRuns.status, "running")).limit(1);
    await expect(
      db.insert(workflowRuns).values({ workflowKey: running.workflowKey, contactId: running.contactId, status: "running" }),
    ).rejects.toThrow();
  });

  // Regression: a raw `sql` template received a JS Date, which postgres-js
  // cannot serialize there. Only caught by running the real query.
  it("runs every UI read query against real data", async () => {
    const d = await getDashboardSummary();
    expect(d.totalLeads).toBe(24);
    expect(d.newLeads).toBeGreaterThan(0);
    expect(d.won).toBe(2);
    expect(d.lost).toBe(2);
    const board = await getPipelineBoard();
    expect(board.reduce((n, c) => n + c.items.length, 0)).toBe(24);
    const list = await listContacts();
    expect(list).toHaveLength(24);
    const detail = await getContactDetail(list[0].id);
    expect(detail?.history.length).toBeGreaterThan(0);
    const appts = await listAppointments();
    expect(appts.upcoming.every((a) => a.startsAt >= new Date())).toBe(true);
  });
});
