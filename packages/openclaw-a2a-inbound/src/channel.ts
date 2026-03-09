import type {
  ChannelAccountSnapshot,
  ChannelPlugin,
} from "openclaw/plugin-sdk";
import {
  A2A_INBOUND_CHANNEL_CONFIG_SCHEMA,
  explainA2AInboundAccountUnconfigured,
  isA2AInboundAccountConfigured,
  listA2AInboundAccountIds,
  parseA2AInboundChannelConfig,
  resolveA2AInboundAccount,
  resolveA2AInboundDefaultAccountId,
  type A2AInboundAccountConfig,
} from "./config.js";
import { CHANNEL_DOCS_PATH, CHANNEL_ID, CHANNEL_LABEL } from "./constants.js";
import type { A2AInboundPluginHost } from "./plugin-host.js";

function describeAccount(
  account: A2AInboundAccountConfig,
): ChannelAccountSnapshot {
  return {
    accountId: account.accountId,
    name: account.label,
    enabled: account.enabled,
    configured: isA2AInboundAccountConfigured(account),
    connected: false,
    running: false,
    baseUrl: account.publicBaseUrl,
    webhookPath: account.jsonRpcPath,
    mode: "a2a",
  };
}

export function buildA2AInboundChannel(
  host: A2AInboundPluginHost,
): ChannelPlugin<A2AInboundAccountConfig> {
  return {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: CHANNEL_LABEL,
      selectionLabel: "A2A Inbound (JSON-RPC)",
      docsPath: CHANNEL_DOCS_PATH,
      blurb: "Expose OpenClaw agents to external A2A peers through A2A JSON-RPC.",
      aliases: ["a2a"],
    },
    capabilities: {
      chatTypes: ["direct"],
      reply: true,
      blockStreaming: true,
    },
    config: {
      listAccountIds: (cfg) => listA2AInboundAccountIds(cfg),
      resolveAccount: (cfg, accountId) =>
        resolveA2AInboundAccount(cfg, accountId),
      defaultAccountId: (cfg) =>
        resolveA2AInboundDefaultAccountId(parseA2AInboundChannelConfig(cfg)) ??
        "default",
      isEnabled: (account) => account.enabled,
      disabledReason: (account) =>
        account.enabled ? "" : "This A2A inbound account is disabled.",
      isConfigured: (account) => isA2AInboundAccountConfigured(account),
      unconfiguredReason: (account) =>
        explainA2AInboundAccountUnconfigured(account),
      describeAccount,
    },
    configSchema: A2A_INBOUND_CHANNEL_CONFIG_SCHEMA,
    outbound: {
      deliveryMode: "direct",
      async sendText() {
        throw new Error(
          "openclaw-a2a-inbound does not implement OpenClaw-initiated outbound delivery. Use openclaw-a2a-outbound for delegated outbound A2A calls.",
        );
      },
    },
    gateway: {
      startAccount: async (ctx) => host.startAccount(ctx),
      stopAccount: async (ctx) => host.stopAccount(ctx),
    },
  };
}
