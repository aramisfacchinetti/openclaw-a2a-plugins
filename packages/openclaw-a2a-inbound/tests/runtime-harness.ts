import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  DefaultExecutionEventBus,
  RequestContext,
  type AgentExecutionEvent,
} from "@a2a-js/sdk/server";
import type { Message } from "@a2a-js/sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { A2AInboundAccountConfig } from "../src/config.js";

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
  waitForAbort: () => Promise<void>;
}) => Promise<void>;

type RuntimeHarnessOptions = {
  resolveAgentRoute?: () => ResolvedAgentRoute;
  resolveStorePath?: () => string;
  recordInboundSession?: (
    params: Parameters<PluginRuntime["channel"]["session"]["recordInboundSession"]>[0],
  ) => Promise<void>;
  readSessionUpdatedAt?: (
    params: Parameters<PluginRuntime["channel"]["session"]["readSessionUpdatedAt"]>[0],
  ) => number | undefined;
};

export type TestAccountOverrides = Partial<A2AInboundAccountConfig> & {
  [key: string]: unknown;
};

export function createPluginRuntimeHarness(script: RuntimeScript): {
  pluginRuntime: PluginRuntime;
};
export function createPluginRuntimeHarness(
  script: RuntimeScript,
  options: RuntimeHarnessOptions,
): {
  pluginRuntime: PluginRuntime;
};
export function createPluginRuntimeHarness(
  script: RuntimeScript,
  options: RuntimeHarnessOptions = {},
): {
  pluginRuntime: PluginRuntime;
} {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  let seq = 0;
  let savedMediaSeq = 0;
  const defaultRoute =
    options.resolveAgentRoute?.() ?? {
      agentId: "main",
      channel: "a2a",
      accountId: "default",
      sessionKey: "session:test",
      mainSessionKey: "session:test",
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
        ) =>
          script({
            params,
            emit,
            waitForAbort: async () => {
              const signal = params.replyOptions?.abortSignal;

              if (!signal || signal.aborted) {
                return;
              }

              await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
            },
          }),
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
          path: `/tmp/${originalFilename ?? `media-${savedMediaSeq}.bin`}`,
          size: buffer.byteLength,
          contentType,
        }),
      },
      activity: {} as PluginRuntime["channel"]["activity"],
      session: {
        resolveStorePath:
          options.resolveStorePath ??
          (() => "/tmp/openclaw-a2a-inbound-sessions.json"),
        readSessionUpdatedAt: options.readSessionUpdatedAt ?? (() => undefined),
        recordSessionMetaFromInbound: async () => {},
        recordInboundSession: options.recordInboundSession ?? (async () => {}),
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
      resolveStateDir: () => "/tmp",
    },
  } as unknown as PluginRuntime;

  return { pluginRuntime };
}

export function createTestAccount(
  overrides: TestAccountOverrides = {},
): A2AInboundAccountConfig {
  const {
    auth: _auth,
    capabilities: _capabilities,
    restPath: _restPath,
  ...accountOverrides
  } = overrides as TestAccountOverrides & {
    auth?: unknown;
    capabilities?: unknown;
    restPath?: unknown;
  };

  return {
    accountId: "default",
    enabled: true,
    label: "Default",
    description: "Test account",
    publicBaseUrl: "https://agents.example.com",
    defaultAgentId: "main",
    sessionStore: undefined,
    protocolVersion: "0.3.0",
    agentCardPath: "/.well-known/agent-card.json",
    jsonRpcPath: "/a2a/jsonrpc",
    maxBodyBytes: 1024 * 1024,
    defaultInputModes: [
      "text/plain",
      "application/json",
    ],
    defaultOutputModes: [
      "text/plain",
      "application/json",
    ],
    agentStyle: "hybrid",
    taskStore: {
      kind: "memory",
    },
    skills: [
      {
        id: "chat",
        name: "Chat",
        tags: [],
        examples: [],
      },
    ],
    ...accountOverrides,
  };
}

export function createUserMessage(
  overrides: Partial<Message> = {},
): Message {
  return {
    kind: "message",
    messageId: overrides.messageId ?? randomUUID(),
    role: "user",
    parts: overrides.parts ?? [{ kind: "text", text: "Hello" }],
    contextId: overrides.contextId,
    taskId: overrides.taskId,
    referenceTaskIds: overrides.referenceTaskIds,
    metadata: overrides.metadata,
    extensions: overrides.extensions,
  };
}

export function createRequestContext(
  overrides: {
    userMessage?: Message;
    taskId?: string;
    contextId?: string;
  } = {},
): RequestContext {
  const userMessage = overrides.userMessage ?? createUserMessage();
  return new RequestContext(
    userMessage,
    overrides.taskId ?? randomUUID(),
    overrides.contextId ?? randomUUID(),
  );
}

export function createEventBusRecorder(): {
  bus: DefaultExecutionEventBus;
  events: AgentExecutionEvent[];
  finished: Promise<void>;
} {
  const bus = new DefaultExecutionEventBus();
  const events: AgentExecutionEvent[] = [];
  let resolveFinished: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  bus.on("event", (event) => {
    events.push(event);
  });
  bus.on("finished", () => {
    resolveFinished?.();
  });

  return {
    bus,
    events,
    finished,
  };
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();

  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      assert.fail("Timed out while waiting for condition.");
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
