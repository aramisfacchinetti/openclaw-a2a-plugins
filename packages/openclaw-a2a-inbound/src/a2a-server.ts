import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentCard } from "@a2a-js/sdk";
import { DefaultRequestHandler } from "@a2a-js/sdk/server";
import {
  UserBuilder,
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
} from "@a2a-js/sdk/server/express";
import express, { type RequestHandler } from "express";
import type { ChannelGatewayContext, ChannelLogSink } from "openclaw/plugin-sdk";
import type { A2AInboundAccountConfig } from "./config.js";
import { CHANNEL_ID, PLUGIN_VERSION } from "./constants.js";
import { createOpenClawA2AExecutor } from "./openclaw-executor.js";
import { createTaskStore } from "./task-store.js";

type OpenClawConfig = ChannelGatewayContext["cfg"];
type ChannelRuntime = NonNullable<ChannelGatewayContext["channelRuntime"]>;

export interface A2AInboundServerOptions {
  accountId: string;
  account: A2AInboundAccountConfig;
  cfg: OpenClawConfig;
  channelRuntime: ChannelRuntime;
  log?: ChannelLogSink;
}

export interface A2AInboundServer {
  requestHandler: DefaultRequestHandler;
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
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
  const additionalInterfaces: AgentCard["additionalInterfaces"] = [
    {
      url: jsonRpcUrl,
      transport: "JSONRPC",
    },
  ];

  if (account.capabilities.rest) {
    additionalInterfaces.push({
      url: resolvePublicUrl(account.publicBaseUrl, account.restPath),
      transport: "HTTP+JSON",
    });
  }

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
      pushNotifications: account.capabilities.pushNotifications,
    },
    defaultInputModes: [...account.defaultInputModes],
    defaultOutputModes: [...account.defaultOutputModes],
    additionalInterfaces,
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
  const requestHandler = new DefaultRequestHandler(
    buildAgentCard(options.account),
    createTaskStore(options.account.taskStore),
    createOpenClawA2AExecutor({
      accountId: options.accountId,
      account: options.account,
      cfg: options.cfg,
      runtime: options.channelRuntime,
      log: options.log,
    }),
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

  if (options.account.capabilities.rest) {
    app.use(
      options.account.restPath,
      restHandler({
        requestHandler,
        userBuilder: UserBuilder.noAuthentication,
      }),
    );
  }

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
  };
}
