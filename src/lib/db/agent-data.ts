import type { AgentData, HistoryMessage } from "@/lib/agent/loop";
import type { PromptTenant } from "@/lib/agent/prompt";
import { spanishTime } from "@/lib/booking/timezone";
import type { Db } from "./client";
import { unwrap } from "./unwrap";

const WEEKDAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

type RuleRow = { weekday: number; opens: string; closes: string };

/** The clinic's opening hours, one line per day, widest window across therapists. */
export function hoursLines(rules: RuleRow[]): string[] {
  return WEEKDAYS.map((name, index) => {
    const day = rules.filter((rule) => rule.weekday === index + 1);
    if (day.length === 0) return `${name}: cerrado`;
    const opens = day.map((rule) => rule.opens.slice(0, 5)).sort()[0]!;
    const closes = day.map((rule) => rule.closes.slice(0, 5)).sort().at(-1)!;
    return `${name}: ${spanishTime(opens)} a ${spanishTime(closes)}`;
  });
}

/** Oldest first, because the model reads the conversation in order. */
export function agentData(client: Db): AgentData {
  return {
    async promptTenant(tenantId) {
      const [tenant, services, rules] = await Promise.all([
        client.from("tenants").select("name, timezone, currency, faq").eq("id", tenantId).single(),
        client.from("services").select("name, duration_minutes, price").eq("tenant_id", tenantId).eq("active", true).order("name"),
        client.from("availability_rules").select("weekday, opens, closes").eq("tenant_id", tenantId),
      ]);
      const row = unwrap(tenant) as Pick<PromptTenant, "name" | "timezone" | "currency" | "faq">;
      return {
        ...row,
        services: (unwrap(services) as { name: string; duration_minutes: number; price: number | string }[]).map((service) => ({
          ...service,
          price: Number(service.price),
        })),
        hours: hoursLines(unwrap(rules) as RuleRow[]),
      };
    },

    async history(tenantId, conversationId, beforeMessageId, limit) {
      const rows = unwrap(
        await client
          .from("messages")
          .select("role, content")
          .eq("tenant_id", tenantId)
          .eq("conversation_id", conversationId)
          .in("role", ["customer", "assistant"])
          .not("content", "is", null)
          .lt("id", beforeMessageId)
          .order("id", { ascending: false })
          .limit(limit),
      ) as HistoryMessage[];
      return rows.reverse();
    },
  };
}
