import type { Message } from "@a2a-js/sdk";
import type { RequestContext } from "@a2a-js/sdk/server";

export interface A2AInboundRouteContext {
  peerId: string;
  from: string;
  to: string;
  body: string;
  conversationLabel: string;
  timestamp: number;
}

type MessagePart = Message["parts"][number];

function readTextPart(part: MessagePart): string | undefined {
  return part.kind === "text" && typeof part.text === "string"
    ? part.text
    : undefined;
}

export function extractUserText(message: Message): string {
  return message.parts
    .map(readTextPart)
    .filter((value): value is string => typeof value === "string")
    .join("\n\n")
    .trim();
}

export function resolveInboundPeerId(requestContext: RequestContext): string {
  const userName = requestContext.context?.user?.userName;

  if (typeof userName === "string" && userName.trim().length > 0) {
    return userName.trim();
  }

  if (requestContext.userMessage.messageId.trim().length > 0) {
    return requestContext.userMessage.messageId;
  }

  return requestContext.contextId;
}

export function buildInboundRouteContext(
  requestContext: RequestContext,
  accountId: string,
): A2AInboundRouteContext {
  const peerId = resolveInboundPeerId(requestContext);
  const body = extractUserText(requestContext.userMessage);

  return {
    peerId,
    from: `a2a:${peerId}`,
    to: `a2a:${accountId}`,
    body,
    conversationLabel: peerId,
    timestamp: Date.now(),
  };
}
