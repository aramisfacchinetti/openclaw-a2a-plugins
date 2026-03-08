import type { Message } from "@a2a-js/sdk";
import type { RequestContext } from "@a2a-js/sdk/server";

type OpenClawRequestContext = RequestContext & {
  openclawOriginalUserMessage?: Message;
  openclawAcceptedOutputModes?: string[];
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

export function attachAcceptedOutputModes(
  requestContext: RequestContext,
  acceptedOutputModes: readonly string[],
): RequestContext {
  (requestContext as OpenClawRequestContext).openclawAcceptedOutputModes = [
    ...acceptedOutputModes,
  ];
  return requestContext;
}

export function readAcceptedOutputModes(
  requestContext: RequestContext,
): string[] | undefined {
  const acceptedOutputModes =
    (requestContext as OpenClawRequestContext).openclawAcceptedOutputModes;

  return acceptedOutputModes ? [...acceptedOutputModes] : undefined;
}
