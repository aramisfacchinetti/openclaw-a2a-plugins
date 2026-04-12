import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type {
  AnyAgentTool,
  ChannelAccountSnapshot,
  ChannelPlugin,
  OpenClawConfig,
  OpenClawPluginApi,
  PluginRuntime,
} from "openclaw/plugin-sdk";
import type { A2AInboundAccountConfig } from "../../packages/openclaw-a2a-inbound/src/config.js";
import { A2A_INBOUND_UNSUPPORTED_OUTBOUND_DELIVERY_MESSAGE } from "../../packages/openclaw-a2a-inbound/dist/constants.js";
import type {
  A2AToolResult,
  SuccessEnvelope,
} from "../../packages/openclaw-a2a-outbound/src/result-shape.js";
import {
  closeHttpServer,
  createAccount,
  createMinimalPluginRuntime,
  listen,
  type RuntimeScript,
} from "./outbound-inbound-harness.js";

type ToolResultLike = {
  structuredContent?: unknown;
  content?: Array<{ text?: unknown }>;
};

type PluginRecordLike = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  origin: "workspace";
  enabled: boolean;
  status: "loaded";
  toolNames: string[];
  hookNames: string[];
  channelIds: string[];
  providerIds: string[];
  gatewayMethods: string[];
  cliCommands: string[];
  services: string[];
  commands: string[];
  httpRoutes: number;
  hookCount: number;
  configSchema: boolean;
  workspaceDir?: string;
};

type RegisteredHttpRoute = {
  path: string;
  match?: "exact" | "prefix";
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<boolean | void> | boolean | void;
};

type PluginRegistryLike = {
  plugins: PluginRecordLike[];
  tools: Array<{
    pluginId: string;
    factory: (ctx: Record<string, unknown>) => AnyAgentTool | AnyAgentTool[] | null | undefined;
    names: string[];
    optional: boolean;
    source: string;
  }>;
  channels: Array<{
    pluginId: string;
    plugin: ChannelPlugin<A2AInboundAccountConfig>;
    source: string;
  }>;
  httpRoutes: RegisteredHttpRoute[];
  diagnostics: Array<{
    level: string;
    message: string;
    pluginId?: string;
  }>;
};

type SDKPluginEntry = {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  configSchema?: unknown;
  register(api: OpenClawPluginApi): void;
};

const REPO_ROOT = resolve(process.cwd());
const INBOUND_PLUGIN_SOURCE = resolve(
  REPO_ROOT,
  "packages/openclaw-a2a-inbound/dist/index.js",
);
const OUTBOUND_PLUGIN_SOURCE = resolve(
  REPO_ROOT,
  "packages/openclaw-a2a-outbound/dist/index.js",
);
const TARGET_ALIAS = "local";

