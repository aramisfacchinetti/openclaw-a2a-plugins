import type { Message } from "@a2a-js/sdk";
import type { RequestContext } from "@a2a-js/sdk/server";
import type { StoredTaskBindingPeerSource } from "./task-store.js";

export interface A2AInboundRouteContext {
  peerId: string;
  from: string;
  to: string;
  body: string;
  conversationLabel: string;
  timestamp: number;
}

export interface A2ABoundPeerIdentity {
  kind: "direct";
  id: string;
  source: StoredTaskBindingPeerSource;
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

export function resolveInboundPeerIdentity(
  requestContext: RequestContext,
): A2ABoundPeerIdentity {
  const userName = requestContext.context?.user?.userName;

  if (typeof userName === "string" && userName.trim().length > 0) {
    return {
      kind: "direct",
      id: userName.trim(),
      source: "server-user-name",
    };
  }

  if (requestContext.contextId.trim().length > 0) {
    return {
      kind: "direct",
      id: requestContext.contextId,
      source: "context-id",
    };
  }

  if (requestContext.taskId.trim().length > 0) {
    return {
      kind: "direct",
      id: requestContext.taskId,
      source: "task-id",
    };
  }

  return {
    kind: "direct",
    id: requestContext.userMessage.messageId,
    source: "message-id",
  };
}

export function buildInboundRouteContext(
  requestContext: RequestContext,
  accountId: string,
  peerId = resolveInboundPeerIdentity(requestContext).id,
): A2AInboundRouteContext {
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
