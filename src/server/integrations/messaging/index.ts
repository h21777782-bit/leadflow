import type { Database } from "@/db/client";
import { getEnv } from "@/lib/env";
import { MockMessagingProvider } from "./mock-provider";
import type { MessagingProvider } from "./types";
import { PermanentJobError } from "@/lib/job-errors";

/**
 * The ONLY place that decides which provider is used. No real provider exists
 * in Phase 4, so live mode refuses to send rather than silently pretending.
 */
export function getMessagingProvider(db: Database): MessagingProvider {
  if (getEnv().MOCK_MODE) return new MockMessagingProvider(db);
  return {
    name: "none",
    async send() {
      throw new PermanentJobError("No real messaging provider is configured (MOCK_MODE=false). Nothing was sent.");
    },
  };
}
