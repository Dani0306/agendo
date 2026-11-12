import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { decryptPhone } from "@/lib/pii/phone";
import {
  CONSENT_DECLINED_REPLY,
  CONSENT_GRANTED_REPLY,
  RESEND_MESSAGE_REPLY,
  TEXT_ONLY_REPLY,
} from "./consent";
import {
  type ConversationStatus,
  type ConversationStore,
  type Customer,
  drainConversation,
  handleInline,
  type InboundDeps,
  LEASE_MS,
  receiveInbound,
} from "./handle-inbound";
import { allowAll } from "@/lib/guard/rate-limit";
import { EMERGENCY_TEXT, HANDOFF_ACK_TEXT, RATE_LIMITED_TEXT, type Reply, staticReply } from "./reply";

const AGENT_TEXT = "Respuesta del agente";
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
  status: ConversationStatus = "open";
  channels: string[] = [];
  renewals = 0;
  toolLogs: Reply["trace"]["tools"][] = [];

  async findTenant(number: string) {
    return number === CLINIC_NUMBER ? TENANT : null;
  }
  async findOrCreateCustomer(_tenant: string, _hash: string, phoneEncrypted: string | null) {
    this.customer ??= { id: "c1", consentStatus: "pending", phoneEncrypted };
    return { ...this.customer };
  }
  async restorePhone(_tenant: string, _customer: string, phoneEncrypted: string) {
    this.customer!.phoneEncrypted = phoneEncrypted;
  }
  async findOrCreateConversation(_tenant: string, _customer: string, channel: string) {
    this.channels.push(channel);
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
  async renew() {
    this.renewals += 1;
  }
  async conversationStatus() {
    return this.status;
  }
  async lastReplyTools() {
    return this.toolLogs.at(-1) ?? [];
  }
  async markHandoff() {
    this.status = "handoff";
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
  async saveReply(_tenant: string, _conversation: string, text: string, _id: string, tools: Reply["trace"]["tools"]) {
    this.replies.push(text);
    this.toolLogs.push(tools);
  }
  async markProcessed(_tenant: string, id: number) {
    this.rows.find((row) => row.id === id)!.processed = true;
  }
}

let store: MemoryStore;
let deps: InboundDeps & {
  send: Mock<InboundDeps["send"]>;
  log: Mock<InboundDeps["log"]>;
  agent: Mock<InboundDeps["agent"]>;
  menu: Mock<InboundDeps["menu"]>;
};
let clock: Date;
let sid: number;

const message = (body: string, id = `SM${++sid}`) => ({
  channel: "whatsapp" as const,
  providerMessageId: id,
  from: PATIENT,
  to: CLINIC_NUMBER,
  body,
});

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
    agent: vi.fn<InboundDeps["agent"]>(async () => staticReply(AGENT_TEXT)),
    limiter: allowAll,
    menu: vi.fn<InboundDeps["menu"]>(async ({ choice }) => staticReply(`menu ${choice}`, "menu")),
    log: vi.fn<InboundDeps["log"]>(),
  };
});

