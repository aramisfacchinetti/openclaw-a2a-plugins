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
    execute: async (...args: unknown[]) => {
      const { params, signal } = resolveExecuteArgs(args);
      return jsonResult(await service.delegate(params, { signal }));
    },
  };

  const delegateStreamTool: AnyAgentTool = {
    ...TOOL_DEFINITIONS.a2a_delegate_stream,
    execute: async (...args: unknown[]) => {
      const { params, signal, onUpdate } = resolveExecuteArgs(args);
      return jsonResult(
        await service.delegateStream(params, {
          signal,
          onUpdate:
            onUpdate !== undefined
              ? (update) => onUpdate(jsonResult(update))
              : undefined,
        }),
      );
    },
  };

  const statusTool: AnyAgentTool = {
    ...TOOL_DEFINITIONS.a2a_task_status,
    execute: async (...args: unknown[]) => {
      const { params, signal } = resolveExecuteArgs(args);
      return jsonResult(await service.status(params, { signal }));
    },
  };

  const resubscribeTool: AnyAgentTool = {
    ...TOOL_DEFINITIONS.a2a_task_resubscribe,
    execute: async (...args: unknown[]) => {
      const { params, signal, onUpdate } = resolveExecuteArgs(args);
      return jsonResult(
        await service.resubscribe(params, {
          signal,
          onUpdate:
            onUpdate !== undefined
              ? (update) => onUpdate(jsonResult(update))
              : undefined,
        }),
      );
    },
  };

  const cancelTool: AnyAgentTool = {
    ...TOOL_DEFINITIONS.a2a_task_cancel,
    execute: async (...args: unknown[]) => {
      const { params, signal } = resolveExecuteArgs(args);
      return jsonResult(await service.cancel(params, { signal }));
    },
  };

  api.registerTool(delegateTool, { optional: true });

  api.registerTool(delegateStreamTool, { optional: true });

  api.registerTool(statusTool, { optional: true });

  api.registerTool(resubscribeTool, { optional: true });

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
