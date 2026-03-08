import type { Message } from "@a2a-js/sdk";
import type { RequestContext } from "@a2a-js/sdk/server";

type OpenClawRequestContext = RequestContext & {
  openclawOriginalUserMessage?: Message;
};

export function attachOriginalUserMessage(
  requestContext: RequestContext,
  message: Message,
): RequestContext {
  (requestContext as OpenClawRequestContext).openclawOriginalUserMessage =
    structuredClone(message);
  return requestContext;
}

export function readOriginalUserMessage(
  requestContext: RequestContext,
): Message {
  return structuredClone(
    (requestContext as OpenClawRequestContext).openclawOriginalUserMessage ??
      requestContext.userMessage,
  );
}
