import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";

export type OpenClawChannelRuntime = PluginRuntime["channel"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireFunction(
  value: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (typeof value[key] !== "function") {
    throw new Error(
      `A2A inbound requires OpenClaw channelRuntime.${path}.${key}().`,
    );
  }
}

function requireRecord(
  value: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> {
  const child = value[key];

  if (!isRecord(child)) {
    throw new Error(`A2A inbound requires OpenClaw channelRuntime.${path}.${key}.`);
  }

  return child;
}

export function requireOpenClawChannelRuntime(
  channelRuntime: ChannelGatewayContext["channelRuntime"],
): OpenClawChannelRuntime {
  if (!isRecord(channelRuntime)) {
    throw new Error(
      "A2A inbound requires an OpenClaw channelRuntime surface from the host runtime.",
    );
  }

  const reply = requireRecord(channelRuntime, "reply", "reply");
  requireFunction(
    reply,
    "dispatchReplyWithBufferedBlockDispatcher",
    "reply",
  );
  requireFunction(reply, "finalizeInboundContext", "reply");
  requireFunction(reply, "resolveEnvelopeFormatOptions", "reply");
  requireFunction(reply, "formatAgentEnvelope", "reply");

  const routing = requireRecord(channelRuntime, "routing", "routing");
  requireFunction(routing, "resolveAgentRoute", "routing");

  const session = requireRecord(channelRuntime, "session", "session");
  requireFunction(session, "resolveStorePath", "session");
  requireFunction(session, "readSessionUpdatedAt", "session");
  requireFunction(session, "recordInboundSession", "session");

  return channelRuntime as OpenClawChannelRuntime;
}
