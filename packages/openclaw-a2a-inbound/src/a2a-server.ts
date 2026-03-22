import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentCard } from "@a2a-js/sdk";
import {
  A2AError,
  DefaultRequestHandler,
  type A2ARequestHandler,
} from "@a2a-js/sdk/server";
import {
  UserBuilder,
  agentCardHandler,
  jsonRpcHandler,
} from "@a2a-js/sdk/server/express";
import express, { type RequestHandler } from "express";
import type {
  ChannelGatewayContext,
  ChannelLogSink,
  PluginRuntime,
} from "openclaw/plugin-sdk";
import type { A2AInboundAccountConfig } from "./config.js";
import { CHANNEL_ID, PLUGIN_VERSION } from "./constants.js";
import { createOpenClawA2AExecutor } from "./openclaw-executor.js";
import { A2ALiveExecutionRegistry } from "./live-execution-registry.js";
import { A2AInboundRequestHandler } from "./request-handler.js";
import { A2AResubscribePlanner } from "./resubscribe-planner.js";
import { createTaskStore } from "./task-store.js";

type OpenClawConfig = ChannelGatewayContext["cfg"];
type ChannelRuntime = NonNullable<ChannelGatewayContext["channelRuntime"]>;

export interface A2AInboundServerOptions {
  accountId: string;
  account: A2AInboundAccountConfig;
  cfg: OpenClawConfig;
  channelRuntime: ChannelRuntime;
  pluginRuntime: PluginRuntime;
  log?: ChannelLogSink;
}

export interface A2AInboundServer {
  requestHandler: A2AInboundRequestHandler;
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  close: () => void;
}

function resolvePublicUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}

function buildAgentCard(account: A2AInboundAccountConfig): AgentCard {
  if (!account.publicBaseUrl) {
    throw new Error(
      `account "${account.accountId}" is missing publicBaseUrl for agent card generation`,
    );
  }

  const jsonRpcUrl = resolvePublicUrl(account.publicBaseUrl, account.jsonRpcPath);
  const normalizedInputModes = [...account.defaultInputModes];
  const normalizedOutputModes = [...account.defaultOutputModes];

  return {
    name: account.label,
    description:
      account.description ??
      "Expose an OpenClaw agent as an inbound A2A endpoint.",
    protocolVersion: account.protocolVersion,
    version: PLUGIN_VERSION,
    url: jsonRpcUrl,
    preferredTransport: "JSONRPC",
    additionalInterfaces: [
      {
        transport: "JSONRPC",
        url: jsonRpcUrl,
      },
    ],
    skills: account.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description ?? skill.name,
      tags: [...skill.tags],
      examples: [...skill.examples],
      inputModes: [...normalizedInputModes],
      outputModes: [...normalizedOutputModes],
    })),
    capabilities: {
      pushNotifications: false,
      streaming: true,
      stateTransitionHistory: false,
    },
    defaultInputModes: normalizedInputModes,
    defaultOutputModes: normalizedOutputModes,
  };
}

function createExpressDispatcher(
  handler: RequestHandler,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) =>
    new Promise<boolean>((resolve, reject) => {
      let settled = false;

      const finish = (handled: boolean) => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(handled);
      };

      res.once("finish", () => finish(true));
      res.once("close", () => finish(res.writableEnded));

      const next = (error?: unknown) => {
        if (error) {
          reject(error);
          return;
        }

        finish(res.writableEnded);
      };

      try {
        handler(req as never, res as never, next);

        if (res.headersSent || res.writableEnded) {
          finish(true);
        }
      } catch (error) {
        reject(error);
      }
    });
}

const REMOVED_JSON_RPC_METHODS = new Set([
  "tasks/pushNotificationConfig/set",
  "tasks/pushNotificationConfig/get",
  "tasks/pushNotificationConfig/list",
  "tasks/pushNotificationConfig/delete",
]);

function createMethodNotFoundResponse(method: string, id: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id:
      typeof id === "string" ||
      (typeof id === "number" && Number.isInteger(id)) ||
      id === null
        ? id
        : null,
    error: A2AError.methodNotFound(method).toJSONRPCError(),
  };
}

