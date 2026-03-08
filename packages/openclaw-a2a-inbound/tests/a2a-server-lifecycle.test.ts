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

function isTask(value: Message | Task): value is Task {
  return value.kind === "task";
}

function isStatusUpdate(
  value: Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
): value is TaskStatusUpdateEvent {
  return value.kind === "status-update";
}

function isArtifactUpdate(
  value: Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
): value is TaskArtifactUpdateEvent {
  return value.kind === "artifact-update";
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

test("sendMessage returns a Task for a nonblocking delayed terminal run", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-nonblocking-delay");
    emit({
      runId: "run-nonblocking-delay",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await params.dispatcherOptions.deliver(
      { text: "Nonblocking delayed reply" },
      { kind: "final" },
    );
    emit({
      runId: "run-nonblocking-delay",
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

  assert.equal(persisted.status.state, "completed");
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

  const persisted = await server.requestHandler.getTask(
    { id: result.id, historyLength: 10 },
  );

  assert.equal(persisted.status.state, "completed");
  assert.ok(persisted.history?.some((message) => message.role === "user"));
  assert.ok(
    persisted.artifacts?.some((artifact) => artifact.artifactId === "assistant-output"),
  );
});

test("sendMessageStream yields task creation, intermediate updates, and a final status", async () => {
  const server = createServerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-stream");
    emit({
      runId: "run-stream",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-stream",
      stream: "assistant",
      data: { text: "Working" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Visible tool output" },
      { kind: "tool" },
    );
    emit({
      runId: "run-stream",
      stream: "assistant",
      data: { text: "Working\nDone" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Done" },
      { kind: "final" },
    );
    emit({
      runId: "run-stream",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const streamed: Array<Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | Message> = [];

  for await (const event of server.requestHandler.sendMessageStream({
    message: createUserMessage(),
  })) {
    streamed.push(event);
  }

  assert.ok(streamed.some((event) => event.kind === "task"));
  assert.ok(streamed.some((event) => isArtifactUpdate(event)));
  assert.ok(
    streamed.some(
      (event) =>
        isStatusUpdate(event) &&
        event.status.state === "completed" &&
        event.final === true,
    ),
  );
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

test("resubscribe works for a live in-process task and fails cleanly after process loss", async () => {
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
        await params.dispatcherOptions.deliver(
          { text: "Tool summary" },
          { kind: "tool" },
        );
        await new Promise<void>((resolve) => {
          resumeLiveRun = resolve;
        });
        emit({
          runId: "run-live",
          stream: "assistant",
          data: { text: "Recovered answer" },
        });
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
          isStatusUpdate(event) &&
          event.status.state === "completed" &&
          event.final === true,
      ),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
