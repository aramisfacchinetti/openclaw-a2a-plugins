import test from "node:test";
import assert from "node:assert/strict";
import type {
  ChannelPlugin,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk";
import { createLoggerBackedRuntime } from "openclaw/plugin-sdk/runtime";
import plugin from "../dist/index.js";

type GatewayRequestHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type RegisterHttpRouteParams = Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];
type RegisterChannelParams = Parameters<OpenClawPluginApi["registerChannel"]>[0];
type RegisterGatewayMethod = OpenClawPluginApi["registerGatewayMethod"];

test("integration smoke: plugin loads with official OpenClawPluginApi shape", () => {
  const channels: ChannelPlugin[] = [];
  const routes: Array<{ path: string; auth: string }> = [];
  const gatewayMethods = new Map<string, GatewayRequestHandler>();
  const runtimeHelper = createLoggerBackedRuntime({
    logger: {
      info() {},
      error() {},
    },
  });

  const api = {
    id: "openclaw-a2a-inbound",
    name: "openclaw-a2a-inbound",
    version: "1.0.0",
    description: "test",
    source: "tests",
    registrationMode: "full",
    config: {
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
    } as OpenClawPluginApi["config"],
    pluginConfig: {},
    runtime: {
      logging: {},
      ...runtimeHelper,
    } as unknown as OpenClawPluginApi["runtime"],
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    registerTool() {},
    registerHook() {},
    registerHttpRoute(params: RegisterHttpRouteParams) {
      routes.push({ path: params.path, auth: params.auth });
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

  plugin.register(api);

  assert.equal(channels.length, 1);
  assert.equal(channels[0]?.id, "a2a");
  assert.equal(channels[0]?.capabilities.reply, false);
  assert.equal(routes.length, 2);
  assert.equal(gatewayMethods.size, 0);
});
