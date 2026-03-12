import test from "node:test";
import assert from "node:assert/strict";
import type {
  AgentCard,
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import {
  A2AError,
  DefaultRequestHandler,
} from "@a2a-js/sdk/server";
import { createOpenClawA2AExecutor } from "../dist/openclaw-executor.js";
import { A2ALiveExecutionRegistry } from "../dist/live-execution-registry.js";
import { A2AInboundRequestHandler } from "../dist/request-handler.js";
import { createTaskSnapshot } from "../dist/response-mapping.js";
import {
  createTaskStore,
  type StoredTaskBinding,
  type TaskJournalSubscriptionHandle,
} from "../dist/task-store.js";
import {
  createPluginRuntimeHarness,
  createTestAccount,
  createUserMessage,
  waitFor,
} from "./runtime-harness.js";
import {
  assertNoOpenClawMetadata,
  getPersistedArtifactData,
  getPersistedArtifactText,
  getStatusMessageText,
  getStatusSequence,
  isArtifactUpdate,
  isMessage,
  isStatusUpdate,
  isTask,
} from "./test-helpers.js";

function createAgentCard(): AgentCard {
  const account = createTestAccount();
  const jsonRpcUrl = new URL(account.jsonRpcPath, account.publicBaseUrl).toString();
  const inputModes = [...account.defaultInputModes];
  const outputModes = [...account.defaultOutputModes];

  return {
    name: account.label,
    description: account.description ?? account.label,
    protocolVersion: account.protocolVersion,
    version: "test",
    url: jsonRpcUrl,
    preferredTransport: "JSONRPC",
    additionalInterfaces: [
      {
        transport: "JSONRPC",
        url: jsonRpcUrl,
      },
    ],
    capabilities: {
      pushNotifications: false,
      streaming: true,
      stateTransitionHistory: false,
    },
    defaultInputModes: inputModes,
    defaultOutputModes: outputModes,
    skills: account.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description ?? skill.name,
      tags: [...skill.tags],
      examples: [...skill.examples],
      inputModes: [...inputModes],
      outputModes: [...outputModes],
    })),
  };
}

function createBinding(taskId: string): StoredTaskBinding {
  return {
    schemaVersion: 1,
    agentId: "main",
    channel: "a2a",
    accountId: "default",
    matchedBy: "default",
    sessionKey: `session:${taskId}`,
    mainSessionKey: `session:${taskId}`,
    storePath: `/tmp/${taskId}.json`,
    peer: {
      kind: "direct",
      id: `peer:${taskId}`,
      source: "task-id",
    },
    createdAt: "2026-03-11T00:00:00.000Z",
    updatedAt: "2026-03-11T00:00:00.000Z",
  };
}

function createHandlerHarness(
  script: Parameters<typeof createPluginRuntimeHarness>[0],
  options?: Parameters<typeof createPluginRuntimeHarness>[1],
) {
  const account = createTestAccount();
  const { pluginRuntime } = options
    ? createPluginRuntimeHarness(script, options)
    : createPluginRuntimeHarness(script);
  const taskRuntime = createTaskStore();
  const liveExecutions = new A2ALiveExecutionRegistry();
  const agentExecutor = createOpenClawA2AExecutor({
    accountId: "default",
    account,
    cfg: {},
    channelRuntime: pluginRuntime.channel,
    pluginRuntime,
    taskRuntime,
    liveExecutions,
  });
  const base = new DefaultRequestHandler(
    createAgentCard(),
    taskRuntime,
    agentExecutor,
    liveExecutions.eventBusManager,
  );

  return {
    liveExecutions,
    taskRuntime,
    requestHandler: new A2AInboundRequestHandler(
      base,
      taskRuntime,
      liveExecutions,
      agentExecutor,
      account.defaultOutputModes,
    ),
  };
}

async function collectCommittedTail(
  subscription: TaskJournalSubscriptionHandle,
): Promise<Array<TaskStatusUpdateEvent | TaskArtifactUpdateEvent>> {
  const events: Array<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];

  try {
    while (true) {
      const event = await subscription.next();

      if (!event) {
        return events;
      }

      events.push(event);

      if (event.kind === "status-update" && event.final) {
        return events;
      }
    }
  } finally {
    subscription.close();
  }
}

