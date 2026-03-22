import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  A2AOutboundService,
  type A2AOutboundServiceOptions,
} from "../dist/service.js";
import { parseA2AOutboundPluginConfig, type A2AOutboundPluginConfig } from "../dist/config.js";
import type {
  A2AToolResult,
  FailureEnvelope,
  SuccessEnvelope,
  StreamUpdateEnvelope,
  TargetListPeerCardSummary,
  TargetListSummary,
} from "../dist/result-shape.js";
import {
  createClientPool,
  type ResolvedTarget,
} from "../dist/sdk-client-pool.js";
import {
  createTargetCatalog,
  type TargetCatalogEntry,
} from "../dist/target-catalog.js";
import { createTaskHandleRegistry } from "../dist/task-handle-registry.js";

type JsonObject = Record<string, unknown>;

type RpcResponse = {
  result?: JsonObject;
  error?: JsonObject;
  delayMs?: number;
};

type StartPeerOptions = {
  cardPath?: string;
  rpcPath?: string;
  streaming?: boolean;
  card?: JsonObject;
  sendResult?: JsonObject;
  sendError?: JsonObject;
  getTaskResult?: JsonObject;
  cancelTaskResult?: JsonObject;
  streamResponses?: RpcResponse[];
  resubscribeResponses?: RpcResponse[];
};

type PeerState = {
  cardRequests: number;
  sendCalls: number;
  streamCalls: number;
  getCalls: number;
  cancelCalls: number;
  resubscribeCalls: number;
  lastSendParams?: JsonObject;
  lastGetTaskParams?: JsonObject;
  lastCancelParams?: JsonObject;
  lastResubscribeParams?: JsonObject;
};

type StartedPeer = {
  server: http.Server;
  state: PeerState;
  baseUrl: string;
  cardPath: string;
};

type ServiceConfigOverrides = Partial<
  Omit<A2AOutboundPluginConfig, "defaults" | "taskHandles" | "policy">
> & {
  defaults?: Partial<A2AOutboundPluginConfig["defaults"]>;
  taskHandles?: Partial<A2AOutboundPluginConfig["taskHandles"]>;
  policy?: Partial<A2AOutboundPluginConfig["policy"]>;
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonObject {
  if (!isRecord(value)) {
    throw new TypeError("expected object");
  }

  return value;
}

function capabilityDiagnosticsFromFailure(
  failure: FailureEnvelope,
): JsonObject {
  return asRecord(asRecord(failure.error.details).capability_diagnostics);
}

function asSuccess(result: A2AToolResult): SuccessEnvelope {
  if (result.ok !== true) {
    throw new TypeError("expected success result");
  }

  return result;
}

function asFailure(result: A2AToolResult): FailureEnvelope {
  if (result.ok !== false) {
    throw new TypeError("expected failure result");
  }

  return result;
}

function taskContinuationFromSummary(
  summary: SuccessEnvelope["summary"],
): NonNullable<NonNullable<SuccessEnvelope["summary"]["continuation"]>["task"]> {
  const task = summary.continuation?.task;

  if (!task) {
    throw new TypeError("expected task continuation");
  }

  return task;
}

function conversationContinuationFromSummary(
  summary: SuccessEnvelope["summary"],
): NonNullable<
  NonNullable<SuccessEnvelope["summary"]["continuation"]>["conversation"]
> {
  const conversation = summary.continuation?.conversation;

  if (!conversation) {
    throw new TypeError("expected conversation continuation");
  }

  return conversation;
}

function continuationFromSummary(
  summary: SuccessEnvelope["summary"],
): NonNullable<SuccessEnvelope["summary"]["continuation"]> {
  const continuation = summary.continuation;

  if (!continuation) {
    throw new TypeError("expected continuation summary");
  }

  return continuation;
}

function targetContinuationFromSummary(
  summary: SuccessEnvelope["summary"],
): NonNullable<NonNullable<SuccessEnvelope["summary"]["continuation"]>["target"]> {
  const target = summary.continuation?.target;

  if (!target) {
    throw new TypeError("expected target continuation");
  }

  return target;
}

function taskHandleFromSummary(summary: SuccessEnvelope["summary"]): string {
  const task = taskContinuationFromSummary(summary);

  if (typeof task.task_handle !== "string") {
    throw new TypeError("expected task_handle summary field");
  }

  return task.task_handle;
}

function targetsFromSummary(summary: SuccessEnvelope["summary"]): TargetListSummary[] {
  if (!Array.isArray(summary.targets)) {
    throw new TypeError("expected summary.targets");
  }

  return summary.targets;
}

function peerCardSummaryFromRaw(
  entry: TargetCatalogEntry,
): TargetListPeerCardSummary {
  return {
    ...(entry.card.preferredTransport !== undefined
      ? { preferred_transport: entry.card.preferredTransport }
      : {}),
    additional_interfaces: entry.card.additionalInterfaces.map((cardInterface) => ({
      transport: cardInterface.transport,
      url: cardInterface.url,
    })),
    capabilities: {
      ...(typeof entry.card.capabilities.streaming === "boolean"
        ? { streaming: entry.card.capabilities.streaming }
        : {}),
      ...(typeof entry.card.capabilities.pushNotifications === "boolean"
        ? { push_notifications: entry.card.capabilities.pushNotifications }
        : {}),
      ...(typeof entry.card.capabilities.stateTransitionHistory === "boolean"
        ? {
            state_transition_history:
              entry.card.capabilities.stateTransitionHistory,
          }
        : {}),
      ...(entry.card.capabilities.extensions !== undefined
        ? {
            extensions: entry.card.capabilities.extensions.map((extension) =>
              structuredClone(extension),
            ),
          }
        : {}),
    },
    default_input_modes: [...entry.card.defaultInputModes],
    default_output_modes: [...entry.card.defaultOutputModes],
    skills: entry.card.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: [...skill.tags],
      examples: [...skill.examples],
      ...(skill.inputModes !== undefined
        ? { input_modes: [...skill.inputModes] }
        : {}),
      ...(skill.outputModes !== undefined
        ? { output_modes: [...skill.outputModes] }
        : {}),
    })),
  };
}

function json(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function writeSse(res: ServerResponse, body: unknown): void {
  res.write(`data: ${JSON.stringify(body)}\n\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(req: IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(asRecord(parsed));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sequenceValue<T>(values: T[] | undefined, index: number): T | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }

  return values[Math.min(index, values.length - 1)];
}

async function sendRpcResponse(
  res: ServerResponse,
  id: unknown,
  response: RpcResponse | undefined,
  fallbackResult: JsonObject,
): Promise<void> {
  if (response?.delayMs) {
    await sleep(response.delayMs);
  }

  json(res, 200, {
    jsonrpc: "2.0",
    id,
    ...(response?.result !== undefined
      ? { result: response.result }
      : response?.error !== undefined
        ? { error: response.error }
        : { result: fallbackResult }),
  });
}

async function sendSseResponses(
  res: ServerResponse,
  id: unknown,
  responses: RpcResponse[],
): Promise<void> {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");

  for (const response of responses) {
    if (response.delayMs) {
      await sleep(response.delayMs);
    }

    writeSse(res, {
      jsonrpc: "2.0",
      id,
      ...(response.result !== undefined
        ? { result: response.result }
        : { error: response.error ?? { code: -32004, message: "stream failure" } }),
    });
  }

  res.end();
}

function startPeer(options: StartPeerOptions = {}): Promise<StartedPeer> {
  const cardPath = options.cardPath ?? "/.well-known/agent-card.json";
  const rpcPath = options.rpcPath ?? "/a2a/jsonrpc";

  const state: PeerState = {
    cardRequests: 0,
    sendCalls: 0,
    streamCalls: 0,
    getCalls: 0,
    cancelCalls: 0,
    resubscribeCalls: 0,
  };

  const server = http.createServer(async (req, res) => {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new TypeError("expected bound server address");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;

    if (req.method === "GET" && req.url === cardPath) {
      state.cardRequests += 1;
      const defaultCard = {
        name: "Mock Peer",
        description: "Mock A2A peer for tests",
        protocolVersion: "0.3.0",
        version: "0.1.0",
        url: `${baseUrl}${rpcPath}`,
        preferredTransport: "JSONRPC",
        additionalInterfaces: [
          {
            transport: "JSONRPC",
            url: `${baseUrl}${rpcPath}`,
          },
          {
            transport: "HTTP+JSON",
            url: `${baseUrl}/a2a/rest`,
          },
        ],
        capabilities: {
          streaming: options.streaming ?? false,
          pushNotifications: true,
          stateTransitionHistory: true,
          extensions: [
            {
              uri: "https://example.com/extensions/audit",
            },
          ],
        },
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
        skills: [
          {
            id: "mock",
            name: "Mock Skill",
            description: "mock skill",
            tags: ["test"],
            examples: ["Do the mock thing"],
            inputModes: ["application/json"],
            outputModes: ["application/pdf"],
          },
        ],
      };

      return json(
        res,
        200,
        options.card ? { ...defaultCard, ...options.card } : defaultCard,
      );
    }

    if (req.method === "POST" && req.url === rpcPath) {
      const payload = await readJson(req);
      const payloadParams = isRecord(payload.params) ? payload.params : {};

      if (payload.method === "message/send") {
        state.sendCalls += 1;
        state.lastSendParams = payloadParams;

        if (options.sendError) {
          return json(res, 200, {
            jsonrpc: "2.0",
            id: payload.id,
            error: options.sendError,
          });
        }

        return json(res, 200, {
          jsonrpc: "2.0",
          id: payload.id,
          result:
            options.sendResult ?? {
              kind: "message",
              messageId: "message-1",
              role: "agent",
              parts: [{ kind: "text", text: "ack" }],
            },
        });
      }

      if (payload.method === "message/stream") {
        state.streamCalls += 1;
        state.lastSendParams = payloadParams;

        return sendSseResponses(res, payload.id, options.streamResponses ?? []);
      }

      if (payload.method === "tasks/get") {
        state.getCalls += 1;
        state.lastGetTaskParams = payloadParams;

        return sendRpcResponse(
          res,
          payload.id,
          undefined,
          options.getTaskResult ?? {
            kind: "task",
            id: payloadParams.id,
            contextId: "ctx-1",
            status: {
              state: "completed",
            },
          },
        );
      }

      if (payload.method === "tasks/cancel") {
        state.cancelCalls += 1;
        state.lastCancelParams = payloadParams;

        return json(res, 200, {
          jsonrpc: "2.0",
          id: payload.id,
          result:
            options.cancelTaskResult ?? {
              kind: "task",
              id: payloadParams.id,
              contextId: "ctx-1",
              status: {
                state: "canceled",
              },
            },
        });
      }

      if (payload.method === "tasks/resubscribe") {
        state.resubscribeCalls += 1;
        state.lastResubscribeParams = payloadParams;

        return sendSseResponses(
          res,
          payload.id,
          options.resubscribeResponses ?? [],
        );
      }

      return json(res, 200, {
        jsonrpc: "2.0",
        id: payload.id,
        error: {
          code: -32601,
          message: "method not found",
        },
      });
    }

    json(res, 404, { error: "not found" });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new TypeError("expected bound server address");
      }

      resolve({
        server,
        state,
        baseUrl: `http://127.0.0.1:${address.port}`,
        cardPath,
      });
    });
  });
}

