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

type RuntimeScript = (ctx: {
  params: DispatchParams;
  emit: (event: {
    runId: string;
    stream: string;
    data: Record<string, unknown>;
  }) => void;
  waitForAbort: () => Promise<void>;
}) => Promise<void>;

export function createPluginRuntimeHarness(script: RuntimeScript): {
  pluginRuntime: PluginRuntime;
} {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  let seq = 0;

  const emit = (event: {
    runId: string;
    stream: string;
    data: Record<string, unknown>;
  }) => {
    const payload = {
      ...event,
      seq: ++seq,
      ts: Date.now(),
      sessionKey: "session:test",
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
      loadWebMedia: async () => undefined,
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
        resolveAgentRoute: () => ({
          agentId: "main",
          sessionKey: "session:test",
        }),
      },
      pairing: {} as PluginRuntime["channel"]["pairing"],
      media: {} as PluginRuntime["channel"]["media"],
      activity: {} as PluginRuntime["channel"]["activity"],
      session: {
        resolveStorePath: () => "/tmp/openclaw-a2a-inbound-sessions.json",
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
      resolveStateDir: () => "/tmp",
    },
  } as unknown as PluginRuntime;

  return { pluginRuntime };
}

export function createTestAccount(
  overrides: Partial<A2AInboundAccountConfig> = {},
): A2AInboundAccountConfig {
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
    restPath: "/a2a/rest",
    maxBodyBytes: 1024 * 1024,
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      {
        id: "chat",
        name: "Chat",
        tags: [],
        examples: [],
      },
    ],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      rest: true,
    },
    auth: {
      mode: "none",
      headerName: "authorization",
    },
    taskStore: {
      kind: "memory",
    },
    ...overrides,
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
