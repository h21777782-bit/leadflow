/**
 * Messaging provider contract. Phase 4 ships ONLY a mock implementation.
 * A real provider (HighLevel conversations, an email API, Twilio…) would implement
 * the same interface in a later phase, behind explicit configuration.
 */
export type OutgoingMessage = {
  idempotencyKey: string; // passed to the provider so a retried send cannot deliver twice
  channel: "email" | "sms";
  to: string;
  subject?: string;
  body: string;
};

export type SendResult = { providerMessageId: string; provider: string; simulated: boolean };

export interface MessagingProvider {
  readonly name: string;
  send(msg: OutgoingMessage): Promise<SendResult>;
}
