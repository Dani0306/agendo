import { generateText, type LanguageModel, type ModelMessage, tool, type ToolSet } from "ai";
import type { z } from "zod";
import { billedTokens, recordCall, type RecordCallDeps } from "@/lib/calls/record-call";
import { callCostUsd } from "@/lib/cost/pricing";
import { type Budget, estimateCallUsd, MAX_OUTPUT_TOKENS } from "@/lib/guard/budget";
import { redactPhones } from "@/lib/pii/redact";
import type { BookingStore } from "@/lib/tools/store";
import {
  isTerminal,
  type TerminalOutcome,
  type ToolContext,
  type ToolName,
  type ToolOutcome,
  TOOLS,
  usesWriteAttempt,
} from "@/lib/tools/tools";
import { type PromptTenant, systemPromptParts, wrapCustomerMessage } from "./prompt";
import {
  bookedText,
  cancelledText,
  HANDOFF_TEXT,
  OVER_BUDGET_TEXT,
  PERSON_SOON_TEXT,
  type Reply,
  rescheduledText,
  slotTakenText,
} from "./reply";

/** Model calls in one customer turn. Each one is a row in model_calls. */
export const MAX_MODEL_CALLS = 5;
export const HISTORY_MESSAGES = 20;

export type HistoryMessage = { role: "customer" | "assistant"; content: string };

export type AgentData = {
  promptTenant(tenantId: string): Promise<PromptTenant>;
  history(tenantId: string, conversationId: string, beforeMessageId: number, limit: number): Promise<HistoryMessage[]>;
};

export type AgentDeps = {
  model: LanguageModel;
  modelId: string;
  bookings: BookingStore;
  data: AgentData;
  record: RecordCallDeps;
  /** Reserved before every model call, settled or refunded after it. */
  budget: Budget;
  now: () => Date;
  log: (event: string, fields: Record<string, unknown>) => void;
};

export type AgentTurn = {
  tenantId: string;
  conversationId: string;
  customerId: string;
  /** The stored id of the message being answered, so history stops before it. */
  messageId: number;
  text: string;
  deadlineMs: number;
};

const SDK_TOOLS: ToolSet = Object.fromEntries(
  Object.entries(TOOLS).map(([name, definition]) => [
    name,
    tool({ description: definition.description, inputSchema: definition.inputSchema as z.ZodType }),
  ]),
);

// store: false keeps customer text out of OpenAI's stored responses. One tool at a
// time keeps the order of a write and what follows it unambiguous.
const PROVIDER_OPTIONS = {
  openai: { store: false, parallelToolCalls: false, reasoningEffort: "low", textVerbosity: "low" },
} as const;

function terminalReply(outcome: TerminalOutcome, trace: Reply["trace"]): Reply {
  switch (outcome.status) {
    case "booked":
      return { text: bookedText(outcome.booking), booking: outcome.booking, trace };
    case "rescheduled":
      return { text: rescheduledText(outcome.booking), booking: outcome.booking, trace };
    case "cancelled":
      return { text: cancelledText(outcome.booking), booking: outcome.booking, trace };
    case "slot_taken":
      return { text: slotTakenText(outcome.alternatives), alternatives: outcome.alternatives, trace };
    case "handoff":
      return { text: HANDOFF_TEXT, degraded: "handoff", trace };
  }
}

function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOLS, name);
}

/**
 * The tool loop. The model only asks; this code validates, scopes and runs each tool.
 * Reaching a write's result ends the turn, so what the customer reads about a booking
 * is built from the database row and never from the model's text.
 */
