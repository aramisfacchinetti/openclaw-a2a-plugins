import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Message } from "@a2a-js/sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { A2AInboundAccountConfig } from "../../packages/openclaw-a2a-inbound/src/config.js";
import type { A2AInboundServer } from "../../packages/openclaw-a2a-inbound/src/a2a-server.js";
import type { A2AOutboundPluginConfig } from "../../packages/openclaw-a2a-outbound/src/config.js";
import type { A2AOutboundService } from "../../packages/openclaw-a2a-outbound/src/service.js";

type InboundServerModule = typeof import("../../packages/openclaw-a2a-inbound/src/a2a-server.js");
type OutboundServiceModule = typeof import("../../packages/openclaw-a2a-outbound/src/service.js");
type DispatchParams = Parameters<
  PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"]
>[0];
type ResolvedAgentRoute = ReturnType<
  PluginRuntime["channel"]["routing"]["resolveAgentRoute"]
>;
type RuntimeScript = (ctx: {
  params: DispatchParams;
  emit: (event: {
    runId: string;
    stream: string;
    data: Record<string, unknown>;
    sessionKey?: string;
  }) => void;
  sleep: (ms: number) => Promise<void>;
  waitForAbort: () => Promise<void>;
}) => Promise<void>;

type RuntimeHarnessOptions = {
  resolveAgentRoute?: () => ResolvedAgentRoute;
  resolveStorePath?: (
    sessionStore: string | undefined,
    route: { agentId: string },
  ) => string;
};

export type E2EScenarioRequestCounts = {
  agentCard: number;
  jsonRpc: number;
};

type StartedScenario = {
  service: A2AOutboundService;
  alias: "local";
  account: A2AInboundAccountConfig;
  baseUrl: string;
  requestCounts: E2EScenarioRequestCounts;
  cleanup: () => Promise<void>;
};

export type DirectReplyScenario = StartedScenario & {
  expectedReplyText: string;
};

export type DirectStreamingScenario = StartedScenario & {
  expectedReplyText: string;
};

export type PromotedStreamingScenario = StartedScenario & {
  expectedToolText: string;
  expectedFinalText: string;
};

export type PersistedContinuationScenario = StartedScenario & {
  expectedPausePromptText: string;
  expectedResumedFinalText: string;
  initialPromptText: string;
  resumedPromptText: string;
  createFreshService: () => Promise<A2AOutboundService>;
};

const REPO_ROOT = resolve(process.cwd());
const INBOUND_DIST_PATH = join(
  REPO_ROOT,
  "packages/openclaw-a2a-inbound/dist/a2a-server.js",
);
const OUTBOUND_DIST_PATH = join(
  REPO_ROOT,
  "packages/openclaw-a2a-outbound/dist/service.js",
);
const TARGET_ALIAS = "local" as const;

let inboundServerModulePromise: Promise<InboundServerModule> | undefined;
let outboundServiceModulePromise: Promise<OutboundServiceModule> | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }

  return `http://127.0.0.1:${address.port}`;
}

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolvePromise();
    });
  });
}

async function loadInboundServerModule(): Promise<InboundServerModule> {
  inboundServerModulePromise ??= import(
    pathToFileURL(INBOUND_DIST_PATH).href
  ) as Promise<InboundServerModule>;
  return inboundServerModulePromise;
}

async function loadOutboundServiceModule(): Promise<OutboundServiceModule> {
  outboundServiceModulePromise ??= import(
    pathToFileURL(OUTBOUND_DIST_PATH).href
  ) as Promise<OutboundServiceModule>;
  return outboundServiceModulePromise;
}

