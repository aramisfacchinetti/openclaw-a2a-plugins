import test from "node:test";
import assert from "node:assert/strict";
import type {
  ChannelPlugin,
  GatewayRequestHandler,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk";
import { createLoggerBackedRuntime } from "openclaw/plugin-sdk";
import plugin from "../dist/index.js";

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

  const api: OpenClawPluginApi = {
    id: "openclaw-a2a-inbound",
    name: "openclaw-a2a-inbound",
    version: "1.0.0",
    description: "test",
    source: "tests",
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
    registerHttpRoute(params) {
      routes.push({ path: params.path, auth: params.auth });
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

  plugin.register(api);

  assert.equal(channels.length, 1);
  assert.equal(channels[0]?.id, "a2a");
  assert.equal(channels[0]?.capabilities.reply, false);
  assert.equal(routes.length, 2);
  assert.equal(gatewayMethods.size, 0);
});
