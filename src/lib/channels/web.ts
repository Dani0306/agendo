import { z } from "zod";
import type { InboundMessage } from "@/lib/agent/handle-inbound";
import { ReplySchema } from "@/lib/agent/reply";

export const VISITOR_COOKIE = "agendo_demo_visitor";

export const ChatRequestSchema = z.object({
  messageId: z.uuid(),
  text: z.string().trim().min(1).max(1000),
});

export const ChatResponseSchema = z.object({ replies: z.array(ReplySchema) });

export type ChatResponse = z.infer<typeof ChatResponseSchema>;

/** Turns a demo request into the same message the WhatsApp webhook produces. */
export function webInbound(
  visitorId: string,
  request: z.infer<typeof ChatRequestSchema>,
  receivingNumber: string,
): InboundMessage {
  return {
    channel: "web",
    providerMessageId: `web:${request.messageId}`,
    from: visitorId,
    to: receivingNumber,
    body: request.text,
  };
}