function buildParsedConfig(
  overrides: ServiceConfigOverrides = {},
): A2AOutboundPluginConfig {
  return parseA2AOutboundPluginConfig({
    enabled: true,
    defaults: {
      timeoutMs: 250,
      cardPath: "/.well-known/agent-card.json",
      preferredTransports: ["JSONRPC", "HTTP+JSON"],
      serviceParameters: {},
      ...overrides.defaults,
    },
    targets: overrides.targets,
    taskHandles: {
      ttlMs: 60_000,
      maxEntries: 100,
      ...overrides.taskHandles,
    },
    policy: {
      acceptedOutputModes: [],
      normalizeBaseUrl: true,
      enforceSupportedTransports: true,
      allowTargetUrlOverride: false,
      ...overrides.policy,
    },
  });
}

function buildService(
  configOverrides: ServiceConfigOverrides = {},
  extraOptions: Partial<A2AOutboundServiceOptions> = {},
): { parsedConfig: A2AOutboundPluginConfig; service: A2AOutboundService } {
  const parsedConfig = buildParsedConfig(configOverrides);
  const service = new A2AOutboundService({
    parsedConfig,
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    ...extraOptions,
  });

  return {
    parsedConfig,
    service,
  };
}

function configuredTarget(
  peer: StartedPeer,
  overrides: Partial<A2AOutboundPluginConfig["targets"][number]> = {},
): A2AOutboundPluginConfig["targets"][number] {
  return {
    alias: "support",
    baseUrl: peer.baseUrl,
    tags: ["test"],
    cardPath: peer.cardPath,
    preferredTransports: ["JSONRPC", "HTTP+JSON"],
    examples: [],
    default: false,
    ...overrides,
  };
}

function resolvedTarget(
  peer: StartedPeer,
  overrides: Partial<ResolvedTarget> = {},
): ResolvedTarget {
  return {
    baseUrl: `${peer.baseUrl}/`,
    cardPath: peer.cardPath,
    preferredTransports: ["JSONRPC", "HTTP+JSON"],
    ...overrides,
  };
}

function continuationFromTarget(
  target: ResolvedTarget,
  overrides: {
    task?: { task_handle?: string; task_id: string };
    conversation?: { context_id: string; can_send?: true };
  } = {},
) {
  return {
    target: {
      target_url: target.baseUrl,
      card_path: target.cardPath,
      preferred_transports: [...target.preferredTransports],
      ...(target.alias !== undefined ? { target_alias: target.alias } : {}),
    },
    ...(overrides.task !== undefined ? { task: overrides.task } : {}),
    ...(overrides.conversation !== undefined
      ? {
          conversation: {
            can_send: true,
            ...overrides.conversation,
          },
        }
      : {}),
  };
}

test("send routes through an explicit target_alias", async (t) => {
  const peer = await startPeer();
  t.after(() => peer.server.close());

  const { service } = buildService({
    targets: [
      configuredTarget(peer, {
        alias: "support",
        default: true,
        description: "Primary support lane",
      }),
    ],
  });

  const result = await service.execute({
    action: "send",
    target_alias: "support",
    parts: [
      {
        kind: "text",
        text: "hello",
      },
    ],
  });

  const success = asSuccess(result);
  const raw = asRecord(success.raw);
  const message = asRecord(asRecord(peer.state.lastSendParams ?? {}).message);
  const parts = message.parts as Array<Record<string, unknown>>;

  assert.equal(success.operation, "remote_agent");
  assert.equal(success.action, "send");
  assert.equal(success.summary.target_alias, "support");
  assert.equal(success.summary.target_url, `${peer.baseUrl}/`);
  assert.equal(success.summary.message_text, "ack");
  assert.equal(raw.kind, "message");
  assert.equal(peer.state.sendCalls, 1);
  assert.equal(message.role, "user");
  assert.equal(parts[0]?.kind, "text");
  assert.equal(parts[0]?.text, "hello");
  assert.deepEqual(
    asRecord(asRecord(peer.state.lastSendParams ?? {}).configuration)
      .acceptedOutputModes,
    [],
  );
});

test("send falls back to the configured default target", async (t) => {
  const peer = await startPeer();
  t.after(() => peer.server.close());

  const { service } = buildService({
    targets: [
      configuredTarget(peer, {
        alias: "support",
        default: true,
      }),
    ],
  });

  const result = await service.execute({
    action: "send",
    parts: [
      {
        kind: "text",
        text: "hello default",
      },
    ],
  });

  const success = asSuccess(result);

  assert.equal(success.action, "send");
  assert.equal(success.summary.target_alias, "support");
  assert.equal(success.summary.target_url, `${peer.baseUrl}/`);
  assert.equal(peer.state.sendCalls, 1);
});

test("lifecycle actions reject conversation-only continuation during normal validation", async (t) => {
  const peer = await startPeer();
  t.after(() => peer.server.close());

  const { service } = buildService();
  const continuation = continuationFromTarget(resolvedTarget(peer, { alias: "support" }), {
    conversation: {
      context_id: "ctx-conversation-only-1",
    },
  });

  for (const action of ["status", "watch", "cancel"] as const) {
    const result = await service.execute({
      action,
      continuation,
    });

    const failure = asFailure(result);
    assert.equal(failure.action, action);
    assert.equal(failure.error.code, "VALIDATION_ERROR");
  }

  assert.equal(peer.state.cardRequests, 0);
  assert.equal(peer.state.getCalls, 0);
  assert.equal(peer.state.resubscribeCalls, 0);
  assert.equal(peer.state.cancelCalls, 0);
});

test("lifecycle actions reject conversation-only continuation before target resolution when validation is bypassed", async (t) => {
  const peer = await startPeer();
  t.after(() => peer.server.close());

  const { service } = buildService();
  const continuation = continuationFromTarget(resolvedTarget(peer, { alias: "support" }), {
    conversation: {
      context_id: "ctx-conversation-only-2",
    },
  });
  const serviceInternals = service as unknown as {
    validateInput: (input: unknown) => unknown;
  };
  const originalValidateInput = serviceInternals.validateInput;
  serviceInternals.validateInput = (input) => input;
  t.after(() => {
    serviceInternals.validateInput = originalValidateInput;
  });

  for (const action of ["status", "watch", "cancel"] as const) {
    const result = await service.execute({
      action,
      continuation,
    });

    const failure = asFailure(result);
    assert.equal(failure.action, action);
    assert.equal(failure.error.code, "VALIDATION_ERROR");
    assert.match(
      failure.error.message,
      /requires task continuity; summary\.continuation\.conversation\.context_id is send-only/,
    );
  }

  assert.equal(peer.state.cardRequests, 0);
  assert.equal(peer.state.getCalls, 0);
  assert.equal(peer.state.resubscribeCalls, 0);
  assert.equal(peer.state.cancelCalls, 0);
});

test("send forwards blocking, accepted output modes, and preserves explicit continuation ids on message/send", async (t) => {
  const peer = await startPeer();
  t.after(() => peer.server.close());

  const { service } = buildService({
    targets: [configuredTarget(peer, { alias: "support", default: true })],
    policy: {
      acceptedOutputModes: ["text/plain"],
    },
  });

  const result = await service.execute({
    action: "send",
    target_alias: "support",
    message_id: "message-1",
    task_id: "task-continue-1",
    context_id: "context-continue-1",
    reference_task_ids: ["task-ref-1", "task-ref-2"],
    parts: [
      {
        kind: "data",
        data: {
          ticket: "123",
        },
      },
    ],
    accepted_output_modes: ["application/json"],
    blocking: false,
  });

  const success = asSuccess(result);
  const params = asRecord(peer.state.lastSendParams ?? {});
  const message = asRecord(params.message);
  const task = taskContinuationFromSummary(success.summary);
  const configuration = asRecord(params.configuration);
  const conversation = conversationContinuationFromSummary(success.summary);

  assert.equal(success.action, "send");
  assert.equal(success.summary.response_kind, "message");
  assert.equal(task.task_id, "task-continue-1");
  assert.match(String(task.task_handle), /^rah_/);
  assert.equal(conversation.context_id, "context-continue-1");
  assert.equal(peer.state.sendCalls, 1);
  assert.equal(peer.state.streamCalls, 0);
  assert.equal(message.messageId, "message-1");
  assert.equal(message.taskId, "task-continue-1");
  assert.equal(message.contextId, "context-continue-1");
  assert.deepEqual(message.referenceTaskIds, ["task-ref-1", "task-ref-2"]);
  assert.deepEqual(message.parts, [
    {
      kind: "data",
      data: {
        ticket: "123",
      },
    },
  ]);
  assert.deepEqual(configuration.acceptedOutputModes, ["application/json"]);
  assert.equal(configuration.blocking, false);
});