function createMinimalPluginRuntime(
  script: RuntimeScript,
  tempDir: string,
  options: RuntimeHarnessOptions = {},
): {
  pluginRuntime: PluginRuntime;
  waitForPending: () => Promise<void>;
} {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const pendingScripts = new Set<Promise<void>>();
  let seq = 0;
  let savedMediaSeq = 0;
  const defaultRoute =
    options.resolveAgentRoute?.() ?? {
      agentId: "main",
      channel: "a2a",
      accountId: "default",
      sessionKey: "session:e2e",
      mainSessionKey: "session:e2e",
      matchedBy: "default",
    };

  const emit = (event: {
    runId: string;
    stream: string;
    data: Record<string, unknown>;
    sessionKey?: string;
  }) => {
    const payload = {
      ...event,
      seq: ++seq,
      ts: Date.now(),
      sessionKey: event.sessionKey ?? defaultRoute.sessionKey,
    };

    for (const listener of listeners) {
      listener(payload);
    }
  };

  const pluginRuntime = {
    version: "test",
    config: {
      loadConfig: () => ({}),
      writeConfigFile: async () => {},
    },
    system: {
      enqueueSystemEvent: async () => {},
      requestHeartbeatNow: async () => {},
      runCommandWithTimeout: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      }),
      formatNativeDependencyHint: () => "",
    },
    media: {
      loadWebMedia: async () => {
        throw new Error("unused");
      },
      detectMime: () => undefined,
      mediaKindFromMime: () => undefined,
      isVoiceCompatibleAudio: () => false,
      getImageMetadata: async () => undefined,
      resizeToJpeg: async () => undefined,
    },
    tts: {
      textToSpeechTelephony: async () => undefined,
    },
    stt: {
      transcribeAudioFile: async () => undefined,
    },
    tools: {
      createMemoryGetTool: () => {
        throw new Error("unused");
      },
      createMemorySearchTool: () => {
        throw new Error("unused");
      },
      registerMemoryCli: () => {},
    },
    channel: {
      text: {} as PluginRuntime["channel"]["text"],
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async (
          params: DispatchParams,
        ) => {
          const promise = script({
            params,
            emit,
            sleep,
            waitForAbort: async () => {
              const signal = params.replyOptions?.abortSignal;

              if (!signal || signal.aborted) {
                return;
              }

              await new Promise<void>((resolvePromise) => {
                signal.addEventListener("abort", () => resolvePromise(), {
                  once: true,
                });
              });
            },
          });
          pendingScripts.add(promise);

          try {
            await promise;
          } finally {
            pendingScripts.delete(promise);
          }
        },
        createReplyDispatcherWithTyping: () => {
          throw new Error("unused");
        },
        resolveEffectiveMessagesConfig: () => ({}),
        resolveHumanDelayConfig: () => undefined,
        dispatchReplyFromConfig: async () => ({
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        }),
        withReplyDispatcher: async ({
          run,
        }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) =>
          run(),
        finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ctx,
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        formatInboundEnvelope: ({ body }: { body: string }) => body,
        resolveEnvelopeFormatOptions: () => ({}),
      },
      routing: {
        resolveAgentRoute: () => defaultRoute,
      },
      pairing: {} as PluginRuntime["channel"]["pairing"],
      media: {
        fetchRemoteMedia: async () => {
          throw new Error("unused");
        },
        saveMediaBuffer: async (
          buffer: Parameters<PluginRuntime["channel"]["media"]["saveMediaBuffer"]>[0],
          contentType: Parameters<PluginRuntime["channel"]["media"]["saveMediaBuffer"]>[1],
          _subdir: Parameters<PluginRuntime["channel"]["media"]["saveMediaBuffer"]>[2],
          _maxBytes: Parameters<PluginRuntime["channel"]["media"]["saveMediaBuffer"]>[3],
          originalFilename: Parameters<
            PluginRuntime["channel"]["media"]["saveMediaBuffer"]
          >[4],
        ) => ({
          id: `saved-${++savedMediaSeq}`,
          path: join(tempDir, originalFilename ?? `media-${savedMediaSeq}.bin`),
          size: buffer.byteLength,
          contentType,
        }),
      },
      activity: {} as PluginRuntime["channel"]["activity"],
      session: {
        resolveStorePath:
          options.resolveStorePath ??
          ((sessionStore, route) =>
            join(sessionStore ?? tempDir, `${route.agentId}.json`)),
        readSessionUpdatedAt: () => undefined,
        recordSessionMetaFromInbound: async () => {},
        recordInboundSession: async () => {},
        updateLastRoute: async () => {},
      },
      mentions: {} as PluginRuntime["channel"]["mentions"],
      reactions: {} as PluginRuntime["channel"]["reactions"],
      groups: {} as PluginRuntime["channel"]["groups"],
      debounce: {} as PluginRuntime["channel"]["debounce"],
      commands: {} as PluginRuntime["channel"]["commands"],
      discord: {} as PluginRuntime["channel"]["discord"],
      slack: {} as PluginRuntime["channel"]["slack"],
      telegram: {} as PluginRuntime["channel"]["telegram"],
      signal: {} as PluginRuntime["channel"]["signal"],
      imessage: {} as PluginRuntime["channel"]["imessage"],
      whatsapp: {} as PluginRuntime["channel"]["whatsapp"],
      line: {} as PluginRuntime["channel"]["line"],
    },
    events: {
      onAgentEvent: (
        listener: Parameters<PluginRuntime["events"]["onAgentEvent"]>[0],
      ) => {
        listeners.add(listener as (event: Record<string, unknown>) => void);
        return () =>
          listeners.delete(listener as (event: Record<string, unknown>) => void);
      },
      onSessionTranscriptUpdate: () => () => true,
    },
    logging: {
      shouldLogVerbose: () => false,
      getChildLogger: () => ({
        debug() {},
        info() {},
        warn() {},
        error() {},
      }),
    },
    state: {
      resolveStateDir: () => tempDir,
    },
  } as unknown as PluginRuntime;

  return {
    pluginRuntime,
    waitForPending: async () => {
      await Promise.allSettled([...pendingScripts]);
    },
  };
}

