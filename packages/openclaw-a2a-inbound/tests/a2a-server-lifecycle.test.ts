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
  createPluginRuntimeHarness,
  createTestAccount,
  createUserMessage,
  waitFor,
} from "./runtime-harness.js";

type StreamEvent = Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | Message;

function isTask(value: Message | Task): value is Task {
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

function getArtifactUpdates(
  events: readonly StreamEvent[],
  artifactId: string,
): TaskArtifactUpdateEvent[] {
  return events.filter(
    (event): event is TaskArtifactUpdateEvent =>
      isArtifactUpdate(event) && event.artifact.artifactId === artifactId,
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
  const artifact = task.artifacts?.find((entry) => entry.artifactId === artifactId);

  if (!artifact) {
    return undefined;
  }

  return artifact.parts
    .filter((part): part is Extract<typeof part, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("");
}

function createServerHarness(
  script: Parameters<typeof createPluginRuntimeHarness>[0],
  accountOverrides: Partial<ReturnType<typeof createTestAccount>> = {},
) {
  const { pluginRuntime } = createPluginRuntimeHarness(script);
  return createA2AInboundServer({
    accountId: "default",
    account: createTestAccount(accountOverrides),
    cfg: {},
    channelRuntime: pluginRuntime.channel,
    pluginRuntime,
  });
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
    persisted.artifacts?.some((artifact) => artifact.artifactId === "assistant-output"),
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
  assert.ok(result.artifacts?.some((artifact) => artifact.artifactId === "assistant-output"));
  assert.ok(result.artifacts?.some((artifact) => artifact.artifactId.startsWith("tool-result-")));

  const persisted = await server.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });

  assert.equal(persisted.status.state, "completed");
  assert.ok(persisted.history?.some((message) => message.role === "user"));
  assert.ok(
    persisted.artifacts?.some((artifact) => artifact.artifactId === "assistant-output"),
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
      isArtifactUpdate(event) && event.artifact.artifactId === "assistant-output",
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
  const authoritativeUpdate = assistantUpdates.findLast(
    (event) => typeof getArtifactText(event) === "string",
  );
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

test("cancelTask aborts a live promoted execution and persists the canceled task", async () => {
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

  const canceled = await server.requestHandler.cancelTask({ id: result.id });

  assert.equal(canceled.status.state, "canceled");

  await waitFor(async () => {
    const snapshot = await server.requestHandler.getTask({
      id: result.id,
      historyLength: 10,
    });

    return snapshot.status.state === "canceled";
  });

  const persisted = await server.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });
  assert.equal(persisted.status.state, "canceled");
});

test("resubscribe works for a live in-process task and replays new progress artifacts", async () => {
  let resumeLiveRun: (() => void) | undefined;
  const tempDir = await mkdtemp(join(tmpdir(), "openclaw-a2a-inbound-"));
  const taskFile = join(tempDir, "tasks.json");

  try {
    const liveServer = createServerHarness(
      async ({ params, emit }) => {
        params.replyOptions?.onAgentRunStart?.("run-live");
        emit({
          runId: "run-live",
          stream: "lifecycle",
          data: { phase: "start" },
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
          path: taskFile,
        },
      },
    );

    const liveResult = await liveServer.requestHandler.sendMessage({
      message: createUserMessage(),
      configuration: {
        blocking: false,
      },
    });

    assert.equal(isTask(liveResult), true);
    if (!isTask(liveResult)) {
      assert.fail("expected live task");
    }

    const restartedServer = createServerHarness(
      async () => {},
      {
        taskStore: {
          kind: "json-file",
          path: taskFile,
        },
      },
    );

    await assert.rejects(
      async () => {
        const stream = restartedServer.requestHandler.resubscribe({
          id: liveResult.id,
        });
        for await (const _event of stream) {
          // noop
        }
      },
      /live in-process tasks/,
    );

    const resubscribed: Array<Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
    const resubscribePromise = (async () => {
      for await (const event of liveServer.requestHandler.resubscribe({
        id: liveResult.id,
      })) {
        resubscribed.push(event);
      }
    })();

    await waitFor(() => resubscribed.length > 0);
    assert.equal(resubscribed[0]?.kind, "task");

    resumeLiveRun?.();
    await resubscribePromise;

    await waitFor(async () => {
      const persisted = await liveServer.requestHandler.getTask({
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
          event.artifact.artifactId === "assistant-output",
      ),
    );
    assert.ok(
      resubscribed.some(
        (event) =>
          isStatusUpdate(event) &&
          event.status.state === "completed" &&
          event.final === true,
      ),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
