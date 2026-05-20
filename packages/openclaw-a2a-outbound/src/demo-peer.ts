import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  AgentCard,
  Artifact,
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskIdParams,
  TaskQueryParams,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import type { A2AOutboundPluginConfig } from "./config.js";

export const LOCAL_DEMO_ALIAS = "local-demo" as const;
export const DEMO_AGENT_CARD_PATH = "/.well-known/agent-card.json" as const;
export const DEMO_JSON_RPC_PATH = "/a2a/jsonrpc" as const;
export const DEMO_PROTOCOL_VERSION = "0.3.0" as const;
export const DEMO_AGENT_NAME = "OpenClaw A2A Local Demo Peer" as const;

const MAX_REQUEST_BYTES = 1024 * 1024;
const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
};

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

type DemoStreamEvent = Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

type DemoTaskRecord = {
  turn: number;
  task: Task;
};

export type DemoPeerSnapshot = {
  taskCount: number;
  tasks: Task[];
};

export type StartedDemoPeer = {
  baseUrl: string;
  cardUrl: string;
  jsonRpcUrl: string;
  close(): Promise<void>;
  snapshot(): DemoPeerSnapshot;
};

export type StartDemoPeerOptions = {
  host?: string;
  port?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromParts(parts: Message["parts"]): string {
  return parts
    .flatMap((part) =>
      part.kind === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n\n");
}

function jsonRpcId(value: unknown): JsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null
    ? value
    : null;
}

function jsonRpcSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function jsonRpcFailure(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

function formatSseEvent(response: JsonRpcResponse): string {
  return `data: ${JSON.stringify(response)}\n\n`;
}

function cloneTask(task: Task): Task {
  return structuredClone(task) as Task;
}

function cloneMessage(message: Message): Message {
  return structuredClone(message) as Message;
}

function cloneArtifact(artifact: Artifact): Artifact {
  return structuredClone(artifact) as Artifact;
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req as AsyncIterable<string | Buffer>) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.byteLength;

    if (total > MAX_REQUEST_BYTES) {
      throw new Error(`request body exceeds ${MAX_REQUEST_BYTES} bytes`);
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(body, null, 2));
}

function writeText(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
  });
  res.end(body);
}

function isMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    value.kind === "message" &&
    typeof value.messageId === "string" &&
    Array.isArray(value.parts)
  );
}

function readSendMessage(params: unknown): Message | undefined {
  return isRecord(params) && isMessage(params.message) ? params.message : undefined;
}

function readTaskId(params: unknown): string | undefined {
  return isRecord(params) && typeof params.id === "string" ? params.id : undefined;
}

function taskStatusUpdate(
  task: Task,
  final: boolean,
): TaskStatusUpdateEvent {
  return {
    kind: "status-update",
    taskId: task.id,
    contextId: task.contextId,
    status: {
      state: task.status.state,
      ...(task.status.message !== undefined
        ? { message: cloneMessage(task.status.message) }
        : {}),
      timestamp: FIXED_TIMESTAMP,
    },
    final,
  };
}

function artifactUpdate(task: Task): TaskArtifactUpdateEvent | undefined {
  const artifact = task.artifacts?.[0];

  if (!artifact) {
    return undefined;
  }

  return {
    kind: "artifact-update",
    taskId: task.id,
    contextId: task.contextId,
    artifact: cloneArtifact(artifact),
    append: false,
    lastChunk: true,
  };
}

function terminalState(state: string): boolean {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "canceled" ||
    state === "rejected"
  );
}

class DemoPeerRuntime {
  private readonly tasks = new Map<string, DemoTaskRecord>();

  private taskSeq = 0;

  private contextSeq = 0;

  private messageSeq = 0;

  private artifactSeq = 0;

  constructor(private readonly baseUrl: () => string) {}

  snapshot(): DemoPeerSnapshot {
    return {
      taskCount: this.tasks.size,
      tasks: [...this.tasks.values()].map((record) => cloneTask(record.task)),
    };
  }

  agentCard(): AgentCard {
    const baseUrl = this.baseUrl();
    const jsonRpcUrl = new URL(DEMO_JSON_RPC_PATH, baseUrl).toString();

    return {
      name: DEMO_AGENT_NAME,
      description:
        "Deterministic local A2A peer for OpenClaw outbound onboarding.",
      protocolVersion: DEMO_PROTOCOL_VERSION,
      version: "1.0.0",
      url: jsonRpcUrl,
      preferredTransport: "JSONRPC",
      capabilities: {
        streaming: true,
        pushNotifications: false,
        stateTransitionHistory: true,
      },
      defaultInputModes: ["text/plain", "application/json"],
      defaultOutputModes: ["text/plain", "application/json"],
      additionalInterfaces: [
        {
          transport: "JSONRPC",
          url: jsonRpcUrl,
        },
      ],
      skills: [
        {
          id: "demo-delegation",
          name: "Demo Delegation",
          description:
            "Returns deterministic direct replies, task results, and continuation-friendly task snapshots.",
          tags: ["demo", "delegation", "continuation"],
          examples: [
            "Create a durable demo task.",
            "Continue from the persisted continuation.",
          ],
          inputModes: ["text/plain", "application/json"],
          outputModes: ["text/plain", "application/json"],
        },
      ],
    };
  }

