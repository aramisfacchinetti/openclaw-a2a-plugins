import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import { createA2AInboundServer } from "../dist/a2a-server.js";
import {
  createPluginRuntimeHarness,
  type TestAccountOverrides,
  createTestAccount,
  createUserMessage,
  waitFor,
} from "./runtime-harness.js";

type StreamEvent = Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | Message;
type StreamParts = Message["parts"] | TaskArtifactUpdateEvent["artifact"]["parts"];
type MessagePart = Message["parts"][number];
type TaskArtifact = NonNullable<Task["artifacts"]>[number];
type TaskHistoryMessage = NonNullable<Task["history"]>[number];

function isTask(value: StreamEvent | Message | Task): value is Task {
  return value.kind === "task";
}

function isMessage(value: StreamEvent): value is Message {
  return value.kind === "message";
}

function isStatusUpdate(value: StreamEvent): value is TaskStatusUpdateEvent {
  return value.kind === "status-update";
}

function isArtifactUpdate(value: StreamEvent): value is TaskArtifactUpdateEvent {
  return value.kind === "artifact-update";
}

function getArtifactText(event: TaskArtifactUpdateEvent): string | undefined {
  const textPart = event.artifact.parts.find((part) => part.kind === "text");
  return textPart?.kind === "text" ? textPart.text : undefined;
}

function getArtifactData(
  event: TaskArtifactUpdateEvent,
): Record<string, unknown> | undefined {
  const dataPart = event.artifact.parts.find((part) => part.kind === "data");
  return dataPart?.kind === "data"
    ? (dataPart.data as Record<string, unknown>)
    : undefined;
}

function getPartFileUris(
  parts: StreamParts,
): string[] {
  return parts.flatMap((part) =>
    part.kind === "file" && "uri" in part.file ? [part.file.uri] : [],
  );
}

function getPartData(
  parts: StreamParts,
): Record<string, unknown> | undefined {
  const dataPart = parts.find((part) => part.kind === "data");
  return dataPart?.kind === "data"
    ? (dataPart.data as Record<string, unknown>)
    : undefined;
}

function getArtifactUpdates(
  events: readonly StreamEvent[],
  artifactId: string,
): TaskArtifactUpdateEvent[] {
  return events.filter(
    (event): event is TaskArtifactUpdateEvent =>
      isArtifactUpdate(event) &&
      (event.artifact.artifactId === artifactId ||
        (artifactId === "assistant-output" &&
          event.artifact.artifactId.startsWith("assistant-output-"))),
  );
}

function getStatusSequence(
  events: readonly StreamEvent[],
): Array<[TaskStatusUpdateEvent["status"]["state"], boolean]> {
  return events
    .filter(isStatusUpdate)
    .map((event) => [event.status.state, event.final]);
}

function getPersistedArtifactText(
  task: Task,
  artifactId: string,
): string | undefined {
  const artifact = task.artifacts?.find(
    (entry) =>
      entry.artifactId === artifactId ||
      (artifactId === "assistant-output" &&
        entry.artifactId.startsWith("assistant-output-")),
  );

  if (!artifact) {
    return undefined;
  }

  return artifact.parts
    .filter((part): part is Extract<typeof part, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("");
}

function getPersistedArtifactData(
  task: Task,
  artifactId: string,
): Record<string, unknown> | undefined {
  const artifact = task.artifacts?.find(
    (entry) =>
      entry.artifactId === artifactId ||
      (artifactId === "assistant-output" &&
        entry.artifactId.startsWith("assistant-output-")),
  );

  if (!artifact) {
    return undefined;
  }

  const dataPart = artifact.parts.find((part) => part.kind === "data");
  return dataPart?.kind === "data"
    ? (dataPart.data as Record<string, unknown>)
    : undefined;
}

function getStatusMessageText(
  value: Task | TaskStatusUpdateEvent,
): string | undefined {
  const part = value.status.message?.parts[0];
  return part?.kind === "text" ? part.text : undefined;
}

function assertNoOpenClawMetadata(value: unknown, path = "root"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoOpenClawMetadata(entry, `${path}[${index}]`));
    return;
  }

  if (typeof value !== "object" || value === null) {
    return;
  }

  const record = value as Record<string, unknown>;
  const metadata = record.metadata;

  if (
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata)
  ) {
    assert.equal(
      "openclaw" in metadata,
      false,
      `unexpected metadata.openclaw at ${path}.metadata`,
    );
  }

  for (const [key, entry] of Object.entries(record)) {
    assertNoOpenClawMetadata(entry, `${path}.${key}`);
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address.");
  }

  return `http://127.0.0.1:${address.port}`;
}

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function createServerHarness(
  script: Parameters<typeof createPluginRuntimeHarness>[0],
  accountOverrides: TestAccountOverrides = {},
) {
  const account = createTestAccount(accountOverrides);
  const { pluginRuntime } = createPluginRuntimeHarness(script);
  const server = createA2AInboundServer({
    accountId: "default",
    account,
    cfg: {},
    channelRuntime: pluginRuntime.channel,
    pluginRuntime,
  });

  return {
    ...server,
    account,
  };
}