const NOOP_LOGGER: OpenClawPluginApi["logger"] = {
  debug() {},
  info() {},
  warn() {},
  error() {},
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

function asSuccess(result: A2AToolResult): SuccessEnvelope {
  if (result.ok !== true) {
    throw new TypeError("expected success result");
  }

  return result;
}

function asMessage(raw: SuccessEnvelope["raw"]): {
  kind: "message";
  parts: Array<{ kind: string; text?: string }>;
} {
  if (typeof raw !== "object" || raw === null || (raw as { kind?: unknown }).kind !== "message") {
    throw new TypeError("expected raw message");
  }

  return raw as {
    kind: "message";
    parts: Array<{ kind: string; text?: string }>;
  };
}

function readMessageText(message: { parts: Array<{ kind: string; text?: string }> }): string {
  return message.parts
    .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
    .map((part) => part.text)
    .join("\n");
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
    execute: (input: unknown, context: unknown) => Promise<unknown>;
  };

  return executable.execute(input, {});
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }

  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function createCapturedPluginRegistry(params: {
  logger: OpenClawPluginApi["logger"];
  runtime: PluginRuntime;
}): {
  registry: PluginRegistryLike;
  createApi: (
    record: PluginRecordLike,
    args: {
      config: OpenClawPluginApi["config"];
      pluginConfig?: Record<string, unknown>;
    },
  ) => OpenClawPluginApi;
} {
  const registry: PluginRegistryLike = {
    plugins: [],
    tools: [],
    channels: [],
    httpRoutes: [],
    diagnostics: [],
  };

  const pushUnique = (target: string[], value: string) => {
    if (!target.includes(value)) {
      target.push(value);
    }
  };

  const readToolNames = (
    tool: AnyAgentTool | ((ctx: Record<string, unknown>) => AnyAgentTool | AnyAgentTool[] | null | undefined),
    opts?: { name?: string; names?: string[]; optional?: boolean },
  ): string[] => {
    const explicitNames = [
      ...(opts?.name ? [opts.name] : []),
      ...(opts?.names ?? []),
    ].filter((name): name is string => typeof name === "string" && name.length > 0);

    if (explicitNames.length > 0) {
      return [...new Set(explicitNames)];
    }

    if (typeof tool === "function") {
      return [];
    }

    return typeof tool.name === "string" && tool.name.length > 0 ? [tool.name] : [];
  };

  return {
    registry,
    createApi(record, args) {
      const api = {
        id: record.id,
        name: record.name,
        ...(record.version ? { version: record.version } : {}),
        ...(record.description ? { description: record.description } : {}),
        source: record.source,
        ...(record.workspaceDir ? { rootDir: record.workspaceDir } : {}),
        registrationMode: "full" as const,
        config: args.config,
        ...(args.pluginConfig ? { pluginConfig: args.pluginConfig } : {}),
        runtime: params.runtime,
        logger: params.logger,
        registerTool(tool, opts) {
          const names = readToolNames(tool, opts);
          const factory =
            typeof tool === "function"
              ? tool
              : () => tool;

          for (const name of names) {
            pushUnique(record.toolNames, name);
          }

          registry.tools.push({
            pluginId: record.id,
            factory,
            names,
            optional: opts?.optional === true,
            source: record.source,
          });
        },
        registerHook(events, _handler, opts) {
          record.hookCount += 1;
          const names = [
            ...(typeof opts?.name === "string" ? [opts.name] : []),
            ...(Array.isArray(events) ? events : [events]),
          ];

          for (const name of names) {
            if (typeof name === "string" && name.length > 0) {
              pushUnique(record.hookNames, name);
            }
          }
        },
        registerHttpRoute(route) {
          record.httpRoutes += 1;
          registry.httpRoutes.push({
            path: route.path,
            ...(route.match ? { match: route.match } : {}),
            handler: route.handler,
          });
        },
        registerChannel(registration) {
          const plugin = "plugin" in registration ? registration.plugin : registration;
          pushUnique(record.channelIds, plugin.id);
          registry.channels.push({
            pluginId: record.id,
            plugin,
            source: record.source,
          });
        },
        registerGatewayMethod(method) {
          pushUnique(record.gatewayMethods, method);
        },
        registerCli(_registrar, opts) {
          for (const command of opts?.commands ?? []) {
            if (typeof command === "string" && command.length > 0) {
              pushUnique(record.cliCommands, command);
            }
          }
        },
        registerReload() {},
        registerNodeHostCommand(command) {
          pushUnique(record.commands, command.command);
        },
        registerSecurityAuditCollector() {},
        registerService(service) {
          if (typeof service.id === "string" && service.id.length > 0) {
            pushUnique(record.services, service.id);
          }
        },
        registerCliBackend() {},
        registerConfigMigration() {},
        registerAutoEnableProbe() {},
        registerProvider(provider) {
          pushUnique(record.providerIds, provider.id);
        },
        registerSpeechProvider() {},
        registerRealtimeTranscriptionProvider() {},
        registerRealtimeVoiceProvider() {},
        registerMediaUnderstandingProvider() {},
        registerImageGenerationProvider() {},
        registerVideoGenerationProvider() {},
        registerMusicGenerationProvider() {},
        registerWebFetchProvider() {},
        registerWebSearchProvider() {},
        registerMemoryEmbeddingProvider() {},
      } satisfies OpenClawPluginApi;

      return api;
    },
  };
}