  directReply(message: Message): Message {
    const contextId =
      message.contextId ?? `demo-context-direct-${++this.contextSeq}`;
    const inboundText = textFromParts(message.parts) || "empty prompt";

    return {
      kind: "message",
      messageId: `demo-agent-message-${++this.messageSeq}`,
      role: "agent",
      contextId,
      ...(message.taskId !== undefined ? { taskId: message.taskId } : {}),
      parts: [
        {
          kind: "text",
          text: `Demo peer direct reply: ${inboundText}`,
        },
      ],
    };
  }

  taskReply(message: Message): Task {
    const existing =
      message.taskId !== undefined ? this.tasks.get(message.taskId) : undefined;
    const taskId = message.taskId ?? `demo-task-${++this.taskSeq}`;
    const contextId =
      message.contextId ?? existing?.task.contextId ?? `demo-context-${++this.contextSeq}`;
    const turn = (existing?.turn ?? 0) + 1;
    const inboundText = textFromParts(message.parts) || "empty prompt";
    const cancelable = /\bcancelable\b/i.test(inboundText);
    const resumed = existing !== undefined || message.taskId !== undefined;
    const statusState = cancelable ? "working" : "completed";
    const artifactText = resumed
      ? `Demo peer resumed ${taskId} from persisted continuation. Received: ${inboundText}`
      : cancelable
        ? `Demo peer started cancelable task ${taskId}.`
        : `Demo peer completed durable task ${taskId}. Received: ${inboundText}`;
    const artifact: Artifact = {
      artifactId: `demo-artifact-${++this.artifactSeq}`,
      name: resumed ? "continuation-result" : "demo-result",
      parts: [
        {
          kind: "text",
          text: artifactText,
        },
      ],
    };
    const agentMessage: Message = {
      kind: "message",
      messageId: `demo-agent-message-${++this.messageSeq}`,
      role: "agent",
      contextId,
      taskId,
      parts: [
        {
          kind: "text",
          text: artifactText,
        },
      ],
    };
    const history = [
      ...(existing?.task.history?.map(cloneMessage) ?? []),
      cloneMessage(message),
      cloneMessage(agentMessage),
    ];
    const task: Task = {
      kind: "task",
      id: taskId,
      contextId,
      status: {
        state: statusState,
        message: cloneMessage(agentMessage),
        timestamp: FIXED_TIMESTAMP,
      },
      artifacts: [artifact],
      history,
      metadata: {
        demo: true,
        turn,
      },
    };

    this.tasks.set(taskId, {
      turn,
      task,
    });

    return cloneTask(task);
  }

  sendMessage(params: unknown): Message | Task {
    const message = readSendMessage(params);

    if (!message) {
      throw jsonRpcFailure(null, -32602, "message is required");
    }

    const text = textFromParts(message.parts);

    return /\bdirect\b/i.test(text) ? this.directReply(message) : this.taskReply(message);
  }

  streamMessage(params: unknown): DemoStreamEvent[] {
    const result = this.sendMessage(params);

    if (result.kind === "message") {
      return [result];
    }

    return this.taskEvents(result);
  }

  getTask(params: TaskQueryParams | unknown): Task {
    const taskId = readTaskId(params);

    if (!taskId) {
      throw jsonRpcFailure(null, -32602, "task id is required");
    }

    const record = this.tasks.get(taskId);

    if (!record) {
      throw jsonRpcFailure(null, -32001, `task not found: ${taskId}`, {
        taskId,
      });
    }

    return cloneTask(record.task);
  }

  cancelTask(params: TaskIdParams | unknown): Task {
    const taskId = readTaskId(params);

    if (!taskId) {
      throw jsonRpcFailure(null, -32602, "task id is required");
    }

    const record = this.tasks.get(taskId);

    if (!record) {
      throw jsonRpcFailure(null, -32001, `task not found: ${taskId}`, {
        taskId,
      });
    }

    if (terminalState(record.task.status.state)) {
      return cloneTask(record.task);
    }

    const canceledMessage: Message = {
      kind: "message",
      messageId: `demo-agent-message-${++this.messageSeq}`,
      role: "agent",
      contextId: record.task.contextId,
      taskId: record.task.id,
      parts: [
        {
          kind: "text",
          text: `Demo peer canceled ${record.task.id}.`,
        },
      ],
    };
    const canceledTask: Task = {
      ...cloneTask(record.task),
      status: {
        state: "canceled",
        message: canceledMessage,
        timestamp: FIXED_TIMESTAMP,
      },
      history: [...(record.task.history?.map(cloneMessage) ?? []), canceledMessage],
    };

    this.tasks.set(taskId, {
      turn: record.turn,
      task: canceledTask,
    });

    return cloneTask(canceledTask);
  }

