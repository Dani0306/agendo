import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { decryptPhone } from "@/lib/pii/phone";
import {
  CONSENT_DECLINED_REPLY,
  CONSENT_GRANTED_REPLY,
  MESSAGE_RECEIVED_REPLY,
  RESEND_MESSAGE_REPLY,
} from "./consent";
import {
  type ConversationStore,
  type Customer,
  drainConversation,
  type InboundDeps,
  LEASE_MS,
  receiveInbound,
} from "./handle-inbound";

const TENANT = { id: "t1", name: "Fisio Aurora (demo)" };
const CLINIC_NUMBER = "whatsapp:+14155238886";
const PATIENT = "whatsapp:+573000000001";
const secrets = { pepper: "p".repeat(32), encryptionKey: randomBytes(32) };

type Row = { id: number; content: string | null; processed: boolean; sid: string };

class MemoryStore implements ConversationStore {
  customer: Customer | null = null;
  rows: Row[] = [];
  replies: string[] = [];
  leaseUntil: Date | null = null;
  beforeRelease: (() => void) | null = null;
  consentCalls = 0;

  async findTenant(number: string) {
    return number === CLINIC_NUMBER ? TENANT : null;
  }
  async findOrCreateCustomer(_tenant: string, _hash: string, phoneEncrypted: string) {
    this.customer ??= { id: "c1", consentStatus: "pending", phoneEncrypted };
    return { ...this.customer };
  }
  async restorePhone(_tenant: string, _customer: string, phoneEncrypted: string) {
    this.customer!.phoneEncrypted = phoneEncrypted;
  }
  async findOrCreateConversation() {
    return "conv1";
  }
  async insertInbound(message: { providerMessageId: string; content: string | null }) {
    if (this.rows.some((row) => row.sid === message.providerMessageId)) return false;
    this.rows.push({ id: this.rows.length + 1, content: message.content, processed: false, sid: message.providerMessageId });
    return true;
  }
  async claim(_tenant: string, _conversation: string, until: Date, now: Date) {
    if (this.leaseUntil && this.leaseUntil >= now) return false;
    this.leaseUntil = until;
    return true;
  }
  async release() {
    this.beforeRelease?.();
    this.beforeRelease = null;
    this.leaseUntil = null;
  }
  async nextUnprocessed() {
    const row = this.rows.find((candidate) => !candidate.processed);
    return row ? { id: row.id, content: row.content } : null;
  }
  async customerOf() {
    return { ...this.customer! };
  }
  async setConsent(_tenant: string, _customer: string, status: "granted" | "declined") {
    this.consentCalls += 1;
    this.customer!.consentStatus = status;
    if (status === "declined") this.customer!.phoneEncrypted = null;
  }
  async saveReply(_tenant: string, _conversation: string, text: string) {
    this.replies.push(text);
  }
  async markProcessed(_tenant: string, id: number) {
    this.rows.find((row) => row.id === id)!.processed = true;
  }
}

let store: MemoryStore;
let deps: InboundDeps & { send: Mock<InboundDeps["send"]>; log: Mock<InboundDeps["log"]> };
let clock: Date;
let sid: number;

const message = (body: string, id = `SM${++sid}`) => ({ providerMessageId: id, from: PATIENT, to: CLINIC_NUMBER, body });

async function deliver(body: string, id?: string) {
  const result = await receiveInbound(deps, message(body, id));
  if (result.status === "queued") await drainConversation(deps, result.tenant, result.conversationId);
  return result;
}

beforeEach(() => {
  store = new MemoryStore();
  clock = new Date("2026-11-09T15:00:00Z");
  sid = 0;
  deps = {
    store,
    secrets,
    privacyUrl: "https://example.test/privacidad",
    now: () => clock,
    send: vi.fn<InboundDeps["send"]>(async () => "SMout"),
    log: vi.fn<InboundDeps["log"]>(),
  };
});

