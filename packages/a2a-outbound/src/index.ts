import {
  jsonResult,
  type AnyAgentTool,
  type OpenClawPluginApi,
  type OpenClawPluginConfigSchema,
} from "openclaw/plugin-sdk";
import { PLUGIN_ID } from "./constants.js";
import {
  A2A_OUTBOUND_OPENCLAW_CONFIG_SCHEMA,
  type A2AOutboundPluginConfig,
} from "./config.js";
import { log } from "./logging.js";
import { TOOL_DEFINITIONS } from "./schemas.js";
import { buildService } from "./service.js";

type SDKPluginEntry = {
  id: string;
  configSchema: OpenClawPluginConfigSchema;
  register(api: OpenClawPluginApi): void;
};

function resolveToolInput(args: unknown[]): unknown {
  if (typeof args[0] === "string" && args[1] !== undefined) {
    return args[1];
  }

  return args[0];
}

function registerTools(api: OpenClawPluginApi): void {
  const config = A2A_OUTBOUND_OPENCLAW_CONFIG_SCHEMA.parse?.(
    api.pluginConfig ?? {},
  ) as A2AOutboundPluginConfig;

  if (config.enabled !== true) {
    log(api.logger, "info", "a2a.plugin.disabled", { pluginId: PLUGIN_ID });
    return;
  }

  const service = buildService({
    config: api.pluginConfig,
    logger: api.logger,
  });

  const delegateTool: AnyAgentTool = {
    ...TOOL_DEFINITIONS.a2a_delegate,
    execute: async (...args: unknown[]) =>
      jsonResult(await service.delegate(resolveToolInput(args))),
  };

  const statusTool: AnyAgentTool = {
    ...TOOL_DEFINITIONS.a2a_task_status,
    execute: async (...args: unknown[]) =>
      jsonResult(await service.status(resolveToolInput(args))),
  };

  const cancelTool: AnyAgentTool = {
    ...TOOL_DEFINITIONS.a2a_task_cancel,
    execute: async (...args: unknown[]) =>
      jsonResult(await service.cancel(resolveToolInput(args))),
  };

  api.registerTool(delegateTool, { optional: true });

  api.registerTool(statusTool, { optional: true });

  api.registerTool(cancelTool, { optional: true });

  log(api.logger, "info", "a2a.plugin.loaded", {
    pluginId: PLUGIN_ID,
    tools: Object.keys(TOOL_DEFINITIONS),
  });
}

export const id = PLUGIN_ID;

export const plugin = {
  id: PLUGIN_ID,
  configSchema: A2A_OUTBOUND_OPENCLAW_CONFIG_SCHEMA,
  register: registerTools,
} satisfies SDKPluginEntry;

export default plugin;