  resubscribe(params: TaskIdParams | unknown): DemoStreamEvent[] {
    return this.taskEvents(this.getTask(params));
  }

  private taskEvents(task: Task): DemoStreamEvent[] {
    const events: DemoStreamEvent[] = [cloneTask(task)];
    const artifact = artifactUpdate(task);

    if (artifact !== undefined) {
      events.push(artifact);
    }

    events.push(taskStatusUpdate(task, terminalState(task.status.state)));
    return events;
  }
}

function isJsonRpcFailure(value: unknown): value is JsonRpcFailure {
  return isRecord(value) && isRecord(value.error) && typeof value.error.code === "number";
}

function rpcResult(runtime: DemoPeerRuntime, request: JsonRpcRequest): unknown {
  switch (request.method) {
    case "message/send":
      return runtime.sendMessage(request.params);
    case "tasks/get":
      return runtime.getTask(request.params);
    case "tasks/cancel":
      return runtime.cancelTask(request.params);
    case "agent/getAuthenticatedExtendedCard":
      return runtime.agentCard();
    default:
      throw jsonRpcFailure(
        jsonRpcId(request.id),
        -32601,
        `method not found: ${String(request.method)}`,
      );
  }
}

function rpcStream(runtime: DemoPeerRuntime, request: JsonRpcRequest): DemoStreamEvent[] {
  switch (request.method) {
    case "message/stream":
      return runtime.streamMessage(request.params);
    case "tasks/resubscribe":
      return runtime.resubscribe(request.params);
    default:
      throw jsonRpcFailure(
        jsonRpcId(request.id),
        -32601,
        `method not found: ${String(request.method)}`,
      );
  }
}

function parseJsonRpcRequest(body: Buffer): JsonRpcRequest {
  const parsed = JSON.parse(body.toString("utf8")) as unknown;

  if (!isRecord(parsed) || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
    throw jsonRpcFailure(null, -32600, "invalid JSON-RPC request");
  }

  return parsed;
}

export function createDemoOutboundConfig(baseUrl: string): A2AOutboundPluginConfig {
  return {
    enabled: true,
    defaults: {
      timeoutMs: 30_000,
      cardPath: DEMO_AGENT_CARD_PATH,
      preferredTransports: ["JSONRPC", "HTTP+JSON"],
      serviceParameters: {},
    },
    targets: [
      {
        alias: LOCAL_DEMO_ALIAS,
        baseUrl,
        description: "Deterministic local A2A demo peer.",
        tags: ["demo", "local"],
        cardPath: DEMO_AGENT_CARD_PATH,
        preferredTransports: ["JSONRPC", "HTTP+JSON"],
        examples: [
          "Create a durable demo task.",
          "Continue from the persisted continuation.",
        ],
        default: true,
      },
    ],
    taskHandles: {
      ttlMs: 86_400_000,
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

export async function startDemoPeerServer(
  options: StartDemoPeerOptions = {},
): Promise<StartedDemoPeer> {
  const host = options.host ?? "127.0.0.1";
  let baseUrl = "";
  const runtime = new DemoPeerRuntime(() => baseUrl);
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === DEMO_AGENT_CARD_PATH) {
        writeJson(res, 200, runtime.agentCard());
        return;
      }

      if (req.method !== "POST" || url.pathname !== DEMO_JSON_RPC_PATH) {
        writeText(res, 404, "not found");
        return;
      }

      const body = await readRequestBody(req);
      const request = parseJsonRpcRequest(body);
      const id = jsonRpcId(request.id);

      if (request.method === "message/stream" || request.method === "tasks/resubscribe") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });

        for (const event of rpcStream(runtime, request)) {
          res.write(formatSseEvent(jsonRpcSuccess(id, event)));
        }

        res.end();
        return;
      }

      writeJson(res, 200, jsonRpcSuccess(id, rpcResult(runtime, request)));
    })().catch((error: unknown) => {
      const failure = isJsonRpcFailure(error)
        ? error
        : jsonRpcFailure(
            null,
            error instanceof SyntaxError ? -32700 : -32603,
            error instanceof Error ? error.message : String(error),
          );

      if (!res.headersSent) {
        writeJson(res, error instanceof SyntaxError ? 400 : 500, failure);
        return;
      }

      if (!res.writableEnded) {
        res.write(formatSseEvent(failure));
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("failed to bind demo peer server");
  }

  baseUrl = `http://${host}:${address.port}`;

  return {
    baseUrl,
    cardUrl: new URL(DEMO_AGENT_CARD_PATH, baseUrl).toString(),
    jsonRpcUrl: new URL(DEMO_JSON_RPC_PATH, baseUrl).toString(),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
    snapshot: () => runtime.snapshot(),
  };
}
