import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ChannelGatewayContext,
  ChannelLogSink,
  PluginRuntime,
} from "openclaw/plugin-sdk";
import {
  explainA2AInboundAccountUnconfigured,
  isA2AInboundAccountConfigured,
  resolveConfiguredAuthToken,
  type A2AInboundAccountConfig,
} from "./config.js";
import { createA2AInboundServer, type A2AInboundServer } from "./a2a-server.js";
import { CHANNEL_ID } from "./constants.js";

type ActiveAccountState = {
  account: A2AInboundAccountConfig;
  server: A2AInboundServer;
};

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

function readHeader(
  req: IncomingMessage,
  headerName: string,
): string | undefined {
  const raw = req.headers[headerName.toLowerCase()];

  if (Array.isArray(raw)) {
    return raw[0];
  }

  return typeof raw === "string" ? raw : undefined;
}

function authorizeRequest(
  account: A2AInboundAccountConfig,
  req: IncomingMessage,
): { statusCode: number; message: string } | undefined {
  if (account.auth.mode !== "header-token") {
    return undefined;
  }

  const expected = resolveConfiguredAuthToken(account.auth);

  if (!expected) {
    return {
      statusCode: 503,
      message:
        "The account is configured for header-token auth but no token is currently resolvable.",
    };
  }

  const actual = readHeader(req, account.auth.headerName);

  if (actual === expected) {
    return undefined;
  }

  if (
    account.auth.headerName.toLowerCase() === "authorization" &&
    typeof actual === "string" &&
    actual.startsWith("Bearer ") &&
    actual.slice("Bearer ".length).trim() === expected
  ) {
    return undefined;
  }

  return {
    statusCode: 401,
    message: `Missing or invalid ${account.auth.headerName} header.`,
  };
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

    const server = createA2AInboundServer({
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

    const authFailure = authorizeRequest(state.account, params.req);

    if (authFailure) {
      return writeJson(params.res, authFailure.statusCode, {
        error: {
          code: "A2A_REQUEST_UNAUTHORIZED",
          message: authFailure.message,
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
