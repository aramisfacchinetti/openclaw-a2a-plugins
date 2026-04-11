import {
  type AnyAgentTool,
  type OpenClawPluginApi,
  type OpenClawPluginConfigSchema,
} from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { PLUGIN_ID } from "./constants.js";
import {
  A2A_OUTBOUND_OPENCLAW_CONFIG_SCHEMA,
  type A2AOutboundPluginConfig,
} from "./config.js";
import { log } from "./logging.js";
import { buildRemoteAgentToolDefinition } from "./schemas.js";
import { buildService } from "./service.js";

type SDKPluginEntry = {
  id: string;
  configSchema: OpenClawPluginConfigSchema;
  register(api: OpenClawPluginApi): void;
};

type ToolExecuteUpdate = ReturnType<typeof jsonResult>;

type ResolvedExecuteArgs = {
  params: unknown;
  signal?: AbortSignal;
  onUpdate?: (update: ToolExecuteUpdate) => void;
};

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    typeof (value as AbortSignal).aborted === "boolean" &&
    "addEventListener" in value &&
    typeof (value as AbortSignal).addEventListener === "function"
  );
}

function resolveExecuteArgs(args: unknown[]): ResolvedExecuteArgs {
  if (typeof args[0] === "string" && args[1] !== undefined) {
    const [, params, maybeSignal, maybeOnUpdate] = args;

    return {
      params,
      ...(isAbortSignal(maybeSignal) ? { signal: maybeSignal } : {}),
      ...(typeof maybeOnUpdate === "function"
        ? { onUpdate: maybeOnUpdate as ResolvedExecuteArgs["onUpdate"] }
        : {}),
    };
  }

  const [params, maybeSignal, maybeOnUpdate] = args;

  return {
    params,
    ...(isAbortSignal(maybeSignal) ? { signal: maybeSignal } : {}),
    ...(typeof maybeOnUpdate === "function"
      ? { onUpdate: maybeOnUpdate as ResolvedExecuteArgs["onUpdate"] }
      : {}),
  };
}

function registerTools(api: OpenClawPluginApi): void {
  const config = A2A_OUTBOUND_OPENCLAW_CONFIG_SCHEMA.parse?.(
    api.pluginConfig ?? {},
  ) as A2AOutboundPluginConfig;

  if (api.registrationMode !== "full") {
    log(api.logger, "debug", "a2a.plugin.registration.deferred", {
      pluginId: PLUGIN_ID,
      registrationMode: api.registrationMode,
    });
    return;
  }

  if (config.enabled !== true) {
    log(api.logger, "info", "a2a.plugin.disabled", {
      pluginId: PLUGIN_ID,
      registrationMode: api.registrationMode,
    });
    return;
  }

  const service = buildService({
    parsedConfig: config,
    logger: api.logger,
  });

  const remoteAgentTool: AnyAgentTool = {
    ...buildRemoteAgentToolDefinition(config),
    execute: async (...args: unknown[]) => {
      const { params, signal, onUpdate } = resolveExecuteArgs(args);
      return jsonResult(
        await service.execute(params, {
          signal,
          ...(onUpdate !== undefined
            ? {
                onUpdate(update) {
                  onUpdate(jsonResult(update));
                },
              }
            : {}),
        }),
      );
    },
  };

  api.registerTool(remoteAgentTool, { optional: true });

  log(api.logger, "info", "a2a.plugin.loaded", {
    pluginId: PLUGIN_ID,
    registrationMode: api.registrationMode,
    tools: [remoteAgentTool.name],
  });
}

export const id = PLUGIN_ID;

export const plugin = {
  id: PLUGIN_ID,
  configSchema: A2A_OUTBOUND_OPENCLAW_CONFIG_SCHEMA,
  register: registerTools,
} satisfies SDKPluginEntry;

export default plugin;
