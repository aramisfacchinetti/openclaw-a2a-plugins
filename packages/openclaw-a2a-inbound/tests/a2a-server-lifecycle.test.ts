import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import { createA2AInboundServer } from "../dist/a2a-server.js";
import {
  buildTaskFileUrl,
  deriveFilesBasePath,
} from "../dist/file-delivery.js";
import {
  createPluginRuntimeHarness,
  createTestAccount,
  createUserMessage,
  waitFor,
} from "./runtime-harness.js";

type StreamEvent = Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | Message;

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
  parts: readonly (Message | TaskArtifactUpdateEvent["artifact"])["parts"],
): string[] {
  return parts.flatMap((part) =>
    part.kind === "file" && "uri" in part.file ? [part.file.uri] : [],
  );
}

function getPartData(
  parts: readonly (Message | TaskArtifactUpdateEvent["artifact"])["parts"],
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

function getOpenClawMetadata(
  value: { metadata?: Record<string, unknown> | undefined },
): Record<string, unknown> | undefined {
  const metadata = value.metadata;

  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    typeof metadata.openclaw !== "object" ||
    metadata.openclaw === null ||
    Array.isArray(metadata.openclaw)
  ) {
    return undefined;
  }

  return metadata.openclaw as Record<string, unknown>;
}

function getCurrentSequence(task: Task): number | undefined {
  const openclaw = getOpenClawMetadata(task);
  return typeof openclaw?.currentSequence === "number"
    ? openclaw.currentSequence
    : undefined;
}

function getEventSequence(
  event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
): number | undefined {
  const openclaw = getOpenClawMetadata(event);
  return typeof openclaw?.sequence === "number" ? openclaw.sequence : undefined;
}

function isReplayedEvent(
  event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
): boolean {
  return getOpenClawMetadata(event)?.replayed === true;
}

function createServerHarness(
  script: Parameters<typeof createPluginRuntimeHarness>[0],
  accountOverrides: Partial<ReturnType<typeof createTestAccount>> = {},
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

function buildExpectedTaskFileUri(params: {
  server: ReturnType<typeof createServerHarness>;
  taskId: string;
  artifactId: string;
  fileId?: string;
}): string {
  return buildTaskFileUrl({
    publicBaseUrl: params.server.account.publicBaseUrl ?? "https://agents.example.com",
    filesBasePath: deriveFilesBasePath(params.server.account.jsonRpcPath),
    taskId: params.taskId,
    artifactId: params.artifactId,
    fileId: params.fileId ?? "ignored",
  });
}

function assertTaskFileUriMatches(params: {
  server: ReturnType<typeof createServerHarness>;
  uri: string;
  taskId: string;
  artifactId: string;
}): void {
  const expectedPrefix = buildExpectedTaskFileUri({
    server: params.server,
    taskId: params.taskId,
    artifactId: params.artifactId,
  }).replace(/ignored$/, "");

  assert.equal(params.uri.startsWith(expectedPrefix), true, params.uri);
}

async function collectStream(
  server: ReturnType<typeof createServerHarness>,
): Promise<StreamEvent[]> {
  const streamed: StreamEvent[] = [];

  for await (const event of server.requestHandler.sendMessageStream({
    message: createUserMessage(),
  })) {
    streamed.push(event);
  }

  return streamed;
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

test("sendMessage promotes blocking file replies to a Task with plugin-owned file URIs", async () => {
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

  assert.equal(result.kind, "task");
  assert.deepEqual(
    result.status.message?.parts.map((part) => part.kind),
    ["text", "file"],
  );
  assert.equal(
    result.status.message?.parts[0] && "text" in result.status.message.parts[0]
      ? result.status.message.parts[0].text
      : undefined,
    "Direct reply with attachment",
  );
  const fileUri = getPartFileUris(result.status.message?.parts ?? [])[0];
  assert.ok(fileUri);
  assertTaskFileUriMatches({
    server,
    uri: fileUri!,
    taskId: result.id,
    artifactId: "assistant-output-0001",
  });
});

test("sendMessage promotes blocking file-only replies to a Task when octet-stream is accepted", async () => {
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

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
    configuration: {
      acceptedOutputModes: ["application/octet-stream"],
    },
  });

  assert.equal(result.kind, "task");
  assert.deepEqual(result.status.message?.parts.map((part) => part.kind), ["file"]);
  const fileUri = getPartFileUris(result.status.message?.parts ?? [])[0];
  assert.ok(fileUri);
  assertTaskFileUriMatches({
    server,
    uri: fileUri!,
    taskId: result.id,
    artifactId: "assistant-output-0001",
  });
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
  assert.deepEqual(result.parts.map((part) => part.kind), ["text"]);
  assert.equal(
    result.parts[0] && "text" in result.parts[0] ? result.parts[0].text : undefined,
    "Plain text survives",
  );
});