function createUserMessage(text: string): Message {
  return {
    kind: "message",
    messageId: randomUUID(),
    role: "user",
    parts: [{ kind: "text", text }],
  };
}

function createAccount(
  baseUrl: string,
  tempDir: string,
  overrides: Partial<A2AInboundAccountConfig> = {},
): A2AInboundAccountConfig {
  return {
    accountId: "default",
    enabled: true,
    label: "Local E2E Agent",
    description: "Real inbound HTTP server fixture for outbound e2e coverage.",
    publicBaseUrl: baseUrl,
    defaultAgentId: "main",
    sessionStore: join(tempDir, "sessions"),
    protocolVersion: "0.3.0",
    agentCardPath: "/.well-known/agent-card.json",
    jsonRpcPath: "/a2a/jsonrpc",
    maxBodyBytes: 1024 * 1024,
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    agentStyle: "hybrid",
    taskStore: {
      kind: "json-file",
      path: join(tempDir, "task-store"),
    },
    skills: [
      {
        id: "chat",
        name: "Chat",
        description: "Answer direct text prompts through the real inbound handler.",
        tags: ["chat", "e2e"],
        examples: ["Summarize the latest incident."],
      },
      {
        id: "workflow",
        name: "Workflow",
        description: "Produce durable tool-style progress and final answers.",
        tags: ["workflow", "durable"],
        examples: ["Continue the delegated workflow."],
      },
    ],
    ...overrides,
  };
}

