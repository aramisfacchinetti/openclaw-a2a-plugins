import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentCard } from "@a2a-js/sdk";
import { DefaultRequestHandler } from "@a2a-js/sdk/server";
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
import {
  deriveFilesBasePath,
  parseTaskFileRequestPath,
} from "./file-delivery.js";
import { createOpenClawA2AExecutor } from "./openclaw-executor.js";
import { A2ALiveExecutionRegistry } from "./live-execution-registry.js";
import { A2AInboundRequestHandler } from "./request-handler.js";
import { createTaskStore, type A2AInboundTaskStoreConfig } from "./task-store.js";

type OpenClawConfig = ChannelGatewayContext["cfg"];
type ChannelRuntime = NonNullable<ChannelGatewayContext["channelRuntime"]>;

export interface A2AInboundServerOptions {
  accountId: string;
  account: A2AInboundAccountConfig;
  cfg: OpenClawConfig;
  channelRuntime: ChannelRuntime;
  pluginRuntime: PluginRuntime;
  log?: ChannelLogSink;
  fileDelivery?: {
    fetchImpl?: typeof fetch;
    lookupFn?: typeof import("node:dns/promises").lookup;
  };
  internal?: {
    enableStreamingMethods?: boolean;
    taskStoreConfig?: A2AInboundTaskStoreConfig;
  };
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

  return {
    name: account.label,
    description:
      account.description ??
      "Expose an OpenClaw agent as an inbound A2A endpoint.",
    protocolVersion: account.protocolVersion,
    version: PLUGIN_VERSION,
    url: jsonRpcUrl,
    skills: account.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description ?? skill.name,
      tags: [...skill.tags],
      examples: [...skill.examples],
    })),
    capabilities: {
      pushNotifications: false,
      streaming: false,
    },
    defaultInputModes: [...account.defaultInputModes],
    defaultOutputModes: [...account.defaultOutputModes],
    additionalInterfaces: [
      {
        url: jsonRpcUrl,
        transport: "JSONRPC",
      },
    ],
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
        const maybePromise = handler(req as never, res as never, next);

        Promise.resolve(maybePromise).then(
          () => finish(res.writableEnded),
          reject,
        );
      } catch (error) {
        reject(error);
      }
    });
}

export function createA2AInboundServer(
  options: A2AInboundServerOptions,
): A2AInboundServer {
  const taskStore = createTaskStore(
    options.internal?.taskStoreConfig ?? { kind: "memory" },
    options.fileDelivery,
  );
  const liveExecutions = new A2ALiveExecutionRegistry();
  const filesBasePath = deriveFilesBasePath(options.account.jsonRpcPath);
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
  const requestHandler = new A2AInboundRequestHandler(
    defaultRequestHandler,
    taskStore,
    liveExecutions,
    options.internal?.enableStreamingMethods ?? false,
    agentExecutor,
    options.account.defaultOutputModes,
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
      agentCardProvider: requestHandler,
    }),
  );
  app.use(
    options.account.jsonRpcPath,
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
  app.use(filesBasePath, async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      res.status(405).end();
      return;
    }

    const requestPath = new URL(req.originalUrl ?? req.url, "http://localhost").pathname;
    const target = parseTaskFileRequestPath({
      filesBasePath,
      requestPath,
    });

    if (!target) {
      res.status(404).end();
      return;
    }

    try {
      const download = await taskStore.materializeTaskFile({
        ...target,
      });

      if (!download) {
        res.status(404).end();
        return;
      }

      res.status(200);
      res.setHeader("content-type", download.contentType);

      if (typeof download.contentLength === "number") {
        res.setHeader("content-length", String(download.contentLength));
      }

      if (download.contentDisposition) {
        res.setHeader("content-disposition", download.contentDisposition);
      }

      if (req.method === "HEAD") {
        res.end();
        return;
      }

      const stream = createReadStream(download.blobPath);
      stream.on("error", () => {
        if (!res.writableEnded) {
          res.destroy();
        }
      });
      stream.pipe(res);
    } catch {
      if (!res.headersSent) {
        res.status(502).end();
        return;
      }

      res.destroy();
    }
  });

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