async function postJsonRpc(
  baseUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/a2a/jsonrpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
}

test("sendMessage returns a direct Message for terminal runs", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-direct");
    emit({
      runId: "run-direct",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Direct server reply" },
      { kind: "final" },
    );
    emit({
      runId: "run-direct",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
  });

  assert.equal(result.kind, "message");
  assert.equal(result.parts[0]?.kind, "text");
  assert.equal(
    result.parts[0] && "text" in result.parts[0] ? result.parts[0].text : undefined,
    "Direct server reply",
  );
});

test("sendMessage keeps a blocking delayed terminal run as one direct Message", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-blocking-delay");
    emit({
      runId: "run-blocking-delay",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await params.dispatcherOptions.deliver(
      { text: "Blocking delayed reply" },
      { kind: "final" },
    );
    emit({
      runId: "run-blocking-delay",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
  });

  assert.equal(result.kind, "message");
  assert.equal(result.parts[0]?.kind, "text");
  assert.equal(
    result.parts[0] && "text" in result.parts[0] ? result.parts[0].text : undefined,
    "Blocking delayed reply",
  );
});

test("sendMessage drops file parts from blocking replies under the default text/json modes", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-direct-multipart");
    emit({
      runId: "run-direct-multipart",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      {
        text: "Direct reply with attachment",
        mediaUrl: "https://example.com/report.pdf",
      },
      { kind: "final" },
    );
    emit({
      runId: "run-direct-multipart",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
  });

  assert.equal(result.kind, "message");
  assert.deepEqual(result.parts.map((part: MessagePart) => part.kind), ["text"]);
  assert.equal(
    result.parts[0] && "text" in result.parts[0]
      ? result.parts[0].text
      : undefined,
    "Direct reply with attachment",
  );
});

test("former /files paths now fall through to the server 404 route", async () => {
  const harness = createServerHarness(async () => {});
  const routeServer = createServer((req, res) => {
    void harness.handle(req, res);
  });

  try {
    const baseUrl = await listen(routeServer);
    const response = await fetch(`${baseUrl}/a2a/files/missing/missing/missing`);

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: {
        code: "A2A_ROUTE_NOT_FOUND",
        message: "No A2A inbound route matched this request.",
        details: {
          channel: "a2a",
          accountId: "default",
        },
      },
    });
  } finally {
    await closeHttpServer(routeServer);
    harness.close();
  }
});

test("sendMessage rejects file-only blocking replies when only octet-stream would match", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-direct-file");
    emit({
      runId: "run-direct-file",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      {
        mediaUrl: "https://example.com/image.png",
      },
      { kind: "final" },
    );
    emit({
      runId: "run-direct-file",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  await assert.rejects(
    () =>
      server.requestHandler.sendMessage({
        message: createUserMessage(),
        configuration: {
          acceptedOutputModes: ["application/octet-stream"],
        },
      }),
    (error: unknown) => {
      assert.equal(
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code: unknown }).code
          : undefined,
        -32005,
      );
      return true;
    },
  );
});

test("nonblocking file-only replies fail the promoted task without file parts", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-nonblocking-file");
    emit({
      runId: "run-nonblocking-file",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      {
        mediaUrl: "https://example.com/image.png",
      },
      { kind: "final" },
    );
    emit({
      runId: "run-nonblocking-file",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
    configuration: {
      blocking: false,
      acceptedOutputModes: ["application/octet-stream"],
    },
  });

  assert.equal(result.kind, "task");

  await waitFor(async () => {
    const persisted = await server.requestHandler.getTask({
      id: result.id,
      historyLength: 10,
    });

    return persisted.status.state === "failed";
  });

  const persisted = await server.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });

  assert.equal(persisted.status.state, "failed");
  assert.equal(
    getStatusMessageText(persisted),
    "The response could not be represented in any accepted output mode.",
  );
  assert.deepEqual(getPartFileUris(persisted.status.message?.parts ?? []), []);
  assert.equal(
    persisted.artifacts?.some(
      (artifact: TaskArtifact) => getPartFileUris(artifact.parts).length > 0,
    ) ?? false,
    false,
  );
});