function createOutboundConfig(
  account: A2AInboundAccountConfig,
  baseUrl: string,
): A2AOutboundPluginConfig {
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
        baseUrl,
        description: account.description,
        tags: ["e2e"],
        cardPath: account.agentCardPath,
        preferredTransports: ["JSONRPC", "HTTP+JSON"],
        examples: ["Use the local e2e peer."],
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

async function createOutboundService(
  config: A2AOutboundPluginConfig,
): Promise<A2AOutboundService> {
  const outboundModule = await loadOutboundServiceModule();

  return new outboundModule.A2AOutboundService({
    config,
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  });
}

async function startScenario(params: {
  accountOverrides?: Partial<A2AInboundAccountConfig>;
  script: RuntimeScript;
}): Promise<StartedScenario> {
  const tempDir = await mkdtemp(join(tmpdir(), "openclaw-a2a-e2e-"));
  const requestCounts: E2EScenarioRequestCounts = {
    agentCard: 0,
    jsonRpc: 0,
  };
  let inboundServer: A2AInboundServer | undefined;
  const routeServer = createServer((req, res) => {
    if (req.url?.startsWith("/.well-known/agent-card.json")) {
      requestCounts.agentCard += 1;
    }

    if (req.url?.startsWith("/a2a/jsonrpc")) {
      requestCounts.jsonRpc += 1;
    }

    if (!inboundServer) {
      res.statusCode = 503;
      res.end("inbound server not ready");
      return;
    }

    void inboundServer.handle(req, res).catch((error: unknown) => {
      if (res.writableEnded) {
        return;
      }

      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  const baseUrl = await listen(routeServer);
  const account = createAccount(baseUrl, tempDir, params.accountOverrides);
  const { pluginRuntime, waitForPending } = createMinimalPluginRuntime(
    params.script,
    tempDir,
  );
  const inboundModule = await loadInboundServerModule();

  inboundServer = inboundModule.createA2AInboundServer({
    accountId: account.accountId,
    account,
    cfg: {},
    channelRuntime: pluginRuntime.channel,
    pluginRuntime,
  });
  const config = createOutboundConfig(account, baseUrl);
  const service = await createOutboundService(config);

  return {
    service,
    alias: TARGET_ALIAS,
    account,
    baseUrl,
    requestCounts,
    cleanup: async () => {
      inboundServer?.close();
      await waitForPending();
      await closeHttpServer(routeServer);
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

export async function directReplyScenario(): Promise<DirectReplyScenario> {
  const expectedReplyText = "Direct e2e reply from the inbound server.";
  const scenario = await startScenario({
    accountOverrides: {
      label: "Direct Reply Agent",
      description: "Direct reply fixture backed by the real inbound HTTP server.",
    },
    script: async ({ params, emit }) => {
      params.replyOptions?.onAgentRunStart?.("run-direct-e2e");
      emit({
        runId: "run-direct-e2e",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      await params.dispatcherOptions.deliver(
        { text: expectedReplyText },
        { kind: "final" },
      );
      emit({
        runId: "run-direct-e2e",
        stream: "lifecycle",
        data: { phase: "end" },
      });
    },
  });

  return {
    ...scenario,
    expectedReplyText,
  };
}

export async function directStreamingScenario(): Promise<DirectStreamingScenario> {
  const expectedReplyText = "Direct streamed e2e reply from the inbound server.";
  const scenario = await startScenario({
    accountOverrides: {
      label: "Direct Streaming Agent",
      description:
        "Hybrid direct-stream fixture backed by the real inbound HTTP server.",
    },
    script: async ({ params, emit }) => {
      params.replyOptions?.onAgentRunStart?.("run-direct-stream-e2e");
      emit({
        runId: "run-direct-stream-e2e",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      await params.dispatcherOptions.deliver(
        { text: expectedReplyText },
        { kind: "final" },
      );
      emit({
        runId: "run-direct-stream-e2e",
        stream: "lifecycle",
        data: { phase: "end" },
      });
    },
  });

  return {
    ...scenario,
    expectedReplyText,
  };
}

export async function promotedStreamingScenario(): Promise<PromotedStreamingScenario> {
  const expectedToolText = "Local tool output";
  const expectedFinalText = "Promoted final answer from the inbound server.";
  const scenario = await startScenario({
    accountOverrides: {
      label: "Promoted Streaming Agent",
      description: "Streaming fixture that promotes a live send into a durable task.",
    },
    script: async ({ params, emit, sleep: pause }) => {
      params.replyOptions?.onAgentRunStart?.("run-promoted-stream-e2e");
      emit({
        runId: "run-promoted-stream-e2e",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      await pause(15);
      await params.dispatcherOptions.deliver(
        { text: expectedToolText },
        { kind: "tool" },
      );
      await pause(15);
      await params.dispatcherOptions.deliver(
        { text: expectedFinalText },
        { kind: "final" },
      );
      emit({
        runId: "run-promoted-stream-e2e",
        stream: "lifecycle",
        data: { phase: "end" },
      });
    },
  });

  return {
    ...scenario,
    expectedToolText,
    expectedFinalText,
  };
}

export async function persistedContinuationScenario(): Promise<PersistedContinuationScenario> {
  const expectedPausePromptText = "Approve the delegated action?";
  const expectedResumedFinalText = "Approved and completed through resumed send.";
  const initialPromptText = "Please request approval first.";
  const resumedPromptText = "Approved. Continue and finish.";
  let approvalIssued = false;

  const scenario = await startScenario({
    accountOverrides: {
      label: "Persisted Continuation Agent",
      description:
        "Approval-pause fixture that resumes the same inbound task through persisted continuation.",
    },
    script: async ({ params, emit }) => {
      const ctx = params.ctx as { BodyForAgent?: unknown };
      const bodyForAgent =
        typeof ctx.BodyForAgent === "string" ? ctx.BodyForAgent : undefined;
      const runId = `run-${approvalIssued ? "resume" : "initial"}`;

      params.replyOptions?.onAgentRunStart?.(runId);
      emit({
        runId,
        stream: "lifecycle",
        data: { phase: "start" },
      });

      if (approvalIssued && bodyForAgent === resumedPromptText) {
        await params.dispatcherOptions.deliver(
          { text: expectedResumedFinalText },
          { kind: "final" },
        );
        emit({
          runId,
          stream: "lifecycle",
          data: { phase: "end" },
        });
        return;
      }

      if (!approvalIssued && bodyForAgent === initialPromptText) {
        approvalIssued = true;
        emit({
          runId,
          stream: "tool",
          data: {
            phase: "result",
            name: "exec",
            toolCallId: "exec/1",
            isError: false,
            result: {
              status: "approval-pending",
              requiresApproval: {
                type: "approval_request",
                prompt: expectedPausePromptText,
              },
              command: "echo approved",
            },
          },
        });
        emit({
          runId,
          stream: "lifecycle",
          data: { phase: "end" },
        });
        return;
      }
      throw new Error(
        `unexpected persisted continuation scenario body: ${String(bodyForAgent)}`,
      );
    },
  });
  const scenarioConfig = createOutboundConfig(scenario.account, scenario.baseUrl);

  return {
    ...scenario,
    expectedPausePromptText,
    expectedResumedFinalText,
    initialPromptText,
    resumedPromptText,
    createFreshService: async () => createOutboundService(scenarioConfig),
  };
}

export { createUserMessage };
