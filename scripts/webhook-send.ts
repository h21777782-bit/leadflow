/**
 * SIGNS AND SENDS a test webhook event to a running LeadFlow server, using
 * the same HMAC-SHA256 scheme /api/webhooks/* expects from the website/n8n
 * (X-LeadFlow-Timestamp + X-LeadFlow-Signature). Also prints the equivalent
 * curl command, so the exact same request can be replayed or inspected by hand.
 *
 *   npm run webhook:send -- leads
 *   npm run webhook:send -- payments --url http://localhost:3000
 *   npm run webhook:send -- leads --bad-signature      # demo: expect 401
 *   npm run webhook:send -- leads --expired             # demo: expect 401 (stale timestamp)
 */
import "./load-env";
import { getEnv } from "@/lib/env";
import { signHmac } from "@/lib/webhook-signature";

type Resource = "leads" | "contacts" | "opportunities" | "appointments" | "payments" | "messages";

function samplePayload(resource: Resource, eventId: string): Record<string, unknown> {
  const base = { eventId, source: "n8n" };
  switch (resource) {
    case "leads":
      return { ...base, firstName: "Webhook", lastName: "Test", email: `webhook-test-${eventId}@automation.example`, leadSource: "website_form", serviceInterest: "seo", budgetAmount: 4000, tags: "demo-automation" };
    case "contacts":
      return { ...base, firstName: "Webhook", lastName: "Update", email: `webhook-test-${eventId}@automation.example`, leadSource: "website_form", company: "Updated via webhook" };
    case "opportunities":
      return { ...base, opportunityId: "REPLACE_WITH_A_REAL_OPPORTUNITY_ID", toStage: "qualified", reason: "Webhook test" };
    case "appointments":
      return { ...base, email: `webhook-test-${eventId}@automation.example`, title: "Discovery call (webhook test)", startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString(), timezone: "UTC" };
    case "payments":
      return { ...base, opportunityId: "REPLACE_WITH_A_REAL_OPPORTUNITY_ID", amount: 5000, currency: "USD", externalPaymentId: `pay_${eventId}` };
    case "messages":
      return { ...base, email: `webhook-test-${eventId}@automation.example`, channel: "email", body: "[webhook test] Yes, still interested!" };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const resource = (args.find((a) => !a.startsWith("--")) ?? "leads") as Resource;
  const url = args.includes("--url") ? args[args.indexOf("--url") + 1] : "http://localhost:3000";
  const badSignature = args.includes("--bad-signature");
  const expired = args.includes("--expired");

  const env = getEnv();
  const secret = env.WEBHOOK_SIGNING_SECRET;
  if (!secret) throw new Error("WEBHOOK_SIGNING_SECRET is not set in .env.local — generate one with: openssl rand -hex 32");

  const eventId = `test-${Date.now()}`;
  const payload = samplePayload(resource, eventId);
  const rawBody = JSON.stringify(payload);
  const timestamp = expired ? Math.floor(Date.now() / 1000) - 600 : Math.floor(Date.now() / 1000);
  const signature = badSignature ? "sha256=0000000000000000000000000000000000000000000000000000000000000000" : signHmac(secret, rawBody, timestamp);

  const target = `${url.replace(/\/$/, "")}/api/webhooks/${resource}`;
  console.log(`POST ${target}`);
  console.log(`  X-LeadFlow-Timestamp: ${timestamp}${expired ? "  (10 minutes old — expect 401)" : ""}`);
  console.log(`  X-LeadFlow-Signature: ${signature}${badSignature ? "  (deliberately wrong — expect 401)" : ""}`);
  console.log(`  body: ${rawBody}`);

  const curl = [
    `curl -i -X POST '${target}'`,
    `  -H 'Content-Type: application/json'`,
    `  -H 'X-LeadFlow-Timestamp: ${timestamp}'`,
    `  -H 'X-LeadFlow-Signature: ${signature}'`,
    `  -d '${rawBody.replace(/'/g, "'\\''")}'`,
  ].join(" \\\n");
  console.log(`\nEquivalent curl:\n${curl}\n`);

  const res = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-LeadFlow-Timestamp": String(timestamp), "X-LeadFlow-Signature": signature },
    body: rawBody,
  });
  const text = await res.text();
  console.log(`Response: ${res.status} ${res.statusText}`);
  console.log(text);
  if (!badSignature && !expired && res.status >= 400) process.exitCode = 1;
}

main().catch((err) => {
  console.error("✖ webhook:send failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
