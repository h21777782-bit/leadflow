import { describe, expect, it } from "vitest";
import { describeIntegrationConfig, EnvValidationError, parseEnv } from "@/lib/env";

const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

describe("parseEnv", () => {
  it("applies safe defaults (mock mode ON by default)", () => {
    const env = parseEnv(base);
    expect(env.MOCK_MODE).toBe(true);
    expect(env.HIGHLEVEL_API_BASE_URL).toBe("https://services.leadconnectorhq.com");
    expect(env.HIGHLEVEL_API_VERSION).toBe("v3");
  });

  it("rejects a missing DATABASE_URL with a readable error", () => {
    expect(() => parseEnv({})).toThrow(EnvValidationError);
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() => parseEnv({ DATABASE_URL: "mysql://x" })).toThrow(/postgres/);
  });

  it("requires HighLevel credentials only when MOCK_MODE=false", () => {
    expect(() => parseEnv({ ...base, MOCK_MODE: "false" })).toThrow(/HIGHLEVEL_PRIVATE_TOKEN/);
    const live = parseEnv({ ...base, MOCK_MODE: "false", HIGHLEVEL_PRIVATE_TOKEN: "pit-x", HIGHLEVEL_LOCATION_ID: "loc" });
    expect(live.MOCK_MODE).toBe(false);
  });

  it("never exposes secret values in the integration summary", () => {
    const env = parseEnv({ ...base, HIGHLEVEL_PRIVATE_TOKEN: "pit-super-secret" });
    const summary = JSON.stringify(describeIntegrationConfig(env));
    expect(summary).not.toContain("pit-super-secret");
    expect(summary).toContain('"tokenConfigured":true');
  });
});
