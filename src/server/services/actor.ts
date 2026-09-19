import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { users } from "@/db/schema";
import { getEnv } from "@/lib/env";
import type { Actor } from "./types";

/**
 * DEMO LIMITATION: there is no login yet. Every UI action is attributed to the
 * user configured in DEMO_ACTOR_EMAIL (default: the seeded "Ops Admin").
 * With real auth this would come from the session.
 */
export async function getActingUser(db: Database): Promise<Actor> {
  const email = getEnv().DEMO_ACTOR_EMAIL;
  const [u] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, email));
  return u ? { type: "user", userId: u.id, label: u.name } : { type: "user", userId: null, label: email };
}
