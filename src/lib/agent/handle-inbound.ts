import { hashPhone, hashWebVisitor, encryptPhone, decryptPhone, type PiiSecrets } from "@/lib/pii/phone";
import { redactPhones } from "@/lib/pii/redact";
import {
  CONSENT_DECLINED_REPLY,
  CONSENT_GRANTED_REPLY,
  CONSENT_VERSION,
  consentRequestText,
  type ConsentStatus,
  decideConsent,
  RESEND_MESSAGE_REPLY,
  storableBeforeConsent,
  TEXT_ONLY_REPLY,
} from "./consent";
import { isPossibleEmergency } from "./emergency";
import type { RateLimiter } from "@/lib/guard/rate-limit";
import { type MenuChoice, parseMenuChoice, wasMenuShown } from "@/lib/resilience/menu";
import { EMERGENCY_TEXT, HANDOFF_ACK_TEXT, RATE_LIMITED_TEXT, type Reply, staticReply } from "./reply";

/** Longer than the agent's deadline. Renewed before each message in a backlog. */
export const LEASE_MS = 60_000;

export type Tenant = { id: string; name: string };
export type Customer = { id: string; consentStatus: ConsentStatus; phoneEncrypted: string | null };
export type QueuedMessage = { id: number; content: string | null };
export type Channel = "whatsapp" | "web";
export type ConversationStatus = "open" | "handoff" | "closed";

export type ConversationStore = {
  findTenant(receivingNumber: string): Promise<Tenant | null>;
  /** A null phone is a web demo visitor, who has none. */
  findOrCreateCustomer(tenantId: string, phoneHash: string, phoneEncrypted: string | null): Promise<Customer>;
  restorePhone(tenantId: string, customerId: string, phoneEncrypted: string): Promise<void>;
  findOrCreateConversation(tenantId: string, customerId: string, channel: Channel): Promise<string>;
  /** False when this provider message id is already stored. */
  insertInbound(message: {
    tenantId: string;
    conversationId: string;
    providerMessageId: string;
    content: string | null;
    receivedAt: Date;
  }): Promise<boolean>;
  claim(tenantId: string, conversationId: string, until: Date, now: Date): Promise<boolean>;
  renew(tenantId: string, conversationId: string, until: Date): Promise<void>;
  release(tenantId: string, conversationId: string): Promise<void>;
  conversationStatus(tenantId: string, conversationId: string): Promise<ConversationStatus>;
  /** The tools recorded with the last assistant reply, to know whether it was a menu. */
  lastReplyTools(tenantId: string, conversationId: string): Promise<Reply["trace"]["tools"]>;
  markHandoff(tenantId: string, conversationId: string): Promise<void>;
  nextUnprocessed(tenantId: string, conversationId: string): Promise<QueuedMessage | null>;
  customerOf(tenantId: string, conversationId: string): Promise<Customer>;
  setConsent(tenantId: string, customerId: string, status: "granted" | "declined", at: Date, version: string): Promise<void>;
  saveReply(
    tenantId: string,
    conversationId: string,
    text: string,
    providerMessageId: string,
    toolCalls: Reply["trace"]["tools"],
  ): Promise<void>;
  markProcessed(tenantId: string, messageId: number, at: Date): Promise<void>;
};

export type InboundDeps = {
  store: ConversationStore;
  /** Delivers a reply and returns its provider id. The phone is null for a web visitor. */
  send: (phone: string | null, reply: Reply) => Promise<string>;
  agent: (turn: AgentRequest) => Promise<Reply>;
  /** Answers a menu choice from tenant data, with no model. */
  menu: (request: { tenantId: string; conversationId: string; choice: MenuChoice }) => Promise<Reply>;
  /** Per customer, checked before anything that could reach a model. */
  limiter: RateLimiter;
  secrets: PiiSecrets;
  privacyUrl: string;
  now: () => Date;
  /** Fields must never hold a plain phone number or message text. */
  log: (event: string, fields: Record<string, unknown>) => void;
};

export type AgentRequest = { tenantId: string; conversationId: string; customerId: string; messageId: number; text: string };

export type InboundMessage = { channel: Channel; providerMessageId: string; from: string; to: string; body: string };

export type ReceiveResult =
  | { status: "ignored" | "duplicate" }
  | { status: "queued"; tenant: Tenant; conversationId: string };