test("acceptedOutputModes application/json emits only the vendor DataPart when vendor metadata exists", async () => {
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

  const result = await server.requestHandler.sendMessage({
    message: createUserMessage(),
    configuration: {
      acceptedOutputModes: ["application/json"],
    },
  });

  assert.equal(result.kind, "message");
  assert.deepEqual(result.parts.map((part) => part.kind), ["data"]);
  assert.deepEqual(getPartData(result.parts), {
    openclaw: {
      reply: {
        channelData: {
          source: "test",
        },
        replyToId: "reply-123",
      },
    },
  });
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
    "application/octet-stream",
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
    persisted.artifacts?.some((artifact) => artifact.artifactId === "assistant-output-0001"),
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
  assert.ok(persisted.history?.some((message) => message.role === "user"));
  assert.ok(
    persisted.artifacts?.some((artifact) => artifact.artifactId === "assistant-output-0001"),
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

test("sendMessageStream emits task-first assistant progress and a closing artifact event", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-stream-fast");
    emit({
      runId: "run-stream-fast",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-stream-fast",
      stream: "assistant",
      data: { delta: "Working..." },
    });
    await params.dispatcherOptions.deliver(
      { text: "Working..." },
      { kind: "final" },
    );
    emit({
      runId: "run-stream-fast",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const streamed = await collectStream(server);
  const assistantUpdates = getArtifactUpdates(streamed, "assistant-output");
  const closingUpdate = assistantUpdates.at(-1);
  const taskIndex = streamed.findIndex((event) => event.kind === "task");
  const firstAssistantIndex = streamed.findIndex(
    (event) =>
      isArtifactUpdate(event) && event.artifact.artifactId === "assistant-output-0001",
  );
  const completedIndex = streamed.findIndex(
    (event) =>
      isStatusUpdate(event) &&
      event.status.state === "completed" &&
      event.final === true,
  );

  assert.equal(streamed.some(isMessage), false);
  assert.equal(taskIndex, 0);
  assert.deepEqual(getStatusSequence(streamed), [
    ["submitted", false],
    ["working", false],
    ["completed", true],
  ]);
  assert.equal(assistantUpdates.length, 2);
  assert.equal(getArtifactText(assistantUpdates[0]), "Working...");
  assert.equal(assistantUpdates[0].lastChunk, false);
  assert.ok(closingUpdate);
  assert.equal(closingUpdate.lastChunk, true);
  assert.equal(getArtifactText(closingUpdate), undefined);
  assert.equal(closingUpdate.append, true);
  assert.ok(firstAssistantIndex > taskIndex);
  assert.ok(completedIndex > firstAssistantIndex);
});

test("sendMessageStream stays task-based when only the final reply arrives", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-stream-final-only");
    emit({
      runId: "run-stream-final-only",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Final only answer" },
      { kind: "final" },
    );
    emit({
      runId: "run-stream-final-only",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const streamed = await collectStream(server);
  const assistantUpdates = getArtifactUpdates(streamed, "assistant-output");
  const closingUpdate = assistantUpdates.at(-1);
  const completedIndex = streamed.findIndex(
    (event) =>
      isStatusUpdate(event) &&
      event.status.state === "completed" &&
      event.final === true,
  );

  assert.equal(streamed.some(isMessage), false);
  assert.equal(streamed[0]?.kind, "task");
  assert.deepEqual(getStatusSequence(streamed), [
    ["submitted", false],
    ["working", false],
    ["completed", true],
  ]);
  assert.equal(assistantUpdates.length, 2);
  assert.equal(getArtifactText(assistantUpdates[0]), "Final only answer");
  assert.equal(assistantUpdates[0].lastChunk, false);
  assert.ok(closingUpdate);
  assert.equal(closingUpdate.lastChunk, true);
  assert.equal(getArtifactText(closingUpdate), undefined);
  assert.equal(closingUpdate.append, true);
  assert.ok(streamed.indexOf(assistantUpdates[0]) < completedIndex);
});

test("sendMessageStream reconciles assistant deltas against the authoritative final reply", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-stream-reconcile");
    emit({
      runId: "run-stream-reconcile",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-stream-reconcile",
      stream: "assistant",
      data: { delta: "Draft reply" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Authoritative final reply" },
      { kind: "final" },
    );
    emit({
      runId: "run-stream-reconcile",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const streamed = await collectStream(server);
  const assistantUpdates = getArtifactUpdates(streamed, "assistant-output");
  const authoritativeUpdate = [...assistantUpdates]
    .reverse()
    .find((event) => typeof getArtifactText(event) === "string");
  const closingUpdate = assistantUpdates.at(-1);
  const completedIndex = streamed.findIndex(
    (event) =>
      isStatusUpdate(event) &&
      event.status.state === "completed" &&
      event.final === true,
  );

  assert.ok(authoritativeUpdate);
  assert.equal(getArtifactText(authoritativeUpdate), "Authoritative final reply");
  assert.equal(authoritativeUpdate.append, undefined);
  assert.ok(closingUpdate);
  assert.equal(closingUpdate.lastChunk, true);
  assert.ok(streamed.indexOf(authoritativeUpdate) < completedIndex);
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

test("streaming assistant artifacts replace the full artifact when media appears after preview text", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-stream-media-replace");
    emit({
      runId: "run-stream-media-replace",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-stream-media-replace",
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
      runId: "run-stream-media-replace",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const streamed = await collectStream(server);
  const task = streamed.find(isTask);
  const assistantUpdates = getArtifactUpdates(streamed, "assistant-output");

  assert.ok(task);
  if (!task || !isTask(task)) {
    assert.fail("expected task snapshot");
  }

  assert.equal(assistantUpdates.length, 3);
  assert.equal(getArtifactText(assistantUpdates[0]), "Preview text");
  assert.equal(assistantUpdates[0].append, undefined);
  assert.deepEqual(getPartFileUris(assistantUpdates[0].artifact.parts), []);
  assert.equal(assistantUpdates[1].append, undefined);
  assert.deepEqual(
    assistantUpdates[1].artifact.parts.map((part) => part.kind),
    ["text", "file"],
  );
  const previewUri = getPartFileUris(assistantUpdates[1].artifact.parts)[0];
  assert.ok(previewUri);
  assertTaskFileUriMatches({
    server,
    uri: previewUri!,
    taskId: task.id,
    artifactId: assistantUpdates[1].artifact.artifactId,
  });
  assert.equal(assistantUpdates[2].lastChunk, true);
  assert.equal(assistantUpdates[2].append, true);
});

test("tool-result artifacts emit file parts when tool payloads contain media URLs", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-tool-file");
    emit({
      runId: "run-tool-file",
      stream: "lifecycle",
      data: { phase: "start" },
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
      runId: "run-tool-file",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const streamed = await collectStream(server);
  const task = streamed.find(isTask);
  const toolArtifact = streamed.find(
    (event) =>
      isArtifactUpdate(event) &&
      event.artifact.artifactId.startsWith("tool-result-"),
  );

  assert.ok(task);
  if (!task || !isTask(task)) {
    assert.fail("expected task snapshot");
  }

  assert.ok(toolArtifact);
  if (!toolArtifact || !isArtifactUpdate(toolArtifact)) {
    assert.fail("expected tool result artifact");
  }

  assert.deepEqual(
    toolArtifact.artifact.parts.map((part) => part.kind),
    ["text", "file"],
  );
  const toolFileUri = getPartFileUris(toolArtifact.artifact.parts)[0];
  assert.ok(toolFileUri);
  assertTaskFileUriMatches({
    server,
    uri: toolFileUri!,
    taskId: task.id,
    artifactId: toolArtifact.artifact.artifactId,
  });
});

test("terminal task status.message uses the canonical multipart assistant Message", async () => {
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
    persisted.status.message?.parts.map((part) => part.kind),
    ["text", "file"],
  );
  const statusFileUri = getPartFileUris(persisted.status.message?.parts ?? [])[0];
  assert.ok(statusFileUri);
  assertTaskFileUriMatches({
    server,
    uri: statusFileUri!,
    taskId: result.id,
    artifactId: "assistant-output-0001",
  });
  assert.deepEqual(
    getPartFileUris(
      persisted.artifacts?.find((artifact) => artifact.artifactId === "assistant-output-0001")
        ?.parts ?? [],
    ),
    [statusFileUri],
  );
});

test("sendMessageStream emits stable live tool progress artifacts", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-stream-tool-progress");
    emit({
      runId: "run-stream-tool-progress",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-stream-tool-progress",
      stream: "tool",
      data: {
        phase: "start",
        name: "fetch-weather",
        toolCallId: "tool:weather/1",
        args: { city: "Zurich" },
      },
    });
    emit({
      runId: "run-stream-tool-progress",
      stream: "tool",
      data: {
        phase: "update",
        name: "fetch-weather",
        toolCallId: "tool:weather/1",
        partialResult: { percent: 50 },
      },
    });
    emit({
      runId: "run-stream-tool-progress",
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
      { text: "Weather fetched" },
      { kind: "final" },
    );
    emit({
      runId: "run-stream-tool-progress",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const streamed = await collectStream(server);
  const toolProgressUpdates = getArtifactUpdates(
    streamed,
    "tool-progress-tool_weather_1",
  );

  assert.equal(toolProgressUpdates.length, 3);
  assert.deepEqual(
    toolProgressUpdates.map((event) => getArtifactText(event)),
    [
      "Started tool fetch-weather",
      "Updated tool fetch-weather",
      "Completed tool fetch-weather",
    ],
  );
  assert.deepEqual(
    toolProgressUpdates.map((event) => event.artifact.metadata),
    [
      {
        source: "tool",
        phase: "start",
        toolName: "fetch-weather",
        toolCallId: "tool:weather/1",
        sequence: toolProgressUpdates[0].artifact.metadata?.sequence,
      },
      {
        source: "tool",
        phase: "update",
        toolName: "fetch-weather",
        toolCallId: "tool:weather/1",
        sequence: toolProgressUpdates[1].artifact.metadata?.sequence,
      },
      {
        source: "tool",
        phase: "result",
        toolName: "fetch-weather",
        toolCallId: "tool:weather/1",
        sequence: toolProgressUpdates[2].artifact.metadata?.sequence,
      },
    ],
  );
  assert.deepEqual(
    toolProgressUpdates.map((event) => event.append),
    [undefined, undefined, undefined],
  );
  assert.deepEqual(
    toolProgressUpdates.map((event) => event.lastChunk),
    [false, false, true],
  );
  assert.deepEqual(getArtifactData(toolProgressUpdates[0]), {
    phase: "start",
    name: "fetch-weather",
    toolCallId: "tool:weather/1",
    args: { city: "Zurich" },
  });
  assert.deepEqual(getArtifactData(toolProgressUpdates[1]), {
    phase: "update",
    name: "fetch-weather",
    toolCallId: "tool:weather/1",
    partialResult: { percent: 50 },
  });
  assert.deepEqual(getArtifactData(toolProgressUpdates[2]), {
    phase: "result",
    name: "fetch-weather",
    toolCallId: "tool:weather/1",
    isError: false,
    result: { temperatureC: 9 },
  });
});

test("streaming approval pauses replay input-required and paused tasks cancel directly", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-stream-input-required");
    emit({
      runId: "run-stream-input-required",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-stream-input-required",
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
      runId: "run-stream-input-required",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const streamed = await collectStream(server);
  const task = streamed.find(isTask);
  const toolProgress = getArtifactUpdates(streamed, "tool-progress-shell_1").at(-1);
  assert.ok(toolProgress);
  const pauseSequence = toolProgress ? getEventSequence(toolProgress) : undefined;

  assert.ok(task);
  assert.deepEqual(getStatusSequence(streamed), [
    ["submitted", false],
    ["working", false],
    ["input-required", false],
  ]);
  assert.equal(
    streamed.some(
      (event) =>
        isStatusUpdate(event) && event.status.state === "auth-required",
    ),
    false,
  );
  assert.equal(
    getStatusMessageText(
      streamed.filter(isStatusUpdate).at(-1) as TaskStatusUpdateEvent,
    ),
    "Approve shell command?",
  );

  if (!task) {
    assert.fail("expected streamed task snapshot");
  }

  const persisted = await server.requestHandler.getTask({
    id: task.id,
    historyLength: 10,
  });
  assert.equal(persisted.status.state, "input-required");
  assert.equal(getStatusMessageText(persisted), "Approve shell command?");

  assert.equal(pauseSequence, 3);
  const replayed: Array<Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
  for await (const event of server.requestHandler.resubscribe({
    id: task.id,
    metadata: {
      openclaw: {
        afterSequence: pauseSequence,
      },
    },
  })) {
    replayed.push(event);
  }

  assert.deepEqual(
    replayed
      .filter(isStatusUpdate)
      .map((event) => [event.status.state, event.final]),
    [["input-required", false]],
  );

  const canceled = await server.requestHandler.cancelTask({ id: task.id });
  assert.equal(canceled.status.state, "canceled");

  const persistedCanceled = await server.requestHandler.getTask({
    id: task.id,
    historyLength: 10,
  });
  assert.equal(persistedCanceled.status.state, "canceled");
});

test("sendMessageStream emits both live tool progress and summarized tool results", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-stream-mixed");
    emit({
      runId: "run-stream-mixed",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-stream-mixed",
      stream: "tool",
      data: {
        phase: "start",
        name: "search",
        toolCallId: "search/1",
        args: { query: "cafes" },
      },
    });
    emit({
      runId: "run-stream-mixed",
      stream: "tool",
      data: {
        phase: "update",
        name: "search",
        toolCallId: "search/1",
        partialResult: { hits: 1 },
      },
    });
    emit({
      runId: "run-stream-mixed",
      stream: "tool",
      data: {
        phase: "result",
        name: "search",
        toolCallId: "search/1",
        isError: false,
        result: { hits: 2 },
      },
    });
    await params.dispatcherOptions.deliver(
      { text: "Visible tool output" },
      { kind: "tool" },
    );
    emit({
      runId: "run-stream-mixed",
      stream: "assistant",
      data: { text: "Working\nDone" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Done" },
      { kind: "final" },
    );
    emit({
      runId: "run-stream-mixed",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const streamed = await collectStream(server);

  assert.equal(
    getArtifactUpdates(streamed, "tool-progress-search_1").length,
    3,
  );
  assert.ok(
    streamed.some(
      (event) =>
        isArtifactUpdate(event) &&
        event.artifact.artifactId.startsWith("tool-result-") &&
        getArtifactText(event) === "Visible tool output",
    ),
  );
  assert.ok(getArtifactUpdates(streamed, "assistant-output").length >= 1);
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
    .then((task) => {
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

test("resubscribe replays backlog from afterSequence and then tails the committed live completion", async () => {
  let resumeLiveRun: (() => void) | undefined;
  const tempDir = await mkdtemp(join(tmpdir(), "openclaw-a2a-inbound-"));
  const taskStoreRoot = join(tempDir, "task-store");
  let liveServer: ReturnType<typeof createServerHarness> | undefined;

  try {
    liveServer = createServerHarness(
      async ({ params, emit }) => {
        params.replyOptions?.onAgentRunStart?.("run-live");
        emit({
          runId: "run-live",
          stream: "lifecycle",
          data: { phase: "start" },
        });
        emit({
          runId: "run-live",
          stream: "assistant",
          data: { delta: "Recovering answer" },
        });
        await new Promise<void>((resolve) => {
          resumeLiveRun = resolve;
        });
        emit({
          runId: "run-live",
          stream: "tool",
          data: {
            phase: "start",
            name: "search",
            toolCallId: "search/live:1",
            args: { query: "pizza" },
          },
        });
        emit({
          runId: "run-live",
          stream: "assistant",
          data: { delta: "Recovered answer" },
        });
        emit({
          runId: "run-live",
          stream: "tool",
          data: {
            phase: "result",
            name: "search",
            toolCallId: "search/live:1",
            isError: false,
            result: { hits: 4 },
          },
        });
        await params.dispatcherOptions.deliver(
          { text: "Tool summary" },
          { kind: "tool" },
        );
        await params.dispatcherOptions.deliver(
          { text: "Recovered answer" },
          { kind: "final" },
        );
        emit({
          runId: "run-live",
          stream: "lifecycle",
          data: { phase: "end" },
        });
      },
      {
        taskStore: {
          kind: "json-file",
          path: taskStoreRoot,
        },
      },
    );
    const activeServer = liveServer;

    if (!activeServer) {
      assert.fail("expected live server");
    }

    const liveResult = await activeServer.requestHandler.sendMessage({
      message: createUserMessage(),
      configuration: {
        blocking: false,
      },
    });

    assert.equal(isTask(liveResult), true);
    if (!isTask(liveResult)) {
      assert.fail("expected live task");
    }

    await waitFor(async () => {
      const snapshot = await activeServer.requestHandler.getTask({
        id: liveResult.id,
        historyLength: 10,
      });

      return (getCurrentSequence(snapshot) ?? 0) >= 3;
    });

    const resubscribed: Array<Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
    const resubscribePromise = (async () => {
      for await (const event of activeServer.requestHandler.resubscribe({
        id: liveResult.id,
        metadata: {
          openclaw: {
            afterSequence: 1,
          },
        },
      })) {
        resubscribed.push(event);
      }
    })();

    await waitFor(() => resubscribed.length >= 2);
    assert.equal(resubscribed.every((event) => event.kind !== "task"), true);
    assert.equal(isStatusUpdate(resubscribed[0]), true);
    assert.equal(isArtifactUpdate(resubscribed[1]), true);
    assert.equal(
      isStatusUpdate(resubscribed[0]) ? resubscribed[0].status.state : undefined,
      "working",
    );
    assert.equal(
      isArtifactUpdate(resubscribed[1])
        ? resubscribed[1].artifact.artifactId
        : undefined,
      "assistant-output-0001",
    );
    assert.equal(
      isStatusUpdate(resubscribed[0]) ? isReplayedEvent(resubscribed[0]) : false,
      true,
    );
    assert.equal(
      isArtifactUpdate(resubscribed[1]) ? isReplayedEvent(resubscribed[1]) : false,
      true,
    );
    assert.equal(
      isStatusUpdate(resubscribed[0]) ? getEventSequence(resubscribed[0]) : undefined,
      2,
    );
    assert.equal(
      isArtifactUpdate(resubscribed[1]) ? getEventSequence(resubscribed[1]) : undefined,
      3,
    );

    resumeLiveRun?.();
    await resubscribePromise;

    await waitFor(async () => {
      const persisted = await activeServer.requestHandler.getTask({
        id: liveResult.id,
        historyLength: 10,
      });

      return persisted.status.state === "completed";
    });

    assert.ok(
      resubscribed.some(
        (event) =>
          isArtifactUpdate(event) &&
          event.artifact.artifactId === "tool-progress-search_live_1",
      ),
    );
    assert.ok(
      resubscribed.some(
        (event) =>
          isArtifactUpdate(event) &&
          event.artifact.artifactId === "assistant-output-0001",
      ),
    );
    assert.ok(
      resubscribed.some(
        (event) =>
          isStatusUpdate(event) &&
          event.status.state === "completed" &&
          event.final === true &&
          isReplayedEvent(event) === false,
      ),
    );
  } finally {
    liveServer?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