describe("consent flow", () => {
  it("asks for consent first and stores none of the text", async () => {
    await deliver("me duele la espalda, necesito cita");

    expect(store.rows[0].content).toBeNull();
    expect(deps.send).toHaveBeenCalledOnce();
    expect(deps.send.mock.calls[0][0]).toBe("+573000000001");
    expect(deps.send.mock.calls[0][1]).toContain("datos sensibles");
  });

  it("grants on ACEPTO, then stores and answers the next message", async () => {
    await deliver("hola");
    await deliver("acepto.");
    expect(store.customer!.consentStatus).toBe("granted");
    expect(store.replies.at(-1)).toBe(CONSENT_GRANTED_REPLY);

    await deliver("quiero una cita");
    expect(store.rows.at(-1)!.content).toBe("quiero una cita");
    expect(store.replies.at(-1)).toBe(MESSAGE_RECEIVED_REPLY);
  });

  it("keeps asking until there is an answer", async () => {
    await deliver("hola");
    await deliver("¿cuánto cuesta?");
    expect(store.customer!.consentStatus).toBe("pending");
    expect(deps.send).toHaveBeenCalledTimes(2);
  });

  it("on NO, deletes the number but still sends the reply", async () => {
    await deliver("hola");
    await deliver("no");

    expect(store.customer).toMatchObject({ consentStatus: "declined", phoneEncrypted: null });
    expect(deps.send.mock.calls.at(-1)![1]).toBe(CONSENT_DECLINED_REPLY);
  });

  it("ignores a customer who declined, storing nothing", async () => {
    await deliver("hola");
    await deliver("no");
    const rowsBefore = store.rows.length;
    const sendsBefore = deps.send.mock.calls.length;

    const result = await deliver("me duele la rodilla");

    expect(result.status).toBe("ignored");
    expect(store.rows).toHaveLength(rowsBefore);
    expect(deps.send).toHaveBeenCalledTimes(sendsBefore);
  });

  it("lets a customer who declined change their mind, restoring the number", async () => {
    await deliver("hola");
    await deliver("no");
    await deliver("ACEPTO");

    expect(store.customer!.consentStatus).toBe("granted");
    expect(decryptPhone(store.customer!.phoneEncrypted!, secrets.encryptionKey)).toBe("+573000000001");
    expect(deps.send.mock.calls.at(-1)![1]).toBe(CONSENT_GRANTED_REPLY);
  });

  it("asks to resend a message that overtook the consent", async () => {
    await deliver("hola");
    const accept = await receiveInbound(deps, message("ACEPTO"));
    const overtaken = await receiveInbound(deps, message("quiero una cita"));
    expect(accept.status).toBe("queued");
    expect(overtaken.status).toBe("queued");

    await drainConversation(deps, TENANT, "conv1");

    expect(store.rows.at(-1)!.content).toBeNull();
    expect(store.replies.at(-1)).toBe(RESEND_MESSAGE_REPLY);
  });

  it("records a refusal even when the reply can't be sent", async () => {
    await deliver("hola");
    deps.send.mockRejectedValueOnce(new Error("Twilio down"));
    await deliver("no");

    expect(store.customer!.consentStatus).toBe("declined");
    expect(store.rows.every((row) => row.processed)).toBe(true);
  });
});

describe("delivery", () => {
  it("drops a provider retry: one row, one reply", async () => {
    await deliver("hola", "SMretry");
    const retry = await deliver("hola", "SMretry");

    expect(retry.status).toBe("duplicate");
    expect(store.rows).toHaveLength(1);
    expect(deps.send).toHaveBeenCalledOnce();
  });

  it("drops a message for an unknown number without replying", async () => {
    const result = await receiveInbound(deps, { ...message("hola"), to: "whatsapp:+19990000000" });

    expect(result.status).toBe("ignored");
    expect(store.customer).toBeNull();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("keeps the queue moving when a send fails, with the phone out of the log", async () => {
    deps.send.mockRejectedValueOnce(new Error("failed for whatsapp:+573000000001"));

    await deliver("hola");

    expect(store.rows[0].processed).toBe(true);
    expect(JSON.stringify(deps.log.mock.calls)).not.toContain("573000000001");
    expect(store.leaseUntil).toBeNull();
  });

  it("never logs a plain phone number or the message", async () => {
    await deliver("hola");
    await deliver("no");
    await deliver("me duele la rodilla");

    const logged = JSON.stringify(deps.log.mock.calls);
    expect(logged).not.toContain("573000000001");
    expect(logged).not.toContain("rodilla");
  });
});

describe("one worker per conversation", () => {
  it("answers each message once when workers run at the same time", async () => {
    await receiveInbound(deps, message("uno"));
    await receiveInbound(deps, message("dos"));
    await receiveInbound(deps, message("tres"));

    await Promise.all([
      drainConversation(deps, TENANT, "conv1"),
      drainConversation(deps, TENANT, "conv1"),
      drainConversation(deps, TENANT, "conv1"),
    ]);

    expect(deps.send).toHaveBeenCalledTimes(3);
    expect(store.rows.every((row) => row.processed)).toBe(true);
  });

  it("handles messages in the order they arrived", async () => {
    await deliver("hola");
    await receiveInbound(deps, message("ACEPTO"));
    await receiveInbound(deps, message("NO"));

    await drainConversation(deps, TENANT, "conv1");

    expect(deps.send.mock.calls.slice(1).map((call) => call[1])).toEqual([CONSENT_GRANTED_REPLY, MESSAGE_RECEIVED_REPLY]);
  });

  it("picks up a message that arrives during the release", async () => {
    await receiveInbound(deps, message("uno"));
    store.beforeRelease = () => {
      store.rows.push({ id: 2, content: null, processed: false, sid: "SMlate" });
    };

    await drainConversation(deps, TENANT, "conv1");

    expect(store.rows.every((row) => row.processed)).toBe(true);
    expect(deps.send).toHaveBeenCalledTimes(2);
  });

  it("leaves a live lease alone", async () => {
    await receiveInbound(deps, message("uno"));
    store.leaseUntil = new Date(clock.getTime() + 1000);

    await drainConversation(deps, TENANT, "conv1");

    expect(deps.send).not.toHaveBeenCalled();
  });

  it("takes over a lease left behind by a crash", async () => {
    await receiveInbound(deps, message("uno"));
    store.leaseUntil = new Date(clock.getTime() - LEASE_MS);

    await drainConversation(deps, TENANT, "conv1");

    expect(deps.send).toHaveBeenCalledOnce();
  });
});