test("acceptedOutputModes text/plain strips vendor data and file parts when text remains", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-filter-text");
    emit({
      runId: "run-filter-text",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      {
        text: "Plain text survives",
        mediaUrl: "https://example.com/image.png",
        channelData: {
          source: "test",
        },
      },
      { kind: "final" },
    );
    emit({
      runId: "run-filter-text",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
    configuration: {
      acceptedOutputModes: ["text/plain"],
    },
  });

  assert.equal(result.kind, "message");
  assert.deepEqual(result.parts.map((part: MessagePart) => part.kind), ["text"]);
  assert.equal(
    result.parts[0] && "text" in result.parts[0] ? result.parts[0].text : undefined,
    "Plain text survives",
  );
});

test("acceptedOutputModes application/json rejects replies that only become vendor metadata", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-filter-json");
    emit({
      runId: "run-filter-json",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      {
        text: "Filtered text",
        channelData: {
          source: "test",
        },
        replyToId: "reply-123",
      },
      { kind: "final" },
    );
    emit({
      runId: "run-filter-json",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  await assert.rejects(
    () =>
      server.requestHandler.sendMessage({
        message: createUserMessage(),
        configuration: {
          acceptedOutputModes: ["application/json"],
        },
      }),
    (error: unknown) => {
      assert.equal(
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code: unknown }).code
          : undefined,
        -32005,
      );
      return true;
    },
  );
});

test("incompatible acceptedOutputModes return content-type-not-supported", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-filter-error");
    emit({
      runId: "run-filter-error",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      {
        text: "No matching mode",
      },
      { kind: "final" },
    );
    emit({
      runId: "run-filter-error",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  await assert.rejects(
    () =>
      server.requestHandler.sendMessage({
        message: createUserMessage(),
        configuration: {
          acceptedOutputModes: ["application/json"],
        },
      }),
    (error: unknown) => {
      assert.equal(
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code: unknown }).code
          : undefined,
        -32005,
      );
      return true;
    },
  );
});

test("agent card advertises MIME-based default output modes", async () => {
  const server = createServerHarness(async () => {});
  const agentCard = await server.requestHandler.getAgentCard();

  assert.deepEqual(agentCard.defaultOutputModes, [
    "text/plain",
    "application/json",
  ]);
});

test("sendMessage returns an initial Task for a nonblocking terminal run", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-nonblocking-terminal");
    emit({
      runId: "run-nonblocking-terminal",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Nonblocking terminal reply" },
      { kind: "final" },
    );
    emit({
      runId: "run-nonblocking-terminal",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
    configuration: {
      blocking: false,
    },
  });

  assert.equal(isTask(result), true);
  if (!isTask(result)) {
    assert.fail("expected task result");
  }

  assert.equal(result.status.state, "submitted");

  await waitFor(async () => {
    const persisted = await server.requestHandler.getTask({
      id: result.id,
      historyLength: 10,
    });

    return persisted.status.state === "completed";
  });

  const persisted = await server.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });

  assert.equal(persisted.status.state, "completed");
  assert.equal(
    getPersistedArtifactText(persisted, "assistant-output"),
    "Nonblocking terminal reply",
  );
  assert.ok(
    persisted.artifacts?.some(
      (artifact: TaskArtifact) => artifact.artifactId === "assistant-output-0001",
    ),
  );
});