async function collectStreamEvents<T>(
  stream: AsyncGenerator<T, void, undefined>,
): Promise<T[]> {
  const events: T[] = [];

  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

test("blocking sendMessage returns a direct Message for terminal replies", async () => {
  const harness = createHandlerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-direct");
    emit({
      runId: "run-direct",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Direct reply" },
      { kind: "final" },
    );
    emit({
      runId: "run-direct",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await harness.requestHandler.sendMessage({
    message: createUserMessage(),
  });

  assert.equal(result.kind, "message");
  assert.equal(result.parts[0]?.kind, "text");
  assert.equal(
    result.parts[0] && "text" in result.parts[0] ? result.parts[0].text : undefined,
    "Direct reply",
  );
});

test("blocking sendMessage returns a Task once reply activity promotes the run", async () => {
  const harness = createHandlerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-promoted");
    emit({
      runId: "run-promoted",
      stream: "lifecycle",
      data: { phase: "start" },
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
      runId: "run-promoted",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await harness.requestHandler.sendMessage({
    message: createUserMessage(),
  });

  assert.equal(isTask(result), true);
  if (!isTask(result)) {
    assert.fail("expected promoted task");
  }

  assert.equal(result.status.state, "completed");
  assert.ok(
    result.artifacts?.some((artifact) => artifact.artifactId.startsWith("tool-result-")),
  );
});

test("sendMessageStream returns only one canonical Message for direct streaming replies", async () => {
  const harness = createHandlerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-stream-direct");
    emit({
      runId: "run-stream-direct",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Direct stream reply" },
      { kind: "final" },
    );
    emit({
      runId: "run-stream-direct",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const events = await collectStreamEvents(
    harness.requestHandler.sendMessageStream({
      message: createUserMessage({
        messageId: "message:stream-direct",
      }),
    }),
  );

  assert.equal(events.length, 1);
  assert.equal(isMessage(events[0]), true);
  if (!isMessage(events[0])) {
    assert.fail("expected direct message");
  }

  assert.equal(events[0].parts[0]?.kind, "text");
  assert.equal(
    events[0].parts[0] && "text" in events[0].parts[0]
      ? events[0].parts[0].text
      : undefined,
    "Direct stream reply",
  );
  assert.deepEqual(await harness.taskRuntime.listTaskIds(), []);
});

test("sendMessageStream yields committed task events for promoted runs and tasks/get matches the final task", async () => {
  const harness = createHandlerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-stream-promoted");
    emit({
      runId: "run-stream-promoted",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Tool summary" },
      { kind: "tool" },
    );
    await params.dispatcherOptions.deliver(
      { text: "Promoted final answer" },
      { kind: "final" },
    );
    emit({
      runId: "run-stream-promoted",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const events = await collectStreamEvents(
    harness.requestHandler.sendMessageStream({
      message: createUserMessage({
        messageId: "message:stream-promoted",
        contextId: "context:stream-promoted",
      }),
    }),
  );

  assert.equal(isTask(events[0]), true);
  if (!isTask(events[0])) {
    assert.fail("expected initial committed task snapshot");
  }

  const finalStatus = events.at(-1);

  assert.equal(isStatusUpdate(finalStatus), true);
  if (!isStatusUpdate(finalStatus)) {
    assert.fail("expected final committed status update");
  }

  assert.deepEqual(getStatusSequence(events), [
    ["submitted", false],
    ["working", false],
    ["completed", true],
  ]);
  assert.ok(
    events.some(
      (event) =>
        isArtifactUpdate(event) &&
        event.artifact.artifactId.startsWith("tool-result-"),
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        isArtifactUpdate(event) &&
        event.artifact.artifactId.startsWith("assistant-output-"),
    ),
  );

  const persisted = await harness.requestHandler.getTask({
    id: events[0].id,
    historyLength: 10,
  });

  assert.equal(persisted.status.state, "completed");
  assert.equal(getStatusMessageText(persisted), "Promoted final answer");
  assert.equal(getPersistedArtifactText(persisted, "assistant-output"), "Promoted final answer");
});

test("getTask reads the latest snapshot and trims returned history", async () => {
  const harness = createHandlerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-nonblocking");
    emit({
      runId: "run-nonblocking",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Final answer" },
      { kind: "final" },
    );
    emit({
      runId: "run-nonblocking",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await harness.requestHandler.sendMessage({
    message: createUserMessage({
      messageId: "message:get-task",
      contextId: "context:get-task",
    }),
    configuration: {
      blocking: false,
    },
  });

  assert.equal(isTask(result), true);
  if (!isTask(result)) {
    assert.fail("expected initial task");
  }

  await waitFor(async () => {
    const persisted = await harness.requestHandler.getTask({
      id: result.id,
      historyLength: 10,
    });

    return persisted.status.state === "completed";
  });

  const trimmed = await harness.requestHandler.getTask({
    id: result.id,
    historyLength: 1,
  });

  assert.equal(trimmed.status.state, "completed");
  assert.equal(trimmed.history?.length, 1);
  assert.equal(trimmed.history?.[0]?.role, "agent");
  assert.equal(getStatusMessageText(trimmed), "Final answer");
});

test("sendMessage rejects follow-ups for missing tasks", async () => {
  const harness = createHandlerHarness(async () => {
    throw new Error("executor should not run");
  });

  await assert.rejects(
    () =>
      harness.requestHandler.sendMessage({
        message: createUserMessage({
          taskId: "task-missing",
          contextId: "context-missing",
        }),
      }),
    (error: unknown) => {
      assert.equal(error instanceof A2AError, true);
      assert.equal(
        error instanceof A2AError ? error.code : undefined,
        A2AError.taskNotFound("task-missing").code,
      );
      return true;
    },
  );
});

test("sendMessage rejects follow-ups whose contextId does not match the stored task", async () => {
  const harness = createHandlerHarness(async () => {
    throw new Error("executor should not run");
  });

  await harness.taskRuntime.save(
    createTaskSnapshot({
      taskId: "task-context",
      contextId: "context-stored",
      state: "working",
      history: [
        createUserMessage({
          messageId: "message:task-context:1",
          taskId: "task-context",
          contextId: "context-stored",
        }),
      ],
    }),
  );

  await assert.rejects(
    () =>
      harness.requestHandler.sendMessage({
        message: createUserMessage({
          messageId: "message:task-context:2",
          taskId: "task-context",
          contextId: "context-other",
        }),
      }),
    /is bound to contextId context-stored, not context-other/,
  );
});

test("sendMessage rejects follow-ups for terminal tasks before mutation", async () => {
  const harness = createHandlerHarness(async () => {
    throw new Error("executor should not run");
  });

  await harness.taskRuntime.save(
    createTaskSnapshot({
      taskId: "task-terminal",
      contextId: "context-terminal",
      state: "completed",
      history: [
        createUserMessage({
          messageId: "message:task-terminal:1",
          taskId: "task-terminal",
          contextId: "context-terminal",
        }),
      ],
      messageText: "Done",
    }),
  );
  await harness.taskRuntime.writeBinding("task-terminal", createBinding("task-terminal"));

  await assert.rejects(
    () =>
      harness.requestHandler.sendMessage({
        message: createUserMessage({
          messageId: "message:task-terminal:2",
          taskId: "task-terminal",
          contextId: "context-terminal",
        }),
      }),
    /cannot be modified/,
  );
});

test("sendMessage rejects file-part follow-ups before execution and without mutating history", async () => {
  let executeCalls = 0;
  const harness = createHandlerHarness(async () => {
    executeCalls += 1;
  });
  const originalMessage: Message = createUserMessage({
    messageId: "message-existing",
    contextId: "context-existing",
    taskId: "task-existing",
    parts: [{ kind: "text", text: "Original request" }],
  });

  await harness.taskRuntime.save(
    createTaskSnapshot({
      taskId: "task-existing",
      contextId: "context-existing",
      state: "working",
      history: [originalMessage],
    }),
  );

  await assert.rejects(
    () =>
      harness.requestHandler.sendMessage({
        message: createUserMessage({
          messageId: "message-follow-up-file",
          contextId: "context-existing",
          taskId: "task-existing",
          parts: [
            {
              kind: "text",
              text: "Please review this",
            },
            {
              kind: "file",
              file: {
                uri: "https://example.com/report.pdf",
                mimeType: "application/pdf",
                name: "report.pdf",
              },
            },
          ],
        }),
      }),
    /only accept text and data parts/,
  );

  const persisted = await harness.taskRuntime.load("task-existing");

  assert.equal(executeCalls, 0);
  assert.deepEqual(persisted?.history, [originalMessage]);
});

test("cancelTask passes terminal tasks through unchanged", async () => {
  const harness = createHandlerHarness(async () => {
    throw new Error("executor should not run");
  });

  await harness.taskRuntime.save(
    createTaskSnapshot({
      taskId: "task-completed",
      contextId: "context-completed",
      state: "completed",
      history: [
        createUserMessage({
          messageId: "message:task-completed:1",
          taskId: "task-completed",
          contextId: "context-completed",
        }),
      ],
      messageText: "Done",
    }),
  );

  const result = await harness.requestHandler.cancelTask({ id: "task-completed" });

  assert.equal(result.status.state, "completed");
  assert.equal(getStatusMessageText(result), "Done");
});

test("cancelTask marks quiescent tasks canceled immediately", async () => {
  const harness = createHandlerHarness(async () => {
    throw new Error("executor should not run");
  });

  await harness.taskRuntime.save(
    createTaskSnapshot({
      taskId: "task-input-required",
      contextId: "context-input-required",
      state: "input-required",
      history: [
        createUserMessage({
          messageId: "message:task-input-required:1",
          taskId: "task-input-required",
          contextId: "context-input-required",
        }),
      ],
      messageText: "Approve shell command?",
    }),
  );

  const canceled = await harness.requestHandler.cancelTask({
    id: "task-input-required",
  });
  const persisted = await harness.requestHandler.getTask({
    id: "task-input-required",
    historyLength: 10,
  });

  assert.equal(canceled.status.state, "canceled");
  assert.equal(persisted.status.state, "canceled");
});

test("cancelTask waits for the committed terminal state of live tasks", async () => {
  let releaseAfterAbort: (() => void) | undefined;
  let abortObserved = false;
  const harness = createHandlerHarness(async ({ params, emit, waitForAbort }) => {
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

  const result = await harness.requestHandler.sendMessage({
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
  const cancelPromise = harness.requestHandler.cancelTask({ id: result.id }).then((task) => {
    cancelResolved = true;
    return task;
  });

  await waitFor(() => abortObserved);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(cancelResolved, false);

  const pending = await harness.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });

  assert.equal(pending.status.state, "working");

  releaseAfterAbort?.();

  const canceled = await cancelPromise;

  assert.equal(canceled.status.state, "canceled");
});

test("cancelTask rejects non-live active tasks", async () => {
  const harness = createHandlerHarness(async () => {
    throw new Error("executor should not run");
  });

  await harness.taskRuntime.save(
    createTaskSnapshot({
      taskId: "task-active",
      contextId: "context-active",
      state: "working",
      history: [
        createUserMessage({
          messageId: "message:task-active:1",
          taskId: "task-active",
          contextId: "context-active",
        }),
      ],
    }),
  );

  await assert.rejects(
    () => harness.requestHandler.cancelTask({ id: "task-active" }),
    /only available while the task is live in this process/,
  );
});

test("resubscribe emits the latest snapshot immediately and only tails future committed events for live active tasks", async () => {
  let releaseRun: (() => void) | undefined;
  const harness = createHandlerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-resubscribe-live");
    emit({
      runId: "run-resubscribe-live",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    await params.dispatcherOptions.deliver(
      { text: "Tool summary" },
      { kind: "tool" },
    );
    await new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    await params.dispatcherOptions.deliver(
      { text: "Resubscribed final answer" },
      { kind: "final" },
    );
    emit({
      runId: "run-resubscribe-live",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await harness.requestHandler.sendMessage({
    message: createUserMessage({
      messageId: "message:resubscribe-live",
      contextId: "context:resubscribe-live",
    }),
    configuration: {
      blocking: false,
    },
  });

  assert.equal(isTask(result), true);
  if (!isTask(result)) {
    assert.fail("expected live task");
  }

  await waitFor(async () => {
    const persisted = await harness.requestHandler.getTask({
      id: result.id,
      historyLength: 10,
    });

    return (
      persisted.status.state === "working" &&
      Boolean(
        persisted.artifacts?.some((artifact) =>
          artifact.artifactId.startsWith("tool-result-"),
        ),
      )
    );
  });

  const stream = harness.requestHandler.resubscribe({ id: result.id });
  const first = await stream.next();

  assert.equal(first.done, false);
  assert.equal(isTask(first.value), true);
  if (!isTask(first.value)) {
    assert.fail("expected latest committed snapshot");
  }

  assert.equal(first.value.status.state, "working");
  assert.ok(
    first.value.artifacts?.some((artifact) =>
      artifact.artifactId.startsWith("tool-result-"),
    ),
  );

  releaseRun?.();

  const tailEvents: Array<Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];

  for await (const event of stream) {
    tailEvents.push(event);
  }

  assert.equal(
    tailEvents.some(
      (event) =>
        isArtifactUpdate(event) &&
        event.artifact.artifactId.startsWith("tool-result-"),
    ),
    false,
  );
  assert.equal(
    tailEvents.some(
      (event) =>
        isArtifactUpdate(event) &&
        event.artifact.artifactId.startsWith("assistant-output-"),
    ),
    true,
  );
  assert.deepEqual(getStatusSequence(tailEvents), [["completed", true]]);
});

for (const taskCase of [
  {
    label: "quiescent",
    task: createTaskSnapshot({
      taskId: "task-resubscribe-quiescent",
      contextId: "context-resubscribe-quiescent",
      state: "input-required",
      history: [
        createUserMessage({
          messageId: "message:task-resubscribe-quiescent",
          taskId: "task-resubscribe-quiescent",
          contextId: "context-resubscribe-quiescent",
        }),
      ],
    }),
  },
  {
    label: "terminal",
    task: createTaskSnapshot({
      taskId: "task-resubscribe-terminal",
      contextId: "context-resubscribe-terminal",
      state: "completed",
      history: [
        createUserMessage({
          messageId: "message:task-resubscribe-terminal",
          taskId: "task-resubscribe-terminal",
          contextId: "context-resubscribe-terminal",
        }),
      ],
      messageText: "Done",
    }),
  },
  {
    label: "restart-orphaned active",
    task: createTaskSnapshot({
      taskId: "task-resubscribe-orphaned",
      contextId: "context-resubscribe-orphaned",
      state: "working",
      history: [
        createUserMessage({
          messageId: "message:task-resubscribe-orphaned",
          taskId: "task-resubscribe-orphaned",
          contextId: "context-resubscribe-orphaned",
        }),
      ],
    }),
  },
] as const) {
  test(`resubscribe returns only the snapshot for ${taskCase.label} tasks`, async () => {
    const harness = createHandlerHarness(async () => {
      throw new Error("executor should not run");
    });

    await harness.taskRuntime.save(taskCase.task);

    const events = await collectStreamEvents(
      harness.requestHandler.resubscribe({ id: taskCase.task.id }),
    );

    assert.equal(events.length, 1);
    assert.equal(isTask(events[0]), true);
    if (!isTask(events[0])) {
      assert.fail("expected single snapshot");
    }

    assert.equal(events[0].id, taskCase.task.id);
    assert.equal(events[0].status.state, taskCase.task.status.state);
  });
}

test("nonblocking tasks and committed tail events stay free of metadata.openclaw", async () => {
  let releaseRun: (() => void) | undefined;
  const harness = createHandlerHarness(async ({ params, emit }) => {
    params.replyOptions?.onAgentRunStart?.("run-metadata-free");
    emit({
      runId: "run-metadata-free",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    emit({
      runId: "run-metadata-free",
      stream: "tool",
      data: {
        phase: "result",
        name: "search",
        toolCallId: "search/1",
        isError: false,
        result: { hits: 3 },
      },
    });
    await new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    await params.dispatcherOptions.deliver(
      {
        text: "Final answer",
        channelData: {
          source: "test",
        },
      },
      { kind: "final" },
    );
    emit({
      runId: "run-metadata-free",
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  const result = await harness.requestHandler.sendMessage({
    message: createUserMessage(),
    configuration: {
      blocking: false,
    },
  });

  assert.equal(isTask(result), true);
  if (!isTask(result)) {
    assert.fail("expected metadata-free task");
  }

  const subscription = await harness.taskRuntime.subscribeToCommittedTail(result.id);

  assert.ok(subscription);

  releaseRun?.();

  const tailEvents = await collectCommittedTail(subscription!);
  const persisted = await harness.requestHandler.getTask({
    id: result.id,
    historyLength: 10,
  });

  assertNoOpenClawMetadata(result);
  assertNoOpenClawMetadata(tailEvents);
  assertNoOpenClawMetadata(persisted);
  assert.deepEqual(getPersistedArtifactData(persisted, "tool-progress-search_1"), {
    phase: "result",
    name: "search",
    toolCallId: "search/1",
    isError: false,
    result: { hits: 3 },
  });
});