test("send preserves task continuation when message/send returns a message with taskId", async (t) => {
  const peer = await startPeer({
    sendResult: {
      kind: "message",
      messageId: "agent-message-1",
      role: "agent",
      taskId: "task-continue-1",
      contextId: "context-continue-1",
      parts: [{ kind: "text", text: "continued" }],
    },
  });
  t.after(() => peer.server.close());

  const { service } = buildService({
    targets: [configuredTarget(peer, { alias: "support", default: true })],
  });

  const result = await service.execute({
    action: "send",
    target_alias: "support",
    task_id: "task-continue-1",
    context_id: "context-continue-1",
    parts: [{ kind: "text", text: "continue" }],
  });

  const success = asSuccess(result);
  const task = taskContinuationFromSummary(success.summary);
  const conversation = conversationContinuationFromSummary(success.summary);

  assert.equal(success.action, "send");
  assert.equal(success.summary.response_kind, "message");
  assert.equal(task.task_id, "task-continue-1");
  assert.match(String(task.task_handle), /^rah_/);
  assert.equal(task.can_watch, false);
  assert.equal(conversation.context_id, "context-continue-1");
});

test("task_requirement=required returns a task and handle from explicit non-blocking creation", async (t) => {
  const peer = await startPeer({
    sendResult: {
      kind: "task",
      id: "task-required-1",
      contextId: "ctx-required-1",
      status: {
        state: "working",
      },
    },
  });
  t.after(() => peer.server.close());

  const { service } = buildService({
    targets: [configuredTarget(peer, { alias: "support", default: true })],
  });

  const result = await service.execute({
    action: "send",
    target_alias: "support",
    task_requirement: "required",
    blocking: true,
    parts: [{ kind: "text", text: "require a durable task" }],
  });

  const success = asSuccess(result);
  const params = asRecord(peer.state.lastSendParams ?? {});
  const configuration = asRecord(params.configuration);
  const task = taskContinuationFromSummary(success.summary);
  const conversation = conversationContinuationFromSummary(success.summary);

  assert.equal(success.action, "send");
  assert.equal(success.summary.response_kind, "task");
  assert.equal(task.task_id, "task-required-1");
  assert.equal(task.status, "working");
  assert.equal(task.can_resume_send, true);
  assert.match(String(task.task_handle), /^rah_/);
  assert.equal(conversation.context_id, "ctx-required-1");
  assert.equal(configuration.blocking, false);
  assert.equal(peer.state.sendCalls, 1);
  assert.equal(peer.state.streamCalls, 0);
});

test("task_requirement=required fails when the peer returns only a Message", async (t) => {
  const peer = await startPeer({
    sendResult: {
      kind: "message",
      messageId: "message-required-1",
      role: "agent",
      contextId: "ctx-required-1",
      parts: [{ kind: "text", text: "not durable" }],
    },
  });
  t.after(() => peer.server.close());

  const { service } = buildService({
    targets: [configuredTarget(peer, { alias: "support", default: true })],
  });

  const result = await service.execute({
    action: "send",
    target_alias: "support",
    task_requirement: "required",
    parts: [{ kind: "text", text: "require a durable task" }],
  });

  const failure = asFailure(result);

  assert.equal(failure.action, "send");
  assert.equal(failure.error.code, "TASK_REQUIRED_BUT_MESSAGE_RETURNED");
  assert.equal(peer.state.sendCalls, 1);
  assert.equal(peer.state.streamCalls, 0);
});

