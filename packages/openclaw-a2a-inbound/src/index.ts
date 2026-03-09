import type { OpenClawPluginApi, OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";
import { buildA2AInboundChannel } from "./channel.js";
import {
  A2A_INBOUND_OPENCLAW_PLUGIN_CONFIG_SCHEMA,
  parseA2AInboundChannelConfig,
} from "./config.js";
import { CHANNEL_ID, PLUGIN_ID } from "./constants.js";
import { registerA2AInboundHttpRoutes } from "./http-routes.js";
import { log } from "./logging.js";
import { A2AInboundPluginHost } from "./plugin-host.js";

type SDKPluginEntry = {
  id: string;
  configSchema?: OpenClawPluginConfigSchema;
  register(api: OpenClawPluginApi): void;
};

function registerPlugin(api: OpenClawPluginApi): void {
  A2A_INBOUND_OPENCLAW_PLUGIN_CONFIG_SCHEMA.parse?.(api.pluginConfig ?? {});

  const channelConfig = parseA2AInboundChannelConfig(api.config);
  const host = new A2AInboundPluginHost(api.runtime);
  const channel = buildA2AInboundChannel(host);

  api.registerChannel({ plugin: channel });

  const registeredRouteCount = registerA2AInboundHttpRoutes(
    api,
    host,
    channelConfig,
  );

  log(api.logger, "info", "a2a.inbound.plugin.loaded", {
    pluginId: PLUGIN_ID,
    channelId: CHANNEL_ID,
    accounts: Object.keys(channelConfig.accounts),
    registeredRouteCount,
  });
}

export const id = PLUGIN_ID;

export const plugin = {
  id: PLUGIN_ID,
  configSchema: A2A_INBOUND_OPENCLAW_PLUGIN_CONFIG_SCHEMA,
  register: registerPlugin,
} satisfies SDKPluginEntry;

export default plugin;
