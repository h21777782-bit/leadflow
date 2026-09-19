import "./load-env";
import { describeIntegrationConfig, EnvValidationError, parseEnv } from "@/lib/env";

// Prints whether the current environment is valid. Never prints secret values.
try {
  const env = parseEnv(process.env);
  console.log("✔ Environment is valid");
  console.log(JSON.stringify(describeIntegrationConfig(env), null, 2));
} catch (err) {
  if (err instanceof EnvValidationError) {
    console.error(`✖ ${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