test("send remains permissive when file and data parts exceed advertised peer-card modes", async (t) => {
  const peer = await startPeer({
    streaming: true,
    card: {
      name: "Strict Peer",
      description: "Advertises text-only defaults",
      capabilities: {
        streaming: true,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
    },
  });
  t.after(() => peer.server.close());

  const { service } = buildService({
    targets: [configuredTarget(peer, { alias: "support", default: true })],
  });

  const result = await service.execute({
    action: "send",
    parts: [
      {
        kind: "data",
        data: {
          ticket: "123",
        },
      },
      {
        kind: "file",
        name: "report.pdf",
        uri: "https://files.example.com/report.pdf",
      },
    ],
    accepted_output_modes: ["application/json"],
  });

  const success = asSuccess(result);
  const params = asRecord(peer.state.lastSendParams ?? {});
  const message = asRecord(params.message);
  const configuration = asRecord(params.configuration);

  assert.equal(success.action, "send");
  assert.equal(peer.state.sendCalls, 1);
  assert.deepEqual(message.parts, [
    {
      kind: "data",
      data: {
        ticket: "123",
      },
    },
    {
      kind: "file",
      file: {
        uri: "https://files.example.com/report.pdf",
        name: "report.pdf",
      },
    },
  ]);
  assert.deepEqual(configuration.acceptedOutputModes, ["application/json"]);
});

test("failed send errors include capability_diagnostics", async (t) => {
  const peer = await startPeer({
    streaming: true,
    sendError: {
      code: -32001,
      message: "remote validation failed",
      data: {
        field: "parts[0]",
      },
    },
    card: {
      capabilities: {
        streaming: true,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
    },
  });
  t.after(() => peer.server.close());

  const { service } = buildService({
    targets: [configuredTarget(peer, { alias: "support", default: true })],
  });

  const result = await service.execute({
    action: "send",
    parts: [
      {
        kind: "data",
        data: {
          ticket: "123",
        },
      },
    ],
    accepted_output_modes: ["application/json"],
  });

  const failure = asFailure(result);
  const diagnostics = capabilityDiagnosticsFromFailure(failure);

  assert.equal(failure.action, "send");
  assert.equal(failure.error.code, "A2A_SDK_ERROR");
  assert.equal(peer.state.sendCalls, 1);
  assert.deepEqual(diagnostics, {
    requested_input_modes: ["application/json"],
    advertised_input_modes: ["text/plain"],
    unsupported_input_modes: ["application/json"],
    requested_output_modes: ["application/json"],
    advertised_output_modes: ["text/plain"],
    unsupported_output_modes: ["application/json"],
    unknown_file_attachments: [],
  });
});

test("failed send diagnostics mark unknown file MIME separately from unsupported modes", async (t) => {
  const peer = await startPeer({
    streaming: true,
    sendError: {
      code: -32001,
      message: "unsupported attachment",
    },
    card: {
      capabilities: {
        streaming: true,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
    },
  });
  t.after(() => peer.server.close());

  const { service } = buildService({
    targets: [configuredTarget(peer, { alias: "support", default: true })],
  });

  const result = await service.execute({
    action: "send",
    parts: [
      {
        kind: "file",
        name: "mystery",
        uri: "https://files.example.com/download",
      },
    ],
    accepted_output_modes: ["text/plain"],
  });

  const diagnostics = capabilityDiagnosticsFromFailure(asFailure(result));

  assert.deepEqual(diagnostics, {
    requested_input_modes: ["unknown"],
    advertised_input_modes: ["text/plain"],
    unsupported_input_modes: [],
    requested_output_modes: ["text/plain"],
    advertised_output_modes: ["text/plain"],
    unsupported_output_modes: [],
    unknown_file_attachments: [0],
  });
});

test("send with task_handle resolves target, task, and context from the handle", async (t) => {
  const peer = await startPeer({
    sendResult: {
      kind: "message",
      messageId: "agent-message-1",
      role: "agent",
      contextId: "ctx-handle-1",
      parts: [{ kind: "text", text: "continued" }],
    },
  });
  t.after(() => peer.server.close());

  const taskHandleRegistry = createTaskHandleRegistry({
    ttlMs: 60_000,
    maxEntries: 100,
  });
  const handle = taskHandleRegistry.create({
    target: resolvedTarget(peer, { alias: "support" }),
    taskId: "task-handle-1",
    contextId: "ctx-handle-1",
  }).taskHandle;

  const { service } = buildService(
    {},
    {
      taskHandleRegistry,
    },
  );

  const result = await service.execute({
    action: "send",
    task_handle: handle,
    parts: [{ kind: "text", text: "continue" }],
  });

  const success = asSuccess(result);
  const params = asRecord(peer.state.lastSendParams ?? {});
  const message = asRecord(params.message);
  const task = taskContinuationFromSummary(success.summary);
  const conversation = conversationContinuationFromSummary(success.summary);

  assert.equal(success.action, "send");
  assert.equal(success.summary.response_kind, "message");
  assert.equal(task.task_id, "task-handle-1");
  assert.equal(task.task_handle, handle);
  assert.equal(conversation.context_id, "ctx-handle-1");
  assert.equal(message.taskId, "task-handle-1");
  assert.equal(message.contextId, "ctx-handle-1");
  assert.equal(peer.state.sendCalls, 1);
});

test("send with follow_updates=true emits send updates and returns a task_handle", async (t) => {
  const peer = await startPeer({
    streaming: true,
    streamResponses: [
      {
        result: {
          kind: "task",
          id: "task-stream-1",
          contextId: "ctx-stream-1",
          status: {
            state: "submitted",
          },
        },
      },
      {
        result: {
          kind: "status-update",
          taskId: "task-stream-1",
          contextId: "ctx-stream-1",
          status: {
            state: "completed",
          },
          final: true,
        },
      },
    ],
  });
  t.after(() => peer.server.close());

  const { service } = buildService({
    targets: [configuredTarget(peer, { alias: "support", default: true })],
  });
  const updates: StreamUpdateEnvelope<"send">[] = [];

  const result = await service.execute(
    {
      action: "send",
      target_alias: "support",
      parts: [
        {
          kind: "text",
          text: "stream hello",
        },
      ],
      follow_updates: true,
    },
    {
      onUpdate(update) {
        updates.push(update as StreamUpdateEnvelope<"send">);
      },
    },
  );

  const success = asSuccess(result);
  const raw = asRecord(success.raw);
  const task = taskContinuationFromSummary(success.summary);
  const conversation = conversationContinuationFromSummary(success.summary);
  const firstUpdateTask = updates[0]?.summary.continuation?.task;
  const secondUpdateTask = updates[1]?.summary.continuation?.task;

  assert.equal(success.action, "send");
  assert.equal(success.summary.response_kind, "task");
  assert.equal(task.task_id, "task-stream-1");
  assert.equal(task.status, "completed");
  assert.equal(task.can_resume_send, false);
  assert.equal(task.can_watch, true);
  assert.match(String(task.task_handle), /^rah_/);
  assert.equal(conversation.context_id, "ctx-stream-1");
  assert.equal(peer.state.streamCalls, 1);
  assert.equal(peer.state.sendCalls, 0);
  assert.ok(Array.isArray(raw.events));
  assert.equal((raw.events as unknown[]).length, 2);
  assert.equal(updates.length, 2);
  assert.equal(updates[0]?.action, "send");
  assert.equal(updates[0]?.phase, "update");
  assert.equal(firstUpdateTask?.task_id, "task-stream-1");
  assert.equal(firstUpdateTask?.status, "submitted");
  assert.match(String(firstUpdateTask?.task_handle), /^rah_/);
  assert.equal(updates[0]?.summary.continuation?.conversation?.context_id, "ctx-stream-1");
  assert.equal(secondUpdateTask?.task_id, "task-stream-1");
  assert.equal(secondUpdateTask?.status, "completed");
  assert.equal(secondUpdateTask?.task_handle, task.task_handle);
  assert.equal(updates[1]?.summary.continuation?.conversation?.context_id, "ctx-stream-1");
});

test("non-strict follow_updates accepts a message-only stream summary", async (t) => {
  const peer = await startPeer({
    streaming: true,
    streamResponses: [
      {
        result: {
          kind: "message",
          messageId: "message-stream-1",
          role: "agent",
          contextId: "ctx-message-stream-1",
          parts: [{ kind: "text", text: "message-only stream" }],
        },
      },
    ],
  });
  t.after(() => peer.server.close());

  const { service } = buildService({
    targets: [configuredTarget(peer, { alias: "support", default: true })],
  });

  const result = await service.execute({
    action: "send",
    target_alias: "support",
    follow_updates: true,
    parts: [{ kind: "text", text: "stream me a message" }],
  });

  const success = asSuccess(result);
  const conversation = conversationContinuationFromSummary(success.summary);

  assert.equal(success.action, "send");
  assert.equal(success.summary.response_kind, "message");
  assert.equal(success.summary.continuation?.task, undefined);
  assert.equal(conversation.context_id, "ctx-message-stream-1");
  assert.equal(peer.state.streamCalls, 1);
  assert.equal(peer.state.sendCalls, 0);
});

test("task_requirement=required with follow_updates merges send and watch without duplicating the initial snapshot", async (t) => {
  const peer = await startPeer({
    streaming: true,
    sendResult: {
      kind: "task",
      id: "task-required-stream-1",
      contextId: "ctx-required-stream-1",
      status: {
        state: "submitted",
      },
    },
    resubscribeResponses: [
      {
        result: {
          kind: "task",
          id: "task-required-stream-1",
          contextId: "ctx-required-stream-1",
          status: {
            state: "submitted",
          },
        },
      },
      {
        result: {
          kind: "status-update",
          taskId: "task-required-stream-1",
          contextId: "ctx-required-stream-1",
          status: {
            state: "completed",
          },
          final: true,
        },
      },
    ],
  });
  t.after(() => peer.server.close());

  const { service } = buildService({
    targets: [configuredTarget(peer, { alias: "support", default: true })],
  });
  const updates: StreamUpdateEnvelope<"send">[] = [];

  const result = await service.execute(
    {
      action: "send",
      target_alias: "support",
      task_requirement: "required",
      follow_updates: true,
      parts: [{ kind: "text", text: "create and watch a durable task" }],
    },
    {
      onUpdate(update) {
        updates.push(update as StreamUpdateEnvelope<"send">);
      },
    },
  );

  const success = asSuccess(result);
  const raw = asRecord(success.raw);
  const task = taskContinuationFromSummary(success.summary);

  assert.equal(success.action, "send");
  assert.equal(success.summary.response_kind, "task");
  assert.equal(peer.state.sendCalls, 1);
  assert.equal(peer.state.streamCalls, 0);
  assert.equal(peer.state.resubscribeCalls, 1);
  assert.equal((raw.events as unknown[]).length, 2);
  assert.equal(updates.length, 2);
  assert.equal(task.task_id, "task-required-stream-1");
  assert.equal(task.status, "completed");
  assert.equal(task.can_resume_send, false);
  assert.equal(updates[0]?.summary.continuation?.task?.status, "submitted");
  assert.equal(updates[1]?.summary.continuation?.task?.status, "completed");
});

test("task_requirement=required with follow_updates returns a single initial snapshot when the created task is already terminal", async (t) => {
  const peer = await startPeer({
    streaming: true,
    sendResult: {
      kind: "task",
      id: "task-required-terminal-1",
      contextId: "ctx-required-terminal-1",
      status: {
        state: "completed",
      },
    },
  });
  t.after(() => peer.server.close());

  const { service } = buildService({
    targets: [configuredTarget(peer, { alias: "support", default: true })],
  });
  const updates: StreamUpdateEnvelope<"send">[] = [];

  const result = await service.execute(
    {
      action: "send",
      target_alias: "support",
      task_requirement: "required",
      follow_updates: true,
      parts: [{ kind: "text", text: "create and finish immediately" }],
    },
    {
      onUpdate(update) {
        updates.push(update as StreamUpdateEnvelope<"send">);
      },
    },
  );

  const success = asSuccess(result);
  const raw = asRecord(success.raw);
  const task = taskContinuationFromSummary(success.summary);

  assert.equal(success.action, "send");
  assert.equal(success.summary.response_kind, "task");
  assert.equal((raw.events as unknown[]).length, 1);
  assert.equal(updates.length, 1);
  assert.equal(task.task_id, "task-required-terminal-1");
  assert.equal(task.status, "completed");
  assert.equal(task.can_resume_send, false);
  assert.equal(peer.state.sendCalls, 1);
  assert.equal(peer.state.resubscribeCalls, 0);
});

test("task_requirement=required with follow_updates returns a recoverable failure when watch cannot be established", async (t) => {
  const peer = await startPeer({
    streaming: false,
    sendResult: {
      kind: "task",
      id: "task-required-failed-watch-1",
      contextId: "ctx-required-failed-watch-1",
      status: {
        state: "working",
      },
    },
  });
  t.after(() => peer.server.close());

  const { service } = buildService({
    targets: [configuredTarget(peer, { alias: "support", default: true })],
  });
  const updates: StreamUpdateEnvelope<"send">[] = [];

  const result = await service.execute(
    {
      action: "send",
      target_alias: "support",
      task_requirement: "required",
      follow_updates: true,
      parts: [{ kind: "text", text: "create and watch a durable task" }],
    },
    {
      onUpdate(update) {
        updates.push(update as StreamUpdateEnvelope<"send">);
      },
    },
  );

  const failure = asFailure(result);
  const details = asRecord(failure.error.details);

  assert.equal(failure.action, "send");
  assert.equal(failure.error.code, "A2A_SDK_ERROR");
  assert.equal(details.task_id, "task-required-failed-watch-1");
  assert.equal(details.context_id, "ctx-required-failed-watch-1");
  assert.equal(details.suggested_action, "status");
  assert.equal(peer.state.sendCalls, 1);
  assert.equal(peer.state.resubscribeCalls, 0);
  assert.equal(updates.length, 1);
});

test("sendStream failures also include capability_diagnostics", async (t) => {
  const peer = await startPeer({
    streaming: true,
    streamResponses: [
      {
        error: {
          code: -32001,
          message: "remote stream validation failed",
        },
      },
    ],
    card: {
      capabilities: {
        streaming: true,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
    },
  });
  t.after(() => peer.server.close());

  const { service } = buildService({
    targets: [configuredTarget(peer, { alias: "support", default: true })],
  });

  const result = await service.execute({
    action: "send",
    follow_updates: true,
    parts: [
      {
        kind: "data",
        data: {
          ticket: "123",
        },
      },
    ],
    accepted_output_modes: ["application/json"],
  });

  const diagnostics = capabilityDiagnosticsFromFailure(asFailure(result));

  assert.deepEqual(diagnostics, {
    requested_input_modes: ["application/json"],
    advertised_input_modes: ["text/plain"],
    unsupported_input_modes: ["application/json"],
    requested_output_modes: ["application/json"],
    advertised_output_modes: ["text/plain"],
    unsupported_output_modes: ["application/json"],
    unknown_file_attachments: [],
  });
});

test("watch with a valid task_handle emits watch updates", async (t) => {
  const peer = await startPeer({
    streaming: true,
    resubscribeResponses: [
      {
        result: {
          kind: "task",
          id: "task-watch-1",
          contextId: "ctx-watch-1",
          status: {
            state: "working",
          },
        },
      },
      {
        result: {
          kind: "status-update",
          taskId: "task-watch-1",
          contextId: "ctx-watch-1",
          status: {
            state: "completed",
          },
          final: true,
        },
      },
    ],
  });
  t.after(() => peer.server.close());

  const taskHandleRegistry = createTaskHandleRegistry({
    ttlMs: 60_000,
    maxEntries: 100,
  });
  const handle = taskHandleRegistry.create({
    target: resolvedTarget(peer, { alias: "support" }),
    taskId: "task-watch-1",
    contextId: "ctx-watch-1",
  }).taskHandle;

  const { service } = buildService(
    {},
    {
      taskHandleRegistry,
    },
  );
  const updates: StreamUpdateEnvelope<"watch">[] = [];

  const result = await service.execute(
    {
      action: "watch",
      task_handle: handle,
    },
    {
      onUpdate(update) {
        updates.push(update as StreamUpdateEnvelope<"watch">);
      },
    },
  );

  const success = asSuccess(result);
  const raw = asRecord(success.raw);
  const task = taskContinuationFromSummary(success.summary);
  const conversation = conversationContinuationFromSummary(success.summary);
  const firstUpdateTask = updates[0]?.summary.continuation?.task;
  const secondUpdateTask = updates[1]?.summary.continuation?.task;

  assert.equal(success.action, "watch");
  assert.equal(success.summary.response_kind, "task");
  assert.equal(task.task_id, "task-watch-1");
  assert.equal(task.status, "completed");
  assert.equal(task.task_handle, handle);
  assert.equal(task.can_resume_send, false);
  assert.equal(task.can_watch, true);
  assert.equal(conversation.context_id, "ctx-watch-1");
  assert.equal(peer.state.resubscribeCalls, 1);
  assert.ok(Array.isArray(raw.events));
  assert.equal((raw.events as unknown[]).length, 2);
  assert.equal(updates.length, 2);
  assert.equal(updates[0]?.action, "watch");
  assert.equal(firstUpdateTask?.task_id, "task-watch-1");
  assert.equal(firstUpdateTask?.status, "working");
  assert.equal(firstUpdateTask?.task_handle, handle);
  assert.equal(updates[0]?.summary.continuation?.conversation?.context_id, "ctx-watch-1");
  assert.equal(secondUpdateTask?.task_id, "task-watch-1");
  assert.equal(secondUpdateTask?.status, "completed");
  assert.equal(secondUpdateTask?.task_handle, handle);
  assert.equal(updates[1]?.summary.continuation?.conversation?.context_id, "ctx-watch-1");
});

test("status and cancel both work from task_handle context", async (t) => {
  const peer = await startPeer({
    getTaskResult: {
      kind: "task",
      id: "task-follow-up-1",
      contextId: "ctx-follow-up-1",
      status: {
        state: "completed",
      },
    },
    cancelTaskResult: {
      kind: "task",
      id: "task-follow-up-1",
      contextId: "ctx-follow-up-1",
      status: {
        state: "canceled",
      },
    },
  });
  t.after(() => peer.server.close());

  const taskHandleRegistry = createTaskHandleRegistry({
    ttlMs: 60_000,
    maxEntries: 100,
  });
  const handle = taskHandleRegistry.create({
    target: resolvedTarget(peer, { alias: "support" }),
    taskId: "task-follow-up-1",
  }).taskHandle;

  const { service } = buildService(
    {},
    {
      taskHandleRegistry,
    },
  );

  const statusResult = await service.execute({
    action: "status",
    task_handle: handle,
    history_length: 2,
  });
  const cancelResult = await service.execute({
    action: "cancel",
    task_handle: handle,
  });

  const status = asSuccess(statusResult);
  const cancel = asSuccess(cancelResult);
  const statusTask = taskContinuationFromSummary(status.summary);
  const cancelTask = taskContinuationFromSummary(cancel.summary);
  const statusConversation = conversationContinuationFromSummary(status.summary);
  const cancelConversation = conversationContinuationFromSummary(cancel.summary);

  assert.equal(status.action, "status");
  assert.equal(status.summary.response_kind, "task");
  assert.equal(statusTask.task_handle, handle);
  assert.equal(statusTask.task_id, "task-follow-up-1");
  assert.equal(statusTask.status, "completed");
  assert.equal(statusTask.can_resume_send, false);
  assert.equal(statusTask.can_watch, false);
  assert.equal(statusConversation.context_id, "ctx-follow-up-1");
  assert.equal(cancel.action, "cancel");
  assert.equal(cancel.summary.response_kind, "task");
  assert.equal(cancelTask.task_handle, handle);
  assert.equal(cancelTask.task_id, "task-follow-up-1");
  assert.equal(cancelTask.status, "canceled");
  assert.equal(cancelTask.can_resume_send, false);
  assert.equal(cancelTask.can_watch, false);
  assert.equal(cancelConversation.context_id, "ctx-follow-up-1");
  assert.equal(peer.state.getCalls, 1);
  assert.equal(peer.state.cancelCalls, 1);
  assert.equal(peer.state.lastGetTaskParams?.id, "task-follow-up-1");
  assert.equal(peer.state.lastGetTaskParams?.historyLength, 2);
});

test("persisted summary.continuation round-trips through send, status, watch, and cancel", async (t) => {
  const peer = await startPeer({
    streaming: true,
    sendResult: {
      kind: "task",
      id: "task-persisted-roundtrip-1",
      contextId: "ctx-persisted-roundtrip-1",
      status: {
        state: "input-required",
      },
    },
    getTaskResult: {
      kind: "task",
      id: "task-persisted-roundtrip-1",
      contextId: "ctx-persisted-roundtrip-1",
      status: {
        state: "working",
      },
    },
    cancelTaskResult: {
      kind: "task",
      id: "task-persisted-roundtrip-1",
      contextId: "ctx-persisted-roundtrip-1",
      status: {
        state: "canceled",
      },
    },
    resubscribeResponses: [
      {
        result: {
          kind: "task",
          id: "task-persisted-roundtrip-1",
          contextId: "ctx-persisted-roundtrip-1",
          status: {
            state: "working",
          },
        },
      },
      {
        result: {
          kind: "status-update",
          taskId: "task-persisted-roundtrip-1",
          contextId: "ctx-persisted-roundtrip-1",
          status: {
            state: "completed",
          },
          final: true,
        },
      },
    ],
  });
  t.after(() => peer.server.close());

  const { service } = buildService({
    targets: [configuredTarget(peer, { alias: "support", default: true })],
  });

  const firstSend = asSuccess(
    await service.execute({
      action: "send",
      parts: [{ kind: "text", text: "start persisted continuation flow" }],
    }),
  );
  const persistedContinuation = structuredClone(
    continuationFromSummary(firstSend.summary),
  );
  const originalHandle = taskHandleFromSummary(firstSend.summary);
  const updates: StreamUpdateEnvelope<"watch">[] = [];

  const resumedSend = asSuccess(
    await service.execute({
      action: "send",
      continuation: persistedContinuation,
      parts: [{ kind: "text", text: "continue from persisted continuation" }],
    }),
  );
  const status = asSuccess(
    await service.execute({
      action: "status",
      continuation: persistedContinuation,
      history_length: 3,
    }),
  );
  const watch = asSuccess(
    await service.execute(
      {
        action: "watch",
        continuation: persistedContinuation,
      },
      {
        onUpdate(update) {
          updates.push(update as StreamUpdateEnvelope<"watch">);
        },
      },
    ),
  );
  const cancel = asSuccess(
    await service.execute({
      action: "cancel",
      continuation: persistedContinuation,
    }),
  );

  const resumedTask = taskContinuationFromSummary(resumedSend.summary);
  const statusTask = taskContinuationFromSummary(status.summary);
  const watchTask = taskContinuationFromSummary(watch.summary);
  const cancelTask = taskContinuationFromSummary(cancel.summary);
  const resumedMessage = asRecord(asRecord(peer.state.lastSendParams ?? {}).message);

  assert.equal(peer.state.sendCalls, 2);
  assert.equal(peer.state.getCalls, 1);
  assert.equal(peer.state.resubscribeCalls, 1);
  assert.equal(peer.state.cancelCalls, 1);
  assert.equal(resumedMessage.taskId, "task-persisted-roundtrip-1");
  assert.equal(resumedMessage.contextId, "ctx-persisted-roundtrip-1");
  assert.equal(resumedTask.task_id, "task-persisted-roundtrip-1");
  assert.equal(resumedTask.task_handle, originalHandle);
  assert.equal(statusTask.task_id, "task-persisted-roundtrip-1");
  assert.equal(statusTask.task_handle, originalHandle);
  assert.equal(watchTask.task_id, "task-persisted-roundtrip-1");
  assert.equal(watchTask.task_handle, originalHandle);
  assert.equal(cancelTask.task_id, "task-persisted-roundtrip-1");
  assert.equal(cancelTask.task_handle, originalHandle);
  assert.equal(conversationContinuationFromSummary(status.summary).context_id, "ctx-persisted-roundtrip-1");
  assert.equal(conversationContinuationFromSummary(watch.summary).context_id, "ctx-persisted-roundtrip-1");
  assert.equal(conversationContinuationFromSummary(cancel.summary).context_id, "ctx-persisted-roundtrip-1");
  assert.equal(updates.length, 2);
  assert.equal(updates[0]?.summary.continuation?.task?.task_handle, originalHandle);
  assert.equal(updates[1]?.summary.continuation?.task?.task_handle, originalHandle);
});

test("persisted summary.continuation recovers send, status, watch, and cancel after handle expiry", async (t) => {
  const peer = await startPeer({
    streaming: true,
    sendResult: {
      kind: "task",
      id: "task-persisted-expired-1",
      contextId: "ctx-persisted-expired-1",
      status: {
        state: "input-required",
      },
    },
    getTaskResult: {
      kind: "task",
      id: "task-persisted-expired-1",
      contextId: "ctx-persisted-expired-1",
      status: {
        state: "working",
      },
    },
    cancelTaskResult: {
      kind: "task",
      id: "task-persisted-expired-1",
      contextId: "ctx-persisted-expired-1",
      status: {
        state: "canceled",
      },
    },
    resubscribeResponses: [
      {
        result: {
          kind: "task",
          id: "task-persisted-expired-1",
          contextId: "ctx-persisted-expired-1",
          status: {
            state: "working",
          },
        },
      },
      {
        result: {
          kind: "status-update",
          taskId: "task-persisted-expired-1",
          contextId: "ctx-persisted-expired-1",
          status: {
            state: "completed",
          },
          final: true,
        },
      },
    ],
  });
  t.after(() => peer.server.close());

  let now = 10_000;
  const taskHandleRegistry = createTaskHandleRegistry({
    ttlMs: 100,
    maxEntries: 100,
    now: () => now,
  });

  const { service } = buildService(
    {
      targets: [configuredTarget(peer, { alias: "support", default: true })],
    },
    { taskHandleRegistry },
  );

  const firstSend = asSuccess(
    await service.execute({
      action: "send",
      parts: [{ kind: "text", text: "start expiring continuation flow" }],
    }),
  );
  const persistedContinuation = structuredClone(
    continuationFromSummary(firstSend.summary),
  );
  const expiredHandle = taskHandleFromSummary(firstSend.summary);
  const updates: StreamUpdateEnvelope<"watch">[] = [];
  now = 10_500;

  const resumedSend = asSuccess(
    await service.execute({
      action: "send",
      continuation: persistedContinuation,
      parts: [{ kind: "text", text: "recover from expired continuation handle" }],
    }),
  );
  const status = asSuccess(
    await service.execute({
      action: "status",
      continuation: persistedContinuation,
    }),
  );
  const watch = asSuccess(
    await service.execute(
      {
        action: "watch",
        continuation: persistedContinuation,
      },
      {
        onUpdate(update) {
          updates.push(update as StreamUpdateEnvelope<"watch">);
        },
      },
    ),
  );
  const cancel = asSuccess(
    await service.execute({
      action: "cancel",
      continuation: persistedContinuation,
    }),
  );

  const resumedTask = taskContinuationFromSummary(resumedSend.summary);
  const statusTask = taskContinuationFromSummary(status.summary);
  const watchTask = taskContinuationFromSummary(watch.summary);
  const cancelTask = taskContinuationFromSummary(cancel.summary);
  const resumedMessage = asRecord(asRecord(peer.state.lastSendParams ?? {}).message);

  assert.equal(peer.state.sendCalls, 2);
  assert.equal(peer.state.getCalls, 1);
  assert.equal(peer.state.resubscribeCalls, 1);
  assert.equal(peer.state.cancelCalls, 1);
  assert.equal(resumedMessage.taskId, "task-persisted-expired-1");
  assert.equal(resumedMessage.contextId, "ctx-persisted-expired-1");
  assert.equal(resumedTask.task_id, "task-persisted-expired-1");
  assert.notEqual(resumedTask.task_handle, expiredHandle);
  assert.equal(statusTask.task_id, "task-persisted-expired-1");
  assert.equal(watchTask.task_id, "task-persisted-expired-1");
  assert.equal(cancelTask.task_id, "task-persisted-expired-1");
  assert.equal(conversationContinuationFromSummary(status.summary).context_id, "ctx-persisted-expired-1");
  assert.equal(conversationContinuationFromSummary(watch.summary).context_id, "ctx-persisted-expired-1");
  assert.equal(conversationContinuationFromSummary(cancel.summary).context_id, "ctx-persisted-expired-1");
  assert.equal(updates.length, 2);
  assert.equal(updates[0]?.summary.continuation?.task?.task_id, "task-persisted-expired-1");
  assert.equal(updates[1]?.summary.continuation?.task?.task_id, "task-persisted-expired-1");
});

test("send with context_id only starts a new task in an existing conversation", async (t) => {
  const peer = await startPeer({
    sendResult: {
      kind: "message",
      messageId: "message-context-1",
      role: "agent",
      contextId: "context-continue-1",
      parts: [{ kind: "text", text: "conversation continued" }],
    },
  });
  t.after(() => peer.server.close());

  const { service } = buildService({
    targets: [configuredTarget(peer, { alias: "support", default: true })],
  });

  const result = await service.execute({
    action: "send",
    context_id: "context-continue-1",
    parts: [{ kind: "text", text: "start another task in this conversation" }],
  });

  const success = asSuccess(result);
  const params = asRecord(peer.state.lastSendParams ?? {});
  const message = asRecord(params.message);
  const conversation = conversationContinuationFromSummary(success.summary);

  assert.equal(success.action, "send");
  assert.equal(success.summary.response_kind, "message");
  assert.equal(success.summary.continuation?.task, undefined);
  assert.equal(conversation.context_id, "context-continue-1");
  assert.equal(message.contextId, "context-continue-1");
  assert.equal("taskId" in message, false);
});

test("send accepts a round-tripped nested continuation contract", async (t) => {
  const peer = await startPeer({
    sendResult: {
      kind: "message",
      messageId: "message-continuation-1",
      role: "agent",
      parts: [{ kind: "text", text: "continued" }],
    },
  });
  t.after(() => peer.server.close());

  const { service } = buildService();
  const continuation = continuationFromTarget(resolvedTarget(peer, { alias: "support" }), {
    task: {
      task_id: "task-continuation-1",
    },
    conversation: {
      context_id: "ctx-continuation-1",
    },
  });

  const result = await service.execute({
    action: "send",
    continuation,
    parts: [{ kind: "text", text: "continue the task" }],
  });

  const success = asSuccess(result);
  const params = asRecord(peer.state.lastSendParams ?? {});
  const message = asRecord(params.message);
  const task = taskContinuationFromSummary(success.summary);
  const conversation = conversationContinuationFromSummary(success.summary);
  const target = targetContinuationFromSummary(success.summary);

  assert.equal(success.action, "send");
  assert.equal(success.summary.response_kind, "message");
  assert.equal(message.taskId, "task-continuation-1");
  assert.equal(message.contextId, "ctx-continuation-1");
  assert.equal(task.task_id, "task-continuation-1");
  assert.equal(conversation.context_id, "ctx-continuation-1");
  assert.equal(target.target_url, `${peer.baseUrl}/`);
  assert.equal(target.card_path, peer.cardPath);
  assert.deepEqual(target.preferred_transports, ["JSONRPC", "HTTP+JSON"]);
});

test("status, watch, and cancel accept nested continuation without configured targets or raw target_url overrides", async (t) => {
  const peer = await startPeer({
    streaming: true,
    getTaskResult: {
      kind: "task",
      id: "task-nested-follow-up-1",
      contextId: "ctx-nested-follow-up-1",
      status: {
        state: "working",
      },
    },
    cancelTaskResult: {
      kind: "task",
      id: "task-nested-follow-up-1",
      contextId: "ctx-nested-follow-up-1",
      status: {
        state: "canceled",
      },
    },
    resubscribeResponses: [
      {
        result: {
          kind: "task",
          id: "task-nested-follow-up-1",
          contextId: "ctx-nested-follow-up-1",
          status: {
            state: "working",
          },
        },
      },
      {
        result: {
          kind: "status-update",
          taskId: "task-nested-follow-up-1",
          contextId: "ctx-nested-follow-up-1",
          status: {
            state: "completed",
          },
          final: true,
        },
      },
    ],
  });
  t.after(() => peer.server.close());

  const { service } = buildService();
  const continuation = continuationFromTarget(resolvedTarget(peer, { alias: "support" }), {
    task: {
      task_id: "task-nested-follow-up-1",
    },
    conversation: {
      context_id: "ctx-nested-follow-up-1",
    },
  });
  const updates: StreamUpdateEnvelope<"watch">[] = [];

  const statusResult = await service.execute({
    action: "status",
    continuation,
  });
  const watchResult = await service.execute(
    {
      action: "watch",
      continuation,
    },
    {
      onUpdate(update) {
        updates.push(update as StreamUpdateEnvelope<"watch">);
      },
    },
  );
  const cancelResult = await service.execute({
    action: "cancel",
    continuation,
  });

  const status = asSuccess(statusResult);
  const watch = asSuccess(watchResult);
  const cancel = asSuccess(cancelResult);

  assert.equal(taskContinuationFromSummary(status.summary).task_id, "task-nested-follow-up-1");
  assert.equal(taskContinuationFromSummary(watch.summary).task_id, "task-nested-follow-up-1");
  assert.equal(taskContinuationFromSummary(cancel.summary).task_id, "task-nested-follow-up-1");
  assert.equal(conversationContinuationFromSummary(status.summary).context_id, "ctx-nested-follow-up-1");
  assert.equal(targetContinuationFromSummary(status.summary).target_url, `${peer.baseUrl}/`);
  assert.equal(peer.state.getCalls, 1);
  assert.equal(peer.state.resubscribeCalls, 1);
  assert.equal(peer.state.cancelCalls, 1);
  assert.equal(updates.length, 2);
});

test("nested continuation with an unknown task_handle falls back to durable target and task_id", async (t) => {
  const peer = await startPeer({
    getTaskResult: {
      kind: "task",
      id: "task-fallback-unknown-1",
      contextId: "ctx-fallback-unknown-1",
      status: {
        state: "completed",
      },
    },
  });
  t.after(() => peer.server.close());

  const { service } = buildService();

  const result = await service.execute({
    action: "status",
    continuation: continuationFromTarget(resolvedTarget(peer, { alias: "support" }), {
      task: {
        task_handle: "rah_missing-handle",
        task_id: "task-fallback-unknown-1",
      },
      conversation: {
        context_id: "ctx-fallback-unknown-1",
      },
    }),
  });

  const success = asSuccess(result);

  assert.equal(success.action, "status");
  assert.equal(taskContinuationFromSummary(success.summary).task_id, "task-fallback-unknown-1");
  assert.equal(peer.state.getCalls, 1);
  assert.equal(peer.state.lastGetTaskParams?.id, "task-fallback-unknown-1");
});

test("nested continuation with an expired task_handle falls back to durable target and task_id", async (t) => {
  const peer = await startPeer({
    getTaskResult: {
      kind: "task",
      id: "task-fallback-expired-1",
      contextId: "ctx-fallback-expired-1",
      status: {
        state: "completed",
      },
    },
  });
  t.after(() => peer.server.close());

  let now = 5_000;
  const taskHandleRegistry = createTaskHandleRegistry({
    ttlMs: 100,
    maxEntries: 100,
    now: () => now,
  });
  const handle = taskHandleRegistry.create({
    target: resolvedTarget(peer, { alias: "support" }),
    taskId: "task-fallback-expired-1",
    contextId: "ctx-fallback-expired-1",
  }).taskHandle;
  now = 5_200;

  const { service } = buildService({}, { taskHandleRegistry });

  const result = await service.execute({
    action: "status",
    continuation: continuationFromTarget(resolvedTarget(peer, { alias: "support" }), {
      task: {
        task_handle: handle,
        task_id: "task-fallback-expired-1",
      },
      conversation: {
        context_id: "ctx-fallback-expired-1",
      },
    }),
  });

  const success = asSuccess(result);

  assert.equal(success.action, "status");
  assert.equal(taskContinuationFromSummary(success.summary).task_id, "task-fallback-expired-1");
  assert.equal(peer.state.getCalls, 1);
  assert.equal(peer.state.lastGetTaskParams?.id, "task-fallback-expired-1");
});

test("nested continuation rejects live-handle task mismatches", async (t) => {
  const peer = await startPeer();
  t.after(() => peer.server.close());

  const taskHandleRegistry = createTaskHandleRegistry({
    ttlMs: 60_000,
    maxEntries: 100,
  });
  const handle = taskHandleRegistry.create({
    target: resolvedTarget(peer, { alias: "support" }),
    taskId: "task-live-1",
    contextId: "ctx-live-1",
  }).taskHandle;

  const { service } = buildService({}, { taskHandleRegistry });
  const result = await service.execute({
    action: "status",
    continuation: continuationFromTarget(resolvedTarget(peer, { alias: "support" }), {
      task: {
        task_handle: handle,
        task_id: "task-other",
      },
      conversation: {
        context_id: "ctx-live-1",
      },
    }),
  });

  const failure = asFailure(result);
  assert.equal(failure.error.code, "VALIDATION_ERROR");
});

test("nested continuation rejects live-handle context mismatches", async (t) => {
  const peer = await startPeer();
  t.after(() => peer.server.close());

  const taskHandleRegistry = createTaskHandleRegistry({
    ttlMs: 60_000,
    maxEntries: 100,
  });
  const handle = taskHandleRegistry.create({
    target: resolvedTarget(peer, { alias: "support" }),
    taskId: "task-live-2",
    contextId: "ctx-live-2",
  }).taskHandle;

  const { service } = buildService({}, { taskHandleRegistry });
  const result = await service.execute({
    action: "status",
    continuation: continuationFromTarget(resolvedTarget(peer, { alias: "support" }), {
      task: {
        task_handle: handle,
        task_id: "task-live-2",
      },
      conversation: {
        context_id: "ctx-other",
      },
    }),
  });

  const failure = asFailure(result);
  assert.equal(failure.error.code, "VALIDATION_ERROR");
});

test("nested continuation rejects live-handle target mismatches", async (t) => {
  const peerOne = await startPeer();
  const peerTwo = await startPeer();
  t.after(() => peerOne.server.close());
  t.after(() => peerTwo.server.close());

  const taskHandleRegistry = createTaskHandleRegistry({
    ttlMs: 60_000,
    maxEntries: 100,
  });
  const handle = taskHandleRegistry.create({
    target: resolvedTarget(peerOne, { alias: "support" }),
    taskId: "task-live-3",
  }).taskHandle;

  const { service } = buildService({}, { taskHandleRegistry });
  const result = await service.execute({
    action: "status",
    continuation: continuationFromTarget(resolvedTarget(peerTwo, { alias: "billing" }), {
      task: {
        task_handle: handle,
        task_id: "task-live-3",
      },
    }),
  });

  const failure = asFailure(result);
  assert.equal(failure.error.code, "VALIDATION_ERROR");
});

test("list_targets hydrates card metadata automatically", async (t) => {
  const peer = await startPeer({
    streaming: true,
  });
  t.after(() => peer.server.close());

  const { service } = buildService({
    targets: [
      configuredTarget(peer, {
        alias: "support",
        default: true,
        description: "Primary support lane",
      }),
    ],
  });

  assert.equal(peer.state.cardRequests, 0);

  const result = await service.execute({
    action: "list_targets",
  });

  const success = asSuccess(result);
  const targets = targetsFromSummary(success.summary);
  const rawTargets = success.raw as TargetCatalogEntry[];

  assert.equal(success.action, "list_targets");
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.target_alias, "support");
  assert.equal(targets[0]?.target_name, "Mock Peer");
  assert.equal(targets[0]?.description, "Primary support lane");
  assert.ok(targets[0]?.peer_card);
  assert.deepEqual(targets[0]?.peer_card, {
    preferred_transport: "JSONRPC",
    additional_interfaces: [
      {
        transport: "JSONRPC",
        url: `${peer.baseUrl}/a2a/jsonrpc`,
      },
      {
        transport: "HTTP+JSON",
        url: `${peer.baseUrl}/a2a/rest`,
      },
    ],
    capabilities: {
      streaming: true,
      push_notifications: true,
      state_transition_history: true,
      extensions: [
        {
          uri: "https://example.com/extensions/audit",
        },
      ],
    },
    default_input_modes: ["text/plain"],
    default_output_modes: ["text/plain"],
    skills: [
      {
        id: "mock",
        name: "Mock Skill",
        description: "mock skill",
        tags: ["test"],
        examples: ["Do the mock thing"],
        input_modes: ["application/json"],
        output_modes: ["application/pdf"],
      },
    ],
  });
  assert.deepEqual(rawTargets[0]?.card.additionalInterfaces, [
    {
      transport: "JSONRPC",
      url: `${peer.baseUrl}/a2a/jsonrpc`,
    },
    {
      transport: "HTTP+JSON",
      url: `${peer.baseUrl}/a2a/rest`,
    },
  ]);
  assert.deepEqual(rawTargets[0]?.card.capabilities, {
    streaming: true,
    pushNotifications: true,
    stateTransitionHistory: true,
    extensions: [
      {
        uri: "https://example.com/extensions/audit",
      },
    ],
  });
  assert.deepEqual(rawTargets[0]?.card.defaultInputModes, ["text/plain"]);
  assert.deepEqual(rawTargets[0]?.card.defaultOutputModes, ["text/plain"]);
  assert.deepEqual(rawTargets[0]?.card.skills[0]?.inputModes, [
    "application/json",
  ]);
  assert.deepEqual(rawTargets[0]?.card.skills[0]?.outputModes, [
    "application/pdf",
  ]);
  assert.deepEqual(
    targets[0]?.peer_card,
    rawTargets[0] ? peerCardSummaryFromRaw(rawTargets[0]) : undefined,
  );
  assert.equal(
    "streaming_supported" in (targets[0] as unknown as Record<string, unknown>),
    false,
  );
  assert.equal(
    "preferred_transport" in (targets[0] as unknown as Record<string, unknown>),
    false,
  );
  assert.equal(peer.state.cardRequests, 1);
  assert.ok(Array.isArray(success.raw));
});

test("send fails validation when no target can be resolved", async () => {
  const { service } = buildService();

  const result = await service.execute({
    action: "send",
    parts: [
      {
        kind: "text",
        text: "hello",
      },
    ],
  });

  const failure = asFailure(result);

  assert.equal(failure.operation, "remote_agent");
  assert.equal(failure.action, "send");
  assert.equal(failure.error.code, "VALIDATION_ERROR");
});

test("send with task_handle rejects explicit target mismatches", async (t) => {
  const peerOne = await startPeer();
  const peerTwo = await startPeer();
  t.after(() => peerOne.server.close());
  t.after(() => peerTwo.server.close());

  const taskHandleRegistry = createTaskHandleRegistry({
    ttlMs: 60_000,
    maxEntries: 100,
  });
  const handle = taskHandleRegistry.create({
    target: resolvedTarget(peerOne, { alias: "support" }),
    taskId: "task-1",
  }).taskHandle;

  const { service } = buildService(
    {
      targets: [
        configuredTarget(peerOne, { alias: "support", default: true }),
        configuredTarget(peerTwo, { alias: "billing" }),
      ],
    },
    { taskHandleRegistry },
  );

  const result = await service.execute({
    action: "send",
    task_handle: handle,
    target_alias: "billing",
    parts: [{ kind: "text", text: "continue" }],
  });

  const failure = asFailure(result);

  assert.equal(failure.action, "send");
  assert.equal(failure.error.code, "VALIDATION_ERROR");
  assert.equal(peerOne.state.sendCalls, 0);
  assert.equal(peerTwo.state.sendCalls, 0);
});

test("send with task_handle rejects task mismatches", async (t) => {
  const peer = await startPeer();
  t.after(() => peer.server.close());

  const taskHandleRegistry = createTaskHandleRegistry({
    ttlMs: 60_000,
    maxEntries: 100,
  });
  const handle = taskHandleRegistry.create({
    target: resolvedTarget(peer, { alias: "support" }),
    taskId: "task-1",
  }).taskHandle;

  const { service } = buildService({}, { taskHandleRegistry });

  const result = await service.execute({
    action: "send",
    task_handle: handle,
    task_id: "task-2",
    parts: [{ kind: "text", text: "continue" }],
  });

  const failure = asFailure(result);

  assert.equal(failure.action, "send");
  assert.equal(failure.error.code, "VALIDATION_ERROR");
  assert.equal(peer.state.sendCalls, 0);
});

test("send with task_handle rejects context mismatches when the handle knows the context", async (t) => {
  const peer = await startPeer();
  t.after(() => peer.server.close());

  const taskHandleRegistry = createTaskHandleRegistry({
    ttlMs: 60_000,
    maxEntries: 100,
  });
  const handle = taskHandleRegistry.create({
    target: resolvedTarget(peer, { alias: "support" }),
    taskId: "task-1",
    contextId: "context-1",
  }).taskHandle;

  const { service } = buildService({}, { taskHandleRegistry });

  const result = await service.execute({
    action: "send",
    task_handle: handle,
    context_id: "context-2",
    parts: [{ kind: "text", text: "continue" }],
  });

  const failure = asFailure(result);

  assert.equal(failure.action, "send");
  assert.equal(failure.error.code, "VALIDATION_ERROR");
  assert.equal(peer.state.sendCalls, 0);
});

test("watch returns an actionable failure when the target is known not to support streaming", async (t) => {
  const peer = await startPeer({
    streaming: false,
  });
  t.after(() => peer.server.close());

  const taskHandleRegistry = createTaskHandleRegistry({
    ttlMs: 60_000,
    maxEntries: 100,
  });
  const handle = taskHandleRegistry.create({
    target: resolvedTarget(peer, {
      alias: "support",
      streamingSupported: false,
    }),
    taskId: "task-no-stream-1",
  }).taskHandle;

  const { service } = buildService(
    {},
    {
      taskHandleRegistry,
    },
  );

  const result = await service.execute({
    action: "watch",
    task_handle: handle,
  });

  const failure = asFailure(result);
  const details = asRecord(failure.error.details);

  assert.equal(failure.action, "watch");
  assert.equal(failure.error.code, "A2A_SDK_ERROR");
  assert.match(failure.error.message, /action=status/);
  assert.equal(details.suggested_action, "status");
  assert.equal(peer.state.resubscribeCalls, 0);
});

test("watch short-circuits from the refreshed peer-card snapshot even when the handle lacks streaming metadata", async (t) => {
  const peer = await startPeer({
    streaming: false,
  });
  t.after(() => peer.server.close());

  const taskHandleRegistry = createTaskHandleRegistry({
    ttlMs: 60_000,
    maxEntries: 100,
  });
  const handle = taskHandleRegistry.create({
    target: resolvedTarget(peer, {
      alias: "support",
    }),
    taskId: "task-no-stream-2",
  }).taskHandle;

  const { service } = buildService(
    {
      targets: [configuredTarget(peer, { alias: "support", default: true })],
    },
    {
      taskHandleRegistry,
    },
  );

  const result = await service.execute({
    action: "watch",
    task_handle: handle,
  });

  const failure = asFailure(result);
  const details = asRecord(failure.error.details);

  assert.equal(failure.action, "watch");
  assert.equal(failure.error.code, "A2A_SDK_ERROR");
  assert.equal(details.suggested_action, "status");
  assert.equal(peer.state.cardRequests, 1);
  assert.equal(peer.state.resubscribeCalls, 0);
});

test("status with unknown task_handle returns UNKNOWN_TASK_HANDLE with suggested_action", async () => {
  const { service } = buildService();

  const result = await service.execute({
    action: "status",
    task_handle: "rah_does-not-exist",
  });

  const failure = asFailure(result);
  const details = asRecord(failure.error.details);

  assert.equal(failure.action, "status");
  assert.equal(failure.error.code, "UNKNOWN_TASK_HANDLE");
  assert.equal(details.suggested_action, "send");
});

test("send with unknown task_handle returns UNKNOWN_TASK_HANDLE with suggested_action", async () => {
  const { service } = buildService();

  const result = await service.execute({
    action: "send",
    task_handle: "rah_does-not-exist",
    parts: [{ kind: "text", text: "continue" }],
  });

  const failure = asFailure(result);
  const details = asRecord(failure.error.details);

  assert.equal(failure.action, "send");
  assert.equal(failure.error.code, "UNKNOWN_TASK_HANDLE");
  assert.equal(details.suggested_action, "send");
});

test("status with expired task_handle returns EXPIRED_TASK_HANDLE with recovery hint", async () => {
  let now = 10_000;
  const taskHandleRegistry = createTaskHandleRegistry({
    ttlMs: 100,
    maxEntries: 100,
    now: () => now,
  });
  const handle = taskHandleRegistry.create({
    target: {
      baseUrl: "https://peer.example/",
      cardPath: "/.well-known/agent-card.json",
      preferredTransports: ["JSONRPC", "HTTP+JSON"],
      alias: "support",
    },
    taskId: "task-expired-1",
    contextId: "ctx-expired-1",
  }).taskHandle;

  now = 10_200;

  const { service } = buildService({}, { taskHandleRegistry });

  const result = await service.execute({
    action: "status",
    task_handle: handle,
  });

  const failure = asFailure(result);
  const details = asRecord(failure.error.details);

  assert.equal(failure.action, "status");
  assert.equal(failure.error.code, "EXPIRED_TASK_HANDLE");
  assert.equal(details.task_id, "task-expired-1");
  assert.equal(details.context_id, "ctx-expired-1");
  assert.ok(Array.isArray(details.suggested_actions));
  assert.ok((details.suggested_actions as string[]).includes("status"));
  assert.ok((details.suggested_actions as string[]).includes("send"));
  assert.equal(
    details.hint,
    "Retry with the persisted continuation, or resend the original request after a restart to obtain a new handle.",
  );
  const continuation = asRecord(details.continuation);
  assert.deepEqual(continuation.task, {
    task_id: "task-expired-1",
  });
  assert.deepEqual(continuation.conversation, {
    context_id: "ctx-expired-1",
  });
  assert.deepEqual(continuation.target, {
    target_url: "https://peer.example/",
    card_path: "/.well-known/agent-card.json",
    preferred_transports: ["JSONRPC", "HTTP+JSON"],
    target_alias: "support",
  });
});

test("send with expired task_handle returns EXPIRED_TASK_HANDLE with recovery hint", async () => {
  let now = 20_000;
  const taskHandleRegistry = createTaskHandleRegistry({
    ttlMs: 100,
    maxEntries: 100,
    now: () => now,
  });
  const handle = taskHandleRegistry.create({
    target: {
      baseUrl: "https://peer.example/",
      cardPath: "/.well-known/agent-card.json",
      preferredTransports: ["JSONRPC", "HTTP+JSON"],
      alias: "support",
    },
    taskId: "task-expired-2",
    contextId: "ctx-expired-2",
  }).taskHandle;

  now = 20_200;

  const { service } = buildService({}, { taskHandleRegistry });

  const result = await service.execute({
    action: "send",
    task_handle: handle,
    parts: [{ kind: "text", text: "continue" }],
  });

  const failure = asFailure(result);
  const details = asRecord(failure.error.details);

  assert.equal(failure.action, "send");
  assert.equal(failure.error.code, "EXPIRED_TASK_HANDLE");
  assert.equal(details.task_id, "task-expired-2");
  assert.equal(details.context_id, "ctx-expired-2");
  assert.ok(Array.isArray(details.suggested_actions));
  assert.ok((details.suggested_actions as string[]).includes("status"));
  assert.ok((details.suggested_actions as string[]).includes("send"));
  assert.equal(
    details.hint,
    "Retry with the persisted continuation, or resend the original request after a restart to obtain a new handle.",
  );
  const continuation = asRecord(details.continuation);
  assert.deepEqual(continuation.task, {
    task_id: "task-expired-2",
  });
  assert.deepEqual(continuation.conversation, {
    context_id: "ctx-expired-2",
  });
  assert.deepEqual(continuation.target, {
    target_url: "https://peer.example/",
    card_path: "/.well-known/agent-card.json",
    preferred_transports: ["JSONRPC", "HTTP+JSON"],
    target_alias: "support",
  });
});

test("list_targets with unreachable peer still returns entries with lastRefreshError", async (t) => {
  const peer = await startPeer();
  const peerUrl = peer.baseUrl;
  peer.server.close();
  await new Promise<void>((resolve) => peer.server.on("close", resolve));

  const { service } = buildService({
    targets: [
      configuredTarget(peer, {
        alias: "down",
        default: true,
      }),
    ],
    defaults: {
      timeoutMs: 500,
    },
  });

  const result = await service.execute({
    action: "list_targets",
  });

  const success = asSuccess(result);
  const targets = targetsFromSummary(success.summary);

  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.target_alias, "down");
  assert.equal(targets[0]?.target_url, `${peerUrl}/`);
  assert.deepEqual(targets[0]?.peer_card, {
    additional_interfaces: [],
    capabilities: {},
    default_input_modes: [],
    default_output_modes: [],
    skills: [],
  });
  assert.ok(targets[0]?.last_refresh_error);
  assert.equal(typeof targets[0]?.last_refresh_error?.code, "string");
});