async function loadPluginEntry(source: string): Promise<SDKPluginEntry> {
  const module = (await import(pathToFileURL(source).href)) as {
    default?: unknown;
  };

  if (!module.default || typeof module.default !== "object") {
    throw new TypeError(`expected plugin default export from ${source}`);
  }

  return module.default as SDKPluginEntry;
}

function createPluginRecord(entry: SDKPluginEntry, source: string): PluginRecordLike {
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    ...(entry.version ? { version: entry.version } : {}),
    ...(entry.description ? { description: entry.description } : {}),
    source,
    origin: "workspace",
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    providerIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: entry.configSchema !== undefined,
    workspaceDir: REPO_ROOT,
  };
}

function registerPlugin(params: {
  registry: PluginRegistryLike;
  createApi: (
    record: PluginRecordLike,
    params: {
      config: OpenClawPluginApi["config"];
      pluginConfig?: Record<string, unknown>;
    },
  ) => OpenClawPluginApi;
  entry: SDKPluginEntry;
  source: string;
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
}): PluginRecordLike {
  const record = createPluginRecord(params.entry, params.source);
  const api = params.createApi(record, {
    config: params.config,
    ...(params.pluginConfig ? { pluginConfig: params.pluginConfig } : {}),
  });

  params.entry.register(api);
  params.registry.plugins.push(record);
  return record;
}

