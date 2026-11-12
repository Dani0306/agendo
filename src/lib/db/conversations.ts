import type { ConversationStatus, ConversationStore, Customer } from "@/lib/agent/handle-inbound";
import type { ConsentStatus } from "@/lib/agent/consent";
import type { Db } from "./client";
import { unwrap } from "./unwrap";

type CustomerRow = { id: string; consent_status: ConsentStatus; phone_encrypted: string | null };

const CUSTOMER_COLUMNS = "id, consent_status, phone_encrypted";

function toCustomer(row: CustomerRow): Customer {
  return { id: row.id, consentStatus: row.consent_status, phoneEncrypted: row.phone_encrypted };
}

export async function markConversationHandoff(client: Db, tenantId: string, conversationId: string): Promise<void> {
  unwrap(
    await client
      .from("conversations")
      .update({ status: "handoff" })
      .eq("tenant_id", tenantId)
      .eq("id", conversationId)
      .select("id"),
  );
}

/** The secret key bypasses RLS, so every query here filters by tenant_id itself. */
export function conversationStore(client: Db): ConversationStore {
  return {
    async findTenant(receivingNumber) {
      const { data, error } = await client
        .from("tenants")
        .select("id, name")
        .eq("receiving_number", receivingNumber)
        .maybeSingle();
      return unwrap({ data: [data], error })[0] as { id: string; name: string } | null;
    },

    async findOrCreateCustomer(tenantId, phoneHash, phoneEncrypted) {
      // ignoreDuplicates makes concurrent first messages safe and leaves an existing row untouched.
      unwrap(
        await client
          .from("customers")
          .upsert(
            { tenant_id: tenantId, phone_hash: phoneHash, phone_encrypted: phoneEncrypted },
            { onConflict: "tenant_id,phone_hash", ignoreDuplicates: true },
          )
          .select("id"),
      );
      const row = unwrap(
        await client
          .from("customers")
          .select(CUSTOMER_COLUMNS)
          .eq("tenant_id", tenantId)
          .eq("phone_hash", phoneHash)
          .single(),
      ) as CustomerRow;
      return toCustomer(row);
    },

    async restorePhone(tenantId, customerId, phoneEncrypted) {
      unwrap(
        await client
          .from("customers")
          .update({ phone_encrypted: phoneEncrypted })
          .eq("tenant_id", tenantId)
          .eq("id", customerId)
          .select("id"),
      );
    },

    async findOrCreateConversation(tenantId, customerId, channel) {
      unwrap(
        await client
          .from("conversations")
          .upsert(
            { tenant_id: tenantId, customer_id: customerId, channel },
            { onConflict: "tenant_id,customer_id,channel", ignoreDuplicates: true },
          )
          .select("id"),
      );
      const row = unwrap(
        await client
          .from("conversations")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("customer_id", customerId)
          .eq("channel", channel)
          .single(),
      ) as { id: string };
      return row.id;
    },

    async insertInbound({ tenantId, conversationId, providerMessageId, content, receivedAt }) {
      const inserted = unwrap(
        await client
          .from("messages")
          .upsert(
            {
              tenant_id: tenantId,
              conversation_id: conversationId,
              role: "customer",
              content,
              provider_message_id: providerMessageId,
            },
            { onConflict: "provider_message_id", ignoreDuplicates: true },
          )
          .select("id"),
      ) as unknown[];
      if (inserted.length === 0) return false;

      unwrap(
        await client
          .from("conversations")
          .update({ last_customer_message_at: receivedAt.toISOString() })
          .eq("tenant_id", tenantId)
          .eq("id", conversationId)
          .select("id"),
      );
      return true;
    },

    async claim(tenantId, conversationId, until, now) {
      // One UPDATE: a concurrent worker waits on the row lock, re-checks the filter and matches nothing.
      const claimed = unwrap(
        await client
          .from("conversations")
          .update({ processing_until: until.toISOString() })
          .eq("tenant_id", tenantId)
          .eq("id", conversationId)
          .or(`processing_until.is.null,processing_until.lt."${now.toISOString()}"`)
          .select("id"),
      ) as unknown[];
      return claimed.length === 1;
    },

    async renew(tenantId, conversationId, until) {
      unwrap(
        await client
          .from("conversations")
          .update({ processing_until: until.toISOString() })
          .eq("tenant_id", tenantId)
          .eq("id", conversationId)
          .select("id"),
      );
    },

    async conversationStatus(tenantId, conversationId) {
      const row = unwrap(
        await client.from("conversations").select("status").eq("tenant_id", tenantId).eq("id", conversationId).single(),
      ) as { status: ConversationStatus };
      return row.status;
    },

    markHandoff: (tenantId, conversationId) => markConversationHandoff(client, tenantId, conversationId),

    async lastReplyTools(tenantId, conversationId) {
      const rows = unwrap(
        await client
          .from("messages")
          .select("tool_calls")
          .eq("tenant_id", tenantId)
          .eq("conversation_id", conversationId)
          .eq("role", "assistant")
          .order("id", { ascending: false })
          .limit(1),
      ) as { tool_calls: { name: string; status: string }[] | null }[];
      return rows[0]?.tool_calls ?? [];
    },

    async release(tenantId, conversationId) {
      unwrap(
        await client
          .from("conversations")
          .update({ processing_until: null })
          .eq("tenant_id", tenantId)
          .eq("id", conversationId)
          .select("id"),
      );
    },

    async nextUnprocessed(tenantId, conversationId) {
      const rows = unwrap(
        await client
          .from("messages")
          .select("id, content")
          .eq("tenant_id", tenantId)
          .eq("conversation_id", conversationId)
          .eq("role", "customer")
          .is("processed_at", null)
          .order("id", { ascending: true })
          .limit(1),
      ) as { id: number; content: string | null }[];
      return rows[0] ?? null;
    },

    async customerOf(tenantId, conversationId) {
      const conversation = unwrap(
        await client
          .from("conversations")
          .select("customer_id")
          .eq("tenant_id", tenantId)
          .eq("id", conversationId)
          .single(),
      ) as { customer_id: string };
      const row = unwrap(
        await client
          .from("customers")
          .select(CUSTOMER_COLUMNS)
          .eq("tenant_id", tenantId)
          .eq("id", conversation.customer_id)
          .single(),
      ) as CustomerRow;
      return toCustomer(row);
    },

    async setConsent(tenantId, customerId, status, at, version) {
      unwrap(
        await client
          .from("customers")
          .update({
            consent_status: status,
            consent_at: at.toISOString(),
            consent_version: version,
            ...(status === "declined" ? { phone_encrypted: null } : {}),
          })
          .eq("tenant_id", tenantId)
          .eq("id", customerId)
          .select("id"),
      );
    },

    async saveReply(tenantId, conversationId, text, providerMessageId, toolCalls) {
      unwrap(
        await client
          .from("messages")
          .insert({
            tenant_id: tenantId,
            conversation_id: conversationId,
            role: "assistant",
            content: text,
            provider_message_id: providerMessageId,
            tool_calls: toolCalls.length > 0 ? toolCalls : null,
          })
          .select("id"),
      );
    },

    async markProcessed(tenantId, messageId, at) {
      unwrap(
        await client
          .from("messages")
          .update({ processed_at: at.toISOString() })
          .eq("tenant_id", tenantId)
          .eq("id", messageId)
          .select("id"),
      );
    },
  };
}
