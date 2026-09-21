import type { Database } from "@/db/client";
import { getEnv } from "@/lib/env";
import type { CallContext } from "./http-client";
import { HighLevelProvider } from "./highlevel-provider";
import { MockCrmProvider } from "./mock-provider";
import type { CrmProvider } from "./types";

/** The ONLY place that decides which CRM provider is used, same pattern as messaging. */
export function getCrmProvider(db: Database, ctx?: (operation: string) => CallContext): CrmProvider {
  if (getEnv().MOCK_MODE) return new MockCrmProvider(db, ctx);
  return new HighLevelProvider(db, ctx);
}

export { CRM_FAILURE_SWITCH_KEY, type CrmFailureMode } from "./mock-provider";
export type * from "./types";
