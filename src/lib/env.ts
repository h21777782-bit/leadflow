import { z } from "zod";

/**
 * Central, validated environment configuration.
 *
 * Every secret comes from environment variables. Nothing is hardcoded.
 * Validation runs lazily (on first access) so `next build` does not need a
 * database or credentials to compile the app.
 */
const booleanFromString = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z
      .string({ error: "DATABASE_URL is required" })
      .min(1, "DATABASE_URL is required")
      .refine((v) => v.startsWith("postgres://") || v.startsWith("postgresql://"), {
        message: "DATABASE_URL must be a postgres:// or postgresql:// URL",
      }),
    APP_TIMEZONE: z.string().default("Asia/Kolkata"),
    DEFAULT_CURRENCY: z.string().length(3).default("USD"),
    // No login in this demo: UI actions are attributed to this user (see server/services/actor.ts).
    DEMO_ACTOR_EMAIL: z.email().default("admin@leadflow.example"),

    // Integration mode. MOCK_MODE=true keeps every external call inside the
    // isolated mock provider (added in Phase 5).
    MOCK_MODE: booleanFromString.default(true),

    // HighLevel (only required when MOCK_MODE=false — enforced below).
    HIGHLEVEL_API_BASE_URL: z.url().default("https://services.leadconnectorhq.com"),
    HIGHLEVEL_API_VERSION: z.string().default("2021-07-28"),
    HIGHLEVEL_PRIVATE_TOKEN: z.string().optional(),
    HIGHLEVEL_LOCATION_ID: z.string().optional(),
    HIGHLEVEL_PIPELINE_ID: z.string().optional(),
    HIGHLEVEL_CALENDAR_ID: z.string().optional(),
    HIGHLEVEL_WEBHOOK_PUBLIC_KEY: z.string().optional(),

    // Shared secret used to sign webhooks from our own site / n8n (Phase 6).
    WEBHOOK_SIGNING_SECRET: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (!env.MOCK_MODE) {
      for (const key of ["HIGHLEVEL_PRIVATE_TOKEN", "HIGHLEVEL_LOCATION_ID"] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when MOCK_MODE=false`,
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvValidationError";
  }
}

/** Pure parser — used by tests and by getEnv(). */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return result.data;
}

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}

/** Safe summary for the Integrations page — never exposes secret values. */
export function describeIntegrationConfig(env: Env) {
  return {
    mode: env.MOCK_MODE ? ("mock" as const) : ("live" as const),
    highlevel: {
      baseUrl: env.HIGHLEVEL_API_BASE_URL,
      apiVersion: env.HIGHLEVEL_API_VERSION,
      tokenConfigured: Boolean(env.HIGHLEVEL_PRIVATE_TOKEN),
      locationConfigured: Boolean(env.HIGHLEVEL_LOCATION_ID),
      pipelineConfigured: Boolean(env.HIGHLEVEL_PIPELINE_ID),
      calendarConfigured: Boolean(env.HIGHLEVEL_CALENDAR_ID),
      webhookKeyConfigured: Boolean(env.HIGHLEVEL_WEBHOOK_PUBLIC_KEY),
    },
    webhookSigningConfigured: Boolean(env.WEBHOOK_SIGNING_SECRET),
  };
}