test("sendMessage returns a Task for promoted runs and getTask returns the persisted latest snapshot", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-task");
    emit({
      runId: "run-task",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-task",
      stream: "assistant",
      data: { text: "Collected context" },
    });
    emit({
      runId: "run-task",
      stream: "tool",
      data: {
        phase: "start",
        name: "search",
        toolCallId: "tool/search:1",
        args: { query: "weather" },
      },
    });
    emit({
      runId: "run-task",
      stream: "tool",
      data: {
        phase: "result",
        name: "search",
        toolCallId: "tool/search:1",
        isError: false,
        result: { hits: 3 },
      },
    });
    await params.dispatcherOptions.deliver(
      { text: "Fetched tool summary" },
      { kind: "tool" },
    );
    emit({
      runId: "run-task",
      stream: "assistant",
      data: { text: "Collected context\nFinal answer" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Final answer" },
      { kind: "final" },
    );
    emit({
      runId: "run-task",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
  });

  assert.equal(isTask(result), true);
  if (!isTask(result)) {
    assert.fail("expected task result");
  }

  assert.equal(result.status.state, "completed");
  assert.ok(result.artifacts?.some((artifact) => artifact.artifactId === "assistant-output-0001"));
  assert.ok(result.artifacts?.some((artifact) => artifact.artifactId.startsWith("tool-result-")));

  const persisted = await server.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });

  assert.equal(persisted.status.state, "completed");
  assert.ok(
    persisted.history?.some((message: TaskHistoryMessage) => message.role === "user"),
  );
  assert.ok(
    persisted.artifacts?.some(
      (artifact: TaskArtifact) => artifact.artifactId === "assistant-output-0001",
    ),
  );
});

test("blocking sendMessage returns input-required for explicit approval pauses and persists the tool payload", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-blocking-input-required");
    emit({
      runId: "run-blocking-input-required",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-blocking-input-required",
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
          },
          command: "npm publish",
        },
      },
    });
    emit({
      runId: "run-blocking-input-required",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
  });

  assert.equal(isTask(result), true);
  if (!isTask(result)) {
    assert.fail("expected task result");
  }

  assert.equal(result.status.state, "input-required");
  assert.equal(
    getStatusMessageText(result),
    "OpenClaw is waiting for tool approval to continue.",
  );
  assert.deepEqual(
    getPersistedArtifactData(result, "tool-progress-exec_1"),
    {
      phase: "result",
      name: "exec",
      toolCallId: "exec/1",
      isError: false,
      result: {
        status: "approval-pending",
        requiresApproval: {
          type: "approval_request",
        },
        command: "npm publish",
      },
    },
  );

  const persisted = await server.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });

  assert.equal(persisted.status.state, "input-required");
  assert.equal(
    getStatusMessageText(persisted),
    "OpenClaw is waiting for tool approval to continue.",
  );
});

test("nonblocking sendMessage persists task payloads without metadata.openclaw", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-metadata-free");
    emit({
      runId: "run-metadata-free",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-metadata-free",
      stream: "assistant",
      data: { delta: "Working on it" },
    });
    emit({
      runId: "run-metadata-free",
      stream: "tool",
      data: {
        phase: "start",
        name: "search",
        toolCallId: "search/1",
        args: { query: "weather" },
      },
    });
    await params.dispatcherOptions.deliver(
      { text: "Tool summary" },
      { kind: "tool" },
    );
    await params.dispatcherOptions.deliver(
      { text: "Final answer" },
      { kind: "final" },
    );
    emit({
      runId: "run-metadata-free",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
    configuration: {
      blocking: false,
    },
  });

  assert.equal(isTask(result), true);
  if (!isTask(result)) {
    assert.fail("expected task result");
  }

  assertNoOpenClawMetadata(result);

  await waitFor(async () => {
    const persisted = await server.requestHandler.getTask({
      id: result.id,
      historyLength: 10,
    });

    return persisted.status.state === "completed";
  });

  const persisted = await server.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });

  assert.equal(persisted.status.state, "completed");
  assert.ok(
    persisted.artifacts?.some(
      (artifact: TaskArtifact) => artifact.artifactId === "assistant-output-0001",
    ),
  );
  assert.ok(
    persisted.artifacts?.some(
      (artifact: TaskArtifact) => artifact.artifactId.startsWith("tool-progress-"),
    ),
  );
  assert.ok(
    persisted.artifacts?.some(
      (artifact: TaskArtifact) => artifact.artifactId.startsWith("tool-result-"),
    ),
  );
  assertNoOpenClawMetadata(persisted);
});

