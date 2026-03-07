import test from "node:test";
import assert from "node:assert/strict";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import plugin from "../dist/index.js";
import type { A2AToolResult, FailureEnvelope } from "../dist/result-shape.js";

type RegisterToolCapture = (tool: AnyAgentTool, options?: { optional?: boolean }) => void;

type RegisteredTool = {
  descriptor: AnyAgentTool;
  options?: { optional?: boolean };
};

type ToolResultLike = {
  structuredContent?: unknown;
  content?: Array<{ text?: unknown }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError("expected object");
  }

  return value;
}

function toFailure(result: A2AToolResult): FailureEnvelope {
  assert.equal(result.ok, false);
  return result;
}

function createApi(
  pluginConfig: Record<string, unknown>,
  onRegisterTool: RegisterToolCapture,
): OpenClawPluginApi {
  const api: OpenClawPluginApi = {
    id: "openclaw-a2a-outbound",
    name: "openclaw-a2a-outbound",
    version: "1.0.0",
    source: "test",
    config: {} as OpenClawPluginApi["config"],
    pluginConfig,
    runtime: {
      logging: {},
    } as OpenClawPluginApi["runtime"],
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    registerTool(tool, options) {
      if (typeof tool === "function") {
        throw new TypeError("unexpected tool factory registration in test");
      }

      onRegisterTool(tool, options);
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

  return api;
}

function readStructuredContent<T = A2AToolResult>(result: unknown): T {
  const toolResult = asRecord(result) as ToolResultLike;

  if (toolResult.structuredContent !== undefined) {
    return toolResult.structuredContent as T;
  }

  if (!Array.isArray(toolResult.content)) {
    throw new TypeError("expected content array");
  }

  const first = toolResult.content[0];
  const firstRecord = asRecord(first);

  if (typeof firstRecord.text !== "string") {
    throw new TypeError("expected first content text");
  }

  return JSON.parse(firstRecord.text) as T;
}

async function executeTool(tool: AnyAgentTool, input: unknown): Promise<unknown> {
  const executable = tool as unknown as {
    execute: (arg: unknown, context: unknown) => Promise<unknown>;
  };

  return executable.execute(input, {});
}

async function executeToolByIdAndInput(
  tool: AnyAgentTool,
  callId: string,
  input: unknown,
): Promise<unknown> {
  const executable = tool as unknown as {
    execute: (id: string, params: unknown, context: unknown) => Promise<unknown>;
  };

  return executable.execute(callId, input, {});
}

test("plugin registration with enabled=false registers no tools", () => {
  const tools: RegisteredTool[] = [];

  plugin.register(
    createApi({ enabled: false }, (descriptor, options) => {
      tools.push({ descriptor, options });
    }),
  );

  assert.equal(tools.length, 0);
});

test("plugin registers one optional remote_agent tool", () => {
  const tools: RegisteredTool[] = [];

  plugin.register(
    createApi({ enabled: true }, (descriptor, options) => {
      tools.push({ descriptor, options });
    }),
  );

  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.descriptor.name, "remote_agent");
  assert.deepEqual(tools[0]?.options, { optional: true });
  assert.equal(typeof tools[0]?.descriptor.execute, "function");
});

test("plugin registration parses pluginConfig through configSchema once", () => {
  const tools: RegisteredTool[] = [];
  const configSchema = plugin.configSchema as {
    parse?: (value: unknown) => unknown;
  };

  const originalParse = configSchema.parse;
  assert.equal(typeof originalParse, "function");

  let parseCalls = 0;
  configSchema.parse = (value: unknown) => {
    parseCalls += 1;
    return originalParse!(value);
  };

  try {
    plugin.register(
      createApi({ enabled: true }, (descriptor, options) => {
        tools.push({ descriptor, options });
      }),
    );
  } finally {
    configSchema.parse = originalParse;
  }

  assert.equal(parseCalls, 1);
  assert.equal(tools.length, 1);
});

test("plugin builds config-driven remote_agent schema", () => {
  const tools: RegisteredTool[] = [];

  plugin.register(
    createApi(
      {
        enabled: true,
        targets: [
          {
            alias: "support",
            baseUrl: "https://support.example",
            default: true,
          },
          {
            alias: "billing",
            baseUrl: "https://billing.example",
          },
        ],
      },
      (descriptor, options) => {
        tools.push({ descriptor, options });
      },
    ),
  );

  const registered = tools[0]?.descriptor as AnyAgentTool & {
    parameters: {
      properties: Record<string, unknown>;
    };
    description: string;
  };
  const targetAlias = registered.parameters.properties.target_alias as {
    enum?: string[];
  };

  assert.deepEqual(targetAlias.enum, ["support", "billing"]);
  assert.match(registered.description, /Configured targets: support, billing\./);
});

test("remote_agent execute rejects malformed input with a validation envelope", async () => {
  const tools = new Map<string, AnyAgentTool>();

  plugin.register(
    createApi({ enabled: true }, (descriptor) => {
      tools.set(descriptor.name, descriptor);
    }),
  );

  const remoteAgent = tools.get("remote_agent");
  assert.ok(remoteAgent);
  const result = await executeTool(remoteAgent, {
    action: "send",
    input: "hello",
  });

  const payload = toFailure(readStructuredContent(result));
  const details = asRecord(payload.error.details);

  assert.equal(payload.operation, "remote_agent");
  assert.equal(payload.action, "send");
  assert.equal(payload.error.code, "VALIDATION_ERROR");
  assert.equal(details.source, "ajv");
  assert.equal(details.tool, "remote_agent");
  assert.ok(Array.isArray(details.errors));
  assert.ok((details.errors as unknown[]).length > 0);
});

test("remote_agent execute accepts execute(callId, params) signature", async () => {
  const tools = new Map<string, AnyAgentTool>();

  plugin.register(
    createApi({ enabled: true }, (descriptor) => {
      tools.set(descriptor.name, descriptor);
    }),
  );

  const remoteAgent = tools.get("remote_agent");
  assert.ok(remoteAgent);
  const result = await executeToolByIdAndInput(remoteAgent, "call-1", {
    action: "watch",
  });

  const payload = toFailure(readStructuredContent(result));

  assert.equal(payload.operation, "remote_agent");
  assert.equal(payload.action, "watch");
  assert.equal(payload.error.code, "VALIDATION_ERROR");
});

test("remote_agent execute returns VALIDATION_ERROR for unknown alias", async () => {
  const tools = new Map<string, AnyAgentTool>();

  plugin.register(
    createApi(
      {
        enabled: true,
        targets: [
          {
            alias: "support",
            baseUrl: "https://support.example",
            default: true,
          },
        ],
      },
      (descriptor) => {
        tools.set(descriptor.name, descriptor);
      },
    ),
  );

  const remoteAgent = tools.get("remote_agent");
  assert.ok(remoteAgent);
  const result = await executeTool(remoteAgent, {
    action: "send",
    target_alias: "unknown",
    input: "hello",
  });

  const payload = toFailure(readStructuredContent(result));

  assert.equal(payload.operation, "remote_agent");
  assert.equal(payload.action, "send");
  assert.equal(payload.error.code, "VALIDATION_ERROR");
  const details = asRecord(payload.error.details);
  assert.ok(Array.isArray(details.errors));
});

test("remote_agent execute returns UNKNOWN_TASK_HANDLE for missing handle", async () => {
  const tools = new Map<string, AnyAgentTool>();

  plugin.register(
    createApi({ enabled: true }, (descriptor) => {
      tools.set(descriptor.name, descriptor);
    }),
  );

  const remoteAgent = tools.get("remote_agent");
  assert.ok(remoteAgent);
  const result = await executeTool(remoteAgent, {
    action: "status",
    task_handle: "rah_missing-handle-id",
  });

  const payload = toFailure(readStructuredContent(result));

  assert.equal(payload.operation, "remote_agent");
  assert.equal(payload.action, "status");
  assert.equal(payload.error.code, "UNKNOWN_TASK_HANDLE");
  const details = asRecord(payload.error.details);
  assert.equal(details.suggested_action, "send");
});