function createRootConfig(account: A2AInboundAccountConfig): OpenClawConfig {
  return {
    channels: {
      a2a: {
        accounts: {
          [account.accountId]: {
            enabled: account.enabled,
            label: account.label,
            ...(account.description ? { description: account.description } : {}),
            ...(account.publicBaseUrl ? { publicBaseUrl: account.publicBaseUrl } : {}),
            ...(account.defaultAgentId ? { defaultAgentId: account.defaultAgentId } : {}),
            ...(account.sessionStore ? { sessionStore: account.sessionStore } : {}),
            protocolVersion: account.protocolVersion,
            agentCardPath: account.agentCardPath,
            jsonRpcPath: account.jsonRpcPath,
            maxBodyBytes: account.maxBodyBytes,
            defaultInputModes: [...account.defaultInputModes],
            defaultOutputModes: [...account.defaultOutputModes],
            agentStyle: account.agentStyle,
            originRoutingPolicy: account.originRoutingPolicy,
            taskStore: account.taskStore,
            skills: account.skills.map((skill) => ({
              id: skill.id,
              name: skill.name,
              ...(skill.description ? { description: skill.description } : {}),
              tags: [...skill.tags],
              examples: [...skill.examples],
            })),
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createOutboundPluginConfig(account: A2AInboundAccountConfig) {
  return {
    enabled: true,
    defaults: {
      timeoutMs: 5_000,
      cardPath: account.agentCardPath,
      preferredTransports: ["JSONRPC", "HTTP+JSON"],
      serviceParameters: {},
    },
    targets: [
      {
        alias: TARGET_ALIAS,
        baseUrl: account.publicBaseUrl,
        description: account.description,
        tags: ["e2e", "host"],
        cardPath: account.agentCardPath,
        preferredTransports: ["JSONRPC", "HTTP+JSON"],
        examples: ["Use the local full-host peer."],
        default: true,
      },
    ],
    taskHandles: {
      ttlMs: 60_000,
      maxEntries: 100,
    },
    policy: {
      acceptedOutputModes: ["text/plain", "application/json"],
      normalizeBaseUrl: true,
      enforceSupportedTransports: true,
      allowTargetUrlOverride: false,
    },
  };
}

async function dispatchRegisteredRoute(
  routes: RegisteredHttpRoute[],
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

  for (const route of routes) {
    const match = route.match ?? "exact";
    const matches =
      match === "prefix"
        ? pathname === route.path || pathname.startsWith(route.path)
        : pathname === route.path;

    if (!matches) {
      continue;
    }

    const handled = await route.handler(req, res);

    if (handled !== false || res.writableEnded) {
      return;
    }
  }

  if (!res.writableEnded) {
    res.statusCode = 404;
    res.end("not found");
  }
}

function resolveRegisteredTool(
  registry: PluginRegistryLike,
  name: string,
  config: OpenClawConfig,
): AnyAgentTool {
  const registration = registry.tools.find((entry) => entry.names.includes(name));
  assert.ok(registration, `expected registered tool ${name}`);

  const resolved = registration.factory({
    config,
    workspaceDir: REPO_ROOT,
    agentId: "main",
    sessionKey: "session:full-host-smoke",
  });
  const tools = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
  const tool = tools.find((entry) => entry.name === name);

  assert.ok(tool, `expected resolved tool ${name}`);
  return tool;
}

function createInitialStatus(
  channel: ChannelPlugin<A2AInboundAccountConfig>,
  account: A2AInboundAccountConfig,
  config: OpenClawConfig,
): ChannelAccountSnapshot {
  return (
    channel.config.describeAccount?.(account, config) ?? {
      accountId: account.accountId,
      name: account.label,
      enabled: account.enabled,
      configured: true,
      connected: false,
      running: false,
      baseUrl: account.publicBaseUrl,
      webhookPath: account.jsonRpcPath,
      mode: "a2a",
    }
  );
}

type StartedFullHostHarness = {
  account: A2AInboundAccountConfig;
  registry: PluginRegistryLike;
  rootConfig: OpenClawConfig;
  requestCounts: {
    agentCard: number;
    jsonRpc: number;
  };
  cleanup: () => Promise<void>;
};

async function startFullHostHarness(params: {
  script: RuntimeScript;
  accountOverrides?: Partial<A2AInboundAccountConfig>;
}): Promise<StartedFullHostHarness> {
  const requestCounts = {
    agentCard: 0,
    jsonRpc: 0,
  };
  const tempDir = await mkdtemp(join(tmpdir(), "openclaw-a2a-full-host-"));
  const routeServer = createServer();
  const baseUrl = await listen(routeServer);
  const account = createAccount(baseUrl, tempDir, {
    label: "Full Host Smoke Agent",
    description: "Public OpenClaw plugin API registration smoke for inbound and outbound A2A.",
    ...params.accountOverrides,
  });
  const rootConfig = createRootConfig(account);
  const outboundPluginConfig = createOutboundPluginConfig(account);
  const { pluginRuntime, waitForPending } = createMinimalPluginRuntime(
    params.script,
    tempDir,
  );
  const [registeredInboundPlugin, registeredOutboundPlugin] = await Promise.all([
    loadPluginEntry(INBOUND_PLUGIN_SOURCE),
    loadPluginEntry(OUTBOUND_PLUGIN_SOURCE),
  ]);
  const { registry, createApi } = createCapturedPluginRegistry({
    logger: NOOP_LOGGER,
    runtime: pluginRuntime,
  });

  let startedAccountPromise: Promise<unknown> | undefined;
  const accountAbort = new AbortController();

  routeServer.removeAllListeners("request");
  routeServer.on("request", (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

    if (pathname === account.agentCardPath) {
      requestCounts.agentCard += 1;
    }

    if (pathname === account.jsonRpcPath) {
      requestCounts.jsonRpc += 1;
    }

    void dispatchRegisteredRoute(registry.httpRoutes, req, res).catch(
      (error: unknown) => {
        if (res.writableEnded) {
          return;
        }

        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      },
    );
  });

  registerPlugin({
    registry,
    createApi,
    entry: registeredInboundPlugin,
    source: INBOUND_PLUGIN_SOURCE,
    config: rootConfig,
  });
  registerPlugin({
    registry,
    createApi,
    entry: registeredOutboundPlugin,
    source: OUTBOUND_PLUGIN_SOURCE,
    config: rootConfig,
    pluginConfig: outboundPluginConfig,
  });

  const inboundChannel = registry.channels.find((entry) => entry.plugin.id === "a2a");
  assert.ok(inboundChannel, "expected the inbound channel to be registered");
  assert.equal(typeof inboundChannel.plugin.gateway?.startAccount, "function");

  let status = createInitialStatus(inboundChannel.plugin, account, rootConfig);
  startedAccountPromise = inboundChannel.plugin.gateway!.startAccount!({
    cfg: rootConfig,
    accountId: account.accountId,
    account,
    runtime: {} as never,
    abortSignal: accountAbort.signal,
    channelRuntime: pluginRuntime.channel,
    getStatus: () => status,
    setStatus: (next) => {
      status = next;
    },
    log: NOOP_LOGGER,
  });

  await waitForCondition(() => status.running === true && status.connected === true);

  return {
    account,
    registry,
    rootConfig,
    requestCounts,
    cleanup: async () => {
      accountAbort.abort();
      await Promise.allSettled([
        startedAccountPromise ?? Promise.resolve(),
        waitForPending(),
        closeHttpServer(routeServer),
      ]);
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

test("full-host smoke registers both plugins through the public OpenClaw plugin API", async () => {
  const expectedReplyText = "Direct e2e reply from the inbound server.";
  const harness = await startFullHostHarness({
    script: async ({ params, emit }) => {
      params.replyOptions?.onAgentRunStart?.("run-full-host-smoke");
      emit({
        runId: "run-full-host-smoke",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      await params.dispatcherOptions.deliver(
        { text: expectedReplyText },
        { kind: "final" },
      );
      emit({
        runId: "run-full-host-smoke",
        stream: "lifecycle",
        data: { phase: "end" },
      });
    },
  });

  try {
    assert.deepEqual(
      harness.registry.diagnostics.filter((entry) => entry.level === "error"),
      [],
    );
    assert.equal(harness.registry.plugins.length, 2);
    assert.equal(harness.registry.channels.length, 1);
    assert.equal(harness.registry.httpRoutes.length, 2);
    assert.equal(harness.registry.tools.length, 1);

    const remoteAgentTool = resolveRegisteredTool(
      harness.registry,
      "remote_agent",
      harness.rootConfig,
    );

    const listTargetsResult = asSuccess(
      readStructuredContent(
        await executeTool(remoteAgentTool, { action: "list_targets" }),
      ),
    );
    const targets = listTargetsResult.summary.targets ?? [];

    assert.equal(listTargetsResult.action, "list_targets");
    assert.equal(targets.length, 1);
    assert.equal(targets[0]?.target_alias, TARGET_ALIAS);
    assert.equal(targets[0]?.target_name, harness.account.label);
    assert.equal(targets[0]?.description, harness.account.description);

    const sendResult = asSuccess(
      readStructuredContent(
        await executeTool(remoteAgentTool, {
          action: "send",
          target_alias: TARGET_ALIAS,
          parts: [{ kind: "text", text: "Say hello through full-host registration." }],
        }),
      ),
    );
    const rawMessage = asMessage(sendResult.raw);

    assert.equal(sendResult.action, "send");
    assert.equal(sendResult.summary.target_alias, TARGET_ALIAS);
    assert.equal(sendResult.summary.message_text, expectedReplyText);
    assert.equal(readMessageText(rawMessage), expectedReplyText);
    assert.ok(harness.requestCounts.agentCard >= 1);
    assert.ok(harness.requestCounts.jsonRpc >= 1);
  } finally {
    await harness.cleanup();
  }
});

test("full-host reproduction locks in the unsupported queued follow-up boundary", async () => {
  const expectedReplyText = "Tracked reply from the inbound server.";
  const harness = await startFullHostHarness({
    accountOverrides: {
      label: "Full Host Follow-Up Boundary Agent",
      description: "Tracked follow-up boundary reproduction through the public plugin API.",
    },
    script: async ({ params, emit }) => {
      params.replyOptions?.onAgentRunStart?.("run-full-host-followup-boundary");
      emit({
        runId: "run-full-host-followup-boundary",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      await params.dispatcherOptions.deliver(
        { text: expectedReplyText },
        { kind: "final" },
      );
      emit({
        runId: "run-full-host-followup-boundary",
        stream: "lifecycle",
        data: { phase: "end" },
      });
    },
  });

  try {
    const remoteAgentTool = resolveRegisteredTool(
      harness.registry,
      "remote_agent",
      harness.rootConfig,
    );
    const sendResult = asSuccess(
      readStructuredContent(
        await executeTool(remoteAgentTool, {
          action: "send",
          target_alias: TARGET_ALIAS,
          task_requirement: "required",
          blocking: true,
          parts: [{ kind: "text", text: "Force a tracked reply for follow-up routing." }],
        }),
      ),
    );
    const inboundChannel = harness.registry.channels.find(
      (entry) => entry.plugin.id === "a2a",
    );

    assert.ok(inboundChannel, "expected the inbound channel to be registered");
    assert.equal(sendResult.action, "send");
    assert.equal(sendResult.summary.target_alias, TARGET_ALIAS);
    assert.equal(sendResult.summary.response_kind, "task");
    assert.ok(sendResult.summary.continuation?.task, "expected task continuation");
    assert.ok(harness.requestCounts.agentCard >= 1);
    assert.ok(harness.requestCounts.jsonRpc >= 1);

    await assert.rejects(
      inboundChannel.plugin.outbound?.sendText({
        accountId: harness.account.accountId,
        to: `a2a:${harness.account.accountId}`,
        text: "Queued tracked follow-up through generic channel routing.",
      }),
      {
        message: A2A_INBOUND_UNSUPPORTED_OUTBOUND_DELIVERY_MESSAGE,
      },
    );

    let completedStatus: SuccessEnvelope<"status"> | undefined;

    await waitForCondition(async () => {
      const statusResult = asSuccess(
        readStructuredContent(
          await executeTool(remoteAgentTool, {
            action: "status",
            continuation: sendResult.summary.continuation,
            history_length: 10,
          }),
        ),
      ) as SuccessEnvelope<"status">;

      if (statusResult.summary.continuation?.task?.status !== "completed") {
        return false;
      }

      completedStatus = statusResult;
      return true;
    }, 2_000);

    assert.match(completedStatus?.summary.message_text ?? "", new RegExp(expectedReplyText));
  } finally {
    await harness.cleanup();
  }
});

test("full-host registration forwards suppressed origin-routing policy into the runtime context", async () => {
  let capturedCtx: Record<string, unknown> | undefined;
  const harness = await startFullHostHarness({
    accountOverrides: {
      originRoutingPolicy: "suppress-generic-followup",
      label: "Full Host Suppressed Origin Routing Agent",
    },
    script: async ({ params, emit }) => {
      capturedCtx = params.ctx as Record<string, unknown>;
      params.replyOptions?.onAgentRunStart?.("run-full-host-origin-routing-suppressed");
      emit({
        runId: "run-full-host-origin-routing-suppressed",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      await params.dispatcherOptions.deliver(
        { text: "Suppressed origin routing through full-host registration." },
        { kind: "final" },
      );
      emit({
        runId: "run-full-host-origin-routing-suppressed",
        stream: "lifecycle",
        data: { phase: "end" },
      });
    },
  });

  try {
    const remoteAgentTool = resolveRegisteredTool(
      harness.registry,
      "remote_agent",
      harness.rootConfig,
    );
    const sendResult = asSuccess(
      readStructuredContent(
        await executeTool(remoteAgentTool, {
          action: "send",
          target_alias: TARGET_ALIAS,
          parts: [{ kind: "text", text: "Verify suppressed origin routing through the host." }],
        }),
      ),
    );

    assert.equal(sendResult.action, "send");
    assert.equal(capturedCtx?.Provider, "a2a");
    assert.equal(capturedCtx?.Surface, "a2a");
    assert.equal("OriginatingChannel" in (capturedCtx ?? {}), false);
    assert.equal("OriginatingTo" in (capturedCtx ?? {}), false);
    assert.ok(harness.requestCounts.agentCard >= 1);
    assert.ok(harness.requestCounts.jsonRpc >= 1);
  } finally {
    await harness.cleanup();
  }
});