describe("consent flow", () => {
  it("asks for consent first and stores none of the text", async () => {
    await deliver("me duele la espalda, necesito cita");

    expect(store.rows[0].content).toBeNull();
    expect(deps.send).toHaveBeenCalledOnce();
    expect(deps.send.mock.calls[0][0]).toBe("+573000000001");
    expect(deps.send.mock.calls[0][1].text).toContain("datos sensibles");
  });

  it("grants on ACEPTO, then stores and answers the next message", async () => {
    await deliver("hola");
    await deliver("acepto.");
    expect(store.customer!.consentStatus).toBe("granted");
    expect(store.replies.at(-1)).toBe(CONSENT_GRANTED_REPLY);

    await deliver("quiero una cita");
    expect(store.rows.at(-1)!.content).toBe("quiero una cita");
    expect(store.replies.at(-1)).toBe(AGENT_TEXT);
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
    expect(deps.send.mock.calls.at(-1)![1].text).toBe(CONSENT_DECLINED_REPLY);
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
    expect(deps.send.mock.calls.at(-1)![1].text).toBe(CONSENT_GRANTED_REPLY);
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

describe("agent gate", () => {
  async function consented() {
    await deliver("hola");
    await deliver("ACEPTO");
    deps.agent.mockClear();
  }

  it("never calls the agent before consent", async () => {
    await deliver("quiero una cita");
    expect(deps.agent).not.toHaveBeenCalled();
  });

  it("passes server-side ids and the stored message id to the agent", async () => {
    await consented();
    await deliver("quiero una cita");
    expect(deps.agent).toHaveBeenCalledWith({
      tenantId: "t1",
      conversationId: "conv1",
      customerId: "c1",
      messageId: 3,
      text: "quiero una cita",
    });
  });

  it("answers an emergency statically, hands off and calls no model", async () => {
    await consented();
    await deliver("Tengo un dolor en el pecho muy fuerte");
    expect(deps.agent).not.toHaveBeenCalled();
    expect(store.replies.at(-1)).toBe(EMERGENCY_TEXT);
    expect(store.status).toBe("handoff");
  });

  it("answers statically when the customer is over the rate limit, keyed by customer", async () => {
    await consented();
    const keys: string[] = [];
    deps.limiter = {
      check: async (key) => {
        keys.push(key);
        return { ok: false, retryAfterMs: 1000 };
      },
    };
    await deliver("quiero una cita");
    expect(deps.agent).not.toHaveBeenCalled();
    expect(store.replies.at(-1)).toBe(RATE_LIMITED_TEXT);
    expect(keys).toEqual(["customer:c1"]);
  });

  it("never rate-limits an emergency", async () => {
    await consented();
    deps.limiter = { check: async () => ({ ok: false, retryAfterMs: 1000 }) };
    await deliver("no puedo respirar");
    expect(store.replies.at(-1)).toBe(EMERGENCY_TEXT);
  });

  it("answers a number after a menu from the menu, with no agent", async () => {
    await consented();
    deps.agent.mockResolvedValueOnce({ text: "menú", degraded: "menu", trace: { model: null, tools: [{ name: "menu", status: "shown" }] } });
    await deliver("hola");
    deps.agent.mockClear();

    await deliver(" 2 ");
    expect(deps.agent).not.toHaveBeenCalled();
    expect(deps.menu).toHaveBeenCalledWith({ tenantId: "t1", conversationId: "conv1", choice: 2 });
    expect(store.replies.at(-1)).toBe("menu 2");
  });

  it("treats a number as a normal message when no menu was shown", async () => {
    await consented();
    await deliver("2");
    expect(deps.menu).not.toHaveBeenCalled();
    expect(deps.agent).toHaveBeenCalledOnce();
  });

  it("keeps the agent silent during a handoff and still acknowledges", async () => {
    await consented();
    store.status = "handoff";
    await deliver("¿hola?");
    expect(deps.agent).not.toHaveBeenCalled();
    expect(store.replies.at(-1)).toBe(HANDOFF_ACK_TEXT);
  });

  it("doesn't call the agent for a message with no text", async () => {
    await consented();
    await deliver("   ");
    expect(deps.agent).not.toHaveBeenCalled();
    expect(store.replies.at(-1)).toBe(TEXT_ONLY_REPLY);
  });

  it("stores which tools ran with the reply", async () => {
    await consented();
    deps.agent.mockResolvedValueOnce({ text: "ok", trace: { model: "m", tools: [{ name: "my_bookings", status: "ok" }] } });
    await deliver("¿cuándo es mi cita?");
    expect(store.toolLogs.at(-1)).toEqual([{ name: "my_bookings", status: "ok" }]);
  });
});

describe("handleInline", () => {
  it("returns the replies instead of sending them", async () => {
    const replies = await handleInline(deps, message("hola"));
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain("datos sensibles");
    expect(deps.send).not.toHaveBeenCalled();
    expect(store.replies).toHaveLength(1);
  });

  it("returns nothing for a provider retry", async () => {
    await handleInline(deps, message("hola", "SMretry"));
    expect(await handleInline(deps, message("hola", "SMretry"))).toEqual([]);
  });

  it("serves a web visitor with no phone at all", async () => {
    const replies = await handleInline(deps, { ...message("hola"), channel: "web", from: "session-1" });
    expect(replies).toHaveLength(1);
    expect(store.customer!.phoneEncrypted).toBeNull();
    expect(store.channels).toEqual(["web"]);
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

    expect(deps.send.mock.calls.slice(1).map((call) => call[1].text)).toEqual([CONSENT_GRANTED_REPLY, AGENT_TEXT]);
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

  it("renews the lease before each message in a backlog", async () => {
    await receiveInbound(deps, message("uno"));
    await receiveInbound(deps, message("dos"));

    await drainConversation(deps, TENANT, "conv1");

    expect(store.renewals).toBe(2);
  });

  it("takes over a lease left behind by a crash", async () => {
    await receiveInbound(deps, message("uno"));
    store.leaseUntil = new Date(clock.getTime() - LEASE_MS);

    await drainConversation(deps, TENANT, "conv1");

    expect(deps.send).toHaveBeenCalledOnce();
  });
});
