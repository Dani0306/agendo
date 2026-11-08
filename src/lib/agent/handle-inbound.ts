import { hashPhone, encryptPhone, decryptPhone, type PiiSecrets } from "@/lib/pii/phone";
import { redactPhones } from "@/lib/pii/redact";
import {
  CONSENT_DECLINED_REPLY,
  CONSENT_GRANTED_REPLY,
  CONSENT_VERSION,
  consentRequestText,
  type ConsentStatus,
  decideConsent,
  MESSAGE_RECEIVED_REPLY,
  RESEND_MESSAGE_REPLY,
  storableBeforeConsent,
} from "./consent";

/** Long enough for several static replies. The agent loop will have to renew it. */
export const LEASE_MS = 60_000;

export type Tenant = { id: string; name: string };
export type Customer = { id: string; consentStatus: ConsentStatus; phoneEncrypted: string | null };
export type QueuedMessage = { id: number; content: string | null };

export type ConversationStore = {
  findTenant(receivingNumber: string): Promise<Tenant | null>;
  findOrCreateCustomer(tenantId: string, phoneHash: string, phoneEncrypted: string): Promise<Customer>;
  restorePhone(tenantId: string, customerId: string, phoneEncrypted: string): Promise<void>;
  findOrCreateConversation(tenantId: string, customerId: string): Promise<string>;
  /** False when this provider message id is already stored. */
  insertInbound(message: {
    tenantId: string;
    conversationId: string;
    providerMessageId: string;
    content: string | null;
    receivedAt: Date;
  }): Promise<boolean>;
  claim(tenantId: string, conversationId: string, until: Date, now: Date): Promise<boolean>;
  release(tenantId: string, conversationId: string): Promise<void>;
  nextUnprocessed(tenantId: string, conversationId: string): Promise<QueuedMessage | null>;
  customerOf(tenantId: string, conversationId: string): Promise<Customer>;
  setConsent(tenantId: string, customerId: string, status: "granted" | "declined", at: Date, version: string): Promise<void>;
  saveReply(tenantId: string, conversationId: string, text: string, providerMessageId: string): Promise<void>;
  markProcessed(tenantId: string, messageId: number, at: Date): Promise<void>;
};

export type InboundDeps = {
  store: ConversationStore;
  send: (phone: string, text: string) => Promise<string>;
  secrets: PiiSecrets;
  privacyUrl: string;
  now: () => Date;
  /** Fields must never hold a plain phone number or message text. */
  log: (event: string, fields: Record<string, unknown>) => void;
};

export type InboundMessage = { providerMessageId: string; from: string; to: string; body: string };

export type ReceiveResult =
  | { status: "ignored" | "duplicate" }
  | { status: "queued"; tenant: Tenant; conversationId: string };

/** Stores a verified message. Runs inside the webhook request, so it does no slow work. */
export async function receiveInbound(deps: InboundDeps, message: InboundMessage): Promise<ReceiveResult> {
  const { store, secrets } = deps;

  const tenant = await store.findTenant(message.to);
  if (!tenant) {
    deps.log("inbound.unknown_tenant", { messageId: message.providerMessageId });
    return { status: "ignored" };
  }

  const phoneHash = hashPhone(message.from, secrets.pepper);
  const phoneEncrypted = encryptPhone(message.from, secrets.encryptionKey);
  const customer = await store.findOrCreateCustomer(tenant.id, phoneHash, phoneEncrypted);

  const beforeConsent = storableBeforeConsent(message.body);
  if (customer.consentStatus === "declined" && beforeConsent !== "ACEPTO") {
    deps.log("inbound.declined_customer", { tenantId: tenant.id, phoneHash });
    return { status: "ignored" };
  }
  if (customer.phoneEncrypted === null) await store.restorePhone(tenant.id, customer.id, phoneEncrypted);

  const conversationId = await store.findOrCreateConversation(tenant.id, customer.id);
  const inserted = await store.insertInbound({
    tenantId: tenant.id,
    conversationId,
    providerMessageId: message.providerMessageId,
    content: customer.consentStatus === "granted" ? message.body : beforeConsent,
    receivedAt: deps.now(),
  });

  if (!inserted) {
    deps.log("inbound.duplicate", { tenantId: tenant.id, messageId: message.providerMessageId });
    return { status: "duplicate" };
  }
  return { status: "queued", tenant, conversationId };
}

async function replyTo(deps: InboundDeps, tenant: Tenant, message: QueuedMessage, customer: Customer): Promise<string | null> {
  const at = deps.now();
  switch (decideConsent(customer.consentStatus, message.content)) {
    case "grant":
      await deps.store.setConsent(tenant.id, customer.id, "granted", at, CONSENT_VERSION);
      return CONSENT_GRANTED_REPLY;
    case "decline":
      // Recorded before sending, so a failed send can't undo a refusal.
      await deps.store.setConsent(tenant.id, customer.id, "declined", at, CONSENT_VERSION);
      return CONSENT_DECLINED_REPLY;
    case "request_consent":
      return consentRequestText(tenant.name, deps.privacyUrl);
    case "ask_to_resend":
      return RESEND_MESSAGE_REPLY;
    case "acknowledge":
      return MESSAGE_RECEIVED_REPLY;
    case "ignore":
      return null;
  }
}

async function processOne(deps: InboundDeps, tenant: Tenant, conversationId: string, message: QueuedMessage) {
  const { store, secrets } = deps;
  try {
    const customer = await store.customerOf(tenant.id, conversationId);
    // Read first: declining deletes the stored number, and the reply still has to go out.
    const phone = customer.phoneEncrypted ? decryptPhone(customer.phoneEncrypted, secrets.encryptionKey) : null;
    const text = await replyTo(deps, tenant, message, customer);
    if (text !== null && phone !== null) {
      const providerMessageId = await deps.send(phone, text);
      await store.saveReply(tenant.id, conversationId, text, providerMessageId);
    }
  } catch (error) {
    // A reply that can't be sent is dropped so the queue keeps moving. Phase 4 adds the fallback.
    const detail = error instanceof Error ? error.message : String(error);
    deps.log("inbound.reply_failed", { tenantId: tenant.id, conversationId, error: redactPhones(detail) });
  }
  // After the send: a crash here can repeat a static reply, but can't lose one.
  await store.markProcessed(tenant.id, message.id, deps.now());
}

/**
 * Handles a conversation's messages one at a time. Whoever fails to claim the lease
 * stops, because the holder will reach the message. The check after releasing covers
 * a message that arrived while the holder was on its way out.
 */
export async function drainConversation(deps: InboundDeps, tenant: Tenant, conversationId: string): Promise<void> {
  const { store } = deps;
  for (;;) {
    const now = deps.now();
    const claimed = await store.claim(tenant.id, conversationId, new Date(now.getTime() + LEASE_MS), now);
    if (!claimed) return;

    try {
      for (;;) {
        const message = await store.nextUnprocessed(tenant.id, conversationId);
        if (!message) break;
        await processOne(deps, tenant, conversationId, message);
      }
    } finally {
      await store.release(tenant.id, conversationId);
    }

    if (!(await store.nextUnprocessed(tenant.id, conversationId))) return;
  }
}