test("raw JSON-RPC rejects removed optional methods at the boundary", async () => {
  let executed = false;
  const harness = createServerHarness(async () => {
    executed = true;
  });
  const routeServer = createServer((req, res) => {
    void harness.handle(req, res);
  });

  try {
    const baseUrl = await listen(routeServer);
    const requests: Array<[string, Record<string, unknown>]> = [
      ["message/stream", { message: createUserMessage() }],
      ["tasks/resubscribe", { id: "task-removed" }],
      [
        "tasks/pushNotificationConfig/set",
        {
          taskId: "task-removed",
          pushNotificationConfig: {
            url: "https://example.com/hook",
          },
        },
      ],
      ["tasks/pushNotificationConfig/get", { id: "task-removed" }],
      ["tasks/pushNotificationConfig/list", { id: "task-removed" }],
      [
        "tasks/pushNotificationConfig/delete",
        { id: "task-removed", pushNotificationConfigId: "cfg-1" },
      ],
    ];

    for (const [method, params] of requests) {
      const response = await postJsonRpc(baseUrl, method, params);

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      });
    }

    assert.equal(executed, false);
  } finally {
    await closeHttpServer(routeServer);
    harness.close();
  }
});

test("sendMessage persists the same final assistant-output for cumulative preview snapshots", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-cumulative-persisted");
    emit({
      runId: "run-cumulative-persisted",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-cumulative-persisted",
      stream: "assistant",
      data: { text: "Alpha" },
    });
    emit({
      runId: "run-cumulative-persisted",
      stream: "assistant",
      data: { text: "Alpha Beta" },
    });
    emit({
      runId: "run-cumulative-persisted",
      stream: "assistant",
      data: { text: "Alpha Beta Gamma" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Alpha Beta Gamma" },
      { kind: "final" },
    );
    emit({
      runId: "run-cumulative-persisted",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
    configuration: {
      blocking: false,
    },
  });

  assert.equal(isTask(result), true);
  if (!isTask(result)) {
    assert.fail("expected task result");
  }

  await waitFor(async () => {
    const persisted = await server.requestHandler.getTask({
      id: result.id,
      historyLength: 10,
    });

    return persisted.status.state === "completed";
  });

  const persisted = await server.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });

  assert.equal(
    getPersistedArtifactText(persisted, "assistant-output"),
    "Alpha Beta Gamma",
  );
});

test("sendMessage persists the same final assistant-output for delta preview snapshots", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-delta-persisted");
    emit({
      runId: "run-delta-persisted",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-delta-persisted",
      stream: "assistant",
      data: { delta: "Alpha" },
    });
    emit({
      runId: "run-delta-persisted",
      stream: "assistant",
      data: { delta: " Beta" },
    });
    emit({
      runId: "run-delta-persisted",
      stream: "assistant",
      data: { delta: " Gamma" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Alpha Beta Gamma" },
      { kind: "final" },
    );
    emit({
      runId: "run-delta-persisted",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
    configuration: {
      blocking: false,
    },
  });

  assert.equal(isTask(result), true);
  if (!isTask(result)) {
    assert.fail("expected task result");
  }

  await waitFor(async () => {
    const persisted = await server.requestHandler.getTask({
      id: result.id,
      historyLength: 10,
    });

    return persisted.status.state === "completed";
  });

  const persisted = await server.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });

  assert.equal(
    getPersistedArtifactText(persisted, "assistant-output"),
    "Alpha Beta Gamma",
  );
});

test("multiple assistant messages use distinct indexed assistant artifact ids", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-multi-assistant");
    emit({
      runId: "run-multi-assistant",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    params.replyOptions?.onAssistantMessageStart?.();
    await params.dispatcherOptions.deliver(
      { text: "First answer" },
      { kind: "final" },
    );
    params.replyOptions?.onAssistantMessageStart?.();
    await params.dispatcherOptions.deliver(
      { text: "Second answer" },
      { kind: "final" },
    );
    emit({
      runId: "run-multi-assistant",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
  });

  assert.equal(isTask(result), true);
  if (!isTask(result)) {
    assert.fail("expected task result");
  }

  assert.ok(
    result.artifacts?.some((artifact) => artifact.artifactId === "assistant-output-0001"),
  );
  assert.ok(
    result.artifacts?.some((artifact) => artifact.artifactId === "assistant-output-0002"),
  );
});

test("nonblocking assistant artifacts stay text-only under the default text/json modes", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-assistant-file-filter");
    emit({
      runId: "run-assistant-file-filter",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-assistant-file-filter",
      stream: "assistant",
      data: { delta: "Preview text" },
    });
    await params.dispatcherOptions.deliver(
      {
        text: "Preview text",
        mediaUrl: "https://example.com/preview.png",
      },
      { kind: "final" },
    );
    emit({
      runId: "run-assistant-file-filter",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
    configuration: {
      blocking: false,
    },
  });

  assert.equal(isTask(result), true);
  if (!isTask(result)) {
    assert.fail("expected task result");
  }

  await waitFor(async () => {
    const persisted = await server.requestHandler.getTask({
      id: result.id,
      historyLength: 10,
    });

    return persisted.status.state === "completed";
  });

  const persisted = await server.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });
  const assistantArtifact = persisted.artifacts?.find(
    (artifact: TaskArtifact) => artifact.artifactId === "assistant-output-0001",
  );

  assert.ok(assistantArtifact);
  assert.deepEqual(
    assistantArtifact?.parts.map((part) => part.kind),
    ["text"],
  );
  assert.deepEqual(getPartFileUris(assistantArtifact?.parts ?? []), []);
  assertNoOpenClawMetadata(persisted);
});

