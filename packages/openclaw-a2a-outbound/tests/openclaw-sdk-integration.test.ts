import test from "node:test";
import assert from "node:assert/strict";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createLoggerBackedRuntime } from "openclaw/plugin-sdk/runtime";
import cliMetadata from "../dist/cli-metadata.js";
import plugin from "../dist/index.js";

type RegisterTool = OpenClawPluginApi["registerTool"];

test("integration smoke: plugin loads with official OpenClawPluginApi shape", () => {
  const registrations: Array<{ tool: AnyAgentTool; opts?: { optional?: boolean } }> =
    [];
  const runtimeHelper = createLoggerBackedRuntime({
    logger: {
      info() {},
      error() {},
    },
  });

  const api = {
    id: "openclaw-a2a-outbound",
    name: "openclaw-a2a-outbound",
    version: "1.0.0",
    description: "test",
    source: "tests",
    registrationMode: "full",
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
    registerTool(
      tool: Parameters<RegisterTool>[0],
      opts?: Parameters<RegisterTool>[1],
    ) {
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
    resolvePath(input: string) {
      return input;
    },
    on() {},
  } as unknown as OpenClawPluginApi;

  plugin.register(api);

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]?.tool.name, "remote_agent");
  assert.deepEqual(registrations[0]?.opts, { optional: true });
  assert.equal(typeof registrations[0]?.tool.execute, "function");
});

test("cli metadata entry registers the a2a command during discovery", () => {
  const registrations: Array<{
    commands?: string[];
    descriptors?: Array<{
      name: string;
      description?: string;
      hasSubcommands?: boolean;
    }>;
  }> = [];

  const api = {
    id: "openclaw-a2a-outbound",
    name: "openclaw-a2a-outbound",
    version: "1.0.0",
    description: "test",
    source: "tests",
    registrationMode: "cli-metadata",
    config: {} as OpenClawPluginApi["config"],
    pluginConfig: {
      enabled: false,
    },
    runtime: {} as OpenClawPluginApi["runtime"],
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    registerTool() {},
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli(
      _registrar: unknown,
      opts?: {
        commands?: string[];
        descriptors?: Array<{
          name: string;
          description?: string;
          hasSubcommands?: boolean;
        }>;
      },
    ) {
      registrations.push(opts ?? {});
    },
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    resolvePath(input: string) {
      return input;
    },
    on() {},
  } as unknown as OpenClawPluginApi;

  cliMetadata.register(api);

  assert.deepEqual(registrations[0]?.commands, ["a2a"]);
  assert.deepEqual(registrations[0]?.descriptors, [
    {
      name: "a2a",
      description: "A2A outbound demo and diagnostics",
      hasSubcommands: true,
    },
  ]);
});
