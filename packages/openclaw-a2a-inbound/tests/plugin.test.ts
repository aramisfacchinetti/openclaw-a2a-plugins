import test from "node:test";
import assert from "node:assert/strict";
import type {
  ChannelPlugin,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk";
import { buildA2AInboundChannel } from "../dist/channel.js";
import { A2A_INBOUND_UNSUPPORTED_OUTBOUND_DELIVERY_MESSAGE } from "../dist/constants.js";
import plugin from "../dist/index.js";

type HttpRouteRegistration = {
  path: string;
  auth: "gateway" | "plugin";
  match?: "exact" | "prefix";
};

type CapturedLogs = {
  debug: string[];
  info: string[];
  warn: string[];
  error: string[];
};

type GatewayRequestHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type RegisterHttpRouteParams = Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];
type RegisterChannelParams = Parameters<OpenClawPluginApi["registerChannel"]>[0];
type RegisterGatewayMethod = OpenClawPluginApi["registerGatewayMethod"];

function createApi(
  config: Record<string, unknown>,
  registrationMode: OpenClawPluginApi["registrationMode"] = "full",
): OpenClawPluginApi {
  const routes: HttpRouteRegistration[] = [];
  const channels: ChannelPlugin[] = [];
  const gatewayMethods = new Map<string, GatewayRequestHandler>();
  const logs: CapturedLogs = {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };

  const api = {
    id: "openclaw-a2a-inbound",
    name: "openclaw-a2a-inbound",
    version: "1.0.0",
    source: "test",
    registrationMode,
    config: config as OpenClawPluginApi["config"],
    pluginConfig: {},
    runtime: {
      logging: {},
    } as OpenClawPluginApi["runtime"],
    logger: {
      debug(message: string) {
        logs.debug.push(message);
      },
      info(message: string) {
        logs.info.push(message);
      },
      warn(message: string) {
        logs.warn.push(message);
      },
      error(message: string) {
        logs.error.push(message);
      },
    },
    registerTool() {},
    registerHook() {},
    registerHttpRoute(params: RegisterHttpRouteParams) {
      routes.push({ path: params.path, auth: params.auth, match: params.match });
    },
    registerChannel(registration: RegisterChannelParams) {
      channels.push(
        "plugin" in registration ? registration.plugin : registration,
      );
    },
    registerGatewayMethod(
      method: Parameters<RegisterGatewayMethod>[0],
      handler: Parameters<RegisterGatewayMethod>[1],
    ) {
      gatewayMethods.set(method, handler);
    },
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    resolvePath(input: string) {
      return input;
    },
    on() {},
  } as unknown as OpenClawPluginApi;

  Object.assign(api, {
    __routes: routes,
    __channels: channels,
    __gatewayMethods: gatewayMethods,
    __logs: logs,
  });

  return api;
}

function getInternalCollections(api: OpenClawPluginApi): {
  routes: HttpRouteRegistration[];
  channels: ChannelPlugin[];
  gatewayMethods: Map<string, GatewayRequestHandler>;
  logs: CapturedLogs;
} {
  return {
    routes: (api as OpenClawPluginApi & { __routes: HttpRouteRegistration[] })
      .__routes,
    channels: (api as OpenClawPluginApi & { __channels: ChannelPlugin[] })
      .__channels,
    gatewayMethods: (
      api as OpenClawPluginApi & {
        __gatewayMethods: Map<string, GatewayRequestHandler>;
      }
    ).__gatewayMethods,
    logs: (api as OpenClawPluginApi & { __logs: CapturedLogs }).__logs,
  };
}

test("plugin registers one channel and the phase 1 HTTP routes", () => {
  const api = createApi({
    channels: {
      a2a: {
        accounts: {
          default: {
            enabled: true,
            publicBaseUrl: "https://agents.example.com",
          },
        },
      },
    },
  });

  plugin.register(api);

  const { routes, channels, gatewayMethods } = getInternalCollections(api);

  assert.equal(channels.length, 1);
  assert.equal(channels[0]?.id, "a2a");
  assert.deepEqual(channels[0]?.capabilities, {
    chatTypes: ["direct"],
    reply: false,
    blockStreaming: true,
  });
  assert.deepEqual(
    routes.map((route) => [route.path, route.match ?? "exact"]),
    [
      ["/.well-known/agent-card.json", "exact"],
      ["/a2a/jsonrpc", "exact"],
    ],
  );
  assert.equal(
    routes.every((route) => route.auth === "plugin"),
    true,
  );
  assert.equal(gatewayMethods.size, 0);
});

test("plugin tolerates missing channel accounts and only registers the channel", () => {
  const api = createApi({});

  plugin.register(api);

  const { routes, channels, gatewayMethods } = getInternalCollections(api);

  assert.equal(channels.length, 1);
  assert.equal(routes.length, 0);
  assert.equal(gatewayMethods.size, 0);
});

test("plugin defers loaded logging during non-full registration", () => {
  const api = createApi(
    {
      channels: {
        a2a: {
          accounts: {
            default: {
              enabled: true,
              publicBaseUrl: "https://agents.example.com",
            },
          },
        },
      },
    },
    "setup-runtime",
  );

  plugin.register(api);

  const { logs } = getInternalCollections(api);

  assert.equal(logs.info.some((entry) => entry.includes("a2a.inbound.plugin.loaded")), false);
  assert.equal(
    logs.debug.some(
      (entry) =>
        entry.includes("a2a.inbound.registration.deferred") &&
        entry.includes('"registrationMode":"setup-runtime"'),
    ),
    true,
  );
});

test("inbound outbound adapter fails with the documented boundary message", async () => {
  const api = createApi({});

  plugin.register(api);

  const { channels } = getInternalCollections(api);
  const channel = channels[0];
  assert.ok(channel);
  assert.ok(channel.outbound);
  const sendText = channel.outbound.sendText as (params: {
    accountId: string;
    to: string;
    text: string;
  }) => Promise<unknown>;

  await assert.rejects(
    sendText({
      accountId: "default",
      to: "a2a:peer",
      text: "follow up",
    }),
    {
      message: A2A_INBOUND_UNSUPPORTED_OUTBOUND_DELIVERY_MESSAGE,
    },
  );
});

test("channel declares protocol queued replies and delegates them to the host", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const channel = buildA2AInboundChannel({
    async deliverQueuedReply(params: Record<string, unknown>) {
      calls.push(params);
      return { ok: true, messageId: "queued-1" };
    },
  } as never);
  const queuedReply = (
    channel as unknown as {
      queuedReply?: {
        mode?: string;
        deliverQueuedReply?: (ctx: Record<string, unknown>) => Promise<{
          ok: boolean;
          messageId?: string;
          error?: string;
        }>;
      };
    }
  ).queuedReply;

  assert.equal(queuedReply?.mode, "protocol");

  const result = await queuedReply?.deliverQueuedReply?.({
    accountId: "default",
    to: "a2a:default",
    threadId: "task-123",
    sessionKey: "session:test",
    payload: { text: "Resume the task." },
  });

  assert.deepEqual(result, { ok: true, messageId: "queued-1" });
  assert.deepEqual(calls, [
    {
      accountId: "default",
      to: "a2a:default",
      threadId: "task-123",
      sessionKey: "session:test",
      payload: { text: "Resume the task." },
    },
  ]);
});