test("nonblocking tool artifacts preserve progress data and text-only tool results", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-tool-artifacts");
    emit({
      runId: "run-tool-artifacts",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-tool-artifacts",
      stream: "tool",
      data: {
        phase: "start",
        name: "fetch-weather",
        toolCallId: "tool:weather/1",
        args: { city: "Zurich" },
      },
    });
    emit({
      runId: "run-tool-artifacts",
      stream: "tool",
      data: {
        phase: "update",
        name: "fetch-weather",
        toolCallId: "tool:weather/1",
        partialResult: { percent: 50 },
      },
    });
    emit({
      runId: "run-tool-artifacts",
      stream: "tool",
      data: {
        phase: "result",
        name: "fetch-weather",
        toolCallId: "tool:weather/1",
        isError: false,
        result: { temperatureC: 9 },
      },
    });
    await params.dispatcherOptions.deliver(
      {
        text: "Tool attachment",
        mediaUrl: "https://example.com/tool-output.png",
      },
      { kind: "tool" },
    );
    await params.dispatcherOptions.deliver(
      { text: "Done" },
      { kind: "final" },
    );
    emit({
      runId: "run-tool-artifacts",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
    configuration: {
      blocking: false,
    },
  });

  assert.equal(isTask(result), true);
  if (!isTask(result)) {
    assert.fail("expected task result");
  }

  await waitFor(async () => {
    const persisted = await server.requestHandler.getTask({
      id: result.id,
      historyLength: 10,
    });

    return persisted.status.state === "completed";
  });

  const persisted = await server.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });
  const toolProgress = persisted.artifacts?.filter(
    (artifact: TaskArtifact) => artifact.artifactId === "tool-progress-tool_weather_1",
  );
  const toolResult = persisted.artifacts?.find(
    (artifact: TaskArtifact) => artifact.artifactId.startsWith("tool-result-"),
  );

  assert.equal(toolProgress?.length, 1);
  assert.deepEqual(toolProgress?.[0]?.metadata, {
    source: "tool",
    phase: "result",
    toolName: "fetch-weather",
    toolCallId: "tool:weather/1",
    sequence: toolProgress?.[0]?.metadata?.sequence,
  });
  assert.deepEqual(getPartData(toolProgress?.[0]?.parts ?? []), {
    phase: "result",
    name: "fetch-weather",
    toolCallId: "tool:weather/1",
    isError: false,
    result: { temperatureC: 9 },
  });
  assert.ok(toolResult);
  assert.deepEqual(toolResult?.parts.map((part) => part.kind), ["text"]);
  assert.deepEqual(getPartFileUris(toolResult?.parts ?? []), []);
  assertNoOpenClawMetadata(persisted);
});

test("terminal task status.message stays text-only under the default text/json modes", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-status-message");
    emit({
      runId: "run-status-message",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      {
        text: "Status with attachment",
        mediaUrl: "https://example.com/status.pdf",
      },
      { kind: "final" },
    );
    emit({
      runId: "run-status-message",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
    configuration: {
      blocking: false,
    },
  });

  assert.equal(isTask(result), true);
  if (!isTask(result)) {
    assert.fail("expected task result");
  }

  await waitFor(async () => {
    const persisted = await server.requestHandler.getTask({
      id: result.id,
      historyLength: 10,
    });

    return persisted.status.state === "completed";
  });

  const persisted = await server.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });

  assert.deepEqual(
    persisted.status.message?.parts.map((part: MessagePart) => part.kind),
    ["text"],
  );
  assert.deepEqual(getPartFileUris(persisted.status.message?.parts ?? []), []);
  assert.deepEqual(
    getPartFileUris(
      persisted.artifacts?.find(
        (artifact: TaskArtifact) => artifact.artifactId === "assistant-output-0001",
      )
        ?.parts ?? [],
    ),
    [],
  );
});

