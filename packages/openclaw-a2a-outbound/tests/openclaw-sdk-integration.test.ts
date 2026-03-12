import test from "node:test";
import assert from "node:assert/strict";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createLoggerBackedRuntime } from "openclaw/plugin-sdk";
import plugin from "../dist/index.js";

test("integration smoke: plugin loads with official OpenClawPluginApi shape", () => {
  const registrations: Array<{ tool: AnyAgentTool; opts?: { optional?: boolean } }> =
    [];
  const runtimeHelper = createLoggerBackedRuntime({
    logger: {
      info() {},
      error() {},
    },
  });

  const api: OpenClawPluginApi = {
    id: "openclaw-a2a-outbound",
    name: "openclaw-a2a-outbound",
    version: "1.0.0",
    description: "test",
    source: "tests",
    config: {} as OpenClawPluginApi["config"],
    pluginConfig: {
      enabled: true,
      targets: [
        {
          alias: "support",
          baseUrl: "https://support.example",
          default: true,
        },
      ],
    },
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
    registerTool(tool, opts) {
      if (typeof tool === "function") {
        throw new TypeError("unexpected tool factory registration in test");
      }

      registrations.push({ tool, opts });
    },
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
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

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]?.tool.name, "remote_agent");
  assert.deepEqual(registrations[0]?.opts, { optional: true });
  assert.equal(typeof registrations[0]?.tool.execute, "function");
});