function rejectRemovedJsonRpcMethods(): RequestHandler {
  return (req, res, next) => {
    const method =
      typeof req.body === "object" &&
      req.body !== null &&
      !Array.isArray(req.body) &&
      typeof req.body.method === "string"
        ? req.body.method
        : undefined;

    if (!method || !REMOVED_JSON_RPC_METHODS.has(method)) {
      next();
      return;
    }

    res.status(200).json(createMethodNotFoundResponse(method, req.body.id));
  };
}

function createProtocolBoundaryRequestHandler(
  handler: A2AInboundRequestHandler,
): A2ARequestHandler {
  return {
    getAgentCard: () => handler.getAgentCard(),
    getAuthenticatedExtendedAgentCard: (context) =>
      handler.getAuthenticatedExtendedAgentCard(context),
    sendMessage: (params, context) => handler.sendMessage(params, context),
    sendMessageStream: (params, context) =>
      handler.sendMessageStream(params, context),
    getTask: (params, context) => handler.getTask(params, context),
    cancelTask: (params, context) => handler.cancelTask(params, context),
    setTaskPushNotificationConfig: async () => {
      throw A2AError.methodNotFound("tasks/pushNotificationConfig/set");
    },
    getTaskPushNotificationConfig: async () => {
      throw A2AError.methodNotFound("tasks/pushNotificationConfig/get");
    },
    listTaskPushNotificationConfigs: async () => {
      throw A2AError.methodNotFound("tasks/pushNotificationConfig/list");
    },
    deleteTaskPushNotificationConfig: async () => {
      throw A2AError.methodNotFound("tasks/pushNotificationConfig/delete");
    },
    resubscribe: (params, context) => handler.resubscribe(params, context),
  };
}

export function createA2AInboundServer(
  options: A2AInboundServerOptions,
): A2AInboundServer {
  const taskStore = createTaskStore(options.account.taskStore);
  const liveExecutions = new A2ALiveExecutionRegistry();
  const agentExecutor = createOpenClawA2AExecutor({
    accountId: options.accountId,
    account: options.account,
    cfg: options.cfg,
    channelRuntime: options.channelRuntime,
    pluginRuntime: options.pluginRuntime,
    taskRuntime: taskStore,
    log: options.log,
    liveExecutions,
  });
  const defaultRequestHandler = new DefaultRequestHandler(
    buildAgentCard(options.account),
    taskStore,
    agentExecutor,
    liveExecutions.eventBusManager,
  );
  const resubscribePlanner = new A2AResubscribePlanner(
    taskStore,
    liveExecutions,
  );
  const requestHandler = new A2AInboundRequestHandler(
    defaultRequestHandler,
    taskStore,
    liveExecutions,
    resubscribePlanner,
    agentExecutor,
    options.account.defaultOutputModes,
  );
  const protocolBoundaryHandler = createProtocolBoundaryRequestHandler(
    requestHandler,
  );

  const app = express();
  app.disable("x-powered-by");
  app.use(
    express.json({
      limit: options.account.maxBodyBytes,
    }),
  );
  app.use(
    express.urlencoded({
      extended: true,
      limit: options.account.maxBodyBytes,
    }),
  );
  app.use(
    options.account.agentCardPath,
    agentCardHandler({
      agentCardProvider: protocolBoundaryHandler,
    }),
  );
  app.use(
    options.account.jsonRpcPath,
    rejectRemovedJsonRpcMethods(),
    jsonRpcHandler({
      requestHandler: protocolBoundaryHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({
      error: {
        code: "A2A_ROUTE_NOT_FOUND",
        message: "No A2A inbound route matched this request.",
        details: {
          channel: CHANNEL_ID,
          accountId: options.accountId,
        },
      },
    });
  });

  return {
    requestHandler,
    handle: createExpressDispatcher(app),
    close: () => {
      taskStore.close();
    },
  };
}