export async function runAgent(deps: AgentDeps, turn: AgentTurn): Promise<Reply> {
  const trace: Reply["trace"] = { model: deps.modelId, tools: [] };
  const deadline = deps.now().getTime() + turn.deadlineMs;
  const fields = { tenantId: turn.tenantId, conversationId: turn.conversationId };

  const degrade = (reason: string, error?: unknown): Reply => {
    deps.log("agent.degraded", {
      ...fields,
      reason,
      ...(error === undefined ? {} : { error: redactPhones(error instanceof Error ? error.message : String(error)).slice(0, 200) }),
    });
    return { text: PERSON_SOON_TEXT, degraded: "person_soon", trace };
  };

  try {
    const [tenant, history] = await Promise.all([
      deps.data.promptTenant(turn.tenantId),
      deps.data.history(turn.tenantId, turn.conversationId, turn.messageId, HISTORY_MESSAGES),
    ]);

    const messages: ModelMessage[] = [
      ...history.map(
        (item): ModelMessage =>
          item.role === "customer"
            ? { role: "user", content: wrapCustomerMessage(item.content) }
            : { role: "assistant", content: item.content },
      ),
      { role: "user", content: wrapCustomerMessage(turn.text) },
    ];

    const instructions = systemPromptParts(tenant, deps.now()).join("\n\n");
    const toolContext: ToolContext = {
      tenantId: turn.tenantId,
      customerId: turn.customerId,
      conversationId: turn.conversationId,
      now: deps.now(),
      store: deps.bookings,
    };
    let writeAttempted = false;

    for (let call = 0; call < MAX_MODEL_CALLS; call += 1) {
      const remaining = deadline - deps.now().getTime();
      if (remaining <= 0) return degrade("deadline");

      // Before the call: the worst case it could cost, so a tenant can't overspend mid-flight.
      const reservation = await deps.budget.reserve(
        turn.tenantId,
        estimateCallUsd(deps.modelId, instructions.length + JSON.stringify(messages).length),
      );
      if (!reservation) {
        deps.log("agent.over_budget", fields);
        return { text: OVER_BUDGET_TEXT, degraded: "over_budget", trace };
      }

      let result;
      try {
        result = await recordCall(
          { tenantId: turn.tenantId, conversationId: turn.conversationId, purpose: "agent", model: deps.modelId },
          deps.record,
          () =>
            generateText({
              model: deps.model,
              instructions,
              messages,
              tools: SDK_TOOLS,
              maxOutputTokens: MAX_OUTPUT_TOKENS,
              maxRetries: 0, // Retries arrive in T19, with a total deadline.
              abortSignal: AbortSignal.timeout(remaining),
              providerOptions: PROVIDER_OPTIONS,
            }),
        );
      } catch (error) {
        await deps.budget.refund(reservation).catch((refundError: unknown) => deps.log("budget.refund_failed", { ...fields, error: String(refundError).slice(0, 200) }));
        throw error;
      }
      // A failed settle must not lose the answer the customer is waiting for.
      await deps.budget
        .settle(reservation, callCostUsd(deps.modelId, billedTokens(result.usage)))
        .catch((settleError: unknown) => deps.log("budget.settle_failed", { ...fields, error: String(settleError).slice(0, 200) }));

      if (result.toolCalls.length === 0) {
        const text = result.text.trim();
        return text.length > 0 ? { text, trace } : degrade("empty_reply");
      }

      messages.push(...result.response.messages);

      const parts = [];
      for (const toolCall of result.toolCalls) {
        let outcome: ToolOutcome | TerminalOutcome;

        if (!isToolName(toolCall.toolName)) {
          outcome = { status: "invalid_arguments" };
        } else if (TOOLS[toolCall.toolName].write && writeAttempted) {
          outcome = { status: "refused", reason: "one_write_per_turn" };
        } else {
          const definition = TOOLS[toolCall.toolName];
          outcome = await definition.run(toolContext, toolCall.input);
          if (definition.write && usesWriteAttempt(outcome)) writeAttempted = true;
        }

        trace.tools.push({ name: toolCall.toolName, status: outcome.status });
        if (isTerminal(outcome)) return terminalReply(outcome, trace);

        parts.push({
          type: "tool-result" as const,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          output: { type: "json" as const, value: JSON.parse(JSON.stringify(outcome)) },
        });
      }
      messages.push({ role: "tool", content: parts });
    }

    return degrade("step_limit");
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return degrade(timedOut ? "deadline" : "error", error);
  }
}
