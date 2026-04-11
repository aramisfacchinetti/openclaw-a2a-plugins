import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type {
  ChannelGatewayContext,
} from "openclaw/plugin-sdk/channel-contract";
import {
  explainA2AInboundAccountUnconfigured,
  isA2AInboundAccountConfigured,
  type A2AInboundAccountConfig,
} from "./config.js";
import { createA2AInboundServer, type A2AInboundServer } from "./a2a-server.js";
import {
  A2A_INBOUND_QUEUED_REPLY_ACCOUNT_NOT_RUNNING_ERROR_CODE,
  A2A_INBOUND_QUEUED_REPLY_TASK_REQUIRED_MESSAGE,
  CHANNEL_ID,
} from "./constants.js";

type ActiveAccountState = {
  account: A2AInboundAccountConfig;
  server: A2AInboundServer;
};
type ChannelLogSink = NonNullable<ChannelGatewayContext["log"]>;

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): boolean {
  if (!res.headersSent) {
    res.statusCode = statusCode;
    res.setHeader("content-type", "application/json; charset=utf-8");
  }

  res.end(JSON.stringify(payload));
  return true;
}

function waitUntilAbort(
  signal: AbortSignal,
  onAbort?: () => void,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      onAbort?.();
      resolve();
      return;
    }

    const listener = () => {
      signal.removeEventListener("abort", listener);
      onAbort?.();
      resolve();
    };

    signal.addEventListener("abort", listener, { once: true });
  });
}

export class A2AInboundPluginHost {
  private readonly activeAccounts = new Map<string, ActiveAccountState>();

  constructor(private readonly pluginRuntime: PluginRuntime) {}

  async startAccount(
    ctx: ChannelGatewayContext<A2AInboundAccountConfig>,
  ): Promise<void> {
    const { accountId, account, cfg, abortSignal } = ctx;

    if (!account.enabled) {
      ctx.log?.info(`Skipping disabled A2A inbound account "${accountId}".`);
      return waitUntilAbort(abortSignal);
    }

    if (!ctx.channelRuntime) {
      ctx.log?.warn?.(
        `A2A inbound account "${accountId}" cannot start because channelRuntime is unavailable.`,
      );
      return waitUntilAbort(abortSignal);
    }

    if (!isA2AInboundAccountConfigured(account)) {
      ctx.log?.warn?.(
        `A2A inbound account "${accountId}" is not configured: ${explainA2AInboundAccountUnconfigured(account)}`,
      );
      return waitUntilAbort(abortSignal);
    }

    const server = await createA2AInboundServer({
      accountId,
      account,
      cfg,
      channelRuntime: ctx.channelRuntime,
      pluginRuntime: this.pluginRuntime,
      log: ctx.log,
    });

    this.activeAccounts.set(accountId, {
      account,
      server,
    });

    ctx.setStatus({
      ...ctx.getStatus(),
      accountId,
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      baseUrl: account.publicBaseUrl,
      webhookPath: account.jsonRpcPath,
      lastStartAt: Date.now(),
      mode: "a2a",
    });

    ctx.log?.info(
      `Started A2A inbound account "${accountId}" on ${account.jsonRpcPath}`,
    );

    return waitUntilAbort(abortSignal, () => {
      this.stopAccountInternal(accountId, ctx.log, ctx);
    });
  }

  async stopAccount(
    ctx: ChannelGatewayContext<A2AInboundAccountConfig>,
  ): Promise<void> {
    this.stopAccountInternal(ctx.accountId, ctx.log, ctx);
  }

  async handleHttpRoute(params: {
    accountId: string;
    req: IncomingMessage;
    res: ServerResponse;
  }): Promise<boolean> {
    const state = this.activeAccounts.get(params.accountId);

    if (!state) {
      return writeJson(params.res, 503, {
        error: {
          code: "A2A_ACCOUNT_NOT_RUNNING",
          message: "The requested A2A inbound account is not running.",
          details: {
            channel: CHANNEL_ID,
            accountId: params.accountId,
          },
        },
      });
    }

    try {
      return await state.server.handle(params.req, params.res);
    } catch (error) {
      if (params.res.writableEnded) {
        return true;
      }

      return writeJson(params.res, 500, {
        error: {
          code: "A2A_INBOUND_ROUTE_ERROR",
          message: "The inbound A2A route failed to process the request.",
          details: {
            channel: CHANNEL_ID,
            accountId: params.accountId,
            error: String(error),
          },
        },
      });
    }
  }

  async deliverQueuedReply(params: {
    accountId?: string | null;
    to: string;
    threadId?: string | number | null;
    payload: unknown;
    sessionKey?: string;
  }): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    const taskId =
      typeof params.threadId === "string" && params.threadId.trim().length > 0
        ? params.threadId.trim()
        : undefined;

    if (!taskId) {
      return {
        ok: false,
        error: A2A_INBOUND_QUEUED_REPLY_TASK_REQUIRED_MESSAGE,
      };
    }

    const accountId = this.resolveQueuedReplyAccountId(params);

    if (!accountId) {
      return {
        ok: false,
        error:
          `${A2A_INBOUND_QUEUED_REPLY_ACCOUNT_NOT_RUNNING_ERROR_CODE}: queued A2A protocol reply could not resolve a running inbound account.`,
      };
    }

    const state = this.activeAccounts.get(accountId);

    if (!state) {
      return {
        ok: false,
        error:
          `${A2A_INBOUND_QUEUED_REPLY_ACCOUNT_NOT_RUNNING_ERROR_CODE}: inbound A2A account "${accountId}" is not running.`,
      };
    }

    return state.server.deliverQueuedReply({
      taskId,
      payload: params.payload,
      sessionKey: params.sessionKey,
      to: params.to,
    });
  }

  private resolveQueuedReplyAccountId(params: {
    accountId?: string | null;
    to: string;
  }): string | undefined {
    if (typeof params.accountId === "string" && params.accountId.trim().length > 0) {
      return params.accountId.trim();
    }

    if (params.to.startsWith("a2a:")) {
      const accountId = params.to.slice("a2a:".length).trim();

      if (accountId.length > 0) {
        return accountId;
      }
    }

    if (this.activeAccounts.size === 1) {
      return this.activeAccounts.keys().next().value;
    }

    return undefined;
  }

  private stopAccountInternal(
    accountId: string,
    channelLog?: ChannelLogSink,
    ctx?: ChannelGatewayContext<A2AInboundAccountConfig>,
  ): void {
    const state = this.activeAccounts.get(accountId);
    state?.server.close();
    this.activeAccounts.delete(accountId);

    if (ctx) {
      ctx.setStatus({
        ...ctx.getStatus(),
        accountId,
        running: false,
        connected: false,
        lastStopAt: Date.now(),
      });
    }

    channelLog?.info(`Stopped A2A inbound account "${accountId}".`);
  }
}