/** Stores a verified message. Runs inside the webhook request, so it does no slow work. */
export async function receiveInbound(deps: Omit<InboundDeps, "send">, message: InboundMessage): Promise<ReceiveResult> {
  const { store, secrets } = deps;

  const tenant = await store.findTenant(message.to);
  if (!tenant) {
    deps.log("inbound.unknown_tenant", { messageId: message.providerMessageId });
    return { status: "ignored" };
  }

  const phoneHash =
    message.channel === "whatsapp" ? hashPhone(message.from, secrets.pepper) : hashWebVisitor(message.from, secrets.pepper);
  const phoneEncrypted = message.channel === "whatsapp" ? encryptPhone(message.from, secrets.encryptionKey) : null;
  const customer = await store.findOrCreateCustomer(tenant.id, phoneHash, phoneEncrypted);

  const beforeConsent = storableBeforeConsent(message.body);
  if (customer.consentStatus === "declined" && beforeConsent !== "ACEPTO") {
    deps.log("inbound.declined_customer", { tenantId: tenant.id, phoneHash });
    return { status: "ignored" };
  }
  if (customer.phoneEncrypted === null && phoneEncrypted !== null) await store.restorePhone(tenant.id, customer.id, phoneEncrypted);

  const conversationId = await store.findOrCreateConversation(tenant.id, customer.id, message.channel);
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

async function agentReply(
  deps: InboundDeps,
  tenant: Tenant,
  conversationId: string,
  message: QueuedMessage,
  customer: Customer,
): Promise<Reply> {
  const { store } = deps;
  const text = (message.content ?? "").trim();
  if ((await store.conversationStatus(tenant.id, conversationId)) === "handoff") return staticReply(HANDOFF_ACK_TEXT, "handoff");
  if (text.length === 0) return staticReply(TEXT_ONLY_REPLY);

  // Before any model call: this text must not depend on a model, or be delayed by one.
  if (isPossibleEmergency(text)) {
    await store.markHandoff(tenant.id, conversationId);
    deps.log("inbound.emergency", { tenantId: tenant.id, conversationId });
    return staticReply(EMERGENCY_TEXT, "handoff");
  }

  // After the emergency check, so an emergency is never rate-limited.
  const allowed = await deps.limiter.check(`customer:${customer.id}`);
  if (!allowed.ok) {
    deps.log("inbound.rate_limited", { tenantId: tenant.id, conversationId });
    return staticReply(RATE_LIMITED_TEXT, "rate_limited");
  }

  // A number right after a menu picks from it, even once the models are back.
  const choice = parseMenuChoice(text);
  if (choice !== null && wasMenuShown(await store.lastReplyTools(tenant.id, conversationId))) {
    return deps.menu({ tenantId: tenant.id, conversationId, choice });
  }

  return deps.agent({ tenantId: tenant.id, conversationId, customerId: customer.id, messageId: message.id, text });
}

async function replyTo(
  deps: InboundDeps,
  tenant: Tenant,
  conversationId: string,
  message: QueuedMessage,
  customer: Customer,
): Promise<Reply | null> {
  const at = deps.now();
  switch (decideConsent(customer.consentStatus, message.content)) {
    case "grant":
      await deps.store.setConsent(tenant.id, customer.id, "granted", at, CONSENT_VERSION);
      return staticReply(CONSENT_GRANTED_REPLY);
    case "decline":
      // Recorded before sending, so a failed send can't undo a refusal.
      await deps.store.setConsent(tenant.id, customer.id, "declined", at, CONSENT_VERSION);
      return staticReply(CONSENT_DECLINED_REPLY);
    case "request_consent":
      return staticReply(consentRequestText(tenant.name, deps.privacyUrl));
    case "ask_to_resend":
      return staticReply(RESEND_MESSAGE_REPLY);
    case "run_agent":
      return agentReply(deps, tenant, conversationId, message, customer);
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
    const reply = await replyTo(deps, tenant, conversationId, message, customer);
    if (reply !== null) {
      const providerMessageId = await deps.send(phone, reply);
      await store.saveReply(tenant.id, conversationId, reply.text, providerMessageId, reply.trace.tools);
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
        await store.renew(tenant.id, conversationId, new Date(deps.now().getTime() + LEASE_MS));
        await processOne(deps, tenant, conversationId, message);
      }
    } finally {
      await store.release(tenant.id, conversationId);
    }

    if (!(await store.nextUnprocessed(tenant.id, conversationId))) return;
  }
}

/**
 * Stores a message and returns its replies for the caller to put in its own response.
 * A message that arrives while another request holds the lease returns no replies,
 * because that request answers it.
 */
export async function handleInline(deps: Omit<InboundDeps, "send">, message: InboundMessage): Promise<Reply[]> {
  const received = await receiveInbound(deps, message);
  if (received.status !== "queued") return [];

  const replies: Reply[] = [];
  const send = async (_phone: string | null, reply: Reply) => {
    replies.push(reply);
    return `inline:${message.providerMessageId}:${replies.length}`;
  };

  try {
    await drainConversation({ ...deps, send }, received.tenant, received.conversationId);
  } catch (error) {
    deps.log("inbound.drain_failed", { conversationId: received.conversationId, error: redactPhones(String(error)).slice(0, 200) });
  }
  return replies;
}