test("input-required tasks cancel directly once the task is quiescent", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-input-required-cancel");
    emit({
      runId: "run-input-required-cancel",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-input-required-cancel",
      stream: "tool",
      data: {
        phase: "result",
        name: "shell",
        toolCallId: "shell/1",
        isError: false,
        result: {
          status: "needs_approval",
          requiresApproval: {
            type: "approval_request",
            prompt: "Approve shell command?",
          },
          command: "rm -rf ./build",
        },
      },
    });
    emit({
      runId: "run-input-required-cancel",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
  });

  assert.equal(isTask(result), true);
  if (!isTask(result)) {
    assert.fail("expected task result");
  }

  const persisted = await server.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });
  assert.equal(persisted.status.state, "input-required");
  assert.equal(getStatusMessageText(persisted), "Approve shell command?");
  assertNoOpenClawMetadata(persisted);

  const canceled = await server.requestHandler.cancelTask({ id: result.id });
  assert.equal(canceled.status.state, "canceled");

  const persistedCanceled = await server.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });
  assert.equal(persistedCanceled.status.state, "canceled");
  assertNoOpenClawMetadata(persistedCanceled);
});

test("cancelTask waits for the real terminal task after aborting a live promoted execution", async () => {
  let releaseAfterAbort: (() => void) | undefined;
  let abortObserved = false;

  const server = createServerHarness(async ({ params, emit, waitForAbort }) => {
    params.replyOptions?.onAgentRunStart?.("run-cancel");
    emit({
      runId: "run-cancel",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Tool summary" },
      { kind: "tool" },
    );
    await waitForAbort();
    abortObserved = true;
    await new Promise<void>((resolve) => {
      releaseAfterAbort = resolve;
    });
    emit({
      runId: "run-cancel",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
    configuration: {
      blocking: false,
    },
  });

  assert.equal(isTask(result), true);
  if (!isTask(result)) {
    assert.fail("expected live task");
  }

  let cancelResolved = false;
  const cancelPromise = server.requestHandler
    .cancelTask({ id: result.id })
    .then((task: Task) => {
      cancelResolved = true;
      return task;
    });

  await waitFor(() => abortObserved);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(cancelResolved, false);

  const pending = await server.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });
  assert.equal(pending.status.state, "working");

  releaseAfterAbort?.();

  const canceled = await cancelPromise;

  assert.equal(canceled.status.state, "canceled");

  const persisted = await server.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });
  assert.equal(persisted.status.state, "canceled");
});

test("restarting the server loses prior process-local task state", async () => {
  const initialServer = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-restart-loss");
    emit({
      runId: "run-restart-loss",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Ephemeral reply" },
      { kind: "final" },
    );
    emit({
      runId: "run-restart-loss",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });
  let taskId: string | undefined;

  try {
    const result = await initialServer.requestHandler.sendMessage({
      message: createUserMessage({
        messageId: "message-restart-loss",
      }),
      configuration: {
        blocking: false,
      },
    });

    assert.equal(isTask(result), true);
    if (!isTask(result)) {
      assert.fail("expected in-process task");
    }
    taskId = result.id;

    await waitFor(async () => {
      const persisted = await initialServer.requestHandler.getTask({
        id: result.id,
        historyLength: 10,
      });

      return persisted.status.state === "completed";
    });
  } finally {
    initialServer.close();
  }

  if (!taskId) {
    assert.fail("expected task id");
  }

  const restartedServer = createServerHarness(async () => {});

  try {
    await assert.rejects(
      () =>
        restartedServer.requestHandler.getTask({
          id: taskId,
          historyLength: 10,
        }),
      (error: unknown) => {
        assert.equal(
          typeof error === "object" && error !== null && "code" in error
            ? (error as { code: unknown }).code
            : undefined,
          -32001,
        );
        return true;
      },
    );
  } finally {
    restartedServer.close();
  }
});
