import type { NextRequest } from "next/server";
import { handleWebhookRequest } from "@/server/http/webhook-route";

export async function POST(req: NextRequest) {
  return handleWebhookRequest(req, "contacts");
}
