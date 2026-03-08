import test from "node:test";
import assert from "node:assert/strict";
import type {
  ChannelPlugin,
  OpenClawPluginApi,
  GatewayRequestHandler,
} from "openclaw/plugin-sdk";
import plugin from "../dist/index.js";

type HttpRouteRegistration = {
  path: string;
  auth: "gateway" | "plugin";
  match?: "exact" | "prefix";
};

function createApi(config: Record<string, unknown>): OpenClawPluginApi {
  const routes: HttpRouteRegistration[] = [];
  const channels: ChannelPlugin[] = [];
  const gatewayMethods = new Map<string, GatewayRequestHandler>();

  const api: OpenClawPluginApi = {
    id: "openclaw-a2a-inbound",
    name: "openclaw-a2a-inbound",
    version: "1.0.0",
    source: "test",
    config: config as OpenClawPluginApi["config"],
    pluginConfig: {},
    runtime: {
      logging: {},
    } as OpenClawPluginApi["runtime"],
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    registerTool() {},
    registerHook() {},
    registerHttpRoute(params) {
      routes.push({ path: params.path, auth: params.auth, match: params.match });
    },
    registerChannel(registration) {
      channels.push(
        "plugin" in registration ? registration.plugin : registration,
      );
    },
    registerGatewayMethod(method, handler) {
      gatewayMethods.set(method, handler);
    },
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    resolvePath(input) {
      return input;
    },
    on() {},
  };

  Object.assign(api, {
    __routes: routes,
    __channels: channels,
    __gatewayMethods: gatewayMethods,
  });

  return api;
}

function getInternalCollections(api: OpenClawPluginApi): {
  routes: HttpRouteRegistration[];
  channels: ChannelPlugin[];
  gatewayMethods: Map<string, GatewayRequestHandler>;
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
  };
}

test("plugin registers one channel, account routes, and a gateway method", () => {
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
  assert.deepEqual(
    routes.map((route) => [route.path, route.match ?? "exact"]),
    [
      ["/.well-known/agent-card.json", "exact"],
      ["/a2a/jsonrpc", "exact"],
      ["/a2a/rest", "exact"],
      ["/a2a/files", "prefix"],
    ],
  );
  assert.equal(
    routes.every((route) => route.auth === "plugin"),
    true,
  );
  assert.equal(gatewayMethods.has("openclaw-a2a-inbound.describe"), true);
});

test("plugin tolerates missing channel accounts and only registers the channel", () => {
  const api = createApi({});

  plugin.register(api);

  const { routes, channels, gatewayMethods } = getInternalCollections(api);

  assert.equal(channels.length, 1);
  assert.equal(routes.length, 0);
  assert.equal(gatewayMethods.has("openclaw-a2a-inbound.describe"), true);
});
